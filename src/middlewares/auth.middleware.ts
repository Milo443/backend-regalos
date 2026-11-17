import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { RowDataPacket } from 'mysql2/promise';
import { cacheService } from '../core/cache/redis.js';
import { env } from '../core/config/env.js';
import { queryOne } from '../core/database/mysql.js';
import { AppError } from '../core/errors/AppError.js';

export type UserRole = 'SUPER_ADMIN' | 'ADMINISTRADOR' | 'REPARTIDOR';

export interface AuthenticatedUser {
  id: number;
  username: string;
  nombre: string;
  email: string | null;
  rol: UserRole;
  debe_cambiar_clave: boolean;
  sede_id: number | null;
  sede_codigo: string | null;
  sede_nombre: string | null;
  jti: string;
}

export interface AccessTokenPayload {
  sub: number;
  rol: UserRole;
  sede_id: number | null;
  debe_cambiar_clave: boolean;
  jti: string;
  type: 'access';
}

interface UserAuthRow extends RowDataPacket {
  id: number;
  username: string;
  nombre: string;
  email: string | null;
  rol: UserRole;
  debe_cambiar_clave: number;
  sede_id: number | null;
  activo: number;
  sede_codigo: string | null;
  sede_nombre: string | null;
  sede_activa: number | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED = new Set([
  '/api/v1/auth/cambiar-clave-inicial',
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
]);

export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Token de acceso requerido.');
  }

  const token = authHeader.slice(7).trim();
  let decoded: AccessTokenPayload;

  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as unknown as AccessTokenPayload;
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Token de acceso inválido o expirado.');
  }

  if (decoded.type !== 'access' || !decoded.jti || !decoded.sub) {
    throw new AppError(401, 'UNAUTHORIZED', 'Token de acceso malformado.');
  }

  const session = await cacheService.getSession(decoded.jti);
  if (!session) {
    throw new AppError(401, 'SESSION_EXPIRED', 'La sesión ha expirado o fue revocada.');
  }

  const userRow = await queryOne<UserAuthRow>(
    `SELECT u.id, u.username, u.nombre, u.email, u.rol, u.debe_cambiar_clave, u.sede_id, u.activo,
            s.codigo AS sede_codigo, s.nombre AS sede_nombre, s.activa AS sede_activa
     FROM usuarios u
     LEFT JOIN sedes s ON s.id = u.sede_id
     WHERE u.id = ?
     LIMIT 1`,
    [decoded.sub],
  );

  if (!userRow || userRow.activo !== 1) {
    await cacheService.removeSession(decoded.jti, decoded.sub);
    throw new AppError(401, 'SESSION_EXPIRED', 'Usuario inactivo o no encontrado.');
  }

  if (userRow.rol === 'REPARTIDOR' && (!userRow.sede_id || userRow.sede_activa !== 1)) {
    throw new AppError(
      403,
      'SEDE_INACTIVE',
      'La sede asignada al repartidor está inactiva o no ha sido configurada.',
    );
  }

  const mustChangePassword = userRow.debe_cambiar_clave === 1;
  const fullPath = `${req.baseUrl}${req.path}`.replace(/\/+$/, '');

  if (mustChangePassword && !ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED.has(fullPath)) {
    throw new AppError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'Debe cambiar su contraseña temporal antes de continuar operando en el sistema.',
    );
  }

  req.user = {
    id: userRow.id,
    username: userRow.username,
    nombre: userRow.nombre,
    email: userRow.email,
    rol: userRow.rol,
    debe_cambiar_clave: mustChangePassword,
    sede_id: userRow.sede_id,
    sede_codigo: userRow.sede_codigo,
    sede_nombre: userRow.sede_nombre,
    jti: decoded.jti,
  };

  next();
}

export function roleMiddleware(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Usuario no autenticado.');
    }
    if (!allowedRoles.includes(req.user.rol)) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'No tiene permisos suficientes para ejecutar esta operación.',
        { required_roles: allowedRoles },
      );
    }
    next();
  };
}

