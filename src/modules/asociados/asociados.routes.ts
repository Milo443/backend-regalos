import { Router } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { logAsociadoFieldChange } from '../../core/audit/audit.service.js';
import { executeSql, queryOne, queryRows, withTransaction } from '../../core/database/mysql.js';
import { AppError } from '../../core/errors/AppError.js';
import { storageProvider } from '../../core/storage/StorageProvider.js';
import { normalizeCedula } from '../../core/utils/timezone.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { assertCampaignNotClosed } from '../../middlewares/campaignLock.middleware.js';
import { searchRateLimiter } from '../../middlewares/rateLimit.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';

interface AsociadoSearchRow extends RowDataPacket {
  id: number;
  cedula: string;
  nombre_completo: string;
  email: string | null;
  direccion: string | null;
  fecha_ult_act: string | null;
  observacion: string | null;
  activo: number;
  entrega_id: number | null;
  fecha_entrega: string | null;
  hora_entrega: string | null;
  otra_informacion: string | null;
  firma_key: string | null;
}

interface AsociadoRow extends RowDataPacket {
  id: number;
  cedula: string;
  nombre_completo: string;
  email: string | null;
  direccion: string | null;
  fecha_ult_act: string | null;
  observacion: string | null;
  activo: number;
}

interface AuditoriaFieldRow extends RowDataPacket {
  id: number;
  asociado_id: number;
  usuario_id: number;
  usuario_nombre: string;
  rol_usuario: 'SUPER_ADMIN' | 'ADMINISTRADOR';
  accion: string;
  campo_modificado: string;
  valor_anterior: string | null;
  valor_nuevo: string | null;
  motivo: string | null;
  ip_origen: string;
  fecha_cambio: string;
}

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const buscarQuerySchema = z.object({
  q: z.string().trim().min(1),
  actividad_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(25).default(10),
});

const getByIdQuerySchema = z.object({
  actividad_id: z.coerce.number().int().positive().optional(),
});

const createAsociadoSchema = z.object({
  cedula: z.string().trim().min(4).max(25),
  nombre_completo: z.string().trim().min(3).max(250),
  email: z.string().trim().email().max(120).optional().nullable(),
  direccion: z.string().trim().max(255).optional().nullable(),
  observacion: z.string().trim().max(2000).optional().nullable(),
  actividad_id: z.number().int().positive().optional(),
});

const patchAsociadoSchema = z.object({
  cedula: z.string().optional(),
  nombre_completo: z.string().optional(),
  email: z.string().trim().email().max(120).optional().nullable(),
  direccion: z.string().trim().max(255).optional().nullable(),
  observacion: z.string().trim().max(2000).optional().nullable(),
});

const maestroAsociadoSchema = z.object({
  cedula: z.string().trim().min(4).max(25),
  nombre_completo: z.string().trim().min(3).max(250),
  email: z.string().trim().email().max(120).optional().nullable(),
  direccion: z.string().trim().max(255).optional().nullable(),
  fecha_ult_act: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  observacion: z.string().trim().max(2000).optional().nullable(),
  activo: z.boolean(),
  motivo: z
    .string()
    .trim()
    .min(15, 'El motivo de edición maestra debe tener al menos 15 caracteres.'),
});

async function resolveTargetActividadId(explicitId?: number): Promise<number | null> {
  if (explicitId) return explicitId;
  const active = await queryOne<RowDataPacket & { id: number }>(
    "SELECT id FROM actividades WHERE estado = 'ACTIVA' LIMIT 1",
  );
  return active?.id ?? null;
}

export const asociadosRouter = Router();

