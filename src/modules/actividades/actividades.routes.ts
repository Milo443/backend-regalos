import { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { logGlobalAudit } from '../../core/audit/audit.service.js';
import { DbExecutor, executeSql, pool, queryOne, queryRows, withTransaction } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { getBogotaDate } from '../../core/utils/timezone.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { campaignLockMiddleware } from '../../middlewares/campaignLock.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';

interface ActividadRow extends RowDataPacket {
  id: number;
  titulo: string;
  cantidad_comprada: number;
  saldo_disponible: number;
  total_entregados: number;
  estado: 'BORRADOR' | 'ACTIVA' | 'CERRADA';
  fecha_inicio: string | null;
  fecha_fin: string | null;
  creado_por: number;
  created_at: string;
}

interface SedeBreakdownRow extends RowDataPacket {
  sede_id: number;
  codigo: string;
  nombre: string;
  entregados: number;
}

async function countAsociadosBase(actividadId: number, executor: DbExecutor = pool): Promise<number> {
  const censoCampaign = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
     FROM actividad_asociados aa
     INNER JOIN asociados a ON a.id = aa.asociado_id
     WHERE aa.actividad_id = ? AND aa.habilitado = 1 AND a.activo = 1`,
    [actividadId],
    executor,
  );
  if (censoCampaign && censoCampaign.total > 0) {
    return censoCampaign.total;
  }
  const globalRow = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM asociados WHERE activo = 1',
    [],
    executor,
  );
  return globalRow?.total ?? 0;
}

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const evaluarQuerySchema = z.object({
  cantidad: z.coerce.number().int().min(0),
});

const createActividadSchema = z.object({
  titulo: z.string().trim().min(3).max(180),
  cantidad_comprada: z.number().int().min(0),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const updateActividadSchema = z.object({
  titulo: z.string().trim().min(3).max(180),
  cantidad_comprada: z.number().int().min(0),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  confirmar_deficit: z.boolean().optional(),
});

const cerrarActividadSchema = z.object({
  confirmacion: z.literal('CERRAR_CAMPAÑA'),
  observacion: z.string().trim().max(500).optional(),
});

export const actividadesRouter = Router();

actividadesRouter.get(
  '/',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  async (_req, res) => {
    const rows = await queryRows<ActividadRow>(
      `SELECT id, titulo, cantidad_comprada, saldo_disponible, total_entregados,
              estado, fecha_inicio, fecha_fin, creado_por, created_at
       FROM actividades
       ORDER BY id DESC`,
    );
    res.json({ actividades: rows });
  },
);

actividadesRouter.get('/activa', authMiddleware, async (_req, res) => {
  const act = await queryOne<ActividadRow>(
    `SELECT id, titulo, cantidad_comprada, saldo_disponible, total_entregados,
            estado, fecha_inicio, fecha_fin
     FROM actividades
     WHERE estado = 'ACTIVA'
     LIMIT 1`,
  );

  if (!act) {
    throw new AppError(404, 'NOT_FOUND', 'No existe ninguna campaña activa en este momento.');
  }

  const today = getBogotaDate();
  const hoyRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
     FROM entregas
     WHERE actividad_id = ? AND fecha_entrega = ? AND estado = 'ENTREGADO'`,
    [act.id, today],
  );

  const asociadosActivos = await countAsociadosBase(act.id);

  const porSede = await queryRows<SedeBreakdownRow>(
    `SELECT s.id AS sede_id, s.codigo, s.nombre, COUNT(e.id) AS entregados
     FROM sedes s
     LEFT JOIN entregas e ON e.sede_id = s.id AND e.actividad_id = ? AND e.estado = 'ENTREGADO'
     WHERE s.activa = 1
     GROUP BY s.id, s.codigo, s.nombre
     ORDER BY s.nombre ASC`,
    [act.id],
  );

  res.json({
    id: act.id,
    titulo: act.titulo,
    estado: act.estado,
    cantidad_comprada: act.cantidad_comprada,
    total_entregados: act.total_entregados,
    saldo_disponible: act.saldo_disponible,
    entregados_hoy: hoyRow?.total ?? 0,
    asociados_activos_base: asociadosActivos,
    fecha_inicio: act.fecha_inicio,
    fecha_fin: act.fecha_fin,
    por_sede: porSede,
  });
});

