import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { CookieOptions, Router } from 'express';
import jwt from 'jsonwebtoken';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { logGlobalAudit } from '../../core/audit/audit.service.js';
import { cacheService } from '../../core/cache/redis.js';
import { env } from '../../core/config/env.js';
import { executeSql, queryOne } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { getBogotaDateTime } from '../../core/utils/timezone.js';
import { AccessTokenPayload, authMiddleware, UserRole } from '../../middlewares/auth.middleware.js';
import { loginRateLimiter } from '../../middlewares/rateLimit.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';

interface UsuarioLoginRow extends RowDataPacket {
  id: number;
  username: string;
  nombre: string;
  email: string | null;
  password_hash: string;
  rol: UserRole;
  debe_cambiar_clave: number;
  sede_id: number | null;
  activo: number;
  sede_codigo: string | null;
  sede_nombre: string | null;
  sede_activa: number | null;
}

interface RefreshTokenPayload {
  sub: number;
  jti: string;
  access_jti: string;
  type: 'refresh';
}

interface ActividadResumenRow extends RowDataPacket {
  id: number;
  titulo: string;
  estado: string;
}

const REFRESH_COOKIE_NAME = 'cemcop_refresh_token';

function getRefreshCookieOptions(): CookieOptions {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    path: '/api/v1/auth',
    maxAge: env.JWT_REFRESH_TTL_SECONDS * 1000,
  };
}

async function issueTokenPair(user: {
  id: number;
  rol: UserRole;
  sede_id: number | null;
  debe_cambiar_clave: boolean;
}) {
  const accessJti = crypto.randomUUID();
  const refreshJti = crypto.randomUUID();

  const accessPayload: AccessTokenPayload = {
    sub: user.id,
    rol: user.rol,
    sede_id: user.sede_id,
    debe_cambiar_clave: user.debe_cambiar_clave,
    jti: accessJti,
    type: 'access',
  };

  const refreshPayload: RefreshTokenPayload = {
    sub: user.id,
    jti: refreshJti,
    access_jti: accessJti,
    type: 'refresh',
  };

  const accessToken = jwt.sign(accessPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });

  const refreshToken = jwt.sign(refreshPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL_SECONDS,
  });

  await cacheService.saveSession(
    accessJti,
    {
      usuario_id: user.id,
      rol: user.rol,
      debe_cambiar_clave: user.debe_cambiar_clave,
      refresh_jti: refreshJti,
    },
    env.JWT_REFRESH_TTL_SECONDS,
  );

  await cacheService.set(
    `refresh_session:${refreshJti}`,
    JSON.stringify({ usuario_id: user.id, access_jti: accessJti }),
    env.JWT_REFRESH_TTL_SECONDS,
  );

  return { accessToken, refreshToken, accessJti, refreshJti };
}

const loginSchema = z.object({
  username: z.string().trim().min(2).max(60),
  password: z.string().min(1).max(128),
});

const changePasswordSchema = z.object({
  password_actual: z.string().min(1),
  password_nueva: z
    .string()
    .min(8, 'La nueva contraseña debe tener al menos 8 caracteres.')
    .max(128),
});

export const authRouter = Router();

