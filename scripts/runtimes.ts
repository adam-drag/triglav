import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * Which agent CLIs this machine has, and which models each offers. Triglav runs in Docker and cannot look, so the host
 * runner asks each CLI and reports the answer. A CLI that does not start, or does not answer in time, counts as missing:
 * the runner could not launch it either. Models come from the CLI's own catalog, so the dashboard never asks for a typed name.
 */
export const CLIS = { 'claude-code': 'claude', codex: 'codex' } as const;
export type Runtime = keyof typeof CLIS;

export type Model = { id: string; label: string; efforts: string[] };
export type Found = Record<Runtime, { version: string; models: Model[] } | null>;

const version = (bin: string) =>
  new Promise<string | null>((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim().split('\n')[0].slice(0, 100) || 'unknown version'));
  });

const efforts = (levels: unknown): string[] => (Array.isArray(levels) ? levels.map((l) => (typeof l === 'string' ? l : (l as { effort?: unknown })?.effort)).filter((e): e is string => typeof e === 'string') : []);

/** The listed models of `codex debug models`. Hidden ones are internal or old. */
export function codexModels(catalog: any): Model[] {
  return (catalog?.models ?? [])
    .filter((m: any) => m?.visibility === 'list' && typeof m.slug === 'string')
    .map((m: any) => ({ id: m.slug, label: String(m.display_name ?? m.slug), efforts: efforts(m.supported_reasoning_levels) }))
    .filter((m: Model) => m.efforts.length);
}

/**
 * The models in Claude Code's reply to the stream-json `initialize` request. A model is its full name (`resolvedModel`),
 * listed once: the "default" entry is skipped because the model it points at is listed under its alias too. A model with
 * no effort levels is left out, because a role always has an effort.
 */
export function claudeModels(initialize: any): Model[] {
  const seen = new Map<string, Model>();
  for (const m of initialize?.models ?? []) {
    const id = m?.resolvedModel;
    const levels = efforts(m?.supportedEffortLevels);
    if (m?.value === 'default' || typeof id !== 'string' || !levels.length || seen.has(id)) continue;
    seen.set(id, { id, label: String(m.displayName ?? id), efforts: levels });
  }
  return [...seen.values()];
}

const run = (bin: string, args: string[]) =>
  new Promise<any>((resolve) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      try {
        resolve(err ? null : JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });

/** Asks Claude Code for its models. No model runs: it answers the control request and is stopped. */
function askClaude(bin: string): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const finish = (value: any) => {
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 30_000);
    child.once('error', () => finish(null));
    child.once('exit', () => finish(null));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const o = JSON.parse(line);
          if (o.type === 'control_response' && o.response?.request_id === 'models') return finish(o.response.response ?? null);
        } catch {}
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n');
  });
}

// Asking a CLI for its models starts it, so the answer is kept for an hour, or until its version changes.
const cache = new Map<string, { version: string; at: number; models: Model[] }>();
const KEEP_MS = 60 * 60_000;

async function modelsOf(runtime: Runtime, bin: string, ver: string): Promise<Model[]> {
  const hit = cache.get(runtime);
  if (hit && hit.version === ver && Date.now() - hit.at < KEEP_MS) return hit.models;
  const models = runtime === 'codex' ? codexModels(await run(bin, ['debug', 'models'])) : claudeModels(await askClaude(bin));
  // An empty answer (the CLI was busy, or too old) is not kept, so the next check asks again.
  if (models.length) cache.set(runtime, { version: ver, at: Date.now(), models });
  return models;
}

export async function detectRuntimes(bins: Record<Runtime, string> = CLIS): Promise<Found> {
  const found = {} as Found;
  await Promise.all(
    (Object.keys(CLIS) as Runtime[]).map(async (rt) => {
      const ver = await version(bins[rt]);
      found[rt] = ver === null ? null : { version: ver, models: await modelsOf(rt, bins[rt], ver) };
    }),
  );
  return found;
}
