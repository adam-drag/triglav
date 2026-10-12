## CLI setup (for the Client)

These are the settings verified on 2026-10-07 with Claude Code 2.1.292 and codex-cli 0.153.4. `<key>` is `ORCH_ENROLLMENT_KEY` from the orchestrator's `.env`.

Claude Code, available in every project, with a 3500 second tool timeout so Staff can wait 50 minutes on a warm cache (verified 2026-10-09 with a 3000 second wait):

```
claude mcp add-json --scope user orchestrator '{"type":"http","url":"{{BASE_URL}}/mcp","timeout":3500000,"headers":{"Authorization":"Bearer <key>"}}'
```

To keep Staff and Seniors from ending their turn while they own open work, add `scripts/stop-hook.sh` from the orchestrator repository as a `Stop` hook in `~/.claude/settings.json`. It blocks the stop with a reminder to keep waiting, and lets the session stop once the job is done, cancelled or paused, after `end_session`, or when the orchestrator is unreachable. Pause a job to let its agents stop and save usage.

Then add `"mcp__orchestrator__*"` to `permissions.allow` in `~/.claude/settings.json` so an unattended session does not stop at prompts. Subagents that Staff starts inherit the server and its tools.

Seniors also run shell commands: `git` (worktree, add, commit, push) and the repository's test commands. Allow those in the target repository's `.claude/settings.local.json`, for example `"Bash(git *)"` and `"Bash(pnpm test *)"`. Without them a Senior hits an approval prompt it cannot answer; it then raises a blocker and stops, which is the intended behavior. A PreToolUse hook that rewrites commands can make allowed commands ask for approval again (seen on 2026-10-07 in headless runs), so check hooks when a Senior reports a permission blocker.

Codex, in `~/.codex/config.toml`:

```
[mcp_servers.orchestrator]
url = "{{BASE_URL}}/mcp"
http_headers = { Authorization = "Bearer <key>" }
tool_timeout_sec = 330
default_tools_approval_mode = "auto"
```

The MCP connection runs outside the Codex command sandbox, so the read-only sandbox is enough for a researcher.

The Models page of the dashboard sets the model and effort for each role and shows a ready launch command for Staff with those settings. Seniors and reviewers get the settings in their spawn ticket, so a change applies to the next one Staff starts. Running agents keep their model.

Start prompts:

- Staff: `Call get_guide with role staff and follow it. Work on Linear ticket <ID> in repository <path>, base branch <branch>.`
- Researchers have no start prompt: create a persona on the Researchers page and Triglav starts its runs.
- Seniors and reviewers get their start prompt from `create_spawn_ticket`.