authRouter.post(
  '/login',
  loginRateLimiter,
  validateRequest({ body: loginSchema }),
  async (req, res) => {
    const { username, password } = req.body as z.infer<typeof loginSchema>;

    const user = await queryOne<UsuarioLoginRow>(
      `SELECT u.id, u.username, u.nombre, u.email, u.password_hash, u.rol,
              u.debe_cambiar_clave, u.sede_id, u.activo,
              s.codigo AS sede_codigo, s.nombre AS sede_nombre, s.activa AS sede_activa
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       WHERE u.username = ?
       LIMIT 1`,
      [username],
    );

    if (!user || user.activo !== 1) {
      await logGlobalAudit({
        usuario_id: user?.id ?? null,
        accion: 'LOGIN_FALLIDO',
        tabla_afectada: 'usuarios',
        registro_id: user?.id ?? null,
        detalle_operacion: { username, razon: 'USUARIO_INACTIVO_O_INEXISTENTE' },
        forensic: req.forensic,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      await logGlobalAudit({
        usuario_id: user.id,
        accion: 'LOGIN_FALLIDO',
        tabla_afectada: 'usuarios',
        registro_id: user.id,
        detalle_operacion: { username, razon: 'CLAVE_INCORRECTA' },
        forensic: req.forensic,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
    }

    if (user.rol === 'REPARTIDOR' && (!user.sede_id || user.sede_activa !== 1)) {
      throw new AppError(
        403,
        'SEDE_INACTIVE',
        'Su sede asignada está inactiva o no configurada. Contacte al Super Admin.',
      );
    }

    const mustChange = user.debe_cambiar_clave === 1;
    await executeSql('UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?', [
      getBogotaDateTime(),
      user.id,
    ]);

    const { accessToken, refreshToken } = await issueTokenPair({
      id: user.id,
      rol: user.rol,
      sede_id: user.sede_id,
      debe_cambiar_clave: mustChange,
    });

    await logGlobalAudit({
      usuario_id: user.id,
      accion: 'LOGIN',
      tabla_afectada: 'usuarios',
      registro_id: user.id,
      detalle_operacion: { rol: user.rol, sede_id: user.sede_id },
      forensic: req.forensic,
    });

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, getRefreshCookieOptions());
    res.json({
      access_token: accessToken,
      expires_in: env.JWT_ACCESS_TTL_SECONDS,
      debe_cambiar_clave: mustChange,
      usuario: {
        id: user.id,
        username: user.username,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        sede: user.sede_id
          ? { id: user.sede_id, codigo: user.sede_codigo, nombre: user.sede_nombre }
          : null,
      },
    });
  },
);

authRouter.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!token) {
    throw new AppError(401, 'SESSION_EXPIRED', 'No se encontró token de actualización.');
  }

  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as unknown as RefreshTokenPayload;
  } catch {
    throw new AppError(401, 'SESSION_EXPIRED', 'La sesión ha expirado. Inicie sesión nuevamente.');
  }

  if (decoded.type !== 'refresh' || !decoded.jti) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Token de actualización inválido.');
  }

  // Ventana de gracia de 10s para peticiones concurrentes desde múltiples pestañas
  const graceHit = await cacheService.getRefreshGrace<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    debe_cambiar_clave: boolean;
  }>(decoded.jti);

  if (graceHit) {
    res.cookie(REFRESH_COOKIE_NAME, graceHit.refresh_token, getRefreshCookieOptions());
    res.json({
      access_token: graceHit.access_token,
      expires_in: graceHit.expires_in,
      debe_cambiar_clave: graceHit.debe_cambiar_clave,
    });
    return;
  }

  const stored = await cacheService.get(`refresh_session:${decoded.jti}`);
  if (!stored) {
    throw new AppError(401, 'SESSION_EXPIRED', 'La sesión fue cerrada o revocada.');
  }

  const user = await queryOne<UsuarioLoginRow>(
    `SELECT u.id, u.username, u.nombre, u.email, u.rol, u.debe_cambiar_clave, u.sede_id, u.activo,
            s.activa AS sede_activa
     FROM usuarios u
     LEFT JOIN sedes s ON s.id = u.sede_id
     WHERE u.id = ?
     LIMIT 1`,
    [decoded.sub],
  );

  if (!user || user.activo !== 1) {
    await cacheService.revokeAllUserSessions(decoded.sub);
    throw new AppError(401, 'SESSION_EXPIRED', 'Usuario inactivo.');
  }

  if (user.rol === 'REPARTIDOR' && (!user.sede_id || user.sede_activa !== 1)) {
    throw new AppError(403, 'SEDE_INACTIVE', 'La sede asignada está inactiva.');
  }

  await cacheService.del(`refresh_session:${decoded.jti}`);
  if (decoded.access_jti) {
    await cacheService.removeSession(decoded.access_jti, user.id);
  }

  const mustChange = user.debe_cambiar_clave === 1;
  const { accessToken, refreshToken } = await issueTokenPair({
    id: user.id,
    rol: user.rol,
    sede_id: user.sede_id,
    debe_cambiar_clave: mustChange,
  });

  await cacheService.setRefreshGrace(decoded.jti, {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: env.JWT_ACCESS_TTL_SECONDS,
    debe_cambiar_clave: mustChange,
  });

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, getRefreshCookieOptions());
  res.json({
    access_token: accessToken,
    expires_in: env.JWT_ACCESS_TTL_SECONDS,
    debe_cambiar_clave: mustChange,
  });
});

