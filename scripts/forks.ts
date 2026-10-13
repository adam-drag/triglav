/** Finds a live fork of a Claude Code session, so the runner does not resume a Staff that is already running. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { staffStartEnv } from './staff-start.ts';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Listed = { id?: string; sessionId?: string; cwd?: string; kind?: string; pid?: number; status?: string };

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


/** The short ids of every live background session of a session's lineage, idle or busy. A model switch stops them all before it resumes. */
export function liveForkIds(home: string, session: string, cwd: string, list = listBackground): string[] {
  const lineage = lineageOf(home, cwd, session);
  if (!lineage) return [];
  return list(cwd)
    .filter((s) => s.kind === 'background' && s.pid && s.id && /^[0-9a-f]{8}$/.test(s.id) && s.sessionId && SESSION.test(s.sessionId) && lineageOf(home, cwd, s.sessionId) === lineage)
    .map((s) => s.id!);
}
