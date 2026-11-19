import { open } from 'node:fs/promises';
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
  /** The tool call a `tool` or `result` entry belongs to, so a result can be matched to its call. */
  id?: string;
  /** The entry was cut to `MAX_ENTRY_CHARS`. */
  cut?: boolean;
}

export const MAX_ENTRY_CHARS = 4000;
const TAIL_BYTES = 1_500_000;
export const DEFAULT_LIMIT = 300;
export const MAX_LIMIT = 1000;

const textOf = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).filter(Boolean).join('\n') : '';

function entry(at: string, kind: StreamKind, raw: string, tool?: string, id?: unknown): StreamEntry[] {
  const text = raw.trim();
  if (!text) return [];
  const cut = text.length > MAX_ENTRY_CHARS;
  return [{ at, kind, text: redactSecrets(cut ? text.slice(0, MAX_ENTRY_CHARS) : text), ...(tool ? { tool } : {}), ...(typeof id === 'string' && id ? { id } : {}), ...(cut ? { cut } : {}) }];
}

/** A tool result. An empty one has nothing to show, but with `markers` it is kept so its call reads as finished. */
function resultEntry(at: string, raw: string, id: unknown, markers: boolean): StreamEntry[] {
  const shown = entry(at, 'result', raw, undefined, id);
  return shown.length || !markers || typeof id !== 'string' || !id ? shown : [{ at, kind: 'result', text: '', id }];
}

/**
 * The entries of one transcript line. `hidden` counts thinking blocks that carry no text: Claude Code usually stores only
 * the signature of a thinking block, so most of an agent's thinking cannot be shown (checked 2026-10-17: 224 of 224 blocks
 * in one subagent transcript were empty).
 */
export function entriesOf(row: any, { markers = false } = {}): { entries: StreamEntry[]; hidden: number } {
  const at = typeof row?.timestamp === 'string' ? row.timestamp : '';
  if (!at) return { entries: [], hidden: 0 };
  const out: StreamEntry[] = [];
  let hidden = 0;
  const content = row?.message?.content;
  // Call ids are only for matching results to calls (`nowOf`); the Stream panel does not need them.
  const idOf = (id: unknown) => (markers ? id : undefined);
  if (row.type === 'assistant' && row.isApiErrorMessage) {
    out.push(...entry(at, 'error', textOf(content)));
  } else if (row.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'thinking') {
        if (typeof c.thinking === 'string' && c.thinking.trim()) out.push(...entry(at, 'thinking', c.thinking));
        else hidden++;
      } else if (c?.type === 'text') out.push(...entry(at, 'text', String(c.text ?? '')));
      else if (c?.type === 'tool_use') out.push(...entry(at, 'tool', JSON.stringify(c.input ?? {}), String(c.name ?? 'tool'), idOf(c.id)));
    }
  } else if (row.type === 'user' && !row.isMeta) {
    if (typeof content === 'string') out.push(...entry(at, 'user', content));
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_result') out.push(...resultEntry(at, textOf(c.content), idOf(c.tool_use_id), markers));
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
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') out.push(...entry(at, 'tool', String(p.arguments ?? p.input ?? ''), String(p.name ?? 'tool'), idOf(p.call_id)));
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') out.push(...resultEntry(at, typeof p.output === 'string' ? p.output : textOf(p.output), idOf(p.call_id), markers));
  }
  return { entries: out, hidden };
}

/** The last `bytes` of a file as lines, without the first line when the read started inside it. */
export async function tailLines(path: string, bytes = TAIL_BYTES): Promise<{ lines: string[]; partial: boolean }> {
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

export const NOW_TAIL_BYTES = 96_000;
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
      // The whole command, so a sleep followed by real work reads as that work.
      if (/^\s*(timeout \d+ tail -f \/dev\/null|sleep \d+)\s*(;\s*true)?\s*$/.test(cmd)) return 'Waiting';
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

/**
 * The `AgentNow` of one transcript tail, oldest entry first, read with `entriesOf(row, { markers: true })` so that a call
 * whose result was empty still reads as finished. `lastAt` is the newest activity of the tail in ms
 * (`lastActivityAt` in src/telemetry.ts): it also counts thinking blocks without text, which give no entry.
 */
export function nowOf(entries: StreamEntry[], lastAt = 0): AgentNow | null {
  // An API error line is not activity (`lastActivityAt` skips it too), so the heartbeat is the newest other entry.
  let last: string | undefined;
  for (const e of entries) if (e.kind !== 'error') last = e.at;
  const at = lastAt > (last ? new Date(last).getTime() || 0 : 0) ? new Date(lastAt).toISOString() : last;
  if (!at) return null;
  const out: AgentNow = { at, recent: [] };
  const runs: { text: string; at: string; since: string }[] = [];
  // The calls of the newest batch (issued since the last result or prompt) that have no result yet, with their run. A
  // result answers its own call: in a parallel batch, a Read that returns must not finish a wait still running. An older
  // call without a result (an interrupted one) is not in the batch, so it cannot hold the status for ever.
  const open = new Map<string, number>();
  let lastTool: StreamEntry | undefined;
  let resultAfterLastTool = false;
  let newBatch = false;
  for (const e of entries) {
    if (e.kind === 'text') out.said = { text: clip(e.text.replace(/\s+/g, ' '), 240), at: e.at };
    if (e.kind === 'user') newBatch = true;
    if (e.kind === 'result') {
      resultAfterLastTool = newBatch = true;
      if (e.id) open.delete(e.id);
    }
    if (e.kind !== 'tool') continue;
    if (newBatch) open.clear();
    newBatch = false;
    lastTool = e;
    resultAfterLastTool = false;
    const text = describeTool(e.tool ?? 'tool', e.text);
    const last = runs[runs.length - 1];
    // A sleep loop right after a wait call is the same wait: the agent idles until something arrives.
    if (last && (last.text === text || (text === 'Waiting' && last.text.startsWith('Waiting')))) last.at = e.at;
    else runs.push({ text, at: e.at, since: e.at });
    if (e.id) open.set(e.id, runs.length - 1);
  }
  // A call still running is what the agent does, even when a later call of its batch already returned.
  const idx = open.size ? Math.max(...open.values()) : runs.length - 1;
  const current = runs[idx];
  // Without an id (an older transcript format), any later result counts.
  const running = open.size > 0 || (!lastTool?.id && !resultAfterLastTool);
  if (current) out.doing = { text: current.text, since: current.since, running };
  out.recent = runs.filter((_, i) => i !== idx).slice(-RECENT).reverse().map((r) => ({ text: r.text, at: r.at }));
  return out;
}