asociadosRouter.get(
  '/buscar',
  authMiddleware,
  searchRateLimiter,
  validateRequest({ query: buscarQuerySchema }),
  async (req, res) => {
    const { q, actividad_id, limit } = req.validated!.query as z.infer<typeof buscarQuerySchema>;
    const targetActividadId = await resolveTargetActividadId(actividad_id);

    const isNumeric = /^[0-9.\s-]+$/.test(q);
    if (!isNumeric && q.length < 3) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Para búsquedas por nombre debe ingresar al menos 3 caracteres.',
      );
    }

    const hasCampaignCenso = targetActividadId
      ? await queryOne<RowDataPacket & { total: number }>(
          'SELECT COUNT(*) AS total FROM actividad_asociados WHERE actividad_id = ?',
          [targetActividadId],
        )
      : null;

    const useCampaignFilter = Boolean(targetActividadId && hasCampaignCenso && hasCampaignCenso.total > 0);
    const params: unknown[] = [];

    let joinSql = '';
    if (targetActividadId) {
      params.push(targetActividadId);
      joinSql = `LEFT JOIN entregas e ON e.asociado_id = a.id AND e.actividad_id = ? AND e.estado = 'ENTREGADO'`;
    } else {
      joinSql = `LEFT JOIN entregas e ON 1 = 0`;
    }

    if (useCampaignFilter) {
      params.push(targetActividadId);
      joinSql = `INNER JOIN actividad_asociados aa ON aa.asociado_id = a.id AND aa.actividad_id = ? AND aa.habilitado = 1 ${joinSql}`;
    }

    let filterSql = '';
    if (isNumeric) {
      const cedulaClean = normalizeCedula(q);
      filterSql = '(a.cedula = ? OR a.cedula LIKE CONCAT(?, "%"))';
      params.push(cedulaClean, cedulaClean);
    } else {
      const ftQuery = q
        .split(/\s+/)
        .filter((w) => w.length >= 2)
        .map((w) => `+${w.replace(/[^a-zA-Z0-9]/g, '')}*`)
        .join(' ');
      if (ftQuery) {
        filterSql =
          '(a.nombre_completo LIKE CONCAT(?, "%") OR MATCH(a.nombre_completo) AGAINST(? IN BOOLEAN MODE))';
        params.push(q, ftQuery);
      } else {
        filterSql = 'a.nombre_completo LIKE CONCAT(?, "%")';
        params.push(q);
      }
    }

    params.push(limit);

    const rows = await queryRows<AsociadoSearchRow>(
      `SELECT a.id, a.cedula, a.nombre_completo, a.email, a.direccion, a.fecha_ult_act,
              a.observacion, a.activo,
              e.id AS entrega_id, e.fecha_entrega, e.hora_entrega, e.otra_informacion, e.firma_key
       FROM asociados a
       ${joinSql}
       WHERE a.activo = 1 AND ${filterSql}
       ORDER BY a.nombre_completo ASC
       LIMIT ?`,
      params,
    );

    const resultados = await Promise.all(
      rows.map(async (r) => {
        const entregado = r.entrega_id !== null;
        const firmaPreviewUrl =
          entregado && r.firma_key
            ? await storageProvider.getPresignedDownloadUrl(r.firma_key, 300)
            : null;

        return {
          id: r.id,
          cedula: r.cedula,
          nombre_completo: r.nombre_completo,
          email: r.email,
          direccion: r.direccion,
          fecha_ult_act: r.fecha_ult_act,
          observacion: r.observacion,
          activo: r.activo === 1,
          estado_entrega: entregado ? 'ENTREGADO' : 'PENDIENTE',
          entrega: entregado
            ? {
                id: r.entrega_id,
                fecha_entrega: r.fecha_entrega,
                hora_entrega: r.hora_entrega,
                otra_informacion: r.otra_informacion,
                firma_preview_url: firmaPreviewUrl,
              }
            : null,
        };
      }),
    );

    res.json({ resultados });
  },
);

