/** Finds a live fork of a Claude Code session, so the runner does not resume a Staff that is already running. */
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { staffStartEnv } from './staff-start.ts';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Listed = { id?: string; sessionId?: string; cwd?: string; kind?: string; pid?: number; status?: string; state?: string };

const listBackground = (cwd: string): Listed[] => JSON.parse(execFileSync('claude', ['agents', '--json', '--cwd', cwd], { encoding: 'utf8', timeout: 30_000, env: staffStartEnv(process.env) }));

/** The id of a session's first user message. Every fork of a session (a resume, or a session that continues by
 * itself after a usage limit) keeps it, so it identifies the session's lineage. */
export function lineageOf(home: string, cwd: string, session: string): string | null {
  const file = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${session}.jsonl`);
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      const uuid = (JSON.parse(line) as { type?: string; uuid?: string }).uuid;
      if (uuid) return uuid;
    }
  } catch {
    // No transcript: no lineage to compare.
  }
  return null;
}

/**
 * A background session of the same lineage whose process is still alive. A session stopped by a usage limit is only
 * paused: after the limit resets, or the Client logs in to another account, it continues by itself as a new session
 * id. Resuming it as well gave two Staff with one token (2026-10-09). Claude Code lists a pid only for live sessions.
 * Returns null when the fork cannot be checked, so a resume is never blocked by this guard failing.
 */
export function runningFork(home: string, session: string, cwd: string, list = listBackground): string | null {
  const lineage = lineageOf(home, cwd, session);
  if (!lineage) return null;
  let sessions: Listed[];
  try {
    sessions = list(cwd);
  } catch (e) {
    console.error('claude agents --json failed, resuming anyway:', (e as Error).message);
    return null;
  }
  // An idle fork ended its turn and does not continue by itself, so it does not block a resume.
  const live = sessions.find((s) => s.kind === 'background' && s.pid && s.status !== 'idle' && s.sessionId && SESSION.test(s.sessionId) && lineageOf(home, cwd, s.sessionId) === lineage);
  return live?.sessionId ?? null;
}


/** Every live background session of a session's lineage, idle or busy, with its status. */
export function liveForksOf(home: string, session: string, cwd: string, list = listBackground): { id: string; status?: string }[] {
  const lineage = lineageOf(home, cwd, session);
  if (!lineage) return [];
  return list(cwd)
    .filter((s) => s.kind === 'background' && s.pid && s.id && /^[0-9a-f]{8}$/.test(s.id) && s.sessionId && SESSION.test(s.sessionId) && lineageOf(home, cwd, s.sessionId) === lineage)
    .map((s) => ({ id: s.id!, status: s.status }));
}

/** The short ids of every live background session of a session's lineage, idle or busy. A model switch stops them all before it resumes. */
export function liveForkIds(home: string, session: string, cwd: string, list = listBackground): string[] {
  return liveForksOf(home, session, cwd, list).map((f) => f.id);
}

// Same lists as BUSY_STATUSES and BUSY_STATES in src/busy-sessions.ts (the route refuses anything else): change both.
const KNOWN_STATES = new Set(['working', 'blocked', 'idle', 'waiting', 'done']);
export const MAX_BUSY_REPORT = 200;

/**
 * The busy background sessions in a `claude agents --json` listing, as the server's /api/runner/busy-sessions takes
 * them: only a full session UUID, status and state, nothing else from that output. An unknown state goes as null.
 */
export function busyOf(listed: unknown): { sessionId: string; status: 'busy'; state: string | null }[] {
  if (!Array.isArray(listed)) return [];
  const out = new Map<string, { sessionId: string; status: 'busy'; state: string | null }>();
  for (const s of listed as Listed[]) {
    // Background sessions only, with a pid (Claude Code lists one only for a live session), as runningFork relies on.
    if (!s || typeof s !== 'object' || s.kind !== 'background' || s.status !== 'busy' || !s.pid || typeof s.sessionId !== 'string' || !SESSION.test(s.sessionId)) continue;
    const state = typeof s.state === 'string' && KNOWN_STATES.has(s.state) ? s.state : null;
    if (state === 'blocked') continue;
    out.set(s.sessionId, { sessionId: s.sessionId, status: 'busy', state });
    if (out.size >= MAX_BUSY_REPORT) break;
  }
  return [...out.values()];
}

type ExecFile = (cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => unknown;

/**
 * Runs `claude agents --json` for every directory (no --cwd) and returns the report for /api/runner/busy-sessions.
 * Fixed argv, scrubbed environment, 30 s timeout with SIGKILL, 4 MB output cap. An error carries a fixed text and the
 * exit code or signal, never the output or stderr, so nothing from the listing reaches a log.
 */
export function busyReport(home: string, run: ExecFile = execFile as unknown as ExecFile): Promise<{ sessions: ReturnType<typeof busyOf> }> {
  return new Promise((resolve, reject) => {
    run('claude', ['agents', '--json'], { cwd: home, env: staffStartEnv(process.env), timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        const e = err as { code?: unknown; signal?: unknown };
        return reject(new Error(`claude agents --json failed (${String(e.code ?? e.signal ?? 'error').slice(0, 40)})`));
      }
      let listed: unknown;
      try {
        listed = JSON.parse(stdout);
      } catch {
        return reject(new Error('claude agents --json printed no JSON'));
      }
      resolve({ sessions: busyOf(listed) });
    });
  });
}

/**
 * The runner's 60 s busy report: runs busyReport and posts only its `{ sessions }`. A call while the previous one still
 * runs is skipped; a failure logs one fixed line and the next call runs again.
 */
export function busyReporter(report: () => Promise<{ sessions: unknown[] }>, post: (body: { sessions: unknown[] }) => Promise<unknown>, log: (line: string) => void) {
  let running = false;
  return async () => {
    if (running) return 'skipped';
    running = true;
    try {
      const r = await report();
      await post({ sessions: r.sessions });
      return 'sent';
    } catch (e) {
      log(`report busy sessions: ${(e as Error).message.split('\n')[0]}`);
      return 'failed';
    } finally {
      running = false;
    }
  };
}
