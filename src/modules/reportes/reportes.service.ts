import ExcelJS from 'exceljs';
import { RowDataPacket } from 'mysql2/promise';
import { cacheService } from '../../core/cache/redis.js';
import { queryOne, queryRows } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import type { ReportQueueMessage } from '../../core/queue/QueueProvider.js';
import { storageProvider } from '../../core/storage/StorageProvider.js';

export interface ControlDiarioDia {
  fecha: string;
  entregados_brutos: number;
  anulaciones_dia: number;
  entregados_netos: number;
  acumulado_neto: number;
  saldo: number;
}

export interface ControlDiarioResult {
  actividad_id: number;
  titulo: string;
  cantidad_comprada: number;
  dias: ControlDiarioDia[];
}

interface ReportEntregaRow extends RowDataPacket {
  cedula: string;
  nombre_completo: string;
  fecha_ult_act: string | null;
  observacion: string | null;
  estado_entrega: 'ENTREGADO' | 'PENDIENTE';
  fecha_entrega: string | null;
  hora_entrega: string | null;
  sede_nombre: string | null;
  repartidor_nombre: string | null;
  otra_informacion: string | null;
  firma_key: string | null;
  firma_thumb_key: string | null;
}

export async function getControlDiario(
  actividadId: number,
  sedeId?: number,
): Promise<ControlDiarioResult> {
  const act = await queryOne<RowDataPacket & { id: number; titulo: string; cantidad_comprada: number }>(
    'SELECT id, titulo, cantidad_comprada FROM actividades WHERE id = ? LIMIT 1',
    [actividadId],
  );
  if (!act) {
    throw new AppError(404, 'NOT_FOUND', 'Campaña no encontrada.');
  }

  const sedeFilterSql = sedeId ? ' AND e.sede_id = ?' : '';
  const baseParams = sedeId ? [actividadId, sedeId] : [actividadId];

  const brutos = await queryRows<RowDataPacket & { fecha: string; total: number }>(
    `SELECT e.fecha_entrega AS fecha, COUNT(*) AS total
     FROM entregas e
     WHERE e.actividad_id = ? ${sedeFilterSql}
     GROUP BY e.fecha_entrega
     ORDER BY e.fecha_entrega ASC`,
    baseParams,
  );

  const anulados = await queryRows<RowDataPacket & { fecha: string; total: number }>(
    `SELECT DATE(an.fecha_anulacion) AS fecha, COUNT(*) AS total
     FROM anulaciones an
     INNER JOIN entregas e ON e.id = an.entrega_id
     WHERE e.actividad_id = ? ${sedeFilterSql}
     GROUP BY DATE(an.fecha_anulacion)
     ORDER BY fecha ASC`,
    baseParams,
  );

  const brutosMap = new Map<string, number>();
  for (const r of brutos) brutosMap.set(String(r.fecha), Number(r.total));

  const anuladosMap = new Map<string, number>();
  for (const r of anulados) anuladosMap.set(String(r.fecha), Number(r.total));

  const allDates = Array.from(new Set([...brutosMap.keys(), ...anuladosMap.keys()])).sort();

  let acumulado = 0;
  const dias: ControlDiarioDia[] = allDates.map((fecha) => {
    const entregadosBrutos = brutosMap.get(fecha) ?? 0;
    const anulacionesDia = anuladosMap.get(fecha) ?? 0;
    const entregadosNetos = entregadosBrutos - anulacionesDia;
    acumulado += entregadosNetos;
    return {
      fecha,
      entregados_brutos: entregadosBrutos,
      anulaciones_dia: anulacionesDia,
      entregados_netos: entregadosNetos,
      acumulado_neto: acumulado,
      saldo: act.cantidad_comprada - acumulado,
    };
  });

  return {
    actividad_id: act.id,
    titulo: act.titulo,
    cantidad_comprada: act.cantidad_comprada,
    dias,
  };
}

async function appendSignatureRow(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  rowIndex: number,
  colIndexZeroBased: number,
  thumbKey: string | null,
  fallbackKey: string | null,
): Promise<void> {
  const keyToUse = thumbKey || fallbackKey;
  if (!keyToUse) return;

  try {
    const imgBuffer = await storageProvider.downloadBuffer(keyToUse);
    const imageId = workbook.addImage({
      buffer: imgBuffer as unknown as ExcelJS.Buffer,
      extension: 'png',
    });

    sheet.getRow(rowIndex).height = 52;
    sheet.addImage(imageId, {
      tl: { col: colIndexZeroBased, row: rowIndex - 1 },
      ext: { width: 130, height: 48 },
    });
  } catch (err) {
    console.warn(`[Reporte] No se pudo incrustar firma ${keyToUse}:`, (err as Error).message);
  }
}

