import { join } from 'node:path';
import { createCtx } from './context.ts';
import { createPool, migrate } from './db.ts';
import { systemClock } from './lib.ts';
import { LinearGraphql } from './linear.ts';
import { startScheduler } from './scheduler.ts';
import { buildServer } from './server.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.ORCH_PORT ?? 7400);
const host = process.env.ORCH_BIND ?? '127.0.0.1';
const baseUrl = process.env.ORCH_PUBLIC_URL ?? `http://localhost:${port}`;
const enrollmentKey = required('ORCH_ENROLLMENT_KEY');
if (enrollmentKey.length < 24) {
  console.error('ORCH_ENROLLMENT_KEY must be at least 24 characters. Generate one with: openssl rand -hex 24');
  process.exit(1);
}

const pool = createPool(required('DATABASE_URL'));
for (let attempt = 1; ; attempt++) {
  try {
    await migrate(pool);
    break;
  } catch (error) {
    if (attempt >= 30) throw error;
    console.log(`Waiting for MySQL (${(error as Error).message})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const linear = process.env.LINEAR_API_KEY ? new LinearGraphql(process.env.LINEAR_API_KEY) : null;
const ctx = createCtx({ pool, clock: systemClock, linear, baseUrl });
const app = buildServer(ctx, { enrollmentKey, webDir: join(import.meta.dirname, '..', 'web', 'dist') });
const stopScheduler = startScheduler(ctx, 1000, { claude: process.env.ORCH_CLAUDE_DIR, codex: process.env.ORCH_CODEX_DIR });

await app.listen({ port, host });
console.log(`Orchestrator listening on ${host}:${port}. Dashboard and guide at ${baseUrl}. Linear: ${linear ? 'API key configured' : 'no key, agents supply ticket snapshots'}.`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopScheduler();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
