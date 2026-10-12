import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { exec } from '../src/db.ts';
import { createJobRequest } from '../src/job-requests.ts';
import { effectiveRoleModel, recordHostRuntimes, roleModelsView, updateRoleModel } from '../src/models.ts';
import { askQuestion } from '../src/board.ts';
import { registerJob, updateJob } from '../src/jobs.ts';
import { createPersona, dispatchResearch, recordCodexBudget } from '../src/research.ts';
import { nextLaunch } from '../src/telemetry.ts';
import { claudeModels, codexModels, detectRuntimes } from '../scripts/runtimes.ts';
import { createTestCtx, issue, TEST_DB_URL } from './helpers.ts';

const CODEX_CATALOG = { models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low', description: 'x' }, { effort: 'high', description: 'y' }] },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low', description: 'x' }] },
] };
const CLAUDE_INIT = { models: [
  { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'high'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'high'] },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', supportedEffortLevels: ['low'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
] };

describe('the runner looks for agent CLIs and their models', () => {
  it('lists the visible Codex models and Claude models once, by full name, with their efforts', () => {
    expect(codexModels(CODEX_CATALOG)).toEqual([{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'high'] }]);
    expect(claudeModels(CLAUDE_INIT).map((m) => [m.id, m.label, m.efforts])).toEqual([
      ['claude-opus-5-5', 'Opus 5.5', ['low', 'medium', 'high']],
      ['claude-sonnet-5-5', 'Sonnet 5.5', ['low', 'high']],
      ['claude-opus-5', 'Opus 5', ['low']],
    ]);
    expect(codexModels(null)).toEqual([]);
    expect(claudeModels({})).toEqual([]);
  });

  it('asks each CLI for its version and models, and reports null for one that does not start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triglav-cli-'));
    const claude = join(dir, 'claude');
    // Answers --version, or the initialize request on stdin, like Claude Code does.
    writeFileSync(
      claude,
      `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('2.9.9 (Claude Code)'); process.exit(0); }\nprocess.stdin.once('data', () => console.log(JSON.stringify({ type: 'control_response', response: { request_id: 'models', response: ${JSON.stringify(CLAUDE_INIT)} } })));\n`,
    );
    chmodSync(claude, 0o755);
    const found = await detectRuntimes({ 'claude-code': claude, codex: join(dir, 'no-such-codex') });
    expect(found.codex).toBeNull();
    expect(found['claude-code']?.version).toBe('2.9.9 (Claude Code)');
    expect(found['claude-code']?.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5']);
  });
});

describe.skipIf(!TEST_DB_URL)('Triglav uses the agent CLIs that are on the machine', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });
  const ok = (version: string, models: { id: string; label: string; efforts: string[] }[] = []) => ({ version, models });
