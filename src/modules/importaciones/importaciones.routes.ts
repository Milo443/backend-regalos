import express, { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { env } from '../../core/config/env.js';
import { queryOne, queryRows } from '../../core/database/mysql.js';
import { storageProvider } from '../../core/storage/StorageProvider.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { campaignLockMiddleware } from '../../middlewares/campaignLock.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';
import { buildImportKey, processExcelImport } from './importaciones.service.js';

interface ImportacionRow extends RowDataPacket {
  id: number;
  actividad_id: number;
  usuario_id: number;
  usuario_nombre: string;
  nombre_archivo: string;
  total_filas: number;
  total_nuevos: number;
  total_actualizados: number;
  estado: 'PROCESANDO' | 'EXITOSO' | 'FALLIDO' | 'CON_ERRORES';
  log_observaciones: string | null;
  created_at: string;
}

const presignSchema = z.object({
  actividad_id: z.number().int().positive(),
  nombre_archivo: z.string().trim().min(1).max(255),
  content_type: z
    .string()
    .default('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
});

const procesarSchema = z.object({
  actividad_id: z.number().int().positive(),
  s3_key: z.string().trim().min(5).max(500),
  nombre_archivo: z.string().trim().min(1).max(255),
});

const listQuerySchema = z.object({
  actividad_id: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

export const importacionesRouter = Router();
importacionesRouter.use(authMiddleware, roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'));

importacionesRouter.post(
  '/presign',
  validateRequest({ body: presignSchema }),
  campaignLockMiddleware(),
  async (req, res) => {
    const { actividad_id, content_type } = req.body as z.infer<typeof presignSchema>;
    const key = buildImportKey(actividad_id);
    const presigned = await storageProvider.createPresignedUpload(key, content_type, 15 * 1024 * 1024);

    res.json({
      url: presigned.url,
      fields: presigned.fields,
      s3_key: presigned.key,
    });
  },
);

if (env.STORAGE_PROVIDER === 'local') {
  importacionesRouter.post(
    '/local-upload',
    express.raw({ type: '*/*', limit: '16mb' }),
    async (req, res) => {
      const key = String(req.query.key ?? req.header('x-storage-key') ?? '');
      if (!key || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Archivo o key inválido.', details: {} } });
        return;
      }
      await storageProvider.uploadBuffer(
        key,
        req.body,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.status(204).send();
    },
  );
}

importacionesRouter.post(
  '/procesar',
  validateRequest({ body: procesarSchema }),
  campaignLockMiddleware(),
  async (req, res) => {
    const body = req.body as z.infer<typeof procesarSchema>;

    const result = await processExcelImport({
      actividad_id: body.actividad_id,
      s3_key: body.s3_key,
      nombre_archivo: body.nombre_archivo,
      usuario_id: req.user!.id,
      forensic: req.forensic,
    });

    res.json(result);
  },
);

importacionesRouter.get('/', validateRequest({ query: listQuerySchema }), async (req, res) => {
  const { actividad_id, page, limit } = req.validated!.query as z.infer<typeof listQuerySchema>;
  const whereSql = actividad_id ? 'WHERE i.actividad_id = ?' : '';
  const params = actividad_id ? [actividad_id] : [];
  const offset = (page - 1) * limit;

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM importaciones_excel i ${whereSql}`,
    params,
  );

  const rows = await queryRows<ImportacionRow>(
    `SELECT i.id, i.actividad_id, i.usuario_id, u.nombre AS usuario_nombre,
            i.nombre_archivo, i.total_filas, i.total_nuevos, i.total_actualizados,
            i.estado, i.log_observaciones, i.created_at
     FROM importaciones_excel i
     INNER JOIN usuarios u ON u.id = i.usuario_id
     ${whereSql}
     ORDER BY i.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({
    total: countRow?.total ?? 0,
    page,
    limit,
    importaciones: rows,
  });
});

