import { NextFunction, Request, Response } from 'express';
import { cacheService } from '../core/cache/redis.js';
import { AppError } from '../core/errors/AppError.js';

export function createRateLimiter(
  prefix: string,
  maxRequests: number,
  windowSeconds: number,
  keyFn: (req: Request) => string = (req) => req.forensic?.ip_origen ?? req.ip ?? 'unknown',
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const identifier = keyFn(req);
    const key = `rl:${prefix}:${identifier}`;
    const count = await cacheService.incrementRateLimit(key, windowSeconds);

    if (count > maxRequests) {
      throw new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Demasiadas solicitudes en poco tiempo. Por favor intente nuevamente en unos segundos.',
        { retry_after_seconds: windowSeconds },
      );
    }
    next();
  };
}

export const loginRateLimiter = createRateLimiter('login', 10, 60);
export const searchRateLimiter = createRateLimiter(
  'search',
  180,
  60,
  (req) => String(req.user?.id ?? req.forensic?.ip_origen ?? 'anon'),
);
export const apiRateLimiter = createRateLimiter('api', 300, 60);

