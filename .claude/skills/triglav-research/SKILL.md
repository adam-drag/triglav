---
name: triglav-research
description: How Triglav researchers work - personas and the kinds they receive, inbox routing from events, the run dispatcher and its budget guard (Codex and Claude windows), run usage and the exit report, the run ticket protocol (start_run, get_item, mark_item, end_run), and the read-only constraints of Claude and Codex research runs and Codex Staff access. Load before changing src/research.ts, scripts/research-run.ts, src/codex-args.ts, the researcher MCP tools, the Researchers page, or Codex sandbox/approval settings.
---

# Researchers

Verified against the code on 2026-11-24 for phase 2 (pinned trees: `src/research-trees.ts` decides the commit per job, `scripts/research-trees.ts` makes the tree and the review diff, the persona folder is the run's cwd, `--setting-sources ""` and path-scoped reads in `claudeResearchArgs`); before that on 2026-11-19 (persona kinds, batching per kind, the Claude window guard, busy until exit, run usage from stream-json, the runner's 14-minute stop, migration 061); before that on 2026-11-12 (claude -p connector fact moved from AGENTS.md); before that on 2026-10-15 (persona runtime, model and effort edited together via updatePersona 2026-10-26; plan reviews 2026-10-23; routing and get_item re-checked 2026-10-18; view requests 2026-10-20; persona rename via PUT /api/agents/:id and `deletePersona` 2026-10-27). If you find this out of date, fix it in the same PR.

## Idea

A researcher has no session between runs (an always-on one burned the Codex window, measured 2026-10-08). Triglav routes events into a **persona inbox**; a dispatcher starts a short run per batch; the run trades a one-off ticket for a session token, handles its items, marks each one, and exits. Memory between runs is a small notebook.

## Files

