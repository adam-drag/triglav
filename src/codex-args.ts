// The Codex settings of a launch, per role. Pure (no Node imports) so the server, the host runner and the dashboard
// build the same arguments from this one file.

/** The roles the host runner starts or resumes with Codex. Anything else throws, so a new role is never launched by accident. */
export type CodexRole = 'staff' | 'researcher';

/**
 * What `codex exec --help` calls the shell environment of a command. Codex's own `inherit = "core"` list for Unix is
 * PATH SHELL TMPDIR TEMP TMP HOME LANG LC_ALL LC_CTYPE LOGNAME USER
 * (codex-rs/protocol/src/shell_environment.rs:164-167, tag rust-v0.162.0). A Staff gets those plus the GitHub token for `gh`.
 */
export const CODEX_STAFF_ENV = ['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER', 'GITHUB_TOKEN'];

/**
 * The `-c` settings for a role. `codex exec resume` has neither `--sandbox` nor `--approve-for-me`, so start and resume
 * both use config keys; `exec` and `exec resume` accept `-c`.
 *
 * staff: what `--approve-for-me` sets (codex-rs/utils/cli/src/shared_options.rs:80-91: approvals_reviewer="auto_review",
 * approval_policy="on-request", sandbox_mode="workspace-write"), so a command that needs more than the sandbox gives
 * (network, .git, the signing agent) goes to Codex's automatic reviewer. The shell environment keeps only CODEX_STAFF_ENV:
 * `inherit="all"` and `ignore_default_excludes=true` let GITHUB_TOKEN through the default *TOKEN* filter, and `include_only`
 * (applied last, shell_environment.rs:146-149) drops everything else.
 * researcher: read-only, never asks.
 */
export function codexRoleArgs(role: string | null | undefined): string[] {
  if (role === 'staff') {
    const names = CODEX_STAFF_ENV.map((n) => JSON.stringify(n)).join(',');
    return [
      '-c', 'approvals_reviewer="auto_review"',
      '-c', 'approval_policy="on-request"',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'shell_environment_policy.inherit="all"',
      '-c', 'shell_environment_policy.ignore_default_excludes=true',
      '-c', `shell_environment_policy.include_only=[${names}]`,
    ];
  }
  if (role === 'researcher') return ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
  throw new Error(`no Codex settings for role ${JSON.stringify(String(role)).slice(0, 40)}`);
}
