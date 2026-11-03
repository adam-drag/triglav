import { describe, expect, it } from 'vitest';
import { claudeStaffArgs, DOCUMENT_RESUME_PROMPT, documentStaffSettings, documentStaffStartPrompt, reportsFolderNote } from '../src/claude-args.ts';

const paths = { mcpConfig: '/tmp/triglav-run-x/staff-mcp.json', reportsDir: '/home/u/.local/state/triglav/reports/req_0123456789abcdef', repoDir: '/home/u/work/my repo' };

describe('the Claude access of a Staff', () => {
  it('adds nothing for a full Staff, as before', () => {
    expect(claudeStaffArgs('full')).toEqual([]);
    expect(claudeStaffArgs(null)).toEqual([]);
    expect(claudeStaffArgs(undefined)).toEqual([]);
  });

  it('holds a document Staff to reading its repository and reports folder, writing in the folder, the orchestrator and Artifact', () => {
    expect(claudeStaffArgs('document', paths)).toEqual([
      // No settings file: neither the user's allow rules nor the repository's rules and hooks apply.
      '--setting-sources', '',
      '--permission-mode', 'dontAsk',
      '--no-chrome',
      '--tools', 'Read,Grep,Glob,ToolSearch,Artifact,Write',
      '--allowedTools', 'mcp__orchestrator', 'ToolSearch', 'Artifact',
      'Read(//home/u/work/my repo/**)', 'Read(//home/u/.local/state/triglav/reports/req_0123456789abcdef/**)', 'Edit(//home/u/.local/state/triglav/reports/req_0123456789abcdef/**)',
      '--strict-mcp-config',
      '--mcp-config', paths.mcpConfig,
    ]);
  });

  it('never allows Read, Grep or Glob without a path: Read rules decide all three', () => {
    for (const web of [false, true]) {
      const args = claudeStaffArgs('document', { ...paths, web });
      const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--strict-mcp-config'));
      expect(allowed.filter((a) => ['Read', 'Grep', 'Glob', 'Write', 'Edit'].includes(a))).toEqual([]);
      expect(allowed.filter((a) => a.startsWith('Read('))).toEqual([`Read(/${paths.repoDir}/**)`, `Read(/${paths.reportsDir}/**)`]);
    }
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
    expect(() => claudeStaffArgs('document', { ...paths, repoDir: undefined })).toThrow(/repository/);
    expect(() => claudeStaffArgs('document', { ...paths, repoDir: '/home/u/x)/**,Read(//' })).toThrow(/repository/);
  });

  it('keeps the Staff settings and adds only Triglav\'s Stop hook, quoted for the shell', () => {
    const settings = JSON.parse(documentStaffSettings('{"autoCompactWindow":300000}', '/home/u/triglav dev/scripts/stop-hook.sh'));
    expect(settings).toEqual({
      autoCompactWindow: 300000,
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: "'/home/u/triglav dev/scripts/stop-hook.sh'", timeout: 10 }] }] },
    });
    expect(() => documentStaffSettings('{}', "/home/u/it's/stop-hook.sh")).toThrow(/Stop hook/);
    expect(() => documentStaffSettings('{}', 'stop-hook.sh')).toThrow(/Stop hook/);
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
