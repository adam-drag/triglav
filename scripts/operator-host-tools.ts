/**
 * The host commands the Operator may run, as tools with fixed commands and checked arguments.
 *
 * The Operator has no Bash. A shell command with a read-only prefix is not read-only (`git log --output=FILE`, or
 * `> FILE`), so each command it needs is a tool here: the program and every option are fixed, the arguments are a short
 * id, a service from a list or a number in a range, and nothing goes through a shell. A tool takes no other property
 * (the schemas are strict), so an option can never be passed in. Kept apart from operator-host-mcp.ts so the tests can import it.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { staffStartEnv } from './staff-start.ts';

export const SHORT_SESSION = /^[0-9a-f]{8}$/;
export const COMPOSE_SERVICES = ['orchestrator', 'mysql'] as const;
const MAX_OUTPUT = 60_000;
const TIMEOUT_MS = 20_000;

type Command = { bin: string; args: string[] };
type HostTool<S extends z.ZodObject<any>> = { description: string; schema: S; command: (a: z.infer<S>) => Command };
const tool = <S extends z.ZodObject<any>>(t: HostTool<S>) => t;

const count = (max: number) => z.number().int().min(1).max(max);

export const HOST_TOOLS = {
  agents: tool({
    description: 'The Claude Code background sessions on this machine: `claude agents --json`.',
    schema: z.object({}).strict(),
    command: () => ({ bin: 'claude', args: ['agents', '--json'] }),
  }),
  logs: tool({
    description: 'The recent output of one Claude Code background session: `claude logs <id>`. The id is the 8 hex characters `agents` shows.',
    schema: z.object({ id: z.string().regex(SHORT_SESSION) }).strict(),
    command: (a) => ({ bin: 'claude', args: ['logs', a.id] }),
  }),
  compose_ps: tool({
    description: 'The state of the Triglav containers: `docker compose ps`.',
    schema: z.object({}).strict(),
    command: () => ({ bin: 'docker', args: ['compose', 'ps'] }),
  }),
  compose_logs: tool({
    description: 'The last lines of a Triglav container log: `docker compose logs --tail N <service>`.',
    schema: z.object({ service: z.enum(COMPOSE_SERVICES), tail: count(2000).default(200) }).strict(),
    command: (a) => ({ bin: 'docker', args: ['compose', 'logs', '--no-color', '--tail', String(a.tail), a.service] }),
  }),
  git_status: tool({
    description: 'The working tree state of this repository: `git status --short --branch`.',
    schema: z.object({}).strict(),
    command: () => ({ bin: 'git', args: ['--no-pager', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch'] }),
  }),
  git_log: tool({
    description: 'The last commits of this repository: `git log -n N`, one line each.',
    schema: z.object({ n: count(200).default(20) }).strict(),
    command: (a) => ({ bin: 'git', args: ['--no-pager', 'log', '--no-color', '--no-ext-diff', '--no-textconv', '-n', String(a.n), '--date=short', '--format=%h %ad %an %s'] }),
  }),
};

export type HostToolName = keyof typeof HOST_TOOLS;

/** Checks the arguments and builds the command. Throws on an unknown tool, an unknown property or a value out of range. */
export function buildHostCommand(name: string, args: unknown): Command {
  if (!Object.hasOwn(HOST_TOOLS, name)) throw new Error(`Unknown host tool ${JSON.stringify(name.slice(0, 40))}.`);
  const t = HOST_TOOLS[name as HostToolName] as HostTool<z.ZodObject<any>>;
  const parsed = t.schema.safeParse(args ?? {});
  if (!parsed.success) throw new Error(`Bad arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
  return t.command(parsed.data);
}

/**
 * Runs the command in `cwd` without a shell and without the orchestrator's keys. Output is capped: the command's stdout
 * is read to its end, only the first MAX_OUTPUT characters are kept, and a longer output is cut with a note instead of
 * failing. A command that runs longer than TIMEOUT_MS is killed.
 */
export function runHostCommand(c: Command, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(c.bin, c.args, { cwd, env: { ...staffStartEnv(process.env), GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let cut = false;
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (out.length >= MAX_OUTPUT) return void (cut = true);
      out += d;
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT);
        cut = true;
      }
    });
    child.stderr.on('data', (d: string) => {
      if (err.length < 500) err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.message.slice(0, 500)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${c.bin} did not finish in ${TIMEOUT_MS / 1000} seconds.`));
      if (code !== 0) return reject(new Error((err || `${c.bin} exited with code ${code}`).trim().slice(0, 500)));
      resolve(cut ? `${out}\n[output cut at ${MAX_OUTPUT} characters]` : out);
    });
  });
}
