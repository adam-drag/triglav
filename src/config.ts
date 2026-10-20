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

export const DEFAULT_DASHBOARD_PORT = 7410;

/** The public dashboard listener: the https URL the Client opens through the reverse proxy, and the port it listens on. */
export type DashboardConfig = { origin: string; host: string; port: number };

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The opt-in public dashboard listener (README "Running behind an HTTPS reverse proxy"). Without ORCH_DASHBOARD_URL it
 * is off and nothing changes. The URL must be an https origin: no path, query, fragment or user info, since the
 * listener compares the Host and Origin headers with it exactly. ORCH_PUBLIC_URL stays the agents' base URL (guide,
 * MCP config, spawn prompt), so it must stay on loopback: agents and the runner run on this machine.
 */
export function readListenerConfig(env: Record<string, string | undefined>): { ok: true; dashboard: DashboardConfig | null } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const publicUrl = env.ORCH_PUBLIC_URL;
  if (publicUrl) {
    let hostname = '';
    try {
      hostname = new URL(publicUrl).hostname;
    } catch {}
    if (!LOOPBACK_HOSTNAMES.has(hostname)) {
      errors.push(
        `ORCH_PUBLIC_URL must be a loopback URL such as http://localhost:7400 (got "${publicUrl}"). It is the address agents and the host runner use on this machine. To open the dashboard from another machine, set ORCH_DASHBOARD_URL instead (see "Running behind an HTTPS reverse proxy" in the README).`,
      );
    }
  }
  const rawPort = env.ORCH_DASHBOARD_PORT;
  let port = DEFAULT_DASHBOARD_PORT;
  if (rawPort) {
    port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
    if (!(port >= 1 && port <= 65535)) errors.push(`ORCH_DASHBOARD_PORT must be a port number from 1 to 65535 (got "${rawPort}").`);
  }
  // The default port counts too: with ORCH_PORT=7410 the second listen would fail after the first one started.
  if ((rawPort || env.ORCH_DASHBOARD_URL) && port === Number(env.ORCH_PORT || 7400)) errors.push(`ORCH_DASHBOARD_PORT must differ from ORCH_PORT (${port}): the public dashboard listener is a second port.`);
  const raw = env.ORCH_DASHBOARD_URL;
  let dashboard: DashboardConfig | null = null;
  if (raw) {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {}
    const fix = 'Use the https origin the reverse proxy serves, for example https://triglav.example.com.';
    if (!url) errors.push(`ORCH_DASHBOARD_URL is not a valid URL (got "${raw}"). ${fix}`);
    else if (url.protocol !== 'https:') errors.push(`ORCH_DASHBOARD_URL must start with https:// (got "${raw}"). The dashboard is only served through an HTTPS reverse proxy. ${fix}`);
    // `href` keeps a bare "?" or "#" that `search` and `hash` drop, so comparing it with the origin refuses each of them.
    else if (url.href !== `${url.origin}/` || raw.includes('@')) errors.push(`ORCH_DASHBOARD_URL must have no path, query, fragment or user info (got "${raw}"). ${fix}`);
    else dashboard = { origin: url.origin, host: url.host, port };
  }
  return errors.length ? { ok: false, errors } : { ok: true, dashboard };
}
