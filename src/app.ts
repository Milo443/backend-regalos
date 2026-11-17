import * as Sentry from '@sentry/node';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { cacheService } from './core/cache/redis.js';
import { env } from './core/config/env.js';
import { checkDbHealth } from './core/database/mysql.js';
import { AppError } from './core/errors/AppError.js';
import { storageProvider } from './core/storage/StorageProvider.js';
import { authMiddleware } from './middlewares/auth.middleware.js';
import { errorHandlerMiddleware } from './middlewares/error.middleware.js';
import { forensicContextMiddleware } from './middlewares/forensic.middleware.js';
import { apiRateLimiter } from './middlewares/rateLimit.middleware.js';
import { actividadesRouter } from './modules/actividades/actividades.routes.js';
import { asociadosRouter } from './modules/asociados/asociados.routes.js';
import { auditoriaRouter } from './modules/auditoria/auditoria.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { anulacionesRouter } from './modules/entregas/anulaciones.routes.js';
import { entregasRouter } from './modules/entregas/entregas.routes.js';
import { importacionesRouter } from './modules/importaciones/importaciones.routes.js';
import { reportesRouter } from './modules/reportes/reportes.routes.js';
import { sedesRouter } from './modules/sedes/sedes.routes.js';
import { usuariosRouter } from './modules/usuarios/usuarios.routes.js';

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
  });
}

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(
    helmet({
      frameguard: { action: 'sameorigin' },
    }),
  );

  const allowedOrigins = env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
      credentials: true,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(forensicContextMiddleware);
  app.use('/api/v1', apiRateLimiter);

  app.get('/api/v1/health', async (_req, res) => {
    const [dbOk, redisOk] = await Promise.all([checkDbHealth(), cacheService.checkHealth()]);
    const healthy = dbOk && redisOk;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      services: {
        mysql: dbOk ? 'up' : 'down',
        redis: redisOk ? 'up' : 'down',
      },
    });
  });

  if (env.STORAGE_PROVIDER === 'local') {
    app.get('/api/v1/storage/local/:key', authMiddleware, async (req, res) => {
      const key = decodeURIComponent(String(req.params.key ?? ''));
      const buffer = await storageProvider.downloadBuffer(key);
      if (key.endsWith('.xlsx')) {
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      } else {
        res.setHeader('Content-Type', 'image/png');
      }
      res.send(buffer);
    });
  }

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/sedes', sedesRouter);
  app.use('/api/v1/usuarios', usuariosRouter);
  app.use('/api/v1/actividades', actividadesRouter);
  app.use('/api/v1/importaciones', importacionesRouter);
  app.use('/api/v1/asociados', asociadosRouter);
  app.use('/api/v1/entregas', entregasRouter);
  app.use('/api/v1', anulacionesRouter);
  app.use('/api/v1/reportes', reportesRouter);
  app.use('/api/v1/auditoria', auditoriaRouter);

  app.use('/api/v1', () => {
    throw new AppError(404, 'NOT_FOUND', 'Ruta de API no encontrada.');
  });

  app.use(errorHandlerMiddleware);

  return app;
}

export const app = createApp();

