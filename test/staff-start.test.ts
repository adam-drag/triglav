import { describe, expect, it } from 'vitest';
import { checkLaunchId, codexStaffStartArgs, EFFORT, runCodexStaffStart, startFailureHint, MODEL, REQUEST_ID, runStaffStart, staffStartArgs, staffStartEnv, staffStartPrompt } from '../scripts/staff-start.ts';
import { REQUEST_ID as SERVER_REQUEST_ID } from '../src/job-requests.ts';
import { STAFF_CLAUDE_SETTINGS } from '../src/telemetry.ts';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ID = 'req_0123456789abcdef';
const SETTINGS = '{"autoCompactWindow":300000}';

describe('start failures the Client can act on', () => {
  const fake = (name: string, body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'triglav-fail-'));
    const bin = join(dir, name);
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return { dir, bin };
  };
  const req = { request_id: ID, model: 'm1', effort: 'low' };

  it('says which folder Claude Code does not trust and what to run, before the raw error', async () => {
    const { dir, bin } = fake('claude', 'echo "Workspace not trusted. Run claude in /x once and accept the trust prompt, then retry." >&2\nexit 1');
    const err = await runStaffStart(req, dir, SETTINGS, { bin }).catch((e) => e as Error);
    const [first, ...rest] = (err as Error).message.split('\n');
    expect(first).toBe(`Claude Code does not trust ${dir} yet. Run "cd ${dir} && claude" once, accept the trust prompt, then retry.`);
    expect(rest.join('\n')).toContain('Workspace not trusted');
  });

  it('says when the command is missing, and leaves an unknown failure as it came', async () => {
    const missing = await runStaffStart(req, tmpdir(), SETTINGS, { bin: '/no/such/dir/claude' }).catch((e) => e as Error);
    expect((missing as Error).message.split('\n')[0]).toMatch(/^The command "claude" was not found on the runner's PATH/);
    const { dir, bin } = fake('claude', 'echo "something else broke" >&2\nexit 3');
    const other = await runStaffStart(req, dir, SETTINGS, { bin }).catch((e) => e as Error);
    expect((other as Error).message).toMatch(/^Command failed/);
    expect(startFailureHint({ text: 'x' }, 'claude', '/d')).toBeNull();
    expect(startFailureHint({ text: 'Workspace not trusted' }, 'codex', '/d')).toBe('Codex does not trust /d yet. Run "cd /d && codex" once, accept the trust prompt, then retry.');
  });

  it('explains a Codex that cannot start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triglav-staff-'));
    const err = await runCodexStaffStart(req, dir, join(dir, 'logs'), { bin: join(dir, 'no-such-codex') }).catch((e) => e as Error);
    expect((err as Error).message.split('\n')[0]).toMatch(/^The command "codex" was not found/);
  });
});

describe('codex staff start', () => {
  it('builds the whole command from the request id, model and effort, like the Models page launch command', () => {
    expect(codexStaffStartArgs({ request_id: ID, model: 'gpt-6.1-sol', effort: 'ultra' })).toEqual([
      'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="ultra"',
      `Call get_guide with role staff and follow it. Start job request ${ID}.`,
    ]);
  });

  it('refuses a request id, model or effort that does not match', () => {
    const ok = { request_id: ID, model: 'gpt-6.1-sol', effort: 'high' };
    expect(() => codexStaffStartArgs({ ...ok, request_id: `${ID}; rm -rf /` })).toThrow(/job request id/);
    for (const model of [undefined, '', '--dangerously-bypass-approvals-and-sandbox', 'a b', 'a;b']) expect(() => codexStaffStartArgs({ ...ok, model }), String(model)).toThrow(/model/);
    for (const effort of [undefined, '', '--x', 'High', 'high"', 'a b']) expect(() => codexStaffStartArgs({ ...ok, effort }), String(effort)).toThrow(/effort/);
  });

  it('starts the binary detached in the directory, with a log file, and without the orchestrator secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triglav-staff-'));
    const fake = join(dir, 'codex');
    writeFileSync(fake, '#!/bin/sh\necho "args: $@"\necho "cwd: $(pwd)"\necho "orch: ${ORCH_ENROLLMENT_KEY:-none}"\n');
    chmodSync(fake, 0o755);
    const out = await runCodexStaffStart({ request_id: ID, model: 'm1', effort: 'low' }, dir, join(dir, 'logs'), { bin: fake, env: { PATH: '/usr/bin:/bin', ORCH_ENROLLMENT_KEY: 'secret' } });
    expect(out).toMatch(/^started codex staff pid \d+, log /);
    const log = join(dir, 'logs', `codex-staff-${ID}.log`);
    for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    const text = readFileSync(log, 'utf8');
    expect(text).toContain(`Start job request ${ID}.`);
    expect(text).toContain(`cwd: ${realpathSync(dir)}`);
    expect(text).toContain('orch: none');
  });
});