const both = { 'claude-code': ok('2.1.0 (Claude Code)'), codex: ok('codex-cli 0.1.0') };
  const roles = async () => Object.fromEntries((await roleModelsView(env.ctx)).roles.map((m) => [m.role, m]));

  it('changes nothing until the runner has reported, and when its report is old', async () => {
    expect((await roleModelsView(env.ctx)).detected).toMatchObject({ known: false, runtimes: [] });
    expect((await roles()).researcher).toMatchObject({ runtime: 'codex', replaces: null });
    await recordHostRuntimes(env.ctx, { 'claude-code': ok('2.1.0'), codex: null });
    expect((await roles()).researcher.runtime).toBe('claude-code');
    env.clock.advance(16 * 60);
    expect((await roleModelsView(env.ctx)).detected.known).toBe(false);
    expect((await roles()).researcher).toMatchObject({ runtime: 'codex', replaces: null });
  });

  it('keeps the saved settings when both CLIs are there', async () => {
    await recordHostRuntimes(env.ctx, both);
    const r = await roles();
    expect(r.researcher).toMatchObject({ runtime: 'codex', model: 'gpt-6-astra', replaces: null });
    expect(r.staff).toMatchObject({ runtime: 'claude-code', replaces: null });
  });

  it('with only Claude Code, moves the researcher to Opus 5.5 high and says what it replaced', async () => {
    await recordHostRuntimes(env.ctx, { 'claude-code': ok('2.1.0 (Claude Code)'), codex: null });
    const r = await roles();
    expect(r.researcher).toMatchObject({ runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'high', replaces: { runtime: 'codex', model: 'gpt-6-astra', effort: 'low' } });
    expect(r.staff).toMatchObject({ runtime: 'claude-code', replaces: null });
    // The saved setting is untouched: it comes back when Codex does.
    await recordHostRuntimes(env.ctx, both);
    expect((await roles()).researcher).toMatchObject({ runtime: 'codex', model: 'gpt-6-astra' });
  });

  it('with only Codex, moves every Claude role to Codex, and New job starts Staff on Codex', async () => {
    await recordHostRuntimes(env.ctx, { 'claude-code': null, codex: ok('codex-cli 0.1.0') });
    const r = await roles();
    expect(r.senior).toMatchObject({ runtime: 'codex', model: 'gpt-6.1-sol', replaces: { runtime: 'claude-code' } });
    expect(r.researcher).toMatchObject({ runtime: 'codex', replaces: null });
    expect((await effectiveRoleModel(env.ctx, env.ctx.pool, 'staff'))?.runtime).toBe('codex');
    const { id } = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'x', repoPath: '/r1' });
    expect(await nextLaunch(env.ctx)).toMatchObject({ kind: 'staff_start', request_id: id, runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it('keeps the saved settings when neither CLI is found, so nothing is guessed', async () => {
    await recordHostRuntimes(env.ctx, { 'claude-code': null, codex: null });
    expect((await roles()).staff).toMatchObject({ runtime: 'claude-code', replaces: null });
  });

  it('runs a researcher saved for Codex on Claude Code when Codex is missing, whatever the Codex window says', async () => {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const staff: Agent = await authenticate(env.ctx, reg.session_token);
    const parent = issue(`RT-${++n}`, 'Runtime target', { children: [] });
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    await updateJob(env.ctx, staff, { jobId: job.job_id, status: 'planning' });
    await exec(env.ctx.pool, `UPDATE researcher_personas SET enabled = 0`);
    await recordHostRuntimes(env.ctx, both);
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'runtime', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    const now = env.clock.now();
    await recordCodexBudget(env.ctx.pool, { used: 95, windowMin: 300, resetsAt: new Date(now.getTime() + 3600_000), weekly: 50, weeklyResetsAt: null, at: now });
    await recordHostRuntimes(env.ctx, { 'claude-code': ok('2.1.0'), codex: null });
    await askQuestion(env.ctx, { kind: 'agent', agent: staff }, { jobId: job.job_id, title: 'Which?', summary: 's', question: 'q?', whyItMatters: 'w', waitingWork: 'x', windowSec: 60 });
    await dispatchResearch(env.ctx);
    const launch: any = await nextLaunch(env.ctx);
    expect(launch).toMatchObject({ kind: 'research_run', runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo' });
    expect(launch.prompt).toContain('start_run');
    expect(persona.id).toBeTruthy();
  });

  it('creates a persona on the researcher role runtime when the runner found only Claude Code', async () => {
    await recordHostRuntimes(env.ctx, { 'claude-code': ok('2.1.0'), codex: null });
    const p = await createPersona(env.ctx, { nickname: `opus-${++n}`, focus: 'x', repo_path: '/repo', model: 'claude-opus-5-5', effort: 'high' });
    const row = (await env.ctx.pool.query(`SELECT runtime FROM agents WHERE id = ?`, [p.agent_id]))[0] as any[];
    expect(row[0].runtime).toBe('claude-code');
  });

  it('saves only models the CLI lists, with an effort the model accepts', async () => {
    await recordHostRuntimes(env.ctx, {
      'claude-code': ok('2.1.0', [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high'] }]),
      codex: ok('codex-cli 0.1.0', [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'medium'] }]),
    });
    await expect(updateRoleModel(env.ctx, 'senior', { runtime: 'claude-code', model: 'claude-opuss-5-5', effort: 'high' })).rejects.toThrow(/does not offer the model "claude-opuss-5-5".*claude-opus-5-5/);
    await expect(updateRoleModel(env.ctx, 'senior', { runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'max' })).rejects.toThrow(/does not accept the effort "max"/);
    await expect(updateRoleModel(env.ctx, 'senior', { runtime: 'codex', model: 'claude-opus-5-5', effort: 'low' })).rejects.toThrow(/Codex does not offer/);
    expect(await updateRoleModel(env.ctx, 'senior', { runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'low' })).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
    expect((await roleModelsView(env.ctx)).detected.runtimes.find((r) => r.runtime === 'codex')?.models).toEqual([{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'medium'] }]);
    // A CLI the runner did not find cannot be chosen, and an old report checks nothing.
    await recordHostRuntimes(env.ctx, { 'claude-code': ok('2.1.0'), codex: null });
    await expect(updateRoleModel(env.ctx, 'senior', { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'low' })).rejects.toThrow(/Codex was not found/);
    env.clock.advance(16 * 60);
    expect(await updateRoleModel(env.ctx, 'senior', { runtime: 'codex', model: 'anything', effort: 'x' })).toMatchObject({ model: 'anything' });
    await exec(env.ctx.pool, `UPDATE role_models SET runtime = 'claude-code', model = 'claude-sonnet-5-5', effort = 'high' WHERE role = 'senior'`);
  });
});
