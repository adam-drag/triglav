import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import mysql from 'mysql2/promise';
import { hashPassword } from '../src/client-auth.ts';
import { createCtx, type Ctx } from '../src/context.ts';
import { createPool, migrate } from '../src/db.ts';
import type { Clock } from '../src/lib.ts';
import type { LinearSource, LinearTree } from '../src/linear.ts';

export const TEST_DB_URL = process.env.ORCH_TEST_DATABASE_URL;

export class FakeClock implements Clock {
  private t: number;
  constructor(iso = '2026-10-07T10:00:00.000Z') {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t);
  }
  set(iso: string) {
    this.t = Date.parse(iso);
  }
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
}

export class FakeLinear implements LinearSource {
  trees = new Map<string, LinearTree>();
  down = false;
  add(tree: LinearTree) {
    this.trees.set(tree.identifier, tree);
    this.trees.set(tree.id, tree);
  }
  async fetchTree(id: string): Promise<LinearTree> {
    if (this.down) throw Object.assign(new Error('Linear down'), { code: 'linear_unavailable' });
    const tree = this.trees.get(id);
    if (!tree) throw new Error(`no issue ${id}`);
    return structuredClone(tree);
  }
}

export function issue(identifier: string, title: string, extra: Partial<LinearTree> = {}) {
  return { id: `uuid-${identifier}`, identifier, title, description: `${title} description`, url: `https://linear.app/t/issue/${identifier}`, state: 'Todo', updatedAt: '2026-10-07T09:00:00.000Z', ...extra };
}

/** A fresh database per test file, dropped at the end. */
export async function createTestCtx(linear: LinearSource | null = new FakeLinear()) {
  if (!TEST_DB_URL) throw new Error('ORCH_TEST_DATABASE_URL is not set');
  const name = `orch_t_${randomBytes(4).toString('hex')}`;
  const admin = await mysql.createConnection({ uri: TEST_DB_URL });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DB_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  const clock = new FakeClock();
  const ctx: Ctx = createCtx({ pool, clock, linear, baseUrl: 'http://localhost:7400' });
  return {
    ctx,
    clock,
    linear: linear as FakeLinear,
    async close() {
      await pool.end();
      const a = await mysql.createConnection({ uri: TEST_DB_URL });
      await a.query(`DROP DATABASE ${name}`);
      await a.end();
    },
  };
}

export const TEST_ENROLLMENT_KEY = 'test-enrollment-key-0123456789abcdef';
export const TEST_RUNNER_KEY = 'test-runner-key-fedcba9876543210ff';
export const TEST_PASSWORD = 'test-dashboard-password';
let passwordHash: Promise<string> | undefined;
/** The scrypt hash of TEST_PASSWORD, made once per test file. */
export const testPasswordHash = () => (passwordHash ??= hashPassword(TEST_PASSWORD));

/** The options buildServer needs for the three credentials. */
export async function testServerKeys() {
  return { enrollmentKey: TEST_ENROLLMENT_KEY, runnerKey: TEST_RUNNER_KEY, passwordHash: await testPasswordHash() };
}

/** Logs in through the login route and returns the session cookie, as the browser would send it. */
export async function loginCookie(app: FastifyInstance, password = TEST_PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

/** `app.inject` with a session cookie, for the Client's calls. */
export const asClient = (app: FastifyInstance, cookie: string) => ({
  inject: (o: InjectOptions) => app.inject({ ...o, headers: { cookie, ...(o.headers as Record<string, string> | undefined) } } as InjectOptions),
});
