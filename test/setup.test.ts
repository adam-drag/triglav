import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/client-auth.ts';
import { fillKeys, GENERATED_KEYS } from '../scripts/setup.ts';

const REPO = join(import.meta.dirname, '..');
const run = (file: string, input: string) => spawnSync('node', ['scripts/setup.ts', '--env', file], { cwd: REPO, input, encoding: 'utf8', timeout: 20_000 });
const valueOf = (text: string, name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] ?? '';

describe('scripts/setup.ts', () => {
  it('fills only the empty keys and never replaces a value', () => {
    let n = 0;
    const { text, filled } = fillKeys('MYSQL_PASSWORD=keep\nMYSQL_ROOT_PASSWORD=\nORCH_ENROLLMENT_KEY=\nLINEAR_API_KEY=\n', () => `gen${n++}`);
    expect(filled).toEqual(['MYSQL_ROOT_PASSWORD', 'ORCH_ENROLLMENT_KEY', 'ORCH_RUNNER_KEY']);
    expect(text).toBe('MYSQL_PASSWORD=keep\nMYSQL_ROOT_PASSWORD=gen0\nORCH_ENROLLMENT_KEY=gen1\nLINEAR_API_KEY=\nORCH_RUNNER_KEY=gen2\n');
    expect(fillKeys(text).filled).toEqual([]);
  });

  it('refuses a key on more than one line and changes nothing, so a set key is never dropped', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'setup-')), '.env');
    const text = 'ORCH_ENROLLMENT_KEY=\nMYSQL_PASSWORD=\nORCH_ENROLLMENT_KEY=configured-in-the-agents-000000000\n';
    writeFileSync(file, text);
    expect(() => fillKeys(text)).toThrow(/ORCH_ENROLLMENT_KEY appears more than once/);
    const r = run(file, 'a long enough password\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ORCH_ENROLLMENT_KEY appears more than once/);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('creates .env from .env.example with distinct hex keys, a password hash, and owner-only access', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'setup-')), '.env');
    const r = run(file, 'a long enough password\n');
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    const keys = GENERATED_KEYS.map((k) => valueOf(text, k));
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{48}$/);
    expect(new Set(keys).size).toBe(keys.length);
    expect(await verifyPassword(valueOf(text, 'ORCH_CLIENT_PASSWORD_HASH'), 'a long enough password')).toBe(true);
    expect(text).toContain('LINEAR_API_KEY=');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).not.toContain(keys[2]);
  });

  it('leaves a complete .env as it is and does not ask for a password', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'setup-')), '.env');
    const full = `${GENERATED_KEYS.map((k) => `${k}=${k.toLowerCase()}-value-000000000000`).join('\n')}\nORCH_CLIENT_PASSWORD_HASH=scrypt:x\n`;
    writeFileSync(file, full);
    chmodSync(file, 0o644);
    const r = run(file, '');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/None was changed/);
    expect(readFileSync(file, 'utf8')).toBe(full);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the generated keys when the password is refused, so a second run only asks again', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'setup-')), '.env');
    expect(run(file, 'short\n').status).toBe(1);
    const first = readFileSync(file, 'utf8');
    expect(valueOf(first, 'ORCH_RUNNER_KEY')).toMatch(/^[0-9a-f]{48}$/);
    expect(run(file, 'a long enough password\n').status).toBe(0);
    const second = readFileSync(file, 'utf8');
    for (const k of GENERATED_KEYS) expect(valueOf(second, k)).toBe(valueOf(first, k));
  });
});
