import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env.js';

/**
 * Pool MySQL sin comandos SET de sesión para evitar Connection Pinning en AWS RDS Proxy.
 * La zona horaria y charset deben configurarse en el DB Parameter Group (America/Bogota, utf8mb4).
 */
export const pool: Pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  queueLimit: 0,
  dateStrings: true,
  namedPlaceholders: false,
});

export type DbExecutor = Pick<PoolConnection, 'query' | 'execute'>;

export async function queryRows<T extends RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  executor: DbExecutor = pool,
): Promise<T[]> {
  const [rows] = await executor.query<T[]>(sql, params);
  return rows;
}

export async function queryOne<T extends RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  executor: DbExecutor = pool,
): Promise<T | null> {
  const rows = await queryRows<T>(sql, params, executor);
  return rows[0] ?? null;
}

export async function executeSql(
  sql: string,
  params: unknown[] = [],
  executor: DbExecutor = pool,
): Promise<ResultSetHeader> {
  const [result] = await executor.query<ResultSetHeader>(sql, params);
  return result;
}

export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function checkDbHealth(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

