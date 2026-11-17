import { NextFunction, Request, Response } from 'express';
import { ZodTypeAny } from 'zod';

export interface ValidatedData<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> {
  body: TBody;
  query: TQuery;
  params: TParams;
}

declare global {
  namespace Express {
    interface Request {
      validated?: ValidatedData;
    }
  }
}

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Valida body, query y params con Zod.
 * En Express 5 `req.query` es un getter de solo lectura, por lo que los valores parseados
 * se exponen de forma segura en `req.validated` (y `req.body` se actualiza).
 */
export function validateRequest(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const validated: ValidatedData = {
      body: req.body,
      query: req.query,
      params: req.params,
    };

    if (schemas.params) {
      validated.params = schemas.params.parse(req.params);
    }
    if (schemas.query) {
      validated.query = schemas.query.parse(req.query);
    }
    if (schemas.body) {
      const parsedBody = schemas.body.parse(req.body);
      validated.body = parsedBody;
      req.body = parsedBody;
    }

    req.validated = validated;
    next();
  };
}

