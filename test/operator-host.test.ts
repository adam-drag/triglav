import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { buildHostCommand, HOST_TOOLS, runHostCommand } from '../scripts/operator-host-tools.ts';

const REPO = resolve(import.meta.dirname, '..');

describe('the Operator host tools build fixed commands', () => {
  it('has the tools the Operator needs and no tool that takes a command or an option', () => {
    expect(Object.keys(HOST_TOOLS).sort()).toEqual(['agents', 'compose_logs', 'compose_ps', 'git_log', 'git_status', 'logs']);
    for (const t of Object.values(HOST_TOOLS)) expect(Object.keys(t.schema.shape)).not.toContain('args');
  });

  it('builds the commands from the checked arguments only', () => {
    expect(buildHostCommand('agents', {})).toEqual({ bin: 'claude', args: ['agents', '--json'] });
    expect(buildHostCommand('logs', { id: 'c6a5f9cb' })).toEqual({ bin: 'claude', args: ['logs', 'c6a5f9cb'] });
    expect(buildHostCommand('compose_ps', undefined)).toEqual({ bin: 'docker', args: ['compose', 'ps'] });
    expect(buildHostCommand('compose_logs', { service: 'mysql' }).args).toEqual(['compose', 'logs', '--no-color', '--tail', '200', 'mysql']);
    expect(buildHostCommand('compose_logs', { service: 'orchestrator', tail: 50 }).args.slice(-3)).toEqual(['--tail', '50', 'orchestrator']);
    const log = buildHostCommand('git_log', { n: 5 });
    expect(log.bin).toBe('git');
    expect(log.args).toEqual(['--no-pager', 'log', '--no-color', '--no-ext-diff', '--no-textconv', '-n', '5', '--date=short', '--format=%h %ad %an %s']);
    expect(buildHostCommand('git_log', {}).args).toContain('20');
    expect(buildHostCommand('git_status', {}).args).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch']);
  });

  it('refuses unknown tools, unknown properties, options and shell syntax', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'host-')), 'x');
    // The case from the scan report: `git log --output=FILE` writes a file.
    expect(() => buildHostCommand('git_log', { n: 5, output: marker })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_log', { args: [`--output=${marker}`] })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_log', { n: `5 --output=${marker}` })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_log', { n: `5; touch ${marker}` })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_log', { n: '$(touch x)' })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_log', { n: 0 })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_log', { n: 201 })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_log', { n: 1.5 })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('git_status', { path: '--ignored' })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('agents', { json: false })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('logs', { id: '--follow' })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('logs', { id: 'c6a5f9cb; id' })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('logs', { id: 'C6A5F9CB' })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('compose_logs', { service: 'orchestrator && id' })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('compose_logs', { service: 'postgres' })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('compose_logs', { service: 'mysql', tail: 5000 })).toThrow(/Bad arguments/);
    expect(() => buildHostCommand('bash', { command: 'id' })).toThrow(/Unknown host tool/);
    expect(() => buildHostCommand('__proto__', {})).toThrow(/Unknown host tool/);
    expect(() => buildHostCommand('constructor', {})).toThrow(/Unknown host tool/);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs git log and git status for real, without a shell, and writes nothing', async () => {
    const log = await runHostCommand(buildHostCommand('git_log', { n: 2 }), REPO);
    expect(log.trim().split('\n')).toHaveLength(2);
    expect(await runHostCommand(buildHostCommand('git_status', {}), REPO)).toMatch(/^## /);
  });
});

describe('host command output', () => {
  it('is cut at the cap when a command prints far more, instead of failing', async () => {
    const out = await runHostCommand({ bin: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(500000))'] }, REPO);
    expect(out.startsWith('x'.repeat(60_000))).toBe(true);
    expect(out.length).toBeLessThan(60_200);
    expect(out).toMatch(/\[output cut at 60000 characters\]$/);
  });
});

describe('the Operator host MCP server over stdio', () => {
  it('lists the tools, answers git_log, and refuses an extra option or a shell metacharacter without running anything', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'host-')), 'x');
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(REPO, 'scripts', 'operator-host-mcp.ts')], cwd: REPO, stderr: 'pipe' });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['agents', 'compose_logs', 'compose_ps', 'git_log', 'git_status', 'logs']);
      for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
      const ok: any = await client.callTool({ name: 'git_log', arguments: { n: 1 } });
      expect(ok.isError).toBeFalsy();
      expect(ok.content[0].text.trim().split('\n')).toHaveLength(1);
      for (const args of [{ n: 1, output: marker }, { n: `1; touch ${marker}` }, { args: [`--output=${marker}`] }]) {
        const refused = await client.callTool({ name: 'git_log', arguments: args }).then((r: any) => r.isError === true, () => true);
        expect(refused).toBe(true);
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('runs from a checkout whose path has a space or a non-ASCII character', async () => {
    const checkout = join(mkdtempSync(join(tmpdir(), 'host-')), 'Triglav Dev ä');
    mkdirSync(checkout);
    cpSync(join(REPO, 'scripts'), join(checkout, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(checkout, 'package.json'));
    symlinkSync(join(REPO, 'node_modules'), join(checkout, 'node_modules'));
    execFileSync('git', ['init', '-q'], { cwd: checkout });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(checkout, 'scripts', 'operator-host-mcp.ts')], cwd: REPO, stderr: 'pipe' }));
    try {
      const r: any = await client.callTool({ name: 'git_status', arguments: {} });
      expect(r.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
