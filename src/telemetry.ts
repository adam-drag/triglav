import { RESEARCH_PROMPT, recordCodexBudget } from './research.ts';
import { randomBytes } from 'node:crypto';
import { presenceOf } from './agents.ts';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn } from './db.ts';
import { emit } from './events.ts';
import { sha256, TOKEN_PREFIX } from './lib.ts';
import { settleRequestOfLaunch } from './job-requests.ts';

/*
 * Observability from the agents' own CLI transcripts, mounted read-only into the container.
 * Only sessions that passed a Triglav session token to an orchestrator tool are counted, so the
 * Client's other CLI work stays out. Re-reading a changed file replaces its rows, so ingesting is idempotent.
 */

interface Usage {
  model: string;
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Artifact {
  kind: 'branch' | 'push' | 'pr';
  url: string;
  label: string;
  at: Date;
}

// Claude stores tool input as JSON; Codex stores it as a JSON string, so the quotes may be escaped.
const TOKEN_RE = /session_token\\?"?\s*:\s*\\?"(orch_tok_[A-Za-z0-9_-]+)/g;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const lines = (text: string) =>
  text.split('\n').flatMap((l) => {
    if (!l) return [];
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

/**
 * When this session last requested a Copilot review (the wait starts there), and last read one. Both are `gh` commands of
 * the delivery loop card (src/guide/deliver.md): `gh pr edit <pr> --add-reviewer "@copilot"`, and a read of one review by id,
 * `gh api repos/<repo>/pulls/<pr>/reviews/<id>`. Listing the reviews (`.../reviews --paginate`) is polling, not a read.
 */
export function copilotLoop(rows: any[]): { awaitAt: Date | null; harvestAt: Date | null } {
  let awaitAt: Date | null = null;
  let harvestAt: Date | null = null;
  for (const r of rows) {
    for (const [, cmd] of callsIn(r)) {
      const at = r.timestamp ? new Date(r.timestamp) : null;
      if (!at) continue;
      if (/--add-reviewer[\s\\"']+@copilot/.test(cmd)) awaitAt = at;
      if (/pulls\/[^\s"\\]+\/reviews\/\d+/.test(cmd)) harvestAt = at;
    }
  }
  return { awaitAt, harvestAt };
}

/** Tool calls in a Claude or Codex transcript line, as call id and the command text. */
function callsIn(row: any): [string, string][] {
  const out: [string, string][] = [];
  const content = row?.message?.content;
  if (Array.isArray(content)) for (const c of content) if (c?.type === 'tool_use' && c.id) out.push([c.id, JSON.stringify(c.input ?? '')]);
  const p = row?.type === 'response_item' ? row.payload : null;
  if (p?.call_id && (p.type === 'function_call' || p.type === 'custom_tool_call')) out.push([p.call_id, String(p.arguments ?? p.input ?? '')]);
  return out;
}

/** Tool results in a Claude or Codex transcript line, as call id and output text. */
function resultsIn(row: any): [string, string][] {
  const out: [string, string][] = [];
  const content = row?.message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type !== 'tool_result') continue;
      const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '';
      out.push([c.tool_use_id, text]);
    }
  }
  const p = row?.type === 'response_item' ? row.payload : null;
  if (p?.call_id && p.output !== undefined) {
    // Codex output is either a string or a list of text parts.
    const text = typeof p.output === 'string' ? p.output : Array.isArray(p.output) ? p.output.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '';
    out.push([p.call_id, text]);
  }
  return out;
}

/** Only output of a command that pushes or opens a PR counts; anything else merely mentions one. */
export function artifactsIn(rows: any[]): Artifact[] {
  const commands = new Map<string, string>();
  const found: Artifact[] = [];
  for (const r of rows) {
    for (const [id, cmd] of callsIn(r)) commands.set(id, cmd);
    const at = r.timestamp ? new Date(r.timestamp) : new Date();
    for (const [id, text] of resultsIn(r)) {
      const cmd = commands.get(id) ?? '';
      const push = /git\b[^"]*\bpush\b/.test(cmd);
      const pr = /gh\s+pr\s+create/.test(cmd);
      if (!push && !pr) continue;
      found.push(...artifactsFrom(text, at).filter((a) => (a.kind === 'pr' ? pr : push)));
    }
  }
  return found;
}

/** Branches, pushes and PRs from git and gh output. */
export function artifactsFrom(text: string, at: Date): Artifact[] {
  const found: Artifact[] = [];
  let repo: string | null = null;
  for (const line of text.split('\n')) {
    const to = line.match(/^To (?:git@)?github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/);
    if (to) {
      repo = to[1]!;
      continue;
    }
    const nb = repo && line.match(/^\s*\* \[new branch\]\s+(\S+)\s+->\s+(\S+)/);
    if (nb) found.push({ kind: 'branch', url: `https://github.com/${repo}/tree/${nb[2]}`, label: `${repo}: ${nb[2]}`, at });
    const range = repo && line.match(/^\s*\+?([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/);
    if (range) found.push({ kind: 'push', url: `https://github.com/${repo}/compare/${range[1]}...${range[2]}`, label: `${repo}: ${range[4]} at ${range[2]}`, at });
  }
  // `gh pr create` prints the new PR's URL on a line of its own. A URL inside other text (a board
  // message, a file, a test fixture) is a mention, not a PR this agent opened.
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
    if (m) found.push({ kind: 'pr', url: m[0], label: `${m[1]}#${m[2]}`, at });
  }
  return found;
}

function parseClaude(rows: any[]) {
  const byMessage = new Map<string, Usage>();
  for (const r of rows) {
    const at = r.timestamp ? new Date(r.timestamp) : new Date();
    const m = r?.message;
    if (r.type === 'assistant' && m?.usage && m.id && m.model && m.model !== '<synthetic>') {
      const u = m.usage;
      byMessage.set(m.id, {
        model: m.model,
        day: at.toISOString().slice(0, 10),
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      });
    }
  }
  return { usage: [...byMessage.values()], artifacts: artifactsIn(rows) };
}

function parseCodex(rows: any[]) {
  const usage: Usage[] = [];
  let model = 'unknown';
  let last = { input: 0, output: 0, cacheRead: 0 };
  for (const r of rows) {
    const at = r.timestamp ? new Date(r.timestamp) : new Date();
    if (r.type === 'turn_context' && r.payload?.model) model = r.payload.model;
    const total = r.type === 'event_msg' && r.payload?.type === 'token_count' ? r.payload.info?.total_token_usage : null;
    if (total) {
      const now = { input: total.input_tokens ?? 0, output: total.output_tokens ?? 0, cacheRead: total.cached_input_tokens ?? 0 };
      // Totals are cumulative; each event adds the difference, booked on its own day.
      usage.push({
        model,
        day: at.toISOString().slice(0, 10),
        input: Math.max(0, now.input - now.cacheRead - (last.input - last.cacheRead)),
        output: Math.max(0, now.output - last.output),
        cacheRead: Math.max(0, now.cacheRead - last.cacheRead),
        cacheWrite: 0,
      });
      last = now;
    }
  }
  return { usage, artifacts: artifactsIn(rows) };
}

/**
 * The Triglav tokens this session itself passed to orchestrator tools. A token that only appears in
 * output (printed while debugging another agent) must not attribute this session to that agent.
 */
export function ownTokens(rows: any[]): string[] {
  const tokens: string[] = [];
  const registerCalls = new Set<string>();
  for (const r of rows) {
    for (const [id, input] of callsIn(r)) if (input.includes('register_agent')) registerCalls.add(id);
    // The token register_agent returned to this session (Codex keeps it in a variable afterwards).
    for (const [id, out] of resultsIn(r)) if (registerCalls.has(id)) for (const m of out.matchAll(/orch_tok_[A-Za-z0-9_-]+/g)) tokens.push(m[0]);
    const content = r?.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        const t = c?.type === 'tool_use' && String(c.name ?? '').startsWith('mcp__orchestrator__') ? c.input?.session_token : null;
        if (typeof t === 'string') tokens.push(t);
      }
    }
    const p = r?.type === 'response_item' ? r.payload : null;
    const args = p && (p.type === 'function_call' || p.type === 'custom_tool_call') ? String(p.arguments ?? p.input ?? '') : '';
    // Codex calls the server either as an MCP function (JSON arguments) or from its JS runtime (tools.mcp__orchestrator__x({...})).
    if ((p?.name ?? '').includes('orchestrator') || args.includes('mcp__orchestrator__')) for (const m of args.matchAll(TOKEN_RE)) tokens.push(m[1]!);
  }
  return [...new Set(tokens)].filter((t) => t.startsWith(TOKEN_PREFIX));
}

async function agentFor(conn: Conn, rows: any[]): Promise<string | null> {
  const tokens = ownTokens(rows);
  for (const t of tokens.reverse()) {
    const row = await queryOne(conn, `SELECT agent_id FROM agent_sessions WHERE token_hash = ?`, [sha256(t)]);
    if (row) return row.agent_id as string;
  }
  return null;
}

async function jobFor(conn: Conn, agentId: string): Promise<string | null> {
  const held = await queryOne(conn, `SELECT job_id FROM assignments WHERE owner_agent_id = ? ORDER BY created_at DESC LIMIT 1`, [agentId]);
  if (held) return held.job_id as string;
  const owned = await queryOne(conn, `SELECT id FROM jobs WHERE staff_agent_id = ? AND parent_job_id IS NULL ORDER BY created_at DESC LIMIT 1`, [agentId]);
  if (owned) return owned.id as string;
  // Its assignment may have moved to a later attempt by another agent; its own events still name the job.
  const ev = await queryOne(conn, `SELECT job_id FROM events WHERE actor = ? AND job_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [agentId]);
  return (ev?.job_id as string) ?? null;
}

async function ingestFile(ctx: Ctx, path: string, runtime: 'claude-code' | 'codex') {
  const text = await readFile(path, 'utf8');
  // Every Codex session reports the shared plan limit, so read it from all of them, not only agents'.
  if (runtime === 'codex' && text.includes('"rate_limits"')) await ingestCodexBudget(ctx, lines(text));
  // Every Claude session shares the plan limit too. A refused request carries the exact reset time.
  if (runtime === 'claude-code' && text.includes('"quotaLimits"')) await ingestClaudeLimit(ctx, lines(text));
  if (!text.includes('orch_tok_')) return;
  const rows = lines(text);
  const agentId = await agentFor(ctx.pool, rows);
  if (!agentId) {
    // No longer (or never) an agent's session: drop anything an earlier, looser pass attributed to it.
    await exec(ctx.pool, `DELETE FROM usage_daily WHERE source = ?`, [path]);
    return;
  }
  const parsed = runtime === 'codex' ? parseCodex(rows) : parseClaude(rows);
  const loop = copilotLoop(rows);
  const sums = new Map<string, Usage>();
  for (const u of parsed.usage) {
    const k = `${u.model}|${u.day}`;
    const s = sums.get(k) ?? { ...u, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    s.input += u.input;
    s.output += u.output;
    s.cacheRead += u.cacheRead;
    s.cacheWrite += u.cacheWrite;
    sums.set(k, s);
  }
  // The newest model or tool entry tells presence the agent is busy even when it is not calling the orchestrator.
  // Bookkeeping lines do not count: a Claude session stopped by the usage limit still appends queue-operation lines
  // every two minutes, which made it look busy (2026-10-09).
  const lastAt = lastActivityAt(rows);
  await tx(ctx, async (conn) => {
    const jobId = await jobFor(conn, agentId);
    if (lastAt) {
      await exec(conn, `UPDATE agent_sessions SET transcript_at = GREATEST(COALESCE(transcript_at, 0), ?) WHERE agent_id = ? AND ended_at IS NULL`, [new Date(lastAt), agentId]);
    }
    // A Claude Code session can be resumed by id in its own directory; remember both for the Client's resume command.
    const meta = runtime === 'codex' ? rows.find((r) => r.type === 'session_meta' && r.payload?.id && r.payload?.cwd)?.payload : null;
    const top = runtime === 'claude-code' ? rows.find((r) => r.sessionId && r.cwd && !r.isSidechain) : meta ? { sessionId: meta.id, cwd: meta.cwd } : null;
    if (top) {
      await exec(conn, `UPDATE agent_sessions SET transcript_session = ?, transcript_cwd = ? WHERE agent_id = ? AND ended_at IS NULL`, [String(top.sessionId), String(top.cwd), agentId]);
    }
    await exec(conn, `DELETE FROM usage_daily WHERE source = ?`, [path]);
    if (loop.awaitAt || loop.harvestAt) {
      await exec(conn, `INSERT INTO copilot_waits (agent_id, await_at, harvest_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE await_at = VALUES(await_at), harvest_at = VALUES(harvest_at)`, [
        agentId,
        loop.awaitAt,
        loop.harvestAt,
      ]);
    }
    for (const s of sums.values()) {
      await exec(
        conn,
        `INSERT INTO usage_daily (source, agent_id, runtime, model, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [path, agentId, runtime, s.model, s.day, s.input, s.output, s.cacheRead, s.cacheWrite],
      );
    }
    if (jobId) await exec(conn, `UPDATE artifacts SET job_id = ? WHERE agent_id = ? AND job_id IS NULL`, [jobId, agentId]);
    for (const a of parsed.artifacts) {
      const res: any = await exec(conn, `INSERT IGNORE INTO artifacts (kind, url, label, agent_id, job_id, at) VALUES (?, ?, ?, ?, ?, ?)`, [a.kind, a.url, a.label.slice(0, 300), agentId, jobId, a.at]);
      // Announce only fresh work. Re-reading an old transcript must not replay past pushes as news.
      if (res?.affectedRows === 1 && ctx.clock.now().getTime() - a.at.getTime() < 15 * 60_000) {
        await emit(conn, ctx, { type: 'artifact.recorded', jobId, actor: agentId, payload: { kind: a.kind, url: a.url, label: a.label } });
      }
    }
  });
}

/** Ingests every transcript that changed since the last pass. */
export async function ingestTelemetry(ctx: Ctx, dirs: { claude?: string; codex?: string }) {
  for (const [dir, runtime] of [
    [dirs.claude, 'claude-code'],
    [dirs.codex, 'codex'],
  ] as const) {
    if (!dir) continue;
    for await (const path of walk(dir)) {
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      const seen = await queryOne(ctx.pool, `SELECT size, mtime_ms FROM telemetry_files WHERE path = ?`, [path]);
      if (seen && Number(seen.size) === st.size && Number(seen.mtime_ms) === Math.floor(st.mtimeMs)) continue;
      try {
        await ingestFile(ctx, path, runtime);
      } catch (error) {
        console.error('telemetry: could not ingest', path, error);
        continue;
      }
      await exec(ctx.pool, `INSERT INTO telemetry_files (path, size, mtime_ms) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE size = VALUES(size), mtime_ms = VALUES(mtime_ms)`, [
        path,
        st.size,
        Math.floor(st.mtimeMs),
      ]);
    }
  }
}

export async function usageReport(conn: Conn) {
  const byDay = await query(
    conn,
    `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, model, runtime, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write
     FROM usage_daily GROUP BY day, model, runtime ORDER BY day, model`,
  );
  const byAgent = await query(
    conn,
    `SELECT MAX(u.agent_id) AS agent_id, a.nickname, a.role, u.model, COUNT(DISTINCT u.agent_id) AS sessions, SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output, SUM(u.cache_read_tokens) AS cache_read, SUM(u.cache_write_tokens) AS cache_write
     FROM usage_daily u LEFT JOIN agents a ON a.id = u.agent_id GROUP BY a.nickname, a.role, u.model ORDER BY output DESC`,
  );
  const num = (rows: any[]) => rows.map((r) => ({ ...r, input: Number(r.input), output: Number(r.output), cache_read: Number(r.cache_read), cache_write: Number(r.cache_write) }));
  return { by_day: num(byDay), by_agent: num(byAgent) };
}

export async function listArtifacts(conn: Conn, jobId?: string) {
  return query(
    conn,
    `SELECT x.*, j.linear_identifier FROM artifacts x LEFT JOIN jobs j ON j.id = x.job_id ${jobId ? 'WHERE x.job_id = ? OR j.parent_job_id = ?' : ''} ORDER BY x.at DESC LIMIT 200`,
    jobId ? [jobId, jobId] : [],
  );
}

/** What the Home map needs beyond agents and jobs: each job's PR, and which agents wait on Copilot now. */
export async function mapExtras(ctx: Ctx) {
  const prs = await query(
    ctx.pool,
    `SELECT COALESCE(j.parent_job_id, x.job_id) AS job_id, x.job_id AS own_job_id, x.url, x.label FROM artifacts x JOIN jobs j ON j.id = x.job_id
     WHERE x.kind = 'pr' AND x.id IN (SELECT MAX(id) FROM artifacts WHERE kind = 'pr' GROUP BY job_id)`,
  );
  // The delivery loop's wait gives up after 10 minutes, so an older await is no longer a wait.
  const since = new Date(ctx.clock.now().getTime() - 12 * 60_000);
  const waits = await query(ctx.pool, `SELECT agent_id, await_at FROM copilot_waits WHERE await_at > ? AND (harvest_at IS NULL OR harvest_at < await_at)`, [since]);
  return { prs, copilot_waiting: waits.map((w) => ({ agent_id: w.agent_id, since: w.await_at })) };
}

/**
 * Sessions the Client can bring back: Staff that stopped (a reboot, a usage limit) while owning open jobs.
 * Researchers have no long-lived session any more: they run per inbox batch (src/research.ts). Seniors run as Staff's subagents, so Staff restarts them once it is back.
 */
export async function resumeList(ctx: Ctx) {
  const rows = await query(
    ctx.pool,
    `SELECT a.id, a.nickname, a.role, a.runtime, a.focus, s.last_seen_at, s.waiting_until, s.ended_at, s.transcript_at, s.transcript_session, s.transcript_cwd,
       (SELECT GROUP_CONCAT(j.linear_identifier ORDER BY j.linear_identifier SEPARATOR ', ') FROM jobs j
          WHERE j.staff_agent_id = a.id AND j.status NOT IN ('done', 'cancelled')) AS jobs
     FROM agents a JOIN agent_sessions s ON s.agent_id = a.id
     WHERE s.ended_at IS NULL AND a.role = 'staff'`,
  );
  const model = await queryOne(ctx.pool, `SELECT model, effort FROM role_models WHERE role = 'researcher'`);
  // An agent that registered more than once (a restart that started fresh) shows once: its newest session.
  const newest = new Map<string, any>();
  for (const r of rows) {
    const k = `${r.role}|${r.nickname}`;
    if (!newest.has(k) || newest.get(k).last_seen_at < r.last_seen_at) newest.set(k, r);
  }
  const online = new Set(rows.filter((r) => !['stale', 'offline'].includes(presenceOf(ctx, r as any))).map((r) => `${r.role}|${r.nickname}`));
  return [...newest.values()]
    .filter((r) => !online.has(`${r.role}|${r.nickname}`))
    .filter((r) => (r.role === 'researcher' || r.jobs) && ['stale', 'offline'].includes(presenceOf(ctx, r as any)))
    .map((r) => {
      const l = { runtime: String(r.runtime), session_id: r.transcript_session, cwd: r.transcript_cwd, model: model?.model, effort: model?.effort };
      return {
        agent_id: r.id as string,
        nickname: r.nickname as string,
        role: r.role as string,
        jobs: r.role === 'staff' ? String(r.jobs) : null,
        focus: r.focus as string | null,
        last_seen_at: r.last_seen_at as Date,
        resumable: !!r.transcript_session && ['claude-code', 'codex'].includes(l.runtime),
        command: r.transcript_session ? `cd ${shq(String(r.transcript_cwd))} && ${resumeArgs({ ...l, prompt: promptFor(String(r.role)) }).map(shq).join(' ')}` : null,
      };
    });
}

export const lastActivityAt = (rows: any[]) => rows.reduce<number>((m, r) => (r.timestamp && ACTIVITY_TYPES.has(r.type) ? Math.max(m, new Date(r.timestamp).getTime() || 0) : m), 0);

/** Transcript line types that mean the model or a tool did something (Claude: assistant, user; Codex: response_item, event_msg). */
const ACTIVITY_TYPES = new Set(['assistant', 'user', 'response_item', 'event_msg']);

export const RESUME_PROMPT =
  'Triglav or this session was restarted (reboot or usage limit). Call get_guide with your role again (the guide may have changed), keep your session token, and continue your open work. For each assignment that was orphaned, restart a Senior that continues from its existing worktree, branch and PR. Ask the Client only through blockers or ask_question.';
const RESEARCHER_PROMPT =
  'Triglav or this session was restarted (reboot or usage limit). Call get_guide with role researcher again, keep your session token and focus, and go back to waiting for questions on the message board. If a wait call drops, retry it.';
const promptFor = (role: string) => (role === 'researcher' ? RESEARCHER_PROMPT : RESUME_PROMPT);

// Staff sessions compact at about 280k tokens instead of the default 980k (Claude Code 2.1.292: --settings autoCompactWindow
// 300000 gives effectiveWindow=280000). Each turn re-reads the whole context, so this is the main cost lever. Keep
// the three copies (src/telemetry.ts, scripts/runner.ts, web/src/App.tsx) the same.
export const STAFF_CLAUDE_SETTINGS = '{"autoCompactWindow":300000}';

/** The one command shape per runtime. The runner rebuilds it from the same fields; this copy is for the dashboard's Copy button. */
export function resumeArgs(l: { runtime: string; session_id: string; prompt: string; model?: string | null; effort?: string | null }): string[] {
  if (l.runtime === 'codex') {
    return ['codex', 'exec', 'resume', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
      ...(l.model ? ['-m', l.model] : []), ...(l.effort ? ['-c', `model_reasoning_effort="${l.effort}"`] : []), l.session_id, l.prompt];
  }
  return ['claude', '--bg', '--settings', STAFF_CLAUDE_SETTINGS, '--resume', l.session_id, l.prompt];
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The Client asks for a stopped Staff or researcher session to be resumed. The host runner (scripts/runner.ts) carries it out. */
export async function requestResume(ctx: Ctx, agentId: string) {
  const r = await queryOne(ctx.pool, `SELECT s.transcript_session, s.transcript_cwd, a.runtime, a.role FROM agent_sessions s JOIN agents a ON a.id = s.agent_id WHERE s.agent_id = ? AND s.ended_at IS NULL`, [agentId]);
  const m = r?.runtime === 'codex' ? await queryOne(ctx.pool, `SELECT model, effort FROM role_models WHERE role = ?`, [r.role]) : null;
  if (!r?.transcript_session) throw new Error('No resumable Claude Code session is known for this agent yet.');
  const pending = await queryOne(ctx.pool, `SELECT id FROM launches WHERE agent_id = ? AND finished_at IS NULL`, [agentId]);
  if (pending) return { id: pending.id as string, already_queued: true };
  const id = `lch_${randomBytes(8).toString('hex')}`;
  await exec(ctx.pool, `INSERT INTO launches (id, agent_id, session_id, cwd, runtime, model, effort, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    id, agentId, r.transcript_session, r.transcript_cwd, r.runtime, m?.model ?? null, m?.effort ?? null, ctx.clock.now(),
  ]);
  return { id, already_queued: false };
}

/**
 * Launches unpicked for 10 minutes are dropped so a late runner does not replay them. A job request whose launch was
 * dropped, or was picked and never reported (the runner died), shows as failed so the Client can ask again.
 */
export async function expireStaleLaunches(ctx: Ctx) {
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - 10 * 60_000);
  const expired = await query(ctx.pool, `SELECT * FROM launches WHERE picked_at IS NULL AND finished_at IS NULL AND requested_at < ?`, [cutoff]);
  await exec(ctx.pool, `UPDATE launches SET finished_at = ?, result = 'expired: no runner picked it up' WHERE picked_at IS NULL AND finished_at IS NULL AND requested_at < ?`, [now, cutoff]);
  for (const l of expired) await settleRequestOfLaunch(ctx.pool, ctx, l, 'failed: expired: no runner picked it up');
  const lost = await query(ctx.pool, `SELECT * FROM launches WHERE kind = 'staff_start' AND picked_at IS NOT NULL AND finished_at IS NULL AND picked_at < ?`, [new Date(now.getTime() - 5 * 60_000)]);
  for (const l of lost) {
    await exec(ctx.pool, `UPDATE launches SET finished_at = ?, result = 'failed: the runner did not report back' WHERE id = ? AND finished_at IS NULL`, [now, l.id]);
    await settleRequestOfLaunch(ctx.pool, ctx, l, 'failed: the runner did not report back');
  }
}

/** The runner takes the oldest unpicked launch. */
export async function nextLaunch(ctx: Ctx) {
  const now = ctx.clock.now();
  await expireStaleLaunches(ctx);
  return tx(ctx, async (conn) => {
    const l = await queryOne(conn, `SELECT * FROM launches WHERE picked_at IS NULL AND finished_at IS NULL ORDER BY requested_at LIMIT 1 FOR UPDATE`);
    if (!l) return null;
    await exec(conn, `UPDATE launches SET picked_at = ? WHERE id = ?`, [now, l.id]);
    if (l.kind === 'research_run') {
      await exec(conn, `UPDATE launches SET ticket = NULL WHERE id = ?`, [l.id]);
      return { id: l.id as string, kind: 'research_run', run_id: l.run_id as string, runtime: l.runtime as string, cwd: l.cwd as string, model: l.model, effort: l.effort, prompt: RESEARCH_PROMPT(String(l.ticket)) };
    }
    if (l.kind === 'staff_start') {
      // Only the request id travels: the runner builds the command and the start prompt itself.
      return { id: l.id as string, kind: 'staff_start', request_id: l.run_id as string, runtime: l.runtime as string, cwd: l.cwd as string, model: l.model, effort: l.effort };
    }
    if (l.kind !== 'resume') {
      // A kind this server version does not know must not run as a resume.
      await exec(conn, `UPDATE launches SET finished_at = ?, result = ? WHERE id = ?`, [now, `failed: unknown launch kind ${String(l.kind).slice(0, 40)}`, l.id]);
      return null;
    }
    const role = (await queryOne(conn, `SELECT role FROM agents WHERE id = ?`, [l.agent_id]))?.role;
    return { id: l.id as string, kind: 'resume', runtime: l.runtime as string, session_id: l.session_id as string, cwd: l.cwd as string, model: l.model, effort: l.effort, prompt: promptFor(String(role)) };
  });
}

export async function finishLaunch(ctx: Ctx, id: string, result: string) {
  await tx(ctx, async (conn) => {
    await exec(conn, `UPDATE launches SET finished_at = ?, result = ? WHERE id = ?`, [ctx.clock.now(), result.slice(0, 2000), id]);
    const l = await queryOne(conn, `SELECT * FROM launches WHERE id = ?`, [id]);
    if (l) await settleRequestOfLaunch(conn, ctx, l, result);
  });
}

export async function recentLaunches(ctx: Ctx) {
  return query(ctx.pool, `SELECT l.*, a.nickname FROM launches l LEFT JOIN agents a ON a.id = l.agent_id ORDER BY l.requested_at DESC LIMIT 10`);
}

/** The newest refused Claude request in a transcript: the window it hit is at 100% until its reset time. */
async function ingestClaudeLimit(ctx: Ctx, rows: any[]) {
  let answeredAt: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    // A normal model turn after the refusal means the limit no longer applies (it reset, or the Client switched accounts).
    if (r?.type === 'assistant' && !r.quotaLimits && r.message?.usage?.output_tokens && r.timestamp && !answeredAt) answeredAt = r.timestamp;
    const q = r?.quotaLimits;
    if (!q || q.status !== 'rejected' || !q.rateLimitType || !q.resetsAt || !r.timestamp) continue;
    if (answeredAt) {
      await exec(ctx.pool, `DELETE FROM claude_usage WHERE window_kind = ? AND source = 'transcript' AND observed_at <= ?`, [String(q.rateLimitType).slice(0, 20), new Date(answeredAt)]);
    } else {
      await recordClaudeUsage(ctx.pool, { window: String(q.rateLimitType), used: 100, resetsAt: new Date(Number(q.resetsAt) * 1000), at: new Date(r.timestamp), source: 'transcript' });
    }
    return;
  }
}

/** Claude plan usage per window (five_hour, seven_day...). A reading never replaces a newer one. */
export async function recordClaudeUsage(conn: Conn, r: { window: string; used: number; resetsAt: Date | null; at: Date; source: string }) {
  await exec(
    conn,
    `INSERT INTO claude_usage (window_kind, used_percent, resets_at, observed_at, source) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE used_percent = IF(VALUES(observed_at) >= observed_at, VALUES(used_percent), used_percent),
       resets_at = IF(VALUES(observed_at) >= observed_at, VALUES(resets_at), resets_at),
       source = IF(VALUES(observed_at) >= observed_at, VALUES(source), source),
       observed_at = GREATEST(observed_at, VALUES(observed_at))`,
    [r.window.slice(0, 20), Math.max(0, Math.min(100, r.used)), r.resetsAt, r.at, r.source],
  );
}

/** Plan limits for the Usage page. A window whose reset time has passed is shown as reset, not as its old reading. */
export async function planLimits(conn: Conn, now: Date) {
  const fresh = (used: number, resetsAt: Date | null) => (resetsAt && resetsAt <= now ? { used: 0, resets_at: null, reset: true } : { used, resets_at: resetsAt, reset: false });
  const claude = (await query(conn, `SELECT * FROM claude_usage ORDER BY window_kind`)).map((r) => ({
    window: r.window_kind as string,
    observed_at: r.observed_at,
    source: r.source,
    ...fresh(Number(r.used_percent), r.resets_at as Date | null),
  }));
  const c = await queryOne(conn, `SELECT * FROM codex_budget WHERE id = 1`);
  const codex = c
    ? [
        { window: 'five_hour', observed_at: c.observed_at, source: 'transcript', ...fresh(Number(c.used_percent), c.resets_at as Date | null) },
        ...(c.weekly_used_percent != null ? [{ window: 'seven_day', observed_at: c.observed_at, source: 'transcript', ...fresh(Number(c.weekly_used_percent), c.weekly_resets_at as Date | null) }] : []),
      ]
    : [];
  return { claude, codex };
}

/** The newest Codex plan-limit reading in a transcript, for the research dispatcher's budget guard. */
async function ingestCodexBudget(ctx: Ctx, rows: any[]) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const rl = r?.payload?.rate_limits;
    if (r?.payload?.type !== 'token_count' || rl?.limit_id !== 'codex' || !rl.primary) continue;
    const at = (s: number | undefined) => (s ? new Date(s * 1000) : null);
    await recordCodexBudget(ctx.pool, {
      used: Number(rl.primary.used_percent),
      windowMin: rl.primary.window_minutes ?? null,
      resetsAt: at(rl.primary.resets_at),
      weekly: rl.secondary ? Number(rl.secondary.used_percent) : null,
      weeklyResetsAt: at(rl.secondary?.resets_at),
      at: new Date(r.timestamp),
    });
    return;
  }
}
