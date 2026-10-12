import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePasswordHash, verifyPassword } from '../src/client-auth.ts';
import { upsertEnvLine } from '../scripts/set-password.ts';

describe('scripts/set-password.ts', () => {
  it('replaces or appends one line and leaves the others alone', () => {
    expect(upsertEnvLine('A=1\nORCH_CLIENT_PASSWORD_HASH=old\nB=2\n', 'ORCH_CLIENT_PASSWORD_HASH', 'new')).toBe('A=1\nORCH_CLIENT_PASSWORD_HASH=new\nB=2\n');
    expect(upsertEnvLine('A=1', 'ORCH_CLIENT_PASSWORD_HASH', 'new')).toBe('A=1\nORCH_CLIENT_PASSWORD_HASH=new\n');
    expect(upsertEnvLine('', 'ORCH_CLIENT_PASSWORD_HASH', 'new')).toBe('ORCH_CLIENT_PASSWORD_HASH=new\n');
    expect(upsertEnvLine('A=1\nORCH_CLIENT_PASSWORD_HASH=\n', 'ORCH_CLIENT_PASSWORD_HASH', 'a$b')).toBe('A=1\nORCH_CLIENT_PASSWORD_HASH=a$b\n');
  });

  it('collapses a duplicated line to one, so a stale later value cannot win', () => {
    const name = 'ORCH_CLIENT_PASSWORD_HASH';
    expect(upsertEnvLine(`A=1\n${name}=old1\nB=2\n${name}=old2\n`, name, 'new')).toBe(`A=1\n${name}=new\nB=2\n`);
    expect(upsertEnvLine(`${name}=old1\n${name}=old2`, name, 'new')).toBe(`${name}=new\n`);
    expect(upsertEnvLine(`${name}=old1\r\nB=2\r\n${name}=old2\r\n`, name, 'new')).toBe(`${name}=new\r\nB=2\r\n`);
  });

  it('writes only a hash of the password to the env file, and refuses a short password', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pw-')), '.env');
    writeFileSync(file, 'MYSQL_PASSWORD=abc\nORCH_CLIENT_PASSWORD_HASH=\n');
    const run = (input: string) => spawnSync('node', ['scripts/set-password.ts', '--env', file], { cwd: join(import.meta.dirname, '..'), input, encoding: 'utf8', timeout: 20_000 });
    const short = run('short\n');
    expect(short.status).toBe(1);
    expect(short.stderr).toMatch(/at least 12 characters/);
    expect(readFileSync(file, 'utf8')).toBe('MYSQL_PASSWORD=abc\nORCH_CLIENT_PASSWORD_HASH=\n');

    const ok = run('a long enough password\n');
    expect(ok.status).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('a long enough password');
    expect(ok.stdout).not.toContain('a long enough password');
    const hash = /^ORCH_CLIENT_PASSWORD_HASH=(.*)$/m.exec(text)![1]!;
    expect(text).toContain('MYSQL_PASSWORD=abc');
    expect(parsePasswordHash(hash)).not.toBeNull();
    expect(await verifyPassword(hash, 'a long enough password')).toBe(true);
    expect(await verifyPassword(hash, 'another password')).toBe(false);
  });

  it('creates a new env file readable by its owner only', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pw-')), '.env');
    const r = spawnSync('node', ['scripts/set-password.ts', '--env', file], { cwd: join(import.meta.dirname, '..'), input: 'a long enough password\n', encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing env file that other users can read', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pw-')), '.env');
    writeFileSync(file, 'MYSQL_PASSWORD=abc\n');
    chmodSync(file, 0o644);
    const r = spawnSync('node', ['scripts/set-password.ts', '--env', file], { cwd: join(import.meta.dirname, '..'), input: 'a long enough password\n', encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
