import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueChatToken, chatByToken } from '../src/chat.ts';
import { createCtx } from '../src/context.ts';
import { createPool, exec, migrate, query, queryOne } from '../src/db.ts';
import { systemClock } from '../src/lib.ts';
import { TEST_DB_URL } from './helpers.ts';

// Migration 026 on a database that already has chats with a plain token (migrations 001 to 025 applied).
describe.skipIf(!TEST_DB_URL)('migration 026: the chat token is replaced by its hash', () => {
  const name = `orch_t_${randomBytes(4).toString('hex')}`;
  let pool: ReturnType<typeof createPool>;
  beforeAll(async () => {
    const admin = await mysql.createConnection({ uri: TEST_DB_URL! });
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(TEST_DB_URL!);
    url.pathname = `/${name}`;
    pool = createPool(url.toString());
  });
  afterAll(async () => {
    await pool?.end();
    const admin = await mysql.createConnection({ uri: TEST_DB_URL! });
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  it('is one statement, so a start that is interrupted cannot leave it half applied', async () => {
    const sql = await readFile(join(import.meta.dirname, '..', 'src', 'migrations', '026_chat_token_hash.sql'), 'utf8');
    // The same split migrate() uses.
    expect(sql.split(/;\s*$/m).map((x) => x.trim()).filter(Boolean)).toHaveLength(1);
  });

  it('drops the stored token, keeps the chat and its messages, and a new token works after it', async () => {
    const dir = join(import.meta.dirname, '..', 'src', 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const before = files.filter((f) => f < '026');
    expect(files.length).toBeGreaterThan(before.length);
    await exec(pool, `CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(200) PRIMARY KEY, applied_at DATETIME(3) NOT NULL)`);
    for (const file of before) {
      for (const statement of (await readFile(join(dir, file), 'utf8')).split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await exec(pool, statement);
      await exec(pool, `INSERT INTO schema_migrations (name, applied_at) VALUES (?, NOW(3))`, [file]);
    }
    const plain = 'orch_chat_' + 'z'.repeat(32);
    await exec(pool, `INSERT INTO chats (id, title, token, state, created_at, updated_at) VALUES ('cht_0123456789abcdef', 'old', ?, 'stopped', NOW(3), NOW(3))`, [plain]);
    await exec(pool, `INSERT INTO chat_messages (chat_id, role, text, created_at) VALUES ('cht_0123456789abcdef', 'client', 'kept', NOW(3))`);

    await migrate(pool);

    const columns = (await query<{ COLUMN_NAME: string }>(pool, `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chats'`)).map((c) => c.COLUMN_NAME);
    expect(columns).not.toContain('token');
    expect(JSON.stringify(await query(pool, `SELECT * FROM chats`))).not.toContain(plain);
    // The old token opens nothing. The chat and its messages are still there, and the runner can get a fresh token for it.
    const ctx = createCtx({ pool, clock: systemClock, linear: null, baseUrl: 'http://localhost:7400' });
    expect(await chatByToken(ctx, plain)).toBeUndefined();
    expect(await queryOne(pool, `SELECT text FROM chat_messages WHERE chat_id = 'cht_0123456789abcdef'`)).toMatchObject({ text: 'kept' });
    expect(await chatByToken(ctx, await issueChatToken(ctx, 'cht_0123456789abcdef'))).toMatchObject({ id: 'cht_0123456789abcdef' });
  });
});