describe('staff-start argv', () => {
  it('builds the whole command from the request id, model and effort', () => {
    expect(staffStartArgs({ request_id: ID, model: 'claude-opus-5-5', effort: 'high' }, SETTINGS)).toEqual([
      '--bg', '-n', `staff-${ID}`, '--settings', SETTINGS, '--model', 'claude-opus-5-5', '--effort', 'high',
      `Call get_guide with role staff and follow it. Start job request ${ID}.`,
    ]);
    expect(staffStartPrompt(ID)).toContain(ID);
  });

  it('refuses a request id, model or effort that does not match', () => {
    const ok = { request_id: ID, model: 'claude-opus-5-5', effort: 'high' };
    for (const request_id of [undefined, null, '', 'req_', 'req_0123456789ABCDEF', 'req_0123456789abcdef0', `${ID}; rm -rf /`, `${ID}\n`, 'https://evil.example/x']) {
      expect(() => staffStartArgs({ ...ok, request_id }, SETTINGS), String(request_id)).toThrow(/job request id/);
    }
    for (const model of [undefined, null, '', '--dangerously-skip-permissions', '-x', 'a b', 'a;b', 'm'.repeat(101)]) {
      expect(() => staffStartArgs({ ...ok, model }, SETTINGS), String(model)).toThrow(/model/);
    }
    for (const effort of [undefined, null, '', '--x', 'ultra', 'High', 'high ']) {
      expect(() => staffStartArgs({ ...ok, effort }, SETTINGS), String(effort)).toThrow(/effort/);
    }
  });

  it('has no place for Client text: the only free field is the id, which is hex', () => {
    const args = staffStartArgs({ request_id: ID, model: 'm1', effort: 'low' }, SETTINGS);
    expect(args.join(' ')).not.toMatch(/https?:/);
    expect(REQUEST_ID.source).toBe(SERVER_REQUEST_ID.source);
    expect(MODEL.test('-x')).toBe(false);
    expect(EFFORT.test('max')).toBe(true);
  });

  it('keeps the runner copy of the Staff settings identical to the server copy', () => {
    expect(readFileSync(new URL('../scripts/runner.ts', import.meta.url), 'utf8')).toContain(`const STAFF_CLAUDE_SETTINGS = '${STAFF_CLAUDE_SETTINGS}';`);
    expect(readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')).toContain(STAFF_CLAUDE_SETTINGS);
  });

  it('drops the orchestrator settings and secrets from the new session environment', () => {
    const env = staffStartEnv({ PATH: '/bin', HOME: '/h', ORCH_ENROLLMENT_KEY: 'k', ORCH_URL: 'u', MYSQL_ROOT_PASSWORD: 'p', DATABASE_URL: 'd', LINEAR_API_KEY: 'l', ANTHROPIC_API_KEY: 'a' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'a' });
  });

  it('runs the binary with the args, the directory and the cleaned environment, and returns the first output line', async () => {
    const out = await runStaffStart({ request_id: ID, model: 'm1', effort: 'low' }, '/tmp', SETTINGS, { bin: '/bin/echo', env: { PATH: '/bin', ORCH_X: '1' } });
    expect(out).toBe(`--bg -n staff-${ID} --settings ${SETTINGS} --model m1 --effort low Call get_guide with role staff and follow it. Start job request ${ID}.`);
    await expect(runStaffStart({ request_id: ID, model: 'm1', effort: 'low' }, '/tmp', SETTINGS, { bin: '/bin/false' })).rejects.toThrow();
    await expect(runStaffStart({ request_id: 'bad', model: 'm1', effort: 'low' }, '/tmp', SETTINGS, { bin: '/bin/echo' })).rejects.toThrow(/job request id/);
  });

  it('accepts only launch ids the server makes, before one reaches a log name or a URL', () => {
    expect(checkLaunchId('lch_0123456789abcdef')).toBe('lch_0123456789abcdef');
    for (const bad of [undefined, null, 5, '', 'lch_', 'lch_0123456789ABCDEF', '../lch_0123456789abcdef', 'lch_0123456789abcdef/../x', 'lch_0123456789abcdef\n', 'req_0123456789abcdef']) {
      expect(() => checkLaunchId(bad), String(bad)).toThrow(/launch id/);
    }
  });
});
