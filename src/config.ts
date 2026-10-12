import { parsePasswordHash } from './client-auth.ts';

export const MIN_KEY_LENGTH = 24;

export type SecurityConfig = { enrollmentKey: string; runnerKey: string; passwordHash: string };

/**
 * The three credentials the server needs before it starts. It never makes one up: a key it generated would have to be
 * stored somewhere the host runner and the agents can read, and the Client would not know where.
 */
export function readSecurityConfig(env: Record<string, string | undefined>): { ok: true; config: SecurityConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const enrollmentKey = env.ORCH_ENROLLMENT_KEY ?? '';
  const runnerKey = env.ORCH_RUNNER_KEY ?? '';
  const passwordHash = env.ORCH_CLIENT_PASSWORD_HASH ?? '';
  const fix = 'Generate one with: openssl rand -hex 24';
  if (!enrollmentKey) errors.push(`ORCH_ENROLLMENT_KEY is missing. Agents use it to reach /mcp. Add it to .env. ${fix}`);
  else if (enrollmentKey.length < MIN_KEY_LENGTH) errors.push(`ORCH_ENROLLMENT_KEY must be at least ${MIN_KEY_LENGTH} characters. ${fix}`);
  if (!runnerKey) errors.push(`ORCH_RUNNER_KEY is missing. Only the host runner uses it (/api/runner/*), and it must differ from ORCH_ENROLLMENT_KEY. Add it to .env. ${fix}`);
  else if (runnerKey.length < MIN_KEY_LENGTH) errors.push(`ORCH_RUNNER_KEY must be at least ${MIN_KEY_LENGTH} characters. ${fix}`);
  else if (runnerKey === enrollmentKey) errors.push(`ORCH_RUNNER_KEY must differ from ORCH_ENROLLMENT_KEY: agents hold the enrollment key and must not be able to act as the runner. ${fix}`);
  if (!passwordHash) errors.push('ORCH_CLIENT_PASSWORD_HASH is missing. Set the dashboard password with: node scripts/set-password.ts (it writes the hash to .env), then restart the server.');
  else if (!parsePasswordHash(passwordHash)) errors.push('ORCH_CLIENT_PASSWORD_HASH is not a valid hash. Set the dashboard password again with: node scripts/set-password.ts');
  return errors.length ? { ok: false, errors } : { ok: true, config: { enrollmentKey, runnerKey, passwordHash } };
}
