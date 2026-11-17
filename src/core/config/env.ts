import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('cemcop_entregas_db'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().optional().default(''),

  JWT_ACCESS_SECRET: z.string().min(16).default('dev_access_secret_cambiar_en_produccion_32'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev_refresh_secret_cambiar_en_produccion_32'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(43200),

  STORAGE_PROVIDER: z.enum(['s3', 'local']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./.local-storage'),
  AWS_REGION: z.string().default('us-east-2'),
  S3_ASSETS_BUCKET: z.string().default('cemcop-entregas-assets-839858225814'),

  SQS_REPORTS_QUEUE_URL: z.string().optional().default(''),
  SQS_EMAIL_QUEUE_URL: z.string().optional().default(''),

  SMTP_HOST: z.string().default('smtp.office365.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default('no-reply@cemcop.net'),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().default('CEMCOP Entregas <no-reply@cemcop.net>'),

  SENTRY_DSN: z.string().optional().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Error en variables de entorno:', parsed.error.flatten().fieldErrors);
  throw new Error('Configuración de entorno inválida');
}

export const env = parsed.data;

