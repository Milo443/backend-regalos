import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { cacheService } from '../../core/cache/redis.js';
import { AppError } from '../../core/errors/AppError.js';
import { queueProvider } from '../../core/queue/QueueProvider.js';
import { storageProvider } from '../../core/storage/StorageProvider.js';
import { getBogotaDate } from '../../core/utils/timezone.js';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware.js';
import { validateRequest } from '../../middlewares/validate.middleware.js';
import { generateExcelReportJob, getControlDiario } from './reportes.service.js';

const controlDiarioQuerySchema = z.object({
  actividad_id: z.coerce.number().int().positive(),
  sede_id: z.coerce.number().int().positive().optional(),
});

const generarSchema = z.object({
  actividad_id: z.number().int().positive(),
  tipo: z.enum(['COMPLETO', 'DIARIO']),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const jobParamsSchema = z.object({
  job_id: z.string().trim().min(5).max(80),
});

export const reportesRouter = Router();
reportesRouter.use(authMiddleware, roleMiddleware('ADMINISTRADOR', 'SUPER_ADMIN'));

reportesRouter.get(
  '/control-diario',
  validateRequest({ query: controlDiarioQuerySchema }),
  async (req, res) => {
    const { actividad_id, sede_id } = req.validated!.query as z.infer<typeof controlDiarioQuerySchema>;
    const result = await getControlDiario(actividad_id, sede_id);
    res.json(result);
  },
);

reportesRouter.post('/generar', validateRequest({ body: generarSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof generarSchema>;
  const jobId = `rep-${crypto.randomUUID()}`;
  const fecha = body.tipo === 'DIARIO' ? (body.fecha ?? getBogotaDate()) : undefined;

  await cacheService.setReportJob(jobId, {
    job_id: jobId,
    estado: 'PENDIENTE',
  });

  await queueProvider.publishReportJob(
    {
      job_id: jobId,
      actividad_id: body.actividad_id,
      tipo: body.tipo,
      fecha,
    },
    generateExcelReportJob,
  );

  res.status(202).json({
    job_id: jobId,
    estado: 'PENDIENTE',
  });
});

reportesRouter.get(
  '/:job_id',
  validateRequest({ params: jobParamsSchema }),
  async (req, res) => {
    const { job_id } = req.validated!.params as z.infer<typeof jobParamsSchema>;
    const job = await cacheService.getReportJob<{
      job_id: string;
      estado: 'PENDIENTE' | 'PROCESANDO' | 'LISTO' | 'FALLIDO';
      s3_key?: string;
      nombre_archivo?: string;
      error?: string;
    }>(job_id);

    if (!job) {
      throw new AppError(404, 'NOT_FOUND', 'El reporte solicitado no existe o expiró.');
    }

    if (job.estado === 'LISTO' && job.s3_key) {
      const downloadUrl = await storageProvider.getPresignedDownloadUrl(job.s3_key, 900);
      res.json({
        job_id: job.job_id,
        estado: job.estado,
        nombre_archivo: job.nombre_archivo,
        download_url: downloadUrl,
      });
      return;
    }

    res.json({
      job_id: job.job_id,
      estado: job.estado,
      error: job.error ?? null,
    });
  },
);

