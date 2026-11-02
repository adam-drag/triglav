import { describe, expect, it } from 'vitest';
import { claudeStaffArgs, DOCUMENT_RESUME_PROMPT, documentStaffStartPrompt, reportsFolderNote } from '../src/claude-args.ts';

const paths = { mcpConfig: '/tmp/triglav-run-x/staff-mcp.json', reportsDir: '/home/u/.local/state/triglav/reports/req_0123456789abcdef' };

describe('the Claude access of a Staff', () => {
  it('adds nothing for a full Staff, as before', () => {
    expect(claudeStaffArgs('full')).toEqual([]);
    expect(claudeStaffArgs(null)).toEqual([]);
    expect(claudeStaffArgs(undefined)).toEqual([]);
  });

  it('holds a document Staff to reading, its reports folder, the orchestrator and Artifact', () => {
    expect(claudeStaffArgs('document', paths)).toEqual([
      '--permission-mode', 'dontAsk',
      '--no-chrome',
      '--tools', 'Read,Grep,Glob,ToolSearch,Artifact,Write',
      '--allowedTools', 'mcp__orchestrator', 'Read', 'Grep', 'Glob', 'ToolSearch', 'Artifact', 'Edit(//home/u/.local/state/triglav/reports/req_0123456789abcdef/**)',
      '--strict-mcp-config',
      '--mcp-config', paths.mcpConfig,
    ]);
  });

  it('gives web tools only when the job allows web sources', () => {
    const args = claudeStaffArgs('document', { ...paths, web: true });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,ToolSearch,Artifact,Write,WebSearch,WebFetch');
    expect(args).toContain('WebSearch');
    expect(args).toContain('WebFetch');
    expect(claudeStaffArgs('document', paths).join(' ')).not.toMatch(/Web/);
  });

  it('never gives Bash, Edit as a tool, or a write rule outside the folder', () => {
    for (const web of [false, true]) {
      const args = claudeStaffArgs('document', { ...paths, web });
      expect(args[args.indexOf('--tools') + 1].split(',')).not.toContain('Bash');
      expect(args[args.indexOf('--tools') + 1].split(',')).not.toContain('Edit');
      expect(args.filter((a) => /^(Edit|Write)\(/.test(a))).toEqual([`Edit(/${paths.reportsDir}/**)`]);
    }
  });

  it('refuses an unknown access and paths it cannot trust', () => {
    expect(() => claudeStaffArgs('researcher')).toThrow(/no Claude Staff access/);
    expect(() => claudeStaffArgs('document')).toThrow(/MCP config/);
    expect(() => claudeStaffArgs('document', { ...paths, mcpConfig: 'staff-mcp.json' })).toThrow(/MCP config/);
    expect(() => claudeStaffArgs('document', { ...paths, reportsDir: 'reports' })).toThrow(/reports folder/);
    expect(() => claudeStaffArgs('document', { ...paths, reportsDir: '/home/u/../etc' })).toThrow(/reports folder/);
  });

  it('starts and resumes with ToolSearch, the document guide role and the reports folder', () => {
    const start = documentStaffStartPrompt('req_0123456789abcdef', paths.reportsDir);
    expect(start).toContain('select:mcp__orchestrator__get_guide');
    expect(start).toContain('role staff_document');
    expect(start).toContain('Start job request req_0123456789abcdef.');
    expect(start).toContain(reportsFolderNote(paths.reportsDir));
    expect(start).not.toMatch(/Bash|tail -f/);
    expect(DOCUMENT_RESUME_PROMPT).toContain('role staff_document');
    expect(DOCUMENT_RESUME_PROMPT).toContain('ToolSearch');
    expect(DOCUMENT_RESUME_PROMPT).not.toMatch(/Senior/);
  });
});
