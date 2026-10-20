---
name: triglav-research
description: How Triglav researchers work - personas, inbox routing from events, the run dispatcher and Codex budget guard, the run ticket protocol (start_run, get_item, mark_item, end_run), and the read-only constraints of Claude and Codex research runs and Codex Staff access. Load before changing src/research.ts, scripts/research-run.ts, src/codex-args.ts, the researcher MCP tools, the Researchers page, or Codex sandbox/approval settings.
---

# Researchers

Verified against the code on 2026-10-15 (routing and get_item re-checked 2026-10-18; view requests 2026-10-20). If you find this out of date, fix it in the same PR.

## Idea

A researcher has no session between runs (an always-on one burned the Codex window, measured 2026-10-08). Triglav routes events into a **persona inbox**; a dispatcher starts a short run per batch; the run trades a one-off ticket for a session token, handles its items, marks each one, and exits. Memory between runs is a small notebook.

## Files

| File | Owns |
| --- | --- |
| `src/research.ts` | `routeToInbox`, `dispatchResearch`, `closeRun`/`closeRunOfLaunch`, run protocol (`startRun`, `getItem`, `markItem`, `updateNotebook`, `endRun`), personas, `researchOverview`, `RESEARCH_PROMPT`, Codex budget (`codexBudget`, `codexUsedNow`, `recordCodexBudget`) |
| `scripts/research-run.ts` | `claudeResearchArgs`, `researchMcpConfig`, `codexMcpDisableArgs` (keeps the orchestrator on), `codexMcpDisableAllArgs` (everything off, used by code reviewers), `isOrchestratorEndpoint` |
| `src/codex-args.ts` | `codexRoleArgs(role)`, `CODEX_STAFF_ENV` |
| `scripts/runner.ts` | `researchRun`, `watchedRun` (see `triglav-runner-launches`) |

## Routing (in `emit()`, same transaction)

`kindOf` maps events to inbox kinds: `question.opened` -> question, `proposal.posted` -> proposal, `mention` -> mention (only if targeted at that persona), or `view_request` when the payload has `view_requested` (a Client mention, see `triglav-jobs-and-leases` Board), `review.submitted` -> review (only for personas who already posted on that job), `blocker.raised` with kind `client_decision` -> client_decision, `decision.recorded`/`decision.superseded` -> decision (only if targeted, which `recordDecision` does for the authors of the objections it lists). A persona never gets its own events. `open_key` (`persona|blocker or thread or event`) merges a follow-up into an open item; a `view_request` upgrades an open `mention` or `proposal` item to its kind (never a `question`, which `reviewedByOthers` reads).

## Dispatcher (scheduler tick, `dispatchResearch`)

- `timeoutRuns`: a run not ended after 15 min is `timed_out`; its unmarked items return to the inbox, and expire after `MAX_ATTEMPTS` (2).
- Per enabled persona with no queued/running run: batch wait `BATCH_SEC` 15 s unless an item is due within `URGENT_SEC` 90 s.
- Budget (Codex runs only): at >= 70% of the 5-hour window only `question`, `client_decision` and `view_request` run (`URGENT_KINDS`); at >= 90% nothing runs. `usedNow` counts a reading from before its window reset as 0. Code review seats (`triglav-code-review`) use the same reading (`codexUsedNow`) and the same 90% stop.
- Runtime: `usableRuntime(detected, persona.runtime)`; a persona saved for a missing CLI runs on the available one with `fallbackFor` model (see `triglav-models-and-usage`).
- Creates `research_runs` (queued), claims the items, inserts a `launches` row (`research_run`, ticket in the row, cleared when picked). Prompt: `RESEARCH_PROMPT(ticket)`.

## Run protocol (MCP tools in `src/mcp.ts`)

`start_run(run_ticket)` -> session token, items, notebook; `get_item` (sets the item's `read_at`, which makes a question item count as a review; returns thread messages (a Client message has author `client`), the thread's `decisions` with ids, the job with `staff_agent_id`, and for a `view_request` the `client_message_id` to answer with `in_reply_to`); `RESEARCH_PROMPT` and `researcher.md` say a `view_request` is always answered; act with `post_message` (stance and reason), `advise_decision` or `file_dissent`; `mark_item` handled/skipped with a one-line note; `update_notebook` (<= 2000 chars); `end_run`. The runner also reports process exit (`/api/runner/:id/exited`), which closes a run that never called `end_run`.

## Read-only constraints (do not widen)

- **Claude run**: `claude -p --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools mcp__orchestrator,Read,Grep,Glob --strict-mcp-config --mcp-config <private file>`. `--tools` decides which built-ins exist; `--allowedTools` and the mode only decide permission, so they cannot remove a Bash that user/repo settings allow. The prompt goes on stdin (`--allowedTools` swallows a trailing argument). `ENABLE_CLAUDEAI_MCP_SERVERS=false` so a claude.ai connector cannot replace a local server. The enrollment key lives only in the 0600 config file.
- **Codex run**: `codex exec -s read-only -c approval_policy="never"` plus `-c mcp_servers.<name>.enabled=false` (with a stub transport: `command="/bin/false"` or `url="http://127.0.0.1:9/"`) for every server in `codex mcp list --json` except `orchestrator`. `-s read-only` does not sandbox MCP tools (verified on 0.162.0). The run refuses to start if `orchestrator` is not an enabled streamable HTTP server at loopback `/mcp` with the runner's `ORCH_URL` port, or if the list cannot be read; items go back to the inbox.
- Do not add a tool, a second MCP server or a Bash rule to either.

## Codex Staff access

`codexRoleArgs` in `src/codex-args.ts` is the **only** place that sets Codex sandbox, approvals and shell environment. `staff`: `approvals_reviewer="auto_review"`, `approval_policy="on-request"`, `sandbox_mode="workspace-write"`, shell env limited to `CODEX_STAFF_ENV` (core names plus `GITHUB_TOKEN`, `SSH_AUTH_SOCK`). `researcher`: read-only, never asks. Any other role throws. Callers: `scripts/staff-start.ts`, `scripts/runner.ts` resume, `resumeArgs` in `src/telemetry.ts`, `launchCommand` in `web/src/App.tsx`; the Dockerfile copies the file into the web build stage. Widening it (`danger-full-access`, more env names, `network_access=true`) is a Client decision.

## Tests

`test/research.test.ts`, `test/research-run.test.ts`, `test/codex-args.test.ts`.
