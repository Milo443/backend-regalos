import * as Sentry from '@sentry/node';
import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../core/config/env.js';
import { AppError } from '../core/errors/AppError.js';

export function errorHandlerMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    const firstIssue = err.issues[0];
    const isMotivoTooShort =
      firstIssue?.path.includes('motivo') && firstIssue.code === 'too_small';

    res.status(400).json({
      error: {
        code: isMotivoTooShort ? 'MOTIVO_TOO_SHORT' : 'VALIDATION_ERROR',
        message: firstIssue?.message ?? 'Error de validación en los datos enviados.',
        details: { issues: err.flatten() },
      },
    });
    return;
  }

  const mysqlErr = err as { code?: string; message?: string };
  if (mysqlErr?.code === 'ER_DUP_ENTRY') {
    res.status(409).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Ya existe un registro duplicado que viola la restricción de unicidad.',
        details: {},
      },
    });
    return;
  }

  if (env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      if (req.user) {
        scope.setUser({ id: String(req.user.id), username: req.user.username });
      }
      scope.setExtra('path', req.originalUrl);
      scope.setExtra('method', req.method);
      Sentry.captureException(err);
    });
  }

  console.error('[UnhandledError]', err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Error interno del servidor. Si persiste, contacte a soporte técnico.',
      details: {},
    },
  });
}

