import { open, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Ctx } from './context.ts';
import { query, queryOne } from './db.ts';
import { notFound, redactSecrets } from './lib.ts';

/*
 * The stream of one agent: what its CLI wrote to its transcript, as plain entries for the dashboard.
 * Transcripts are mounted read-only into the server (see telemetry.ts). The files come from `usage_daily.source`,
 * which ingest only fills for a transcript it attributed to this agent, and each must lie under a telemetry directory.
 * Everything here is agent text: it is shown as plain text, never followed.
 */

export type StreamKind = 'thinking' | 'text' | 'tool' | 'result' | 'user' | 'error';

export interface StreamEntry {
  at: string;
  kind: StreamKind;
  text: string;
  /** The tool name, for `tool` entries. */
  tool?: string;
  /** The entry was cut to `MAX_ENTRY_CHARS`. */
  cut?: boolean;
}

export const MAX_ENTRY_CHARS = 4000;
const TAIL_BYTES = 1_500_000;
export const DEFAULT_LIMIT = 300;
export const MAX_LIMIT = 1000;

const textOf = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).filter(Boolean).join('\n') : '';

function entry(at: string, kind: StreamKind, raw: string, tool?: string): StreamEntry[] {
  const text = raw.trim();
  if (!text) return [];
  const cut = text.length > MAX_ENTRY_CHARS;
  return [{ at, kind, text: redactSecrets(cut ? text.slice(0, MAX_ENTRY_CHARS) : text), ...(tool ? { tool } : {}), ...(cut ? { cut } : {}) }];
}

/**
 * The entries of one transcript line. `hidden` counts thinking blocks that carry no text: Claude Code usually stores only
 * the signature of a thinking block, so most of an agent's thinking cannot be shown (checked 2026-10-17: 224 of 224 blocks
 * in one subagent transcript were empty).
 */
export function entriesOf(row: any): { entries: StreamEntry[]; hidden: number } {
  const at = typeof row?.timestamp === 'string' ? row.timestamp : '';
  if (!at) return { entries: [], hidden: 0 };
  const out: StreamEntry[] = [];
  let hidden = 0;
  const content = row?.message?.content;
  if (row.type === 'assistant' && row.isApiErrorMessage) {
    out.push(...entry(at, 'error', textOf(content)));
  } else if (row.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'thinking') {
        if (typeof c.thinking === 'string' && c.thinking.trim()) out.push(...entry(at, 'thinking', c.thinking));
        else hidden++;
      } else if (c?.type === 'text') out.push(...entry(at, 'text', String(c.text ?? '')));
      else if (c?.type === 'tool_use') out.push(...entry(at, 'tool', JSON.stringify(c.input ?? {}), String(c.name ?? 'tool')));
    }
  } else if (row.type === 'user' && !row.isMeta) {
    if (typeof content === 'string') out.push(...entry(at, 'user', content));
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_result') out.push(...entry(at, 'result', textOf(c.content)));
        else if (c?.type === 'text') out.push(...entry(at, 'user', String(c.text ?? '')));
      }
    }
  } else if (row.type === 'response_item') {
    // Codex. `event_msg` lines repeat the messages, so only response items are read.
    const p = row.payload ?? {};
    if (p.type === 'message' && p.role === 'assistant') out.push(...entry(at, 'text', textOf(p.content)));
    else if (p.type === 'message' && p.role === 'user') out.push(...entry(at, 'user', textOf(p.content)));
    else if (p.type === 'reasoning') {
      const t = textOf(p.summary) || textOf(p.content);
      if (t) out.push(...entry(at, 'thinking', t));
      else hidden++;
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') out.push(...entry(at, 'tool', String(p.arguments ?? p.input ?? ''), String(p.name ?? 'tool')));
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') out.push(...entry(at, 'result', typeof p.output === 'string' ? p.output : textOf(p.output)));
  }
  return { entries: out, hidden };
}

/** The last `bytes` of a file as lines, without the first line when the read started inside it. */
async function tailLines(path: string, bytes = TAIL_BYTES): Promise<{ lines: string[]; partial: boolean }> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines, partial: start > 0 };
  } finally {
    await fh.close();
  }
}

export interface AgentStream {
  entries: StreamEntry[];
  /** Thinking blocks in the read part of the transcripts that have no text to show. */
  hidden_thinking: number;
  files: number;
  /** Older entries exist than the ones returned. */
  more: boolean;
}

