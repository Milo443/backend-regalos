import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { logGlobalAudit } from '../../core/audit/audit.service.js';
import { cacheService } from '../../core/cache/redis.js';
import { executeSql, queryOne, queryRows } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { authMiddleware, roleMiddleware, UserRole } from '../../middlewares/auth.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';

interface UsuarioListRow extends RowDataPacket {
  id: number;
  username: string;
  nombre: string;
  email: string | null;
  rol: UserRole;
  debe_cambiar_clave: number;
  sede_id: number | null;
  sede_nombre: string | null;
  activo: number;
  ultimo_acceso: string | null;
  created_at: string;
}

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const listQuerySchema = z.object({
  rol: z.enum(['SUPER_ADMIN', 'ADMINISTRADOR', 'REPARTIDOR']).optional(),
  sede_id: z.coerce.number().int().positive().optional(),
  activo: z.enum(['0', '1']).optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(60),
  nombre: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(120).optional().nullable(),
  password_temporal: z.string().min(8).max(128),
  rol: z.enum(['SUPER_ADMIN', 'ADMINISTRADOR', 'REPARTIDOR']),
  sede_id: z.number().int().positive().optional().nullable(),
});

const updateUserSchema = z.object({
  nombre: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(120).optional().nullable(),
  rol: z.enum(['SUPER_ADMIN', 'ADMINISTRADOR', 'REPARTIDOR']),
  sede_id: z.number().int().positive().optional().nullable(),
});

const estadoUserSchema = z.object({
  activo: z.boolean(),
});

const resetPasswordSchema = z.object({
  password_temporal: z.string().min(8).max(128),
});

async function assertValidSedeIfRequired(rol: UserRole, sedeId: number | null | undefined): Promise<void> {
  if (rol === 'REPARTIDOR' && !sedeId) {
    throw new AppError(
      422,
      'SEDE_REQUIRED_FOR_REPARTIDOR',
      'Todo usuario con rol REPARTIDOR debe tener una sede activa asignada.',
    );
  }
  if (sedeId) {
    const sede = await queryOne<RowDataPacket>(
      'SELECT id, activa FROM sedes WHERE id = ? LIMIT 1',
      [sedeId],
    );
    if (!sede) {
      throw new AppError(404, 'NOT_FOUND', 'La sede seleccionada no existe.');
    }
    if (rol === 'REPARTIDOR' && Number(sede.activa) !== 1) {
      throw new AppError(403, 'SEDE_INACTIVE', 'No se puede asignar un repartidor a una sede inactiva.');
    }
  }
}

export const usuariosRouter = Router();
usuariosRouter.use(authMiddleware, roleMiddleware('SUPER_ADMIN'));

