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

/** The last `TAIL_BYTES` of a file as lines, without the first line when the read started inside it. */
async function tailLines(path: string): Promise<{ lines: string[]; partial: boolean }> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
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