authRouter.post('/logout', authMiddleware, async (req, res) => {
  const user = req.user!;
  const session = await cacheService.getSession(user.jti);
  if (session?.refresh_jti) {
    await cacheService.del(`refresh_session:${session.refresh_jti}`);
  }
  await cacheService.removeSession(user.jti, user.id);

  await logGlobalAudit({
    usuario_id: user.id,
    accion: 'LOGOUT',
    tabla_afectada: 'usuarios',
    registro_id: user.id,
    forensic: req.forensic,
  });

  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  res.json({ ok: true });
});

authRouter.post(
  '/cambiar-clave-inicial',
  authMiddleware,
  validateRequest({ body: changePasswordSchema }),
  async (req, res) => {
    const user = req.user!;
    const { password_actual, password_nueva } = req.body as z.infer<typeof changePasswordSchema>;

    if (password_actual === password_nueva) {
      throw new AppError(400, 'VALIDATION_ERROR', 'La nueva contraseña debe ser diferente a la temporal.');
    }

    const row = await queryOne<UsuarioLoginRow>(
      'SELECT id, password_hash, rol, sede_id FROM usuarios WHERE id = ? LIMIT 1',
      [user.id],
    );
    if (!row || !(await bcrypt.compare(password_actual, row.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'La contraseña actual no es correcta.');
    }

    const newHash = await bcrypt.hash(password_nueva, 10);
    await executeSql('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0 WHERE id = ?', [
      newHash,
      user.id,
    ]);

    const prevSession = await cacheService.getSession(user.jti);
    if (prevSession?.refresh_jti) {
      await cacheService.del(`refresh_session:${prevSession.refresh_jti}`);
    }
    await cacheService.removeSession(user.jti, user.id);

    // Re-emitir nuevo JWT con debe_cambiar_clave: false para evitar bloqueo
    const { accessToken, refreshToken } = await issueTokenPair({
      id: user.id,
      rol: row.rol,
      sede_id: row.sede_id,
      debe_cambiar_clave: false,
    });

    await logGlobalAudit({
      usuario_id: user.id,
      accion: 'CAMBIO_CLAVE_INICIAL',
      tabla_afectada: 'usuarios',
      registro_id: user.id,
      forensic: req.forensic,
    });

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, getRefreshCookieOptions());
    res.json({
      access_token: accessToken,
      expires_in: env.JWT_ACCESS_TTL_SECONDS,
      debe_cambiar_clave: false,
      message: 'Contraseña actualizada correctamente.',
    });
  },
);

authRouter.post(
  '/cambiar-clave',
  authMiddleware,
  validateRequest({ body: changePasswordSchema }),
  async (req, res) => {
    const user = req.user!;
    const { password_actual, password_nueva } = req.body as z.infer<typeof changePasswordSchema>;

    const row = await queryOne<UsuarioLoginRow>(
      'SELECT id, password_hash FROM usuarios WHERE id = ? LIMIT 1',
      [user.id],
    );
    if (!row || !(await bcrypt.compare(password_actual, row.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'La contraseña actual no es correcta.');
    }

    const newHash = await bcrypt.hash(password_nueva, 10);
    await executeSql('UPDATE usuarios SET password_hash = ? WHERE id = ?', [newHash, user.id]);

    await logGlobalAudit({
      usuario_id: user.id,
      accion: 'CAMBIO_CLAVE',
      tabla_afectada: 'usuarios',
      registro_id: user.id,
      forensic: req.forensic,
    });

    res.json({ ok: true, message: 'Contraseña actualizada exitosamente.' });
  },
);

authRouter.get('/me', authMiddleware, async (req, res) => {
  const user = req.user!;
  const actividadActiva = await queryOne<ActividadResumenRow>(
    "SELECT id, titulo, estado FROM actividades WHERE estado = 'ACTIVA' LIMIT 1",
  );

  res.json({
    usuario: {
      id: user.id,
      username: user.username,
      nombre: user.nombre,
      email: user.email,
      rol: user.rol,
      debe_cambiar_clave: user.debe_cambiar_clave,
      sede: user.sede_id
        ? { id: user.sede_id, codigo: user.sede_codigo, nombre: user.sede_nombre }
        : null,
    },
    campana_activa: actividadActiva,
  });
});