| File | Owns |
| --- | --- |
| `src/research.ts` | `routeToInbox`, `dispatchResearch`, `closeRun`/`closeRunOfLaunch`, run protocol (`startRun`, `getItem`, `markItem`, `updateNotebook`, `endRun`), personas (`createPersona`, `updatePersona`, `deletePersona`: removes the persona, inbox, notebook and finished runs, keeps the agent row and its messages, refuses while a run is queued or running), `researchOverview` (also cost per persona for 7 days, the Claude reading, `PERSONA_KINDS`), `RESEARCH_PROMPT`, budget (`codexBudget`, `codexUsedNow`, `recordCodexBudget`, `claudeUsedNow`), `batchReady`, `recordRunExit` |
| `scripts/research-run.ts` | `claudeResearchArgs`, `researchMcpConfig`, `codexMcpDisableArgs` (keeps the orchestrator on), `codexMcpDisableAllArgs` (everything off, used by code reviewers), `isOrchestratorEndpoint` |
| `src/codex-args.ts` | `codexRoleArgs(role)`, `CODEX_STAFF_ENV` |
| `src/research-trees.ts` | `headOfJob` (a job's head: its newest delivery or review package), `treesOfRun` (the persona and the trees of a run, at most `MAX_TREE_JOBS` 4), used by `nextLaunch` and `getItem` |
| `scripts/research-trees.ts` | `prepareTrees` (a detached, locked worktree per commit under `~/.local/state/triglav/research-trees`, reused; the review diff into the persona folder), `studyBlock` (the lines the prompt gets), `sweepTrees` (trees not used for a day, removed through git without `--force`), `personaFolder` |
| `scripts/runner.ts` | `researchRun`, `watchedRun` (see `triglav-runner-launches`) |
| `scripts/claude-stream.ts` | `planWindows` (a `rate_limit_event`, also used by the Operator), `runUsage` (the final `result`), `streamReader` |

## Routing (in `emit()`, same transaction)

`kindOf` maps events to inbox kinds: `question.opened` -> question, `proposal.posted` -> proposal, `mention` -> mention (only if targeted at that persona), or `view_request` when the payload has `view_requested` (a Client mention, see `triglav-jobs-and-leases` Board), `review.submitted` -> review (only for personas who already posted on that job), `blocker.raised` with kind `client_decision` -> client_decision (not when Staff set `routine`, a step the Client only does or confirms: no run is spent on it), `decision.recorded`/`decision.superseded` -> decision (only if targeted, which `recordDecision` does for the authors of the objections it lists). A persona never gets its own events. `researcher_personas.kinds` (JSON, NULL = all; `kindsOf` reads a bad value as all) limits question, proposal, review and client_decision (`PERSONA_KINDS`); mention, view_request and decision are addressed, so they always arrive. `open_key` (`persona|blocker or thread or event`) merges a follow-up into an item that is still `new`; the claim clears `open_key`, so an event during a run makes a new item. A `view_request` upgrades a `new` `mention` or `proposal` item to its kind; a `question` keeps its kind and title (`reviewedByOthers` reads the kind).

Open items show on the Client queue: `clientQueue` (`src/blockers.ts`) adds `researching` (agent id and status of each `new` or `claimed` item for that blocker, enabled personas only) and the decision card shows the name with `WorkingDots`. `closeRun` emits `research.run_closed` so an expired or returned item updates the card.

## Plan reviews

A plan review is a `question` item titled `Plan review: ...` (see `triglav-jobs-and-leases`). Marking every item of the thread handled or skipped closes it early (`planReviewSettled`). `researchUnavailable` decides when Staff skips it: no enabled persona, no runner report in 15 min, no CLI available, or every persona on Codex at `BUDGET_STOP`.

## Dispatcher (scheduler tick, `dispatchResearch`)

- `timeoutRuns`: a run not ended after 15 min is `timed_out`; its unmarked items return to the inbox, and expire after `MAX_ATTEMPTS` (2).
- Busy: a persona with a queued or running run, or with a closed run that was started and whose process has not exited (`exited_at` NULL, closed less than `EXIT_GRACE_MIN` 5 min ago), gets no new run.
- Batch (`batchReady`): an `URGENT_KINDS` item starts a run after `BATCH_SEC` 15 s, any other kind after `BATCH_SLOW_SEC` 120 s, any item due within `URGENT_SEC` 90 s at once; the run claims every waiting item.
- Budget: each run uses its CLI's 5-hour window, Codex (`codexUsedNow`) or the Claude plan (`claudeUsedNow`, `claude_usage` row `five_hour`). At >= 70% only `question`, `client_decision` and `view_request` run (`URGENT_KINDS`); at >= 90% nothing runs. `usedNow` counts a reading from before its window reset as 0. Claude readings come from research run exits (source `research`), Operator and Architect chats (`stream`) and the status line. Code review seats (`triglav-code-review`) use the Codex reading and the same 90% stop.
- Runtime: `usableRuntime(detected, persona.runtime)`; a persona saved for a missing CLI runs on the available one with `fallbackFor` model (see `triglav-models-and-usage`).
- Creates `research_runs` (queued), claims the items, inserts a `launches` row (`research_run`, ticket in the row, cleared when picked). Prompt: `RESEARCH_PROMPT(ticket)`.

## Run protocol (MCP tools in `src/mcp.ts`)

`start_run(run_ticket)` -> session token, items, notebook; `get_item` (sets the item's `read_at`, which makes a question item count as a review; returns thread messages (a Client message has author `client`), the thread's `decisions` with ids, the job with `staff_agent_id`, `repo_path`, `base_branch`, `head_sha`, `head_source` and `pr_url` (`headOfJob`, the commit its pinned tree is at), and `client_message_id` when a Client mention of this researcher was merged into the item, whatever its kind, found from the Client's `mention` events up to the item's `event_id`); `RESEARCH_PROMPT` and `researcher.md` say such an item is always answered; act with `post_message` (stance and reason), `advise_decision` or `file_dissent`; `mark_item` handled/skipped with a one-line note; `update_notebook` (<= 2000 chars); `end_run`. The runner also reports process exit (`/api/runner/:id/exited`), which closes a run that never called `end_run`. A Claude run prints stream-json; the runner keeps lines of at most `LOG_LINE_MAX` in the log up to `LOG_MAX`, reads the final usage and the newest plan windows (`streamReader`), and sends them with the exit as `usage` and `windows`. The route parses those apart from `code` and `tail` (`runExitExtra`), so a bad value never blocks the exit; `recordRunExit` sets `exited_at` and the usage columns, the windows go to `recordClaudeUsage`. The tail is cut to `EXIT_TAIL_MAX` 4000 characters. The runner stops a run (SIGTERM, then SIGKILL after 10 s) at `RESEARCH_KILL_MS` 14 min, a minute before `timeoutRuns`. `mark_item` notes and notebook entries go through `assertNoSecrets`.

## Read-only constraints (do not widen)

- **Claude run**: `claude -p --setting-sources "" --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools mcp__orchestrator Read(//<pinned folder>/**) ... --disallowedTools Read(//<folder>/**/<secret file>) ... --strict-mcp-config --mcp-config <private file>`, started in the persona's own folder (`~/.local/state/triglav/research/<persona>`). Read, Grep and Glob have no bare permission: they work only inside the pinned folders (`scripts/research-trees.ts`, phase 2 of docs/plans/researcher-access.md). `--tools` decides which built-ins exist; `--allowedTools` and the mode only decide permission, so they cannot remove a Bash that user/repo settings allow. The prompt goes on stdin (`--allowedTools` swallows a trailing argument). `ENABLE_CLAUDEAI_MCP_SERVERS=false` so a claude.ai connector cannot replace a local server: on an account that has a claude.ai connector, Claude Code can drop a local MCP server of the same name in favour of the connector, and a connector cannot do OAuth in print mode (seen with a Slack plugin server). The enrollment key lives only in the 0600 config file.
- **Codex run**: `codex exec -s read-only -c approval_policy="never"` plus `-c mcp_servers.<name>.enabled=false` (with a stub transport: `command="/bin/false"` or `url="http://127.0.0.1:9/"`) for every server in `codex mcp list --json` except `orchestrator`. `-s read-only` does not sandbox MCP tools (verified on 0.162.0). The run refuses to start if `orchestrator` is not an enabled streamable HTTP server at loopback `/mcp` with the runner's `ORCH_URL` port, or if the list cannot be read; items go back to the inbox.
- Do not add a tool, a second MCP server or a Bash rule to either.

## Codex Staff access

`codexRoleArgs` in `src/codex-args.ts` is the **only** place that sets Codex sandbox, approvals and shell environment. `staff`: `approvals_reviewer="auto_review"`, `approval_policy="on-request"`, `sandbox_mode="workspace-write"`, shell env limited to `CODEX_STAFF_ENV` (core names plus `GITHUB_TOKEN`, `SSH_AUTH_SOCK`). `researcher`: read-only, never asks. Any other role throws. Callers: `scripts/staff-start.ts`, `scripts/runner.ts` resume, `resumeArgs` in `src/telemetry.ts`, `launchCommand` in `web/src/App.tsx`; the Dockerfile copies the file into the web build stage. Widening it (`danger-full-access`, more env names, `network_access=true`) is a Client decision.

## Tests

`test/research.test.ts`, `test/research-run.test.ts`, `test/codex-args.test.ts`.