actividadesRouter.get(
  '/:id/evaluar-cobertura',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema, query: evaluarQuerySchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const { cantidad } = req.validated!.query as z.infer<typeof evaluarQuerySchema>;

    const act = await queryOne<ActividadRow>('SELECT id FROM actividades WHERE id = ? LIMIT 1', [id]);
    if (!act) {
      throw new AppError(404, 'NOT_FOUND', 'Campaña no encontrada.');
    }

    const asociadosActivos = await countAsociadosBase(id);
    const diferencia = cantidad - asociadosActivos;

    let tipoAlerta: 'DEFICIT' | 'SUPERAVIT' | 'OPTIMA' = 'OPTIMA';
    let mensaje = `Cobertura óptima: La cantidad cubre exactamente el 100% de los asociados (${asociadosActivos}).`;

    if (diferencia < 0) {
      tipoAlerta = 'DEFICIT';
      mensaje = `Alerta de cobertura: Se están ingresando ${cantidad} obsequios para ${asociadosActivos} asociados activos. Faltarán ${Math.abs(diferencia)} obsequios para cubrir la totalidad del censo.`;
    } else if (diferencia > 0) {
      tipoAlerta = 'SUPERAVIT';
      mensaje = `Aviso de inventario: Se están ingresando ${cantidad} obsequios para ${asociadosActivos} asociados. Quedará un excedente de ${diferencia} obsequios.`;
    }

    res.json({
      cantidad_ingresada: cantidad,
      asociados_activos: asociadosActivos,
      diferencia,
      tipo_alerta: tipoAlerta,
      requiere_confirmacion: diferencia < 0,
      mensaje,
    });
  },
);

actividadesRouter.post(
  '/',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ body: createActividadSchema }),
  async (req, res) => {
    const body = req.body as z.infer<typeof createActividadSchema>;

    const result = await executeSql(
      `INSERT INTO actividades
        (titulo, cantidad_comprada, saldo_disponible, total_entregados, estado, fecha_inicio, creado_por)
       VALUES (?, ?, ?, 0, 'BORRADOR', ?, ?)`,
      [body.titulo, body.cantidad_comprada, body.cantidad_comprada, body.fecha_inicio ?? null, req.user!.id],
    );

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: 'CREAR_ACTIVIDAD',
      tabla_afectada: 'actividades',
      registro_id: result.insertId,
      detalle_operacion: { ...body, estado: 'BORRADOR' },
      forensic: req.forensic,
    });

    res.status(201).json({
      id: result.insertId,
      titulo: body.titulo,
      cantidad_comprada: body.cantidad_comprada,
      saldo_disponible: body.cantidad_comprada,
      total_entregados: 0,
      estado: 'BORRADOR',
      fecha_inicio: body.fecha_inicio ?? null,
    });
  },
);

