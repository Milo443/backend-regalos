import { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { queryOne, queryRows } from '../../core/database/mysql.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';

interface AuditoriaLogRow extends RowDataPacket {
  id: number;
  usuario_id: number | null;
  usuario_nombre: string | null;
  usuario_username: string | null;
  accion: string;
  tabla_afectada: string | null;
  registro_id: number | null;
  detalle_operacion: string | null;
  ip_origen: string;
  user_agent: string | null;
  created_at: string;
}

const logsQuerySchema = z.object({
  usuario_id: z.coerce.number().int().positive().optional(),
  accion: z.string().trim().max(80).optional(),
  fecha_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fecha_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ip_origen: z.string().trim().max(45).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const auditoriaRouter = Router();

auditoriaRouter.get(
  '/logs',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  validateRequest({ query: logsQuerySchema }),
  async (req, res) => {
    const { usuario_id, accion, fecha_desde, fecha_hasta, ip_origen, page, limit } = req.validated!
      .query as z.infer<typeof logsQuerySchema>;

    const where: string[] = [];
    const params: unknown[] = [];

    if (usuario_id) {
      where.push('l.usuario_id = ?');
      params.push(usuario_id);
    }
    if (accion) {
      where.push('l.accion = ?');
      params.push(accion);
    }
    if (fecha_desde) {
      where.push('DATE(l.created_at) >= ?');
      params.push(fecha_desde);
    }
    if (fecha_hasta) {
      where.push('DATE(l.created_at) <= ?');
      params.push(fecha_hasta);
    }
    if (ip_origen) {
      where.push('l.ip_origen = ?');
      params.push(ip_origen);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM auditoria_logs l ${whereSql}`,
      params,
    );

    const rows = await queryRows<AuditoriaLogRow>(
      `SELECT l.id, l.usuario_id, u.nombre AS usuario_nombre, u.username AS usuario_username,
              l.accion, l.tabla_afectada, l.registro_id, l.detalle_operacion,
              l.ip_origen, l.user_agent, l.created_at
       FROM auditoria_logs l
       LEFT JOIN usuarios u ON u.id = l.usuario_id
       ${whereSql}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    res.json({
      total: countRow?.total ?? 0,
      page,
      limit,
      logs: rows,
    });
  },
);