export async function generateExcelReportJob(msg: ReportQueueMessage): Promise<void> {
  try {
    await cacheService.setReportJob(msg.job_id, {
      job_id: msg.job_id,
      estado: 'PROCESANDO',
    });

    const control = await getControlDiario(msg.actividad_id);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CEMCOP Entregas';
    workbook.created = new Date();

    const censoCount = await queryOne<RowDataPacket & { total: number }>(
      'SELECT COUNT(*) AS total FROM actividad_asociados WHERE actividad_id = ?',
      [msg.actividad_id],
    );
    const useCenso = Boolean(censoCount && censoCount.total > 0);

    const baseSelect = useCenso
      ? `SELECT a.cedula, a.nombre_completo, a.fecha_ult_act, a.observacion,
                IF(e.id IS NOT NULL, 'ENTREGADO', 'PENDIENTE') AS estado_entrega,
                e.fecha_entrega, e.hora_entrega, s.nombre AS sede_nombre,
                u.nombre AS repartidor_nombre, e.otra_informacion, e.firma_key, e.firma_thumb_key
         FROM actividad_asociados aa
         INNER JOIN asociados a ON a.id = aa.asociado_id
         LEFT JOIN entregas e ON e.asociado_id = a.id AND e.actividad_id = ? AND e.estado = 'ENTREGADO'
         LEFT JOIN sedes s ON s.id = e.sede_id
         LEFT JOIN usuarios u ON u.id = e.repartidor_id
         WHERE aa.actividad_id = ? AND aa.habilitado = 1`
      : `SELECT a.cedula, a.nombre_completo, a.fecha_ult_act, a.observacion,
                IF(e.id IS NOT NULL, 'ENTREGADO', 'PENDIENTE') AS estado_entrega,
                e.fecha_entrega, e.hora_entrega, s.nombre AS sede_nombre,
                u.nombre AS repartidor_nombre, e.otra_informacion, e.firma_key, e.firma_thumb_key
         FROM asociados a
         LEFT JOIN entregas e ON e.asociado_id = a.id AND e.actividad_id = ? AND e.estado = 'ENTREGADO'
         LEFT JOIN sedes s ON s.id = e.sede_id
         LEFT JOIN usuarios u ON u.id = e.repartidor_id
         WHERE a.activo = 1`;

    if (msg.tipo === 'COMPLETO') {
      const rows = await queryRows<ReportEntregaRow>(
        `${baseSelect} ORDER BY a.nombre_completo ASC`,
        useCenso ? [msg.actividad_id, msg.actividad_id] : [msg.actividad_id],
      );

      // Hoja 1: Lista de entrega
      const sheetLista = workbook.addWorksheet('Lista de entrega');
      sheetLista.columns = [
        { header: 'Cédula', key: 'cedula', width: 16 },
        { header: 'Asociado', key: 'nombre', width: 34 },
        { header: 'Fecha ult. act.', key: 'fecha_ult_act', width: 15 },
        { header: 'Observación', key: 'observacion', width: 28 },
        { header: 'Estado', key: 'estado', width: 14 },
        { header: 'Fecha entrega', key: 'fecha_entrega', width: 14 },
        { header: 'Hora entrega', key: 'hora_entrega', width: 12 },
        { header: 'Sede', key: 'sede', width: 20 },
        { header: 'Otra información', key: 'otra_info', width: 30 },
        { header: 'Firma recibido', key: 'firma', width: 22 },
      ];
      sheetLista.getRow(1).font = { bold: true };

      for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx]!;
        const excelRowIdx = idx + 2;
        sheetLista.addRow({
          cedula: r.cedula,
          nombre: r.nombre_completo,
          fecha_ult_act: r.fecha_ult_act ?? '',
          observacion: r.observacion ?? '',
          estado: r.estado_entrega,
          fecha_entrega: r.fecha_entrega ?? '',
          hora_entrega: r.hora_entrega ?? '',
          sede: r.sede_nombre ?? '',
          otra_info: r.otra_informacion ?? '',
          firma: '',
        });

        if (r.estado_entrega === 'ENTREGADO') {
          await appendSignatureRow(workbook, sheetLista, excelRowIdx, 9, r.firma_thumb_key, r.firma_key);
        }
      }

      // Hoja 2: Solo entregados
      const deliveredRows = rows.filter((r) => r.estado_entrega === 'ENTREGADO');
      const sheetEntregados = workbook.addWorksheet('Solo entregados');
      sheetEntregados.columns = [
        { header: 'Cédula', key: 'cedula', width: 16 },
        { header: 'Asociado', key: 'nombre', width: 34 },
        { header: 'Fecha entrega', key: 'fecha_entrega', width: 14 },
        { header: 'Hora entrega', key: 'hora_entrega', width: 12 },
        { header: 'Sede', key: 'sede', width: 20 },
        { header: 'Repartidor', key: 'repartidor', width: 24 },
        { header: 'Otra información', key: 'otra_info', width: 32 },
        { header: 'Firma recibido', key: 'firma', width: 22 },
      ];
      sheetEntregados.getRow(1).font = { bold: true };

      for (let idx = 0; idx < deliveredRows.length; idx++) {
        const r = deliveredRows[idx]!;
        const excelRowIdx = idx + 2;
        sheetEntregados.addRow({
          cedula: r.cedula,
          nombre: r.nombre_completo,
          fecha_entrega: r.fecha_entrega ?? '',
          hora_entrega: r.hora_entrega ?? '',
          sede: r.sede_nombre ?? '',
          repartidor: r.repartidor_nombre ?? '',
          otra_info: r.otra_informacion ?? '',
          firma: '',
        });
        await appendSignatureRow(workbook, sheetEntregados, excelRowIdx, 7, r.firma_thumb_key, r.firma_key);
      }

      // Hoja 3: Control diario
      const sheetControl = workbook.addWorksheet('Control diario');
      sheetControl.addRow([`Campaña: ${control.titulo}`, `Cantidad Comprada: ${control.cantidad_comprada}`]);
      sheetControl.addRow([
        'Fecha',
        'Entregados Brutos',
        'Anulaciones del Día',
        'Entregados Netos',
        'Acumulado Neto',
        'Saldo Disponible',
      ]);
      sheetControl.getRow(1).font = { bold: true };
      sheetControl.getRow(2).font = { bold: true };

      for (const d of control.dias) {
        sheetControl.addRow([
          d.fecha,
          d.entregados_brutos,
          d.anulaciones_dia,
          d.entregados_netos,
          d.acumulado_neto,
          d.saldo,
        ]);
      }
    } else {
      const targetDate = msg.fecha ?? new Date().toISOString().slice(0, 10);
      const rows = await queryRows<ReportEntregaRow>(
        `SELECT e.cedula_historica AS cedula, e.nombre_historico AS nombre_completo,
                e.fecha_entrega, e.hora_entrega, s.nombre AS sede_nombre,
                u.nombre AS repartidor_nombre, e.otra_informacion, e.firma_key, e.firma_thumb_key
         FROM entregas e
         INNER JOIN sedes s ON s.id = e.sede_id
         INNER JOIN usuarios u ON u.id = e.repartidor_id
         WHERE e.actividad_id = ? AND e.fecha_entrega = ? AND e.estado = 'ENTREGADO'
         ORDER BY e.hora_entrega ASC`,
        [msg.actividad_id, targetDate],
      );

      const sheetDiario = workbook.addWorksheet(`Entregas ${targetDate}`);
      const diaResumen = control.dias.find((d) => d.fecha === targetDate);
      sheetDiario.addRow([
        `Campaña: ${control.titulo}`,
        `Fecha: ${targetDate}`,
        `Entregados Netos Día: ${diaResumen?.entregados_netos ?? rows.length}`,
        `Acumulado: ${diaResumen?.acumulado_neto ?? 0}`,
        `Saldo: ${diaResumen?.saldo ?? control.cantidad_comprada}`,
      ]);
      sheetDiario.getRow(1).font = { bold: true };

      sheetDiario.addRow([
        'Cédula',
        'Asociado',
        'Hora entrega',
        'Sede',
        'Repartidor',
        'Otra información',
        'Firma recibido',
      ]);
      sheetDiario.getRow(2).font = { bold: true };
      sheetDiario.columns = [
        { width: 16 },
        { width: 34 },
        { width: 14 },
        { width: 20 },
        { width: 24 },
        { width: 32 },
        { width: 22 },
      ];

      for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx]!;
        const excelRowIdx = idx + 3;
        sheetDiario.addRow([
          r.cedula,
          r.nombre_completo,
          r.hora_entrega ?? '',
          r.sede_nombre ?? '',
          r.repartidor_nombre ?? '',
          r.otra_informacion ?? '',
          '',
        ]);
        await appendSignatureRow(workbook, sheetDiario, excelRowIdx, 6, r.firma_thumb_key, r.firma_key);
      }
    }

    const outBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const s3Key = `reportes/${msg.actividad_id}/${msg.job_id}.xlsx`;
    await storageProvider.uploadBuffer(
      s3Key,
      outBuffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const nombreArchivo =
      msg.tipo === 'DIARIO'
        ? `Entrega obsequios CEMCOP ${msg.fecha ?? 'diario'}.xlsx`
        : `Entrega obsequios CEMCOP Completo.xlsx`;

    await cacheService.setReportJob(msg.job_id, {
      job_id: msg.job_id,
      estado: 'LISTO',
      s3_key: s3Key,
      nombre_archivo: nombreArchivo,
    });
  } catch (err) {
    await cacheService.setReportJob(msg.job_id, {
      job_id: msg.job_id,
      estado: 'FALLIDO',
      error: (err as Error).message,
    });
    throw err;
  }
}

