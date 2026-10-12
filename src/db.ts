import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type Conn = Pool | PoolConnection;
export type Row = Record<string, any>;

export function createPool(url: string): Pool {
  return mysql.createPool({
    uri: url,
    timezone: 'Z',
    connectionLimit: 10,
    supportBigNumbers: true,
    bigNumberStrings: false,
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 4) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      return next();
    },
  });
}

export async function query<T = Row>(conn: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

export async function queryOne<T = Row>(conn: Conn, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(conn, sql, params);
  return rows[0];
}

export async function exec(conn: Conn, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await conn.query<ResultSetHeader>(sql, params);
  return result;
}

/**
 * Runs fn in a transaction that first takes the global write lock (see migration 002).
 * Retries a few times on deadlock or lock wait timeout; fn must only do database work.
 */
export async function withTx<T>(pool: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`SELECT id FROM write_lock WHERE id = 1 FOR UPDATE`);
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      const code = (error as { errno?: number }).errno;
      if ((code === 1213 || code === 1205) && attempt < 3) continue;
      throw error;
    } finally {
      conn.release();
    }
  }
}

export async function migrate(pool: Pool): Promise<void> {
  await exec(pool, `CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(200) PRIMARY KEY, applied_at DATETIME(3) NOT NULL)`);
  const dir = join(import.meta.dirname, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await query(pool, `SELECT name FROM schema_migrations`)).map((r) => r.name as string));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    // One statement at a time, so the pool never needs multipleStatements.
    for (const statement of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await exec(pool, statement);
    await exec(pool, `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, [file, new Date()]);
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}
