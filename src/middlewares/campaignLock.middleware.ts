import { NextFunction, Request, Response } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { DbExecutor, pool, queryOne } from '../core/database/mysql.js';
import { AppError } from '../core/errors/AppError.js';

interface ActivityStateRow extends RowDataPacket {
  id: number;
  estado: 'BORRADOR' | 'ACTIVA' | 'CERRADA';
}

export async function assertCampaignNotClosed(
  actividadId: number,
  executor: DbExecutor = pool,
): Promise<ActivityStateRow> {
  const row = await queryOne<ActivityStateRow>(
    'SELECT id, estado FROM actividades WHERE id = ? LIMIT 1',
    [actividadId],
    executor,
  );
  if (!row) {
    throw new AppError(404, 'NOT_FOUND', 'La campaña especificada no existe.');
  }
  if (row.estado === 'CERRADA') {
    throw new AppError(
      403,
      'CAMPAIGN_CLOSED',
      'La campaña se encuentra CERRADA en modo solo lectura; no se permiten modificaciones.',
    );
  }
  return row;
}

/**
 * Middleware de bloqueo de campaña (RF-14).
 * Excluye explícitamente la generación de reportes y rutas de autenticación.
 */
export function campaignLockMiddleware(
  resolveActividadId?: (req: Request) => Promise<number | null> | number | null,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const fullPath = `${req.baseUrl}${req.path}`;
    if (fullPath.startsWith('/api/v1/reportes/generar') || fullPath.startsWith('/api/v1/auth/')) {
      next();
      return;
    }

    let actividadId: number | null = null;
    if (resolveActividadId) {
      actividadId = await resolveActividadId(req);
    } else if (req.body && typeof req.body.actividad_id === 'number') {
      actividadId = req.body.actividad_id;
    } else if (req.params?.id && req.baseUrl.endsWith('/actividades')) {
      const parsed = Number(req.params.id);
      if (Number.isInteger(parsed) && parsed > 0) {
        actividadId = parsed;
      }
    }

    if (actividadId !== null) {
      await assertCampaignNotClosed(actividadId);
    }

    next();
  };
}

