import { NextFunction, Request, Response } from 'express';
import type { ForensicContext } from '../core/audit/audit.service.js';

declare global {
  namespace Express {
    interface Request {
      forensic: ForensicContext;
    }
  }
}

/**
 * Extrae la IP real desde CloudFront-Viewer-Address o X-Forwarded-For,
 * eliminando corchetes IPv6 y puerto (:puerto) para cumplir con VARCHAR(45).
 */
export function extractCleanIp(rawIp: string | undefined): string {
  if (!rawIp) return '0.0.0.0';

  const first = rawIp.split(',')[0]?.trim() ?? '';
  if (!first) return '0.0.0.0';

  // Formato [2001:db8::1]:54321
  const ipv6BracketMatch = /^\[([^\]]+)\](?::\d+)?$/.exec(first);
  if (ipv6BracketMatch?.[1]) {
    return ipv6BracketMatch[1].slice(0, 45);
  }

  // Formato IPv4 con puerto: 190.24.10.5:54321
  const ipv4PortMatch = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(first);
  if (ipv4PortMatch?.[1]) {
    return ipv4PortMatch[1].slice(0, 45);
  }

  // IPv6 sin corchetes pero con posible puerto al final (solo si hay más de 7 grupos o ::)
  return first.replace(/^::ffff:/i, '').slice(0, 45);
}

export function forensicContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const cfAddress = req.header('cloudfront-viewer-address');
  const forwarded = req.header('x-forwarded-for');
  const rawIp = cfAddress || forwarded || req.ip || req.socket.remoteAddress || '0.0.0.0';
  const userAgent = (req.header('user-agent') ?? 'unknown').slice(0, 255);

  req.forensic = {
    ip_origen: extractCleanIp(rawIp),
    user_agent: userAgent,
  };
  next();
}

