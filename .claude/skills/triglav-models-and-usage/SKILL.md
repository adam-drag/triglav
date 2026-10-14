---
name: triglav-models-and-usage
description: How Triglav picks a runtime, model and effort per role, detects the installed Claude Code and Codex CLIs and their model lists, edits agents, reads transcripts for tokens and plan limits, and keeps token cost down (wake lists, wait lengths, compaction). Load before changing src/models.ts, src/agent-edit.ts, scripts/runtimes.ts, usage/limits code in src/telemetry.ts, the Models or Usage pages, or anything that changes how many turns or how much context an agent uses.
---

# Models, runtimes and usage

Verified against the code on 2026-10-15. If you find this out of date, fix it in the same PR.

## Role models

- Table `role_models` (roles `staff, senior, reviewer, researcher`): saved `runtime`, `model`, `effort`. Seniors and reviewers are Staff's subagents, so their model is handed out in the spawn ticket (`startHint`). Staff and researchers are launched from the dashboard or runner. A change applies to agents started afterwards.
- **Always read through `effectiveRoleModel(ctx, conn, role)` / `effective(det, m)`, never by SQL.** If the runner reported the saved CLI missing and exactly one other CLI present, `effective()` returns the other CLI with the `FALLBACK` model and effort for that role, and `replaces` shows what was swapped. It never writes the swap to `role_models`.
- `FALLBACK` (today): Claude Code staff opus-5-5 high, senior/reviewer sonnet-5-5 high, researcher opus-5-5 high; Codex `gpt-6.1-sol` (researcher medium, others high). Re-check the file; these change.
- Values must match `SAFE` (`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`), because they end up in commands the Client copies and in runner argv.
- `updateRoleModel` validates against the CLI's own model list (`checkAgainstCatalog`): unknown model or an effort the model does not accept is refused. With no list, anything safe passes.
- `settings.review_mode` (`auto | copilot | ci_only`) lives in `models.ts` too (`reviewMode`, `setReviewMode`). See `triglav-jobs-and-leases` for what it gates.

## Detection

- The server cannot see the host. `scripts/runtimes.ts` `detectRuntimes()` runs `claude --version` / `codex --version`; models come from `codex debug models` (visible ones with effort levels) and Claude Code's stream-json `initialize` control reply (`resolvedModel`, `supportedEffortLevels`; no model runs). Cached 1 h per CLI version; an empty answer is not cached.
- The runner posts to `/api/runner/runtimes` at start and every 5 min. `recordHostRuntimes` replaces the report. `detectedRuntimes().known` is false when there is no report or it is older than 15 min; **unknown changes nothing** (no fallback, no catalog check).
- `usableRuntime(det, wanted)`: swap only when known, wanted is missing and exactly one other is present.
- Dropdowns (`ModelPicker` in `web/src/App.tsx`) come from this list; with no list they fall back to text fields. The Arch `openai-codex` 0.153.4 refuses `gpt-6.1-sol`; npm `@openai/codex` 0.162.0 accepts it.

## Editing an agent (`editAgent`, also the Operator's `edit_agent`)

Rename applies at once. Model/effort: needs both values; Seniors and reviewers cannot be switched (change the role instead); only a Claude Code Staff can be restarted (`requestSwitch` creates a `switch` launch, and the agent row changes only when the runner reports `ok`); a researcher persona keeps model/effort in `researcher_personas` and uses them from its next run. The runtime never changes.

## Transcript telemetry and usage

- `ingestTelemetry` (every 60 s, scheduler) walks `~/.claude/projects` and `~/.codex/sessions` (mounted read-only into the container). Only sessions that passed a Triglav session token to an orchestrator tool are counted. A re-read replaces the file's rows (idempotent). `telemetry_files` skips unchanged files (size + mtime); delete the row to force a re-read.
- Tables: `usage_daily` (tokens per day/model/agent), `artifacts` (branch, push, PR URLs found in transcripts), `claude_usage`, `codex_budget`.
- Plan limits: Codex writes 5-hour and weekly usage into every transcript (`ingestCodexBudget`). Claude writes only the reset time of a refused request (`ingestClaudeLimit`, source `transcript`, used = 100); exact readings come from `scripts/claude-statusline.sh` (posts to `/api/usage/claude`, source `statusline`) or the Operator's stream (`rate_limit_event`, source `stream`; the fraction scale is an assumption, see `translate()` in `scripts/operator.ts`). A reading never replaces a newer one; a window past its reset shows as reset (`planLimits`).
- **Counting tokens by hand**: Claude Code writes one transcript line per content block with repeated `usage`, so dedupe by `message.id`.

## Token cost is a design constraint

Every return of a wait is a model turn that re-reads the whole context (300k to 700k tokens for Staff). Levers in the code:
- `STAFF_WAKE_TYPES` (`src/events.ts`): Staff wakes only for events it must act on.
- Waits: Staff 3000 s (one-hour prompt cache, MCP timeout 3500000 ms honoured by Claude Code, Codex `tool_timeout_sec` 330), Seniors 240 s (five-minute cache). `POLICY.waitDefaultSec`, `staffWaitSec`, `waitMaxSec` in `src/context.ts`.
- Staff compaction: `STAFF_CLAUDE_SETTINGS = {"autoCompactWindow":300000}` (effective window 280000; the default for Opus is 980000, so Staff never compacted). Three copies: `src/telemetry.ts`, `scripts/runner.ts`, `web/src/App.tsx`.
- Researchers run on demand with a notebook (see `triglav-research`).
- Staff writes its prompt cache at the one-hour TTL; subagents at five minutes.
- Measure before and after a change that affects turns or context size.

## Tests

`test/runtimes.test.ts`, `test/telemetry.test.ts`, `test/agent-edit.test.ts`, `test/plan-limits.test.ts`.