actividadesRouter.put(
  '/:id',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  campaignLockMiddleware(),
  validateRequest({ params: idParamsSchema, body: updateActividadSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const body = req.body as z.infer<typeof updateActividadSchema>;

    const updated = await withTransaction(async (conn) => {
      const act = await queryOne<ActividadRow>(
        'SELECT id, titulo, cantidad_comprada, saldo_disponible, total_entregados, estado FROM actividades WHERE id = ? FOR UPDATE',
        [id],
        conn,
      );
      if (!act) {
        throw new AppError(404, 'NOT_FOUND', 'Campaña no encontrada.');
      }
      if (act.estado === 'CERRADA') {
        throw new AppError(403, 'CAMPAIGN_CLOSED', 'La campaña está cerrada.');
      }
      if (body.cantidad_comprada < act.total_entregados) {
        throw new AppError(
          422,
          'INVALID_STOCK',
          `La cantidad comprada (${body.cantidad_comprada}) no puede ser menor al total ya entregado (${act.total_entregados}).`,
        );
      }

      const asociadosActivos = await countAsociadosBase(id, conn);
      if (body.cantidad_comprada < asociadosActivos && body.confirmar_deficit !== true) {
        throw new AppError(
          409,
          'DEFICIT_CONFIRMATION_REQUIRED',
          `Déficit proyectado: ${body.cantidad_comprada} obsequios para ${asociadosActivos} asociados. Confirme si desea guardar.`,
          { cantidad_comprada: body.cantidad_comprada, asociados_activos: asociadosActivos },
        );
      }

      const nuevoSaldo = body.cantidad_comprada - act.total_entregados;
      await executeSql(
        `UPDATE actividades
         SET titulo = ?, cantidad_comprada = ?, saldo_disponible = ?, fecha_inicio = COALESCE(?, fecha_inicio)
         WHERE id = ?`,
        [body.titulo, body.cantidad_comprada, nuevoSaldo, body.fecha_inicio ?? null, id],
        conn,
      );

      await logGlobalAudit(
        {
          usuario_id: req.user!.id,
          accion: 'CAMBIO_STOCK',
          tabla_afectada: 'actividades',
          registro_id: id,
          detalle_operacion: {
            anterior_cantidad: act.cantidad_comprada,
            nueva_cantidad: body.cantidad_comprada,
            nuevo_saldo: nuevoSaldo,
          },
          forensic: req.forensic,
        },
        conn,
      );

      return {
        id,
        titulo: body.titulo,
        cantidad_comprada: body.cantidad_comprada,
        total_entregados: act.total_entregados,
        saldo_disponible: nuevoSaldo,
        estado: act.estado,
      };
    });

    res.json(updated);
  },
);

actividadesRouter.patch(
  '/:id/activar',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;

    const act = await queryOne<ActividadRow>('SELECT id, estado FROM actividades WHERE id = ? LIMIT 1', [id]);
    if (!act) {
      throw new AppError(404, 'NOT_FOUND', 'Campaña no encontrada.');
    }
    if (act.estado === 'CERRADA') {
      throw new AppError(403, 'CAMPAIGN_CLOSED', 'No se puede reactivar una campaña cerrada.');
    }
    if (act.estado === 'ACTIVA') {
      res.json({ id, estado: 'ACTIVA' });
      return;
    }

    try {
      await executeSql("UPDATE actividades SET estado = 'ACTIVA' WHERE id = ?", [id]);
    } catch (err) {
      const mysqlErr = err as { code?: string };
      if (mysqlErr?.code === 'ER_DUP_ENTRY') {
        throw new AppError(
          409,
          'ACTIVE_CAMPAIGN_EXISTS',
          'Ya existe otra campaña ACTIVA en curso. Debe cerrarla antes de activar una nueva.',
        );
      }
      throw err;
    }

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: 'ACTIVAR_CAMPAÑA',
      tabla_afectada: 'actividades',
      registro_id: id,
      forensic: req.forensic,
    });

    res.json({ id, estado: 'ACTIVA' });
  },
);

actividadesRouter.post(
  '/:id/cerrar',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema, body: cerrarActividadSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const { observacion } = req.body as z.infer<typeof cerrarActividadSchema>;

    const act = await queryOne<ActividadRow>('SELECT id, estado FROM actividades WHERE id = ? LIMIT 1', [id]);
    if (!act) {
      throw new AppError(404, 'NOT_FOUND', 'Campaña no encontrada.');
    }
    if (act.estado === 'CERRADA') {
      throw new AppError(403, 'CAMPAIGN_CLOSED', 'La campaña ya fue cerrada.');
    }

    const importEnCurso = await queryOne<RowDataPacket>(
      "SELECT id FROM importaciones_excel WHERE actividad_id = ? AND estado = 'PROCESANDO' LIMIT 1",
      [id],
    );
    if (importEnCurso) {
      throw new AppError(
        409,
        'IMPORT_IN_PROGRESS',
        'No se puede cerrar la campaña mientras existe una importación de Excel en procesamiento.',
      );
    }

    const fechaFin = getBogotaDate();
    await executeSql("UPDATE actividades SET estado = 'CERRADA', fecha_fin = ? WHERE id = ?", [
      fechaFin,
      id,
    ]);

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: 'CIERRE_CAMPAÑA',
      tabla_afectada: 'actividades',
      registro_id: id,
      detalle_operacion: { observacion: observacion ?? null, fecha_fin: fechaFin },
      forensic: req.forensic,
    });

    res.json({ id, estado: 'CERRADA', fecha_fin: fechaFin });
  },
);