usuariosRouter.get('/', validateRequest({ query: listQuerySchema }), async (req, res) => {
  const { rol, sede_id, activo, q, page, limit } = req.validated!.query as z.infer<
    typeof listQuerySchema
  >;

  const where: string[] = [];
  const params: unknown[] = [];

  if (rol) {
    where.push('u.rol = ?');
    params.push(rol);
  }
  if (sede_id) {
    where.push('u.sede_id = ?');
    params.push(sede_id);
  }
  if (activo !== undefined) {
    where.push('u.activo = ?');
    params.push(Number(activo));
  }
  if (q) {
    where.push('(u.nombre LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM usuarios u ${whereSql}`,
    params,
  );

  const rows = await queryRows<UsuarioListRow>(
    `SELECT u.id, u.username, u.nombre, u.email, u.rol, u.debe_cambiar_clave,
            u.sede_id, s.nombre AS sede_nombre, u.activo, u.ultimo_acceso, u.created_at
     FROM usuarios u
     LEFT JOIN sedes s ON s.id = u.sede_id
     ${whereSql}
     ORDER BY u.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({
    total: countRow?.total ?? 0,
    page,
    limit,
    usuarios: rows.map((r) => ({
      ...r,
      debe_cambiar_clave: r.debe_cambiar_clave === 1,
      activo: r.activo === 1,
    })),
  });
});

usuariosRouter.post('/', validateRequest({ body: createUserSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof createUserSchema>;

  const existing = await queryOne<RowDataPacket>(
    'SELECT id FROM usuarios WHERE username = ? LIMIT 1',
    [body.username],
  );
  if (existing) {
    throw new AppError(
      409,
      'USERNAME_ALREADY_EXISTS',
      `El username "${body.username}" ya se encuentra registrado.`,
    );
  }

  await assertValidSedeIfRequired(body.rol, body.sede_id);
  const hash = await bcrypt.hash(body.password_temporal, 10);

  const result = await executeSql(
    `INSERT INTO usuarios (username, nombre, email, password_hash, rol, debe_cambiar_clave, sede_id, activo)
     VALUES (?, ?, ?, ?, ?, 1, ?, 1)`,
    [body.username, body.nombre, body.email ?? null, hash, body.rol, body.sede_id ?? null],
  );

  await logGlobalAudit({
    usuario_id: req.user!.id,
    accion: 'CREAR_USUARIO',
    tabla_afectada: 'usuarios',
    registro_id: result.insertId,
    detalle_operacion: { username: body.username, rol: body.rol, sede_id: body.sede_id ?? null },
    forensic: req.forensic,
  });

  res.status(201).json({
    id: result.insertId,
    username: body.username,
    nombre: body.nombre,
    email: body.email ?? null,
    rol: body.rol,
    sede_id: body.sede_id ?? null,
    debe_cambiar_clave: true,
    activo: true,
  });
});

usuariosRouter.put(
  '/:id',
  validateRequest({ params: idParamsSchema, body: updateUserSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const body = req.body as z.infer<typeof updateUserSchema>;

    const prev = await queryOne<RowDataPacket & { rol: UserRole; sede_id: number | null }>(
      'SELECT id, rol, sede_id FROM usuarios WHERE id = ? LIMIT 1',
      [id],
    );
    if (!prev) {
      throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado.');
    }

    await assertValidSedeIfRequired(body.rol, body.sede_id);

    await executeSql('UPDATE usuarios SET nombre = ?, email = ?, rol = ?, sede_id = ? WHERE id = ?', [
      body.nombre,
      body.email ?? null,
      body.rol,
      body.sede_id ?? null,
      id,
    ]);

    if (prev.rol !== body.rol || prev.sede_id !== (body.sede_id ?? null)) {
      await cacheService.revokeAllUserSessions(id);
    }

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: 'ACTUALIZAR_USUARIO',
      tabla_afectada: 'usuarios',
      registro_id: id,
      detalle_operacion: body,
      forensic: req.forensic,
    });

    res.json({ id, ...body });
  },
);

usuariosRouter.patch(
  '/:id/estado',
  validateRequest({ params: idParamsSchema, body: estadoUserSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const { activo } = req.body as z.infer<typeof estadoUserSchema>;

    const existing = await queryOne<RowDataPacket>('SELECT id FROM usuarios WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado.');
    }

    await executeSql('UPDATE usuarios SET activo = ? WHERE id = ?', [activo ? 1 : 0, id]);

    if (!activo) {
      await cacheService.revokeAllUserSessions(id);
    }

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: activo ? 'HABILITAR_USUARIO' : 'BLOQUEAR_USUARIO',
      tabla_afectada: 'usuarios',
      registro_id: id,
      detalle_operacion: { activo },
      forensic: req.forensic,
    });

    res.json({ id, activo });
  },
);

usuariosRouter.post(
  '/:id/reset-password',
  validateRequest({ params: idParamsSchema, body: resetPasswordSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const { password_temporal } = req.body as z.infer<typeof resetPasswordSchema>;

    const existing = await queryOne<RowDataPacket>('SELECT id FROM usuarios WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado.');
    }

    const hash = await bcrypt.hash(password_temporal, 10);
    await executeSql('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 1 WHERE id = ?', [
      hash,
      id,
    ]);

    await cacheService.revokeAllUserSessions(id);

    await logGlobalAudit({
      usuario_id: req.user!.id,
      accion: 'RESET_PASSWORD',
      tabla_afectada: 'usuarios',
      registro_id: id,
      forensic: req.forensic,
    });

    res.json({ id, debe_cambiar_clave: true, message: 'Contraseña temporal restablecida.' });
  },
);

