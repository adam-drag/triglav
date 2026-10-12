/**
 * The runner sends its bearer key to ORCH_URL, and the hooks send session and usage data there. Both must stay on this
 * machine, so the URL has to be plain http to a loopback host. Kept apart from runner.ts, which has a top-level loop,
 * so the tests can import it. The shell hooks (stop-hook.sh, claude-statusline.sh) apply the same rule.
 */
export const DEFAULT_ORCH_URL = 'http://127.0.0.1:7400';

/** Returns the origin to use, or throws a sentence the Client can act on. Credentials, other schemes and other hosts are refused. */
export function loopbackBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`ORCH_URL is not a URL: ${JSON.stringify(raw.slice(0, 60))}`);
  }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password) {
    throw new Error(`ORCH_URL must be an http URL to localhost, 127.0.0.1 or [::1] without credentials, because the runner sends its key there. Got ${JSON.stringify(u.origin)}.`);
  }
  return u.origin;
}
