export type ErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'FORBIDDEN'
  | 'SEDE_INACTIVE'
  | 'CAMPAIGN_CLOSED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'SEDE_CODE_EXISTS'
  | 'USERNAME_ALREADY_EXISTS'
  | 'SEDE_REQUIRED_FOR_REPARTIDOR'
  | 'INVALID_STOCK'
  | 'DEFICIT_CONFIRMATION_REQUIRED'
  | 'ACTIVE_CAMPAIGN_EXISTS'
  | 'IMPORT_IN_PROGRESS'
  | 'INVALID_EXCEL_STRUCTURE'
  | 'CEDULA_ALREADY_EXISTS'
  | 'MASTER_FIELDS_LOCKED'
  | 'MOTIVO_TOO_SHORT'
  | 'ASSOCIATE_HAS_ACTIVE_DELIVERY'
  | 'ASSOCIATE_NOT_ELIGIBLE'
  | 'SIGNATURE_REQUIRED'
  | 'CONCURRENT_DELIVERY_IN_PROGRESS'
  | 'OUT_OF_STOCK'
  | 'ALREADY_DELIVERED'
  | 'ALREADY_CANCELLED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