/** The newest `limit` entries across the agent's transcripts, oldest first. */
export async function agentStream(ctx: Ctx, agentId: string, dirs: { claude?: string; codex?: string }, limit = DEFAULT_LIMIT): Promise<AgentStream> {
  if (!(await queryOne(ctx.pool, `SELECT id FROM agents WHERE id = ?`, [agentId]))) throw notFound(`Agent ${agentId}`);
  const roots = [dirs.claude, dirs.codex].filter((d): d is string => !!d).map((d) => resolve(d) + sep);
  const sources = await query(ctx.pool, `SELECT DISTINCT source FROM usage_daily WHERE agent_id = ?`, [agentId]);
  const paths = sources.map((s) => resolve(String(s.source))).filter((p) => roots.some((r) => p.startsWith(r)));
  const all: StreamEntry[] = [];
  let hidden = 0;
  let more = false;
  let files = 0;
  for (const path of paths) {
    let read;
    try {
      read = await tailLines(path);
    } catch {
      continue;
    }
    files++;
    more ||= read.partial;
    for (const l of read.lines) {
      if (!l) continue;
      let row;
      try {
        row = JSON.parse(l);
      } catch {
        continue;
      }
      const r = entriesOf(row);
      all.push(...r.entries);
      hidden += r.hidden;
    }
  }
  all.sort((a, b) => a.at.localeCompare(b.at));
  const n = Math.min(Math.max(1, limit), MAX_LIMIT);
  more ||= all.length > n;
  return { entries: all.slice(-n), hidden_thinking: hidden, files, more };
}

/*
 * What each live agent is doing now, for the live map: the newest transcript entries, turned into a few words each.
 * Read from the transcript and not asked of the agent, so it costs the agent nothing and still moves when the agent is stuck.
 */

const NOW_TAIL_BYTES = 96_000;
const RECENT = 5;

const ORCHESTRATOR_WORDS: Record<string, string> = {
  wait_for_events: 'Waiting for events',
  await_question: 'Waiting for an answer',
  ask_question: 'Asking a question',
  report_progress: 'Reporting progress',
  request_code_review: 'Asking for a local code review',
  get_code_review: 'Reading the local code review',
  request_copilot_review: 'Asking Copilot for a review',
  record_copilot_result: 'Recording the Copilot result',
  submit_review_package: 'Submitting for review',
  request_plan_review: 'Asking for a plan review',
  record_verdict: 'Recording a review verdict',
  post_message: 'Posting on the board',
  get_job: 'Reading the job',
  get_thread: 'Reading a thread',
  get_item: 'Reading a board item',
  raise_blocker: 'Raising a blocker',
  create_spawn_ticket: 'Starting a Senior',
  report_delivery: 'Reporting delivery',
  submit_report: 'Submitting the report',
};

const base = (p: unknown) => String(p ?? '').split('/').filter(Boolean).pop() ?? '';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A tool call in a few words. Wait loops (a sleep in Bash) read as waiting, so a Staff between events does not look busy. */
export function describeTool(tool: string, inputText: string): string {
  let input: any = {};
  try {
    input = JSON.parse(inputText);
  } catch {
    // Cut at MAX_ENTRY_CHARS, or a Codex call with plain text arguments.
  }
  if (tool.startsWith('mcp__orchestrator__')) {
    const name = tool.slice('mcp__orchestrator__'.length);
    return ORCHESTRATOR_WORDS[name] ?? clip(name.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()), 48);
  }
  switch (tool) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `Editing ${base(input.file_path ?? input.notebook_path)}`;
    case 'Grep':
      return `Searching for ${clip(String(input.pattern ?? ''), 32)}`;
    case 'Glob':
      return `Listing ${clip(String(input.pattern ?? ''), 32)}`;
    case 'Agent':
    case 'Task':
      return `Delegated: ${clip(String(input.description ?? 'a subagent'), 48)}`;
    case 'TodoWrite': {
      const doing = Array.isArray(input.todos) ? input.todos.find((t: any) => t?.status === 'in_progress') : undefined;
      return doing ? clip(String(doing.activeForm ?? doing.content), 60) : 'Updating its plan';
    }
    case 'WebSearch':
      return `Searching the web for ${clip(String(input.query ?? ''), 32)}`;
    case 'WebFetch':
      return `Reading ${(() => { try { return new URL(String(input.url)).host; } catch { return 'a web page'; } })()}`;
    case 'Skill':
      return `Using the ${clip(String(input.skill ?? ''), 32)} skill`;
    case 'Bash':
    case 'shell':
    case 'exec_command': {
      const cmd = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? input.cmd ?? inputText);
      if (/^\s*(timeout \d+ tail -f \/dev\/null|sleep \d+)/.test(cmd)) return 'Waiting';
      if (typeof input.description === 'string' && input.description.trim()) return clip(input.description.trim(), 60);
      return `Running ${clip(cmd.replace(/^cd \S+ && /, '').trim(), 48)}`;
    }
    case 'apply_patch':
      return 'Editing files';
    default:
      return clip(tool.replace(/^mcp__[^_]+__/, '').replaceAll('_', ' '), 48);
  }
}

