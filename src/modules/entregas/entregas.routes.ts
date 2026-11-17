import { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { cacheService } from '../../core/cache/redis.js';
import { executeSql, queryOne, queryRows, withTransaction } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { queueProvider } from '../../core/queue/QueueProvider.js';
import { storageProvider } from '../../core/storage/StorageProvider.js';
import { validateAndProcessSignature } from '../../core/utils/signature.js';
import { getBogotaDate, getBogotaTime } from '../../core/utils/timezone.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { campaignLockMiddleware } from '../../middlewares/campaignLock.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';
import { sendDeliveryReceiptEmail } from './notifier.service.js';

interface AsociadoEntregaRow extends RowDataPacket {
  id: number;
  cedula: string;
  nombre_completo: string;
  email: string | null;
  activo: number;
}

interface ExistingEntregaRow extends RowDataPacket {
  id: number;
  fecha_entrega: string;
  hora_entrega: string;
  firma_key: string;
}

interface EntregaListRow extends RowDataPacket {
  id: number;
  actividad_id: number;
  asociado_id: number;
  cedula_historica: string;
  nombre_historico: string;
  estado: 'ENTREGADO' | 'ANULADO';
  fecha_entrega: string;
  hora_entrega: string;
  otra_informacion: string | null;
  firma_key: string;
  firma_thumb_key: string | null;
  sede_id: number;
  sede_nombre: string;
  repartidor_id: number;
  repartidor_nombre: string;
}

const createEntregaSchema = z.object({
  actividad_id: z.number().int().positive(),
  asociado_id: z.number().int().positive(),
  firma_base64: z.string().min(30),
  otra_informacion: z.string().trim().max(1000).optional().nullable(),
});

const listEntregasQuerySchema = z.object({
  actividad_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().optional(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sede_id: z.coerce.number().int().positive().optional(),
  estado: z.enum(['ENTREGADO', 'ANULADO']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export const entregasRouter = Router();

entregasRouter.post(
  '/',
  authMiddleware,
  roleMiddleware('REPARTIDOR'),
  validateRequest({ body: createEntregaSchema }),
  campaignLockMiddleware(),
  async (req, res) => {
    const user = req.user!;
    const idempKeyRaw = req.header('x-idempotency-key')?.trim();

    if (!idempKeyRaw || !z.string().uuid().safeParse(idempKeyRaw).success) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Cabecera X-Idempotency-Key (UUIDv4) requerida para registrar la entrega.',
      );
    }

    // 1. Idempotencia ante reintentos por microcortes de red
    const cachedIdemp = await cacheService.getIdempotency<Record<string, unknown>>(
      `entrega:${idempKeyRaw}`,
    );
    if (cachedIdemp) {
      res.status(201).json(cachedIdemp);
      return;
    }

    const body = req.body as z.infer<typeof createEntregaSchema>;

    // 2. Validación real del PNG (detecta firma vacía o toque accidental)
    const { originalBuffer, thumbBuffer } = await validateAndProcessSignature(body.firma_base64);

    // 3. Lock distribuido en Redis
    const lockKey = `lock:entrega:${body.actividad_id}:${body.asociado_id}`;
    const locked = await cacheService.acquireLock(lockKey, 10);
    if (!locked) {
      throw new AppError(
        409,
        'CONCURRENT_DELIVERY_IN_PROGRESS',
        'Otro punto de entrega está procesando este asociado en este momento. Espere unos segundos.',
      );
    }

    const timestamp = Date.now();
    const firmaKey = `firmas/${body.actividad_id}/${body.asociado_id}_${timestamp}.png`;
    const firmaThumbKey = `firmas/${body.actividad_id}/${body.asociado_id}_${timestamp}_thumb.png`;
    let uploadedToStorage = false;

    try {
      // 4. Subida de firma original + miniatura FUERA de la transacción SQL
      await Promise.all([
        storageProvider.uploadBuffer(firmaKey, originalBuffer, 'image/png'),
        storageProvider.uploadBuffer(firmaThumbKey, thumbBuffer, 'image/png'),
      ]);
      uploadedToStorage = true;

      const fechaEntrega = getBogotaDate();
      const horaEntrega = getBogotaTime();

      const txResult = await withTransaction(async (conn) => {
        const act = await queryOne<
          RowDataPacket & { id: number; titulo: string; estado: string; saldo_disponible: number }
        >(
          'SELECT id, titulo, estado, saldo_disponible FROM actividades WHERE id = ? LIMIT 1',
          [body.actividad_id],
          conn,
        );
        if (!act) {
          throw new AppError(404, 'NOT_FOUND', 'Campaña no encontrada.');
        }
        if (act.estado === 'CERRADA') {
          throw new AppError(403, 'CAMPAIGN_CLOSED', 'La campaña está cerrada.');
        }
        if (act.estado !== 'ACTIVA') {
          throw new AppError(409, 'VALIDATION_ERROR', 'La campaña seleccionada no está activa.');
        }

        const asociado = await queryOne<AsociadoEntregaRow>(
          'SELECT id, cedula, nombre_completo, email, activo FROM asociados WHERE id = ? LIMIT 1',
          [body.asociado_id],
          conn,
        );
        if (!asociado || asociado.activo !== 1) {
          throw new AppError(
            409,
            'ASSOCIATE_NOT_ELIGIBLE',
            'El asociado no existe o se encuentra inactivo en el sistema.',
          );
        }

        const censoCount = await queryOne<RowDataPacket & { total: number }>(
          'SELECT COUNT(*) AS total FROM actividad_asociados WHERE actividad_id = ?',
          [body.actividad_id],
          conn,
        );
        if (censoCount && censoCount.total > 0) {
          const enabledInCampaign = await queryOne<RowDataPacket & { habilitado: number }>(
            'SELECT habilitado FROM actividad_asociados WHERE actividad_id = ? AND asociado_id = ? LIMIT 1',
            [body.actividad_id, body.asociado_id],
            conn,
          );
          if (!enabledInCampaign || enabledInCampaign.habilitado !== 1) {
            throw new AppError(
              409,
              'ASSOCIATE_NOT_ELIGIBLE',
              'El asociado no está habilitado en el censo de esta campaña.',
            );
          }
        }

        // Insertar entrega; uq_entrega_activa garantiza atomicidad sin lock temprano en actividades
        let entregaId: number;
        try {
          const insertRes = await executeSql(
            `INSERT INTO entregas
              (actividad_id, asociado_id, repartidor_id, sede_id, cedula_historica, nombre_historico,
               estado, fecha_entrega, hora_entrega, otra_informacion, firma_key, firma_thumb_key, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, 'ENTREGADO', ?, ?, ?, ?, ?, ?)`,
            [
              body.actividad_id,
              asociado.id,
              user.id,
              user.sede_id!,
              asociado.cedula,
              asociado.nombre_completo,
              fechaEntrega,
              horaEntrega,
              body.otra_informacion ?? null,
              firmaKey,
              firmaThumbKey,
              idempKeyRaw,
            ],
            conn,
          );
          entregaId = insertRes.insertId;
        } catch (err) {
          const mysqlErr = err as { code?: string };
          if (mysqlErr?.code === 'ER_DUP_ENTRY') {
            const existing = await queryOne<ExistingEntregaRow>(
              `SELECT id, fecha_entrega, hora_entrega, firma_key
               FROM entregas
               WHERE actividad_id = ? AND asociado_id = ? AND estado = 'ENTREGADO'
               LIMIT 1`,
              [body.actividad_id, body.asociado_id],
              conn,
            );
            const previewUrl = existing?.firma_key
              ? await storageProvider.getPresignedDownloadUrl(existing.firma_key, 300)
              : null;

            throw new AppError(
              409,
              'ALREADY_DELIVERED',
              'Entrega bloqueada: este asociado ya recibió su obsequio.',
              {
                fecha_entrega: existing?.fecha_entrega ?? null,
                hora_entrega: existing?.hora_entrega ?? null,
                firma_preview_url: previewUrl,
              },
            );
          }
          throw err;
        }

        // Descuento atómico al final de la transacción
        const stockRes = await executeSql(
          `UPDATE actividades
           SET saldo_disponible = saldo_disponible - 1,
               total_entregados = total_entregados + 1
           WHERE id = ? AND estado = 'ACTIVA' AND saldo_disponible > 0`,
          [body.actividad_id],
          conn,
        );

        if (stockRes.affectedRows === 0) {
          throw new AppError(
            409,
            'OUT_OF_STOCK',
            'No hay saldo disponible de obsequios en esta campaña.',
          );
        }

        const updatedAct = await queryOne<
          RowDataPacket & { saldo_disponible: number; total_entregados: number }
        >(
          'SELECT saldo_disponible, total_entregados FROM actividades WHERE id = ? LIMIT 1',
          [body.actividad_id],
          conn,
        );

        return {
          entrega_id: entregaId,
          actividad_titulo: act.titulo,
          asociado_nombre: asociado.nombre_completo,
          asociado_email: asociado.email,
          fecha_entrega: fechaEntrega,
          hora_entrega: horaEntrega,
          saldo_disponible: updatedAct?.saldo_disponible ?? 0,
          total_entregados: updatedAct?.total_entregados ?? 0,
        };
      });

      const responsePayload = {
        id: txResult.entrega_id,
        actividad_id: body.actividad_id,
        asociado_id: body.asociado_id,
        estado: 'ENTREGADO',
        fecha_entrega: txResult.fecha_entrega,
        hora_entrega: txResult.hora_entrega,
        saldo_disponible: txResult.saldo_disponible,
        total_entregados: txResult.total_entregados,
      };

      await cacheService.setIdempotency(`entrega:${idempKeyRaw}`, responsePayload, 300);

      // Post-commit asíncrono: solo si el asociado registra correo electrónico
      if (txResult.asociado_email) {
        await queueProvider.publishEmailNotification(
          {
            entrega_id: txResult.entrega_id,
            asociado_nombre: txResult.asociado_nombre,
            asociado_email: txResult.asociado_email,
            actividad_titulo: txResult.actividad_titulo,
            fecha_entrega: txResult.fecha_entrega,
            hora_entrega: txResult.hora_entrega,
            sede_nombre: user.sede_nombre ?? 'Sede CEMCOP',
          },
          sendDeliveryReceiptEmail,
        );
      }

      res.status(201).json(responsePayload);
    } catch (err) {
      if (uploadedToStorage) {
        await Promise.allSettled([
          storageProvider.deleteObject(firmaKey),
          storageProvider.deleteObject(firmaThumbKey),
        ]);
      }
      throw err;
    } finally {
      await cacheService.releaseLock(lockKey);
    }
  },
);

entregasRouter.get(
  '/',
  authMiddleware,
  validateRequest({ query: listEntregasQuerySchema }),
  async (req, res) => {
    const user = req.user!;
    const { actividad_id, q, fecha, sede_id, estado, page, limit } = req.validated!.query as z.infer<
      typeof listEntregasQuerySchema
    >;

    const where: string[] = [];
    const params: unknown[] = [];

    if (actividad_id) {
      where.push('e.actividad_id = ?');
      params.push(actividad_id);
    }
    if (user.rol === 'REPARTIDOR') {
      where.push('e.repartidor_id = ?');
      params.push(user.id);
    } else if (sede_id) {
      where.push('e.sede_id = ?');
      params.push(sede_id);
    }
    if (fecha) {
      where.push('e.fecha_entrega = ?');
      params.push(fecha);
    }
    if (estado) {
      where.push('e.estado = ?');
      params.push(estado);
    }
    if (q) {
      where.push('(e.cedula_historica LIKE ? OR a.cedula LIKE ? OR e.nombre_historico LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
       FROM entregas e
       INNER JOIN asociados a ON a.id = e.asociado_id
       ${whereSql}`,
      params,
    );

    const rows = await queryRows<EntregaListRow>(
      `SELECT e.id, e.actividad_id, e.asociado_id, e.cedula_historica, e.nombre_historico,
              e.estado, e.fecha_entrega, e.hora_entrega, e.otra_informacion,
              e.firma_key, e.firma_thumb_key, e.sede_id, s.nombre AS sede_nombre,
              e.repartidor_id, u.nombre AS repartidor_nombre
       FROM entregas e
       INNER JOIN asociados a ON a.id = e.asociado_id
       INNER JOIN sedes s ON s.id = e.sede_id
       INNER JOIN usuarios u ON u.id = e.repartidor_id
       ${whereSql}
       ORDER BY e.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    res.json({
      total: countRow?.total ?? 0,
      page,
      limit,
      entregas: rows.map((r) => ({
        id: r.id,
        actividad_id: r.actividad_id,
        asociado_id: r.asociado_id,
        cedula_historica: r.cedula_historica,
        nombre_historico: r.nombre_historico,
        estado: r.estado,
        fecha_entrega: r.fecha_entrega,
        hora_entrega: r.hora_entrega,
        otra_informacion: r.otra_informacion,
        sede: { id: r.sede_id, nombre: r.sede_nombre },
        repartidor: { id: r.repartidor_id, nombre: r.repartidor_nombre },
        tiene_firma: Boolean(r.firma_key),
      })),
    });
  },
);

entregasRouter.get(
  '/:id/firma',
  authMiddleware,
  validateRequest({ params: idParamsSchema }),
  async (req, res) => {
    const user = req.user!;
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;

    const row = await queryOne<RowDataPacket & { id: number; repartidor_id: number; firma_key: string }>(
      'SELECT id, repartidor_id, firma_key FROM entregas WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', 'Entrega no encontrada.');
    }
    if (user.rol === 'REPARTIDOR' && row.repartidor_id !== user.id) {
      throw new AppError(403, 'FORBIDDEN', 'No tiene permiso para consultar esta firma.');
    }

    const url = await storageProvider.getPresignedDownloadUrl(row.firma_key, 300);
    res.json({ entrega_id: row.id, firma_preview_url: url });
  },
);

entregasRouter.get(
  '/mi-turno',
  authMiddleware,
  roleMiddleware('REPARTIDOR'),
  async (req, res) => {
    const user = req.user!;
    const today = getBogotaDate();

    const countRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
       FROM entregas
       WHERE repartidor_id = ? AND fecha_entrega = ? AND estado = 'ENTREGADO'`,
      [user.id, today],
    );

    const ultimas = await queryRows<EntregaListRow>(
      `SELECT e.id, e.actividad_id, e.asociado_id, e.cedula_historica, e.nombre_historico,
              e.estado, e.fecha_entrega, e.hora_entrega, e.otra_informacion
       FROM entregas e
       WHERE e.repartidor_id = ? AND e.fecha_entrega = ?
       ORDER BY e.id DESC
       LIMIT 10`,
      [user.id, today],
    );

    res.json({
      fecha: today,
      sede: user.sede_id
        ? { id: user.sede_id, codigo: user.sede_codigo, nombre: user.sede_nombre }
        : null,
      entregados_hoy: countRow?.total ?? 0,
      ultimas_entregas: ultimas,
    });
  },
);

