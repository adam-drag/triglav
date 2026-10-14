import { describe, expect, it } from 'vitest';
import { CODEX_STAFF_ENV, codexRoleArgs } from '../src/codex-args.ts';
import { codexStaffStartArgs, staffStartEnv } from '../scripts/staff-start.ts';
import { resumeArgs } from '../src/telemetry.ts';

const settings = (args: string[]) => args.map((a, i) => (args[i - 1] === '-c' ? a : null)).filter((a): a is string => a !== null);

describe('codex role settings', () => {
  it('staff: what --approve-for-me sets, and an environment of the core names plus GITHUB_TOKEN', () => {
    expect(settings(codexRoleArgs('staff'))).toEqual([
      'approvals_reviewer="auto_review"',
      'approval_policy="on-request"',
      'sandbox_mode="workspace-write"',
      'shell_environment_policy.inherit="all"',
      'shell_environment_policy.ignore_default_excludes=true',
      'shell_environment_policy.include_only=["PATH","SHELL","TMPDIR","TEMP","TMP","HOME","LANG","LC_ALL","LC_CTYPE","LOGNAME","USER","GITHUB_TOKEN"]',
    ]);
    // Nothing of the orchestrator can be named in the allow-list.
    for (const n of CODEX_STAFF_ENV) expect(n).not.toMatch(/^(ORCH_|MYSQL_)|^(DATABASE_URL|LINEAR_API_KEY)$/);
  });

  it('researcher: read-only and never asks', () => {
    expect(codexRoleArgs('researcher')).toEqual(['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"']);
  });

  it('an unknown or missing role throws', () => {
    for (const role of ['senior', 'reviewer', 'Staff', '', 'staff; rm -rf /', undefined, null]) expect(() => codexRoleArgs(role as any), String(role)).toThrow(/no Codex settings for role/);
  });

  it('start and resume of a Staff carry the same settings, and the token is never an argument', () => {
    const start = codexStaffStartArgs({ request_id: 'req_0123456789abcdef', model: 'gpt-6.1-sol', effort: 'high' });
    const resume = resumeArgs({ runtime: 'codex', role: 'staff', session_id: 's', prompt: 'p', model: 'gpt-6.1-sol', effort: 'high' });
    expect(settings(start).filter((s) => !s.startsWith('model_reasoning_effort'))).toEqual(settings(resume).filter((s) => !s.startsWith('model_reasoning_effort')));
    for (const a of [...start, ...resume]) expect(a).not.toMatch(/ghp_|github_pat_/);
    expect(() => resumeArgs({ runtime: 'codex', role: 'senior', session_id: 's', prompt: 'p' })).toThrow();
    expect(resumeArgs({ runtime: 'codex', role: 'researcher', session_id: 's', prompt: 'p' })).toContain('sandbox_mode="read-only"');
  });

  it('the runner still drops the orchestrator secrets and keeps GITHUB_TOKEN for Codex to filter', () => {
    const env = staffStartEnv({ ORCH_RUNNER_KEY: 'a', ORCH_ENROLLMENT_KEY: 'b', MYSQL_PASSWORD: 'c', DATABASE_URL: 'd', LINEAR_API_KEY: 'e', GITHUB_TOKEN: 'f', PATH: '/bin' });
    expect(Object.keys(env).sort()).toEqual(['GITHUB_TOKEN', 'PATH']);
  });
});
