import { join } from 'node:path';
import { readListenerConfig, readSecurityConfig } from './config.ts';
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
const security = readSecurityConfig(process.env);
if (!security.ok) {
  console.error(`Triglav does not start without its credentials:\n${security.errors.map((e) => `- ${e}`).join('\n')}\nSee .env.example.`);
  process.exit(1);
}
const { enrollmentKey, runnerKey, passwordHash } = security.config;
const listeners = readListenerConfig(process.env);
if (!listeners.ok) {
  console.error(`Triglav does not start with this listener configuration:\n${listeners.errors.map((e) => `- ${e}`).join('\n')}\nSee .env.example.`);
  process.exit(1);
}
const dashboard = listeners.dashboard;

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
const transcriptDirs = { claude: process.env.ORCH_CLAUDE_DIR, codex: process.env.ORCH_CODEX_DIR };
const webDir = join(import.meta.dirname, '..', 'web', 'dist');
const app = buildServer(ctx, { enrollmentKey, runnerKey, passwordHash, webDir, transcriptDirs });
// The opt-in public listener serves only the dashboard, for an HTTPS reverse proxy. Off unless ORCH_DASHBOARD_URL is set.
const publicApp = dashboard ? buildServer(ctx, { enrollmentKey, runnerKey, passwordHash, webDir, transcriptDirs, dashboard }) : null;
const stopScheduler = startScheduler(ctx, 1000, transcriptDirs);

await app.listen({ port, host });
console.log(`Orchestrator listening on ${host}:${port}. Dashboard and guide at ${baseUrl}. Linear: ${linear ? 'API key configured' : 'no key, agents supply ticket snapshots'}.`);
if (publicApp && dashboard) {
  await publicApp.listen({ port: dashboard.port, host });
  console.log(`Public dashboard listener on ${host}:${dashboard.port}, for the reverse proxy at ${dashboard.origin}. It serves only the dashboard.`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopScheduler();
    await app.close();
    await publicApp?.close();
    await pool.end();
    process.exit(0);
  });
}
