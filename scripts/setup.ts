/**
 * First-time setup of .env. It creates .env from .env.example when there is none, fills every empty key below with a
 * random value, and then runs set-password.ts when the dashboard password is not set yet.
 *
 *   node scripts/setup.ts            # .env next to this repository
 *   node scripts/setup.ts --env FILE # another env file, for tests
 *
 * A key that already has a value is never replaced: the agents' MCP configs hold the enrollment key, and a new one would
 * lock every agent out. To rotate a key, edit .env by hand and update the configs (README, Connect agents).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertEnvLine } from './set-password.ts';

/** Hex, so the values are safe inside the MySQL URL that docker-compose.yml builds. 48 characters, above the 24 minimum. */
export const GENERATED_KEYS = ['MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'ORCH_ENROLLMENT_KEY', 'ORCH_RUNNER_KEY'] as const;

const valueOf = (text: string, name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';

/**
 * Fills the empty generated keys and returns the new text with the names it filled. A key on more than one line is
 * refused before anything is written: which line wins differs between readers, and filling one would drop the others,
 * which can replace a key that is set.
 */
export function fillKeys(text: string, random: () => string = () => randomBytes(24).toString('hex')): { text: string; filled: string[] } {
  const repeated = [...GENERATED_KEYS, 'ORCH_CLIENT_PASSWORD_HASH'].filter((name) => (text.match(new RegExp(`^${name}=`, 'gm')) ?? []).length > 1);
  if (repeated.length) throw new Error(`${repeated.join(', ')} ${repeated.length === 1 ? 'appears' : 'appear'} more than once in .env. Keep one line for each and run setup again. Nothing was changed.`);
  const filled: string[] = [];
  for (const name of GENERATED_KEYS) {
    if (valueOf(text, name)) continue;
    text = upsertEnvLine(text, name, random());
    filled.push(name);
  }
  return { text, filled };
}

export const hasPasswordHash = (text: string) => valueOf(text, 'ORCH_CLIENT_PASSWORD_HASH') !== '';

if (import.meta.filename === process.argv[1]) {
  const root = join(import.meta.dirname, '..');
  const i = process.argv.indexOf('--env');
  const file = i >= 0 ? process.argv[i + 1]! : join(root, '.env');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync(join(root, '.env.example'), 'utf8');
  let result: ReturnType<typeof fillKeys>;
  try {
    result = fillKeys(before);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { text, filled } = result;
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // `mode` only applies to a new file; an existing .env may be 0644.
  console.log(filled.length ? `Generated ${filled.join(', ')} in ${file}.` : `${file} already has every key. None was changed.`);
  if (!hasPasswordHash(text)) {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, 'set-password.ts'), '--env', file], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  console.log('Next: docker compose up -d --build, then node scripts/runner.ts, then connect your agents (README, Connect agents).');
}
