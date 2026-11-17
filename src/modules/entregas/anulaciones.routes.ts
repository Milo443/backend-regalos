import { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { logGlobalAudit } from '../../core/audit/audit.service.js';
import { executeSql, queryOne, queryRows, withTransaction } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { getBogotaDateTime } from '../../core/utils/timezone.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { assertCampaignNotClosed } from '../../middlewares/campaignLock.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';

interface EntregaAnularRow extends RowDataPacket {
  id: number;
  actividad_id: number;
  asociado_id: number;
  estado: 'ENTREGADO' | 'ANULADO';
}

interface AnulacionListRow extends RowDataPacket {
  id: number;
  entrega_id: number;
  asociado_id: number;
  cedula: string;
  nombre_asociado: string;
  admin_id: number;
  admin_nombre: string;
  motivo: string;
  fecha_anulacion: string;
}

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const anularBodySchema = z.object({
  motivo: z.string().trim().min(15, 'El motivo de anulación debe tener al menos 15 caracteres.'),
});

const listQuerySchema = z.object({
  actividad_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const anulacionesRouter = Router();

export async function handleAnularEntrega(
  entregaId: number,
  motivo: string,
  adminId: number,
  forensic: { ip_origen: string; user_agent: string },
) {
  return withTransaction(async (conn) => {
    const entrega = await queryOne<EntregaAnularRow>(
      'SELECT id, actividad_id, asociado_id, estado FROM entregas WHERE id = ? FOR UPDATE',
      [entregaId],
      conn,
    );
    if (!entrega) {
      throw new AppError(404, 'NOT_FOUND', 'Entrega no encontrada.');
    }

    await assertCampaignNotClosed(entrega.actividad_id, conn);

    if (entrega.estado === 'ANULADO') {
      throw new AppError(409, 'ALREADY_CANCELLED', 'Esta entrega ya fue anulada previamente.');
    }

    const act = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM actividades WHERE id = ? FOR UPDATE',
      [entrega.actividad_id],
      conn,
    );
    if (!act) {
      throw new AppError(404, 'NOT_FOUND', 'Campaña asociada no encontrada.');
    }

    const fechaAnulacion = getBogotaDateTime();

    await executeSql("UPDATE entregas SET estado = 'ANULADO' WHERE id = ?", [entregaId], conn);

    await executeSql(
      `INSERT INTO anulaciones (entrega_id, asociado_id, admin_id, motivo, fecha_anulacion)
       VALUES (?, ?, ?, ?, ?)`,
      [entregaId, entrega.asociado_id, adminId, motivo, fechaAnulacion],
      conn,
    );

    await executeSql(
      `UPDATE actividades
       SET saldo_disponible = saldo_disponible + 1,
           total_entregados = total_entregados - 1
       WHERE id = ? AND total_entregados > 0`,
      [entrega.actividad_id],
      conn,
    );

    const updatedAct = await queryOne<RowDataPacket & { saldo_disponible: number }>(
      'SELECT saldo_disponible FROM actividades WHERE id = ? LIMIT 1',
      [entrega.actividad_id],
      conn,
    );

    await logGlobalAudit(
      {
        usuario_id: adminId,
        accion: 'ANULAR_ENTREGA',
        tabla_afectada: 'entregas',
        registro_id: entregaId,
        detalle_operacion: { motivo, asociado_id: entrega.asociado_id },
        forensic,
      },
      conn,
    );

    return {
      entrega_id: entregaId,
      estado: 'ANULADO',
      fecha_anulacion: fechaAnulacion,
      saldo_disponible: updatedAct?.saldo_disponible ?? 0,
      estado_asociado: 'PENDIENTE',
    };
  });
}

anulacionesRouter.post(
  '/entregas/:id/anular',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema, body: anularBodySchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const { motivo } = req.body as z.infer<typeof anularBodySchema>;
    const result = await handleAnularEntrega(id, motivo, req.user!.id, req.forensic);
    res.json(result);
  },
);

anulacionesRouter.get(
  '/anulaciones',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ query: listQuerySchema }),
  async (req, res) => {
    const { actividad_id, q, page, limit } = req.validated!.query as z.infer<
      typeof listQuerySchema
    >;

    const where: string[] = [];
    const params: unknown[] = [];

    if (actividad_id) {
      where.push('e.actividad_id = ?');
      params.push(actividad_id);
    }
    if (q) {
      where.push('(a.cedula LIKE ? OR a.nombre_completo LIKE ? OR an.motivo LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
       FROM anulaciones an
       INNER JOIN entregas e ON e.id = an.entrega_id
       INNER JOIN asociados a ON a.id = an.asociado_id
       ${whereSql}`,
      params,
    );

    const rows = await queryRows<AnulacionListRow>(
      `SELECT an.id, an.entrega_id, an.asociado_id, a.cedula, a.nombre_completo AS nombre_asociado,
              an.admin_id, u.nombre AS admin_nombre, an.motivo, an.fecha_anulacion
       FROM anulaciones an
       INNER JOIN entregas e ON e.id = an.entrega_id
       INNER JOIN asociados a ON a.id = an.asociado_id
       INNER JOIN usuarios u ON u.id = an.admin_id
       ${whereSql}
       ORDER BY an.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    res.json({
      total: countRow?.total ?? 0,
      page,
      limit,
      anulaciones: rows,
    });
  },
);

