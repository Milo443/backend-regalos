import { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { logGlobalAudit } from '../../core/audit/audit.service.js';
import { executeSql, queryOne, queryRows } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';

interface SedeRow extends RowDataPacket {
  id: number;
  codigo: string;
  nombre: string;
  direccion: string | null;
  ciudad: string;
  activa: number;
}

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const createSedeSchema = z.object({
  codigo: z.string().trim().min(2).max(20).toUpperCase(),
  nombre: z.string().trim().min(2).max(120),
  direccion: z.string().trim().max(250).optional().nullable(),
  ciudad: z.string().trim().min(2).max(80),
});

const updateSedeSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  direccion: z.string().trim().max(250).optional().nullable(),
  ciudad: z.string().trim().min(2).max(80),
});

const estadoSedeSchema = z.object({
  activa: z.boolean(),
});

export const sedesRouter = Router();

sedesRouter.get('/', authMiddleware, async (req, res) => {
  const user = req.user!;
  const activaQuery = req.query.activa as string | undefined;

  let sql = 'SELECT id, codigo, nombre, direccion, ciudad, activa FROM sedes';
  const params: unknown[] = [];

  if (user.rol !== 'SUPER_ADMIN') {
    sql += ' WHERE activa = 1';
  } else if (activaQuery === '1' || activaQuery === '0') {
    sql += ' WHERE activa = ?';
    params.push(Number(activaQuery));
  }

  sql += ' ORDER BY nombre ASC';
  const rows = await queryRows<SedeRow>(sql, params);

  res.json({
    sedes: rows.map((r) => ({ ...r, activa: r.activa === 1 })),
  });
});

sedesRouter.post(
  '/',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  validateRequest({ body: createSedeSchema }),
  async (req, res) => {
    const body = req.body as z.infer<typeof createSedeSchema>;
    const existing = await queryOne<RowDataPacket>(
      'SELECT id FROM sedes WHERE codigo = ? LIMIT 1',
      [body.codigo],
    );
    if (existing) {
      throw new AppError(409, 'SEDE_CODE_EXISTS', `Ya existe una sede con el código ${body.codigo}.`);
    }

    const result = await executeSql(
      'INSERT INTO sedes (codigo, nombre, direccion, ciudad, activa) VALUES (?, ?, ?, ?, 1)',
      [body.codigo, body.nombre, body.direccion ?? null, body.ciudad],
    );

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: 'CREAR_SEDE',
      tabla_afectada: 'sedes',
      registro_id: result.insertId,
      detalle_operacion: body,
      forensic: req.forensic,
    });

    res.status(201).json({
      id: result.insertId,
      ...body,
      activa: true,
    });
  },
);

sedesRouter.put(
  '/:id',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema, body: updateSedeSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const body = req.body as z.infer<typeof updateSedeSchema>;

    const existing = await queryOne<SedeRow>('SELECT id FROM sedes WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Sede no encontrada.');
    }

    await executeSql('UPDATE sedes SET nombre = ?, direccion = ?, ciudad = ? WHERE id = ?', [
      body.nombre,
      body.direccion ?? null,
      body.ciudad,
      id,
    ]);

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: 'ACTUALIZAR_SEDE',
      tabla_afectada: 'sedes',
      registro_id: id,
      detalle_operacion: body,
      forensic: req.forensic,
    });

    res.json({ id, ...body });
  },
);

sedesRouter.patch(
  '/:id/estado',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema, body: estadoSedeSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const { activa } = req.body as z.infer<typeof estadoSedeSchema>;

    const existing = await queryOne<SedeRow>('SELECT id FROM sedes WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Sede no encontrada.');
    }

    await executeSql('UPDATE sedes SET activa = ? WHERE id = ?', [activa ? 1 : 0, id]);

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: activa ? 'ACTIVAR_SEDE' : 'INACTIVAR_SEDE',
      tabla_afectada: 'sedes',
      registro_id: id,
      detalle_operacion: { activa },
      forensic: req.forensic,
    });

    res.json({ id, activa });
  },
);