export interface AgentNow {
  /** The newest transcript entry of any kind: the agent's heartbeat. */
  at: string;
  /** What it is doing, and since when: a run of the same action (a wait loop) counts from its first call. */
  doing?: { text: string; since: string; running: boolean };
  /** The agent's newest message in its own words. */
  said?: { text: string; at: string };
  /** The last few actions before `doing`, newest first, with repeats folded. */
  recent: { text: string; at: string }[];
}

/** The `AgentNow` of one transcript tail, oldest entry first. */
export function nowOf(entries: StreamEntry[]): AgentNow | null {
  if (!entries.length) return null;
  const out: AgentNow = { at: entries[entries.length - 1].at, recent: [] };
  const runs: { text: string; at: string; since: string }[] = [];
  let resultAfterLastTool = false;
  for (const e of entries) {
    if (e.kind === 'text') out.said = { text: clip(e.text.replace(/\s+/g, ' '), 240), at: e.at };
    if (e.kind === 'result') resultAfterLastTool = true;
    if (e.kind !== 'tool') continue;
    resultAfterLastTool = false;
    const text = describeTool(e.tool ?? 'tool', e.text);
    const last = runs[runs.length - 1];
    // A sleep loop right after a wait call is the same wait: the agent idles until something arrives.
    if (last && (last.text === text || (text === 'Waiting' && last.text.startsWith('Waiting')))) last.at = e.at;
    else runs.push({ text, at: e.at, since: e.at });
  }
  const current = runs.pop();
  if (current) out.doing = { text: current.text, since: current.since, running: !resultAfterLastTool };
  out.recent = runs.slice(-RECENT).reverse().map((r) => ({ text: r.text, at: r.at }));
  return out;
}

/** What each agent with an open session is doing, from the newest of its transcripts. */
export async function agentsNow(ctx: Ctx, dirs: { claude?: string; codex?: string }): Promise<Record<string, AgentNow>> {
  const roots = [dirs.claude, dirs.codex].filter((d): d is string => !!d).map((d) => resolve(d) + sep);
  if (!roots.length) return {};
  const rows = await query(
    ctx.pool,
    `SELECT DISTINCT u.agent_id, u.source FROM usage_daily u
     WHERE u.agent_id IN (SELECT agent_id FROM agent_sessions WHERE ended_at IS NULL)`,
  );
  const newest = new Map<string, { path: string; mtime: number }>();
  for (const r of rows) {
    const path = resolve(String(r.source));
    if (!roots.some((root) => path.startsWith(root))) continue;
    try {
      const { mtimeMs } = await stat(path);
      const cur = newest.get(r.agent_id);
      if (!cur || cur.mtime < mtimeMs) newest.set(r.agent_id, { path, mtime: mtimeMs });
    } catch {
      continue;
    }
  }
  const out: Record<string, AgentNow> = {};
  for (const [agentId, { path }] of newest) {
    let read;
    try {
      read = await tailLines(path, NOW_TAIL_BYTES);
    } catch {
      continue;
    }
    const entries: StreamEntry[] = [];
    for (const l of read.lines) {
      if (!l) continue;
      try {
        entries.push(...entriesOf(JSON.parse(l)).entries);
      } catch {
        continue;
      }
    }
    const now = nowOf(entries);
    if (now) out[agentId] = now;
  }
  return out;
}