asociadosRouter.get(
  '/:id',
  authMiddleware,
  validateRequest({ params: idParamsSchema, query: getByIdQuerySchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const { actividad_id } = req.validated!.query as z.infer<typeof getByIdQuerySchema>;
    const targetActividadId = await resolveTargetActividadId(actividad_id);

    const row = await queryOne<AsociadoSearchRow>(
      `SELECT a.id, a.cedula, a.nombre_completo, a.email, a.direccion, a.fecha_ult_act,
              a.observacion, a.activo,
              e.id AS entrega_id, e.fecha_entrega, e.hora_entrega, e.otra_informacion, e.firma_key
       FROM asociados a
       LEFT JOIN entregas e ON e.asociado_id = a.id AND e.actividad_id = ? AND e.estado = 'ENTREGADO'
       WHERE a.id = ?
       LIMIT 1`,
      [targetActividadId ?? 0, id],
    );

    if (!row) {
      throw new AppError(404, 'NOT_FOUND', 'Asociado no encontrado.');
    }

    const entregado = row.entrega_id !== null;
    const firmaPreviewUrl =
      entregado && row.firma_key
        ? await storageProvider.getPresignedDownloadUrl(row.firma_key, 300)
        : null;

    res.json({
      id: row.id,
      cedula: row.cedula,
      nombre_completo: row.nombre_completo,
      email: row.email,
      direccion: row.direccion,
      fecha_ult_act: row.fecha_ult_act,
      observacion: row.observacion,
      activo: row.activo === 1,
      estado_entrega: entregado ? 'ENTREGADO' : 'PENDIENTE',
      entrega: entregado
        ? {
            id: row.entrega_id,
            fecha_entrega: row.fecha_entrega,
            hora_entrega: row.hora_entrega,
            otra_informacion: row.otra_informacion,
            firma_preview_url: firmaPreviewUrl,
          }
        : null,
    });
  },
);

asociadosRouter.post(
  '/',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ body: createAsociadoSchema }),
  async (req, res) => {
    const body = req.body as z.infer<typeof createAsociadoSchema>;
    const cedula = normalizeCedula(body.cedula);
    const targetActividadId = await resolveTargetActividadId(body.actividad_id);

    if (targetActividadId) {
      await assertCampaignNotClosed(targetActividadId);
    }

    const existing = await queryOne<RowDataPacket>(
      'SELECT id FROM asociados WHERE cedula = ? LIMIT 1',
      [cedula],
    );
    if (existing) {
      throw new AppError(
        409,
        'CEDULA_ALREADY_EXISTS',
        `Ya existe un asociado registrado con la cédula ${cedula}.`,
      );
    }

    const newId = await withTransaction(async (conn) => {
      const insertRes = await executeSql(
        `INSERT INTO asociados (cedula, nombre_completo, email, direccion, observacion, activo, creado_por, actualizado_por)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          cedula,
          body.nombre_completo,
          body.email ?? null,
          body.direccion ?? null,
          body.observacion ?? null,
          req.user!.id,
          req.user!.id,
        ],
        conn,
      );

      if (targetActividadId) {
        await executeSql(
          `INSERT INTO actividad_asociados (actividad_id, asociado_id, habilitado)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE habilitado = 1`,
          [targetActividadId, insertRes.insertId],
          conn,
        );
      }

      await logAsociadoFieldChange(
        {
          asociado_id: insertRes.insertId,
          usuario_id: req.user!.id,
          rol_usuario: req.user!.rol as 'SUPER_ADMIN' | 'ADMINISTRADOR',
          accion: 'CREACION',
          campo_modificado: 'registro_completo',
          valor_anterior: null,
          valor_nuevo: JSON.stringify({
            cedula,
            nombre_completo: body.nombre_completo,
            email: body.email ?? null,
            direccion: body.direccion ?? null,
            observacion: body.observacion ?? null,
          }),
          ip_origen: req.forensic.ip_origen,
        },
        conn,
      );

      return insertRes.insertId;
    });

    res.status(201).json({
      id: newId,
      cedula,
      nombre_completo: body.nombre_completo,
      email: body.email ?? null,
      direccion: body.direccion ?? null,
      observacion: body.observacion ?? null,
      activo: true,
    });
  },
);

asociadosRouter.patch(
  '/:id',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema, body: patchAsociadoSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const body = req.body as z.infer<typeof patchAsociadoSchema>;

    if (
      req.user!.rol === 'ADMINISTRADOR' &&
      (body.cedula !== undefined || body.nombre_completo !== undefined)
    ) {
      throw new AppError(
        403,
        'MASTER_FIELDS_LOCKED',
        'El rol ADMINISTRADOR no puede modificar Cédula ni Nombre completo. Use Edición Maestra como SUPER_ADMIN.',
      );
    }

    const activeCampaignId = await resolveTargetActividadId();
    if (activeCampaignId) {
      await assertCampaignNotClosed(activeCampaignId);
    }

    await withTransaction(async (conn) => {
      const prev = await queryOne<AsociadoRow>(
        'SELECT id, email, direccion, observacion FROM asociados WHERE id = ? FOR UPDATE',
        [id],
        conn,
      );
      if (!prev) {
        throw new AppError(404, 'NOT_FOUND', 'Asociado no encontrado.');
      }

      const nextEmail = body.email !== undefined ? body.email : prev.email;
      const nextDir = body.direccion !== undefined ? body.direccion : prev.direccion;
      const nextObs = body.observacion !== undefined ? body.observacion : prev.observacion;

      await executeSql(
        'UPDATE asociados SET email = ?, direccion = ?, observacion = ?, actualizado_por = ? WHERE id = ?',
        [nextEmail, nextDir, nextObs, req.user!.id, id],
        conn,
      );

      const changes: Array<[string, string | null, string | null]> = [];
      if ((prev.email ?? null) !== (nextEmail ?? null)) {
        changes.push(['email', prev.email, nextEmail]);
      }
      if ((prev.direccion ?? null) !== (nextDir ?? null)) {
        changes.push(['direccion', prev.direccion, nextDir]);
      }
      if ((prev.observacion ?? null) !== (nextObs ?? null)) {
        changes.push(['observacion', prev.observacion, nextObs]);
      }

      for (const [campo, antes, despues] of changes) {
        await logAsociadoFieldChange(
          {
            asociado_id: id,
            usuario_id: req.user!.id,
            rol_usuario: req.user!.rol as 'SUPER_ADMIN' | 'ADMINISTRADOR',
            accion: 'MODIF_PARCIAL',
            campo_modificado: campo,
            valor_anterior: antes,
            valor_nuevo: despues,
            ip_origen: req.forensic.ip_origen,
          },
          conn,
        );
      }
    });

    res.json({ ok: true, id });
  },
);

asociadosRouter.put(
  '/:id/maestro',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema, body: maestroAsociadoSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const body = req.body as z.infer<typeof maestroAsociadoSchema>;
    const newCedula = normalizeCedula(body.cedula);

    const activeCampaignId = await resolveTargetActividadId();
    if (activeCampaignId) {
      await assertCampaignNotClosed(activeCampaignId);
    }

    await withTransaction(async (conn) => {
      const prev = await queryOne<AsociadoRow>(
        'SELECT id, cedula, nombre_completo, email, direccion, fecha_ult_act, observacion, activo FROM asociados WHERE id = ? FOR UPDATE',
        [id],
        conn,
      );
      if (!prev) {
        throw new AppError(404, 'NOT_FOUND', 'Asociado no encontrado.');
      }

      if (!body.activo && activeCampaignId) {
        const activeDelivery = await queryOne<RowDataPacket>(
          "SELECT id FROM entregas WHERE actividad_id = ? AND asociado_id = ? AND estado = 'ENTREGADO' LIMIT 1",
          [activeCampaignId, id],
          conn,
        );
        if (activeDelivery) {
          throw new AppError(
            409,
            'ASSOCIATE_HAS_ACTIVE_DELIVERY',
            'No se puede inactivar un asociado que ya tiene una entrega activa en la campaña actual.',
          );
        }
      }

      if (newCedula !== prev.cedula) {
        const dup = await queryOne<RowDataPacket>(
          'SELECT id FROM asociados WHERE cedula = ? AND id <> ? LIMIT 1',
          [newCedula, id],
          conn,
        );
        if (dup) {
          throw new AppError(
            409,
            'CEDULA_ALREADY_EXISTS',
            `Ya existe otro asociado con la cédula ${newCedula}.`,
          );
        }
      }

      await executeSql(
        `UPDATE asociados
         SET cedula = ?, nombre_completo = ?, email = ?, direccion = ?, fecha_ult_act = ?, observacion = ?, activo = ?, actualizado_por = ?
         WHERE id = ?`,
        [
          newCedula,
          body.nombre_completo,
          body.email ?? null,
          body.direccion ?? null,
          body.fecha_ult_act ?? null,
          body.observacion ?? null,
          body.activo ? 1 : 0,
          req.user!.id,
          id,
        ],
        conn,
      );

      // Sincronizar entrega histórica activa en campaña en curso si cambió cédula o nombre
      if (
        activeCampaignId &&
        (prev.cedula !== newCedula || prev.nombre_completo !== body.nombre_completo)
      ) {
        await executeSql(
          `UPDATE entregas
           SET cedula_historica = ?, nombre_historico = ?
           WHERE actividad_id = ? AND asociado_id = ? AND estado = 'ENTREGADO'`,
          [newCedula, body.nombre_completo, activeCampaignId, id],
          conn,
        );
      }

      const comparisons: Array<[string, string | null, string | null]> = [
        ['cedula', prev.cedula, newCedula],
        ['nombre_completo', prev.nombre_completo, body.nombre_completo],
        ['email', prev.email, body.email ?? null],
        ['direccion', prev.direccion, body.direccion ?? null],
        ['fecha_ult_act', prev.fecha_ult_act, body.fecha_ult_act ?? null],
        ['observacion', prev.observacion, body.observacion ?? null],
        ['activo', String(prev.activo === 1), String(body.activo)],
      ];

      for (const [campo, antes, despues] of comparisons) {
        if ((antes ?? null) !== (despues ?? null)) {
          await logAsociadoFieldChange(
            {
              asociado_id: id,
              usuario_id: req.user!.id,
              rol_usuario: 'SUPER_ADMIN',
              accion: 'EDICION_MAESTRA',
              campo_modificado: campo,
              valor_anterior: antes,
              valor_nuevo: despues,
              motivo: body.motivo,
              ip_origen: req.forensic.ip_origen,
            },
            conn,
          );
        }
      }
    });

    res.json({ ok: true, id });
  },
);

asociadosRouter.get(
  '/:id/auditoria',
  authMiddleware,
  roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'),
  validateRequest({ params: idParamsSchema }),
  async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof idParamsSchema>;
    const rows = await queryRows<AuditoriaFieldRow>(
      `SELECT aa.id, aa.asociado_id, aa.usuario_id, u.nombre AS usuario_nombre,
              aa.rol_usuario, aa.accion, aa.campo_modificado, aa.valor_anterior,
              aa.valor_nuevo, aa.motivo, aa.ip_origen, aa.fecha_cambio
       FROM asociados_auditoria aa
       INNER JOIN usuarios u ON u.id = aa.usuario_id
       WHERE aa.asociado_id = ?
       ORDER BY aa.fecha_cambio DESC, aa.id DESC`,
      [id],
    );

    res.json({ historial: rows });
  },
);

