import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { RowDataPacket } from 'mysql2/promise';
import { logGlobalAudit, type ForensicContext } from '../../core/audit/audit.service.js';
import { cacheService } from '../../core/cache/redis.js';
import { executeSql, queryOne, withTransaction } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { storageProvider } from '../../core/storage/StorageProvider.js';
import { normalizeCedula, parseExcelDateUTC } from '../../core/utils/timezone.js';
import { assertCampaignNotClosed } from '../../middlewares/campaignLock.middleware.js';

interface ParsedAsociadoRow {
  cedula: string;
  nombre_completo: string;
  fecha_ult_act: string | null;
  observacion: string | null;
  email: string | null;
  direccion: string | null;
}

export interface ImportProcessInput {
  actividad_id: number;
  s3_key: string;
  nombre_archivo: string;
  usuario_id: number;
  forensic: ForensicContext;
}

export interface ImportProcessResult {
  importacion_id: number;
  estado: 'EXITOSO' | 'CON_ERRORES';
  total_filas: number;
  total_nuevos: number;
  total_actualizados: number;
  errores: string[];
}

function normalizeHeader(header: unknown): string {
  return String(header ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findColumnIndex(headers: Map<string, number>, aliases: string[]): number | undefined {
  for (const alias of aliases) {
    const idx = headers.get(alias);
    if (idx !== undefined) return idx;
  }
  return undefined;
}

function extractCellValue(cell: ExcelJS.Cell): unknown {
  const val = cell.value;
  if (val && typeof val === 'object') {
    if ('result' in val) return (val as ExcelJS.CellFormulaValue).result;
    if ('text' in val) return (val as ExcelJS.CellHyperlinkValue).text;
    if ('richText' in val) {
      return (val as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    }
  }
  return val;
}

export async function processExcelImport(input: ImportProcessInput): Promise<ImportProcessResult> {
  await assertCampaignNotClosed(input.actividad_id);

  const lockKey = `lock:importacion:${input.actividad_id}`;
  const acquired = await cacheService.acquireLock(lockKey, 300);
  if (!acquired) {
    throw new AppError(
      409,
      'IMPORT_IN_PROGRESS',
      'Ya existe una importación de Excel en procesamiento para esta campaña.',
    );
  }

  const initRes = await executeSql(
    `INSERT INTO importaciones_excel (actividad_id, usuario_id, nombre_archivo, estado)
     VALUES (?, ?, ?, 'PROCESANDO')`,
    [input.actividad_id, input.usuario_id, input.nombre_archivo],
  );
  const importacionId = initRes.insertId;

  try {
    const fileBuffer = await storageProvider.downloadBuffer(input.s3_key);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as unknown as ArrayBuffer);

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new AppError(422, 'INVALID_EXCEL_STRUCTURE', 'El archivo Excel no contiene hojas válidas.');
    }

    const headerRow = sheet.getRow(1);
    const headerMap = new Map<string, number>();
    headerRow.eachCell((cell, colNumber) => {
      const normalized = normalizeHeader(extractCellValue(cell));
      if (normalized) headerMap.set(normalized, colNumber);
    });

    const idxCedula = findColumnIndex(headerMap, ['cedula', 'documento', 'identificacion', 'cc']);
    const idxAsociado = findColumnIndex(headerMap, ['asociado', 'nombre', 'nombre completo']);
    const idxFecha = findColumnIndex(headerMap, [
      'fecha ult act',
      'fecha ultima actualizacion',
      'fecha act',
    ]);
    const idxObs = findColumnIndex(headerMap, ['observacion', 'observaciones', 'nota', 'notas']);
    const idxEmail = findColumnIndex(headerMap, ['email', 'correo', 'correo electronico']);
    const idxDireccion = findColumnIndex(headerMap, ['direccion', 'domicilio']);

    const missing: string[] = [];
    if (!idxCedula) missing.push('Cédula');
    if (!idxAsociado) missing.push('Asociado');
    if (!idxFecha) missing.push('Fecha ult. act.');
    if (!idxObs) missing.push('Observación');

    if (missing.length > 0) {
      await executeSql(
        `UPDATE importaciones_excel SET estado = 'FALLIDO', log_observaciones = ? WHERE id = ?`,
        [`Columnas faltantes: ${missing.join(', ')}`, importacionId],
      );
      throw new AppError(
        422,
        'INVALID_EXCEL_STRUCTURE',
        `Estructura Excel inválida. Faltan las columnas requeridas: ${missing.join(', ')}`,
        { missing_columns: missing },
      );
    }

    const dedupedRows = new Map<string, ParsedAsociadoRow>();
    const errores: string[] = [];
    let totalFilas = 0;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const rawCedula = extractCellValue(row.getCell(idxCedula!));
      const rawNombre = extractCellValue(row.getCell(idxAsociado!));
      if (
        (rawCedula === null || rawCedula === undefined || String(rawCedula).trim() === '') &&
        (rawNombre === null || rawNombre === undefined || String(rawNombre).trim() === '')
      ) {
        return;
      }

      totalFilas += 1;

      try {
        const cedula = normalizeCedula(rawCedula);
        const nombre = String(rawNombre ?? '').trim();
        if (!cedula || !nombre) {
          errores.push(`Fila ${rowNumber}: cédula o nombre vacío.`);
          return;
        }

        const fechaUltAct = parseExcelDateUTC(extractCellValue(row.getCell(idxFecha!)));
        const rawObs = extractCellValue(row.getCell(idxObs!));
        const observacion = rawObs !== null && rawObs !== undefined ? String(rawObs).trim() || null : null;

        const rawEmail = idxEmail ? extractCellValue(row.getCell(idxEmail)) : null;
        const email =
          rawEmail !== null && rawEmail !== undefined ? String(rawEmail).trim() || null : null;

        const rawDir = idxDireccion ? extractCellValue(row.getCell(idxDireccion)) : null;
        const direccion =
          rawDir !== null && rawDir !== undefined ? String(rawDir).trim() || null : null;

        dedupedRows.set(cedula, {
          cedula,
          nombre_completo: nombre.slice(0, 250),
          fecha_ult_act: fechaUltAct,
          observacion,
          email: email ? email.slice(0, 120) : null,
          direccion: direccion ? direccion.slice(0, 255) : null,
        });
      } catch (err) {
        errores.push(`Fila ${rowNumber}: ${(err as Error).message}`);
      }
    });

    const rowsToUpsert = Array.from(dedupedRows.values());
    let totalNuevos = 0;
    let totalActualizados = 0;

    await withTransaction(async (conn) => {
      const existingCedulas = new Set<string>();
      const chunkSize = 1000;

      for (let i = 0; i < rowsToUpsert.length; i += chunkSize) {
        const chunk = rowsToUpsert.slice(i, i + chunkSize);
        const cedulasChunk = chunk.map((r) => r.cedula);
        const placeholders = cedulasChunk.map(() => '?').join(',');

        const [existingRows] = await conn.query<(RowDataPacket & { cedula: string })[]>(
          `SELECT cedula FROM asociados WHERE cedula IN (${placeholders})`,
          cedulasChunk,
        );
        for (const row of existingRows) {
          existingCedulas.add(row.cedula);
        }

        const valuesPlaceholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, 1, ?, ?)').join(',');
        const flatValues: unknown[] = [];
        for (const r of chunk) {
          flatValues.push(
            r.cedula,
            r.nombre_completo,
            r.email,
            r.direccion,
            r.fecha_ult_act,
            r.observacion,
            input.usuario_id,
            input.usuario_id,
          );
        }

        // Nunca usar REPLACE INTO para preservar FK ON DELETE RESTRICT de asociados_auditoria
        await conn.query(
          `INSERT INTO asociados
            (cedula, nombre_completo, email, direccion, fecha_ult_act, observacion, activo, creado_por, actualizado_por)
           VALUES ${valuesPlaceholders}
           ON DUPLICATE KEY UPDATE
            nombre_completo = VALUES(nombre_completo),
            email = COALESCE(VALUES(email), email),
            direccion = COALESCE(VALUES(direccion), direccion),
            fecha_ult_act = VALUES(fecha_ult_act),
            observacion = VALUES(observacion),
            activo = 1,
            actualizado_por = VALUES(actualizado_por)`,
          flatValues,
        );

        for (const r of chunk) {
          if (existingCedulas.has(r.cedula)) {
            totalActualizados += 1;
          } else {
            totalNuevos += 1;
          }
        }
      }

      // Sincronizar censo aislado de la campaña en actividad_asociados
      await conn.query(
        `UPDATE actividad_asociados aa
         LEFT JOIN entregas e
           ON e.actividad_id = aa.actividad_id AND e.asociado_id = aa.asociado_id AND e.estado = 'ENTREGADO'
         SET aa.habilitado = 0
         WHERE aa.actividad_id = ? AND e.id IS NULL`,
        [input.actividad_id],
      );

      for (let i = 0; i < rowsToUpsert.length; i += chunkSize) {
        const chunk = rowsToUpsert.slice(i, i + chunkSize);
        const cedulasChunk = chunk.map((r) => r.cedula);
        const placeholders = cedulasChunk.map(() => '?').join(',');

        await conn.query(
          `INSERT INTO actividad_asociados (actividad_id, asociado_id, habilitado)
           SELECT ?, id, 1 FROM asociados WHERE cedula IN (${placeholders})
           ON DUPLICATE KEY UPDATE habilitado = 1`,
          [input.actividad_id, ...cedulasChunk],
        );
      }

      const finalEstado: 'EXITOSO' | 'CON_ERRORES' =
        errores.length > 0 ? 'CON_ERRORES' : 'EXITOSO';

      await conn.query(
        `UPDATE importaciones_excel
         SET total_filas = ?, total_nuevos = ?, total_actualizados = ?, estado = ?, log_observaciones = ?
         WHERE id = ?`,
        [
          totalFilas,
          totalNuevos,
          totalActualizados,
          finalEstado,
          errores.length > 0 ? errores.slice(0, 50).join('\n') : null,
          importacionId,
        ],
      );

      await logGlobalAudit(
        {
          usuario_id: input.usuario_id,
          accion: 'IMPORTAR_EXCEL',
          tabla_afectada: 'importaciones_excel',
          registro_id: importacionId,
          detalle_operacion: {
            actividad_id: input.actividad_id,
            nombre_archivo: input.nombre_archivo,
            total_filas: totalFilas,
            total_nuevos: totalNuevos,
            total_actualizados: totalActualizados,
            errores_count: errores.length,
          },
          forensic: input.forensic,
        },
        conn,
      );
    });

    return {
      importacion_id: importacionId,
      estado: errores.length > 0 ? 'CON_ERRORES' : 'EXITOSO',
      total_filas: totalFilas,
      total_nuevos: totalNuevos,
      total_actualizados: totalActualizados,
      errores: errores.slice(0, 50),
    };
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'INVALID_EXCEL_STRUCTURE')) {
      await executeSql(
        `UPDATE importaciones_excel SET estado = 'FALLIDO', log_observaciones = ? WHERE id = ?`,
        [(err as Error).message.slice(0, 1000), importacionId],
      );
    }
    throw err;
  } finally {
    await cacheService.releaseLock(lockKey);
  }
}

export function buildImportKey(actividadId: number): string {
  return `imports/${actividadId}/${crypto.randomUUID()}.xlsx`;
}

