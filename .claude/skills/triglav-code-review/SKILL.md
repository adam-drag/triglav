---
name: triglav-code-review
description: How Triglav's local code review works - a Senior asks for a panel of read-only reviewers (Codex and Claude) to review base..head sha of its worktree before pushing; seats and runtime fallback, the code_review launch and runner, parsing untrusted reviewer output, merging findings, verdict, answer_finding, the code_review.finished event. Load before changing src/code-review.ts, scripts/code-review-run.ts, the code_review launch branch in runner.ts or nextLaunch, the request_code_review, get_code_review or answer_finding tools, or migration 033.
---

# Local code review

Verified against the code on 2026-10-15. If you find this out of date, fix it in the same PR. This is PR A of the plan: the server and runner module and the three tools. The gate on `submit_review_package`/Copilot, the dashboard and the tuned prompt are later PRs, so nothing forces a Senior to ask for a review yet.

## Flow

1. A Senior (holding an assignment) calls `request_code_review(worktree, base_sha, head_sha, notes)`. `requestCodeReview` (`src/code-review.ts`) validates (40-hex shas, absolute path, no secrets in notes), is idempotent for the same running range, refuses a second range while one runs, numbers the round (`round_no`), and runs `resolveSeats`. The Senior must hold an assignment with a live lease (the same fence as `report_progress`).
2. One `code_reviews` row, one `code_review_runs` row and one `launches` row (`kind 'code_review'`, `run_id` = the run id, `agent_id` = the Senior) per seat. Tables: `src/migrations/033_code_reviews.sql` (`code_reviews`, `code_review_runs`, `code_review_findings`).
3. `nextLaunch` -> `codeReviewLaunch`: marks the run `running` and returns ids, shas, model, effort and a **server-built prompt** (`buildReviewPrompt`: workflow, repository rule files, severities, JSON shape; the ticket, criteria and PR notes are marked as data). Never a command.
4. The runner (`codeReviewRun` in `scripts/runner.ts`) checks the fields, computes the diff itself (`worktreeDiff`: worktree must be at `head_sha`, no uncommitted tracked change, base present; `--unified=5`; a diff over `MAX_DIFF_CHARS` (250000) is refused, never cut), builds argv, runs the reviewer (`runReviewer`, which waits for `close` so no output is lost) with the prompt on stdin, keeps only the answer and usage lines of a Codex stream (`codexKeepLine`), fails the seat on kept output over 500000 characters, a JSON body over `MAX_REPORT_BYTES` (900000, Fastify's limit is 1 MB), a signal or the 20 min timeout, and posts `{code, stdout, stderr, secs}` to `POST /api/runner/:id/review-output` (runner key only, like every `/api/runner/*` route; no `OPEN_API_ROUTES` entry). A start failure goes through `/done failed:`, which fails the seat at once (`finishLaunch`).
5. `recordReviewOutput` parses (`parseReviewerOutput`), stores the seat, and when every seat has ended `finalizeIfDone` merges, writes `code_review_findings`, sets verdict and emits `code_review.finished`.
6. The Senior reads `get_code_review` and answers findings with `answer_finding` (valid, debatable, invalid, with a reason); the verdict is recomputed. `answer_finding` is a write: a Senior needs a live assignment on the job, Staff must be the job's Staff.

## Seats

`DEFAULT_PANEL` (Client decision 2026-10-15): `strong` = codex `gpt-6.1-sol` high, `cheap-claude` = claude-code `claude-sonnet-5-5` low, `cheap-codex` = codex `gpt-6-luna` low ("smallest model" is a naming guess). `resolveSeats` (pure, tested): Codex is usable when the runner reports it and `codexUsedNow` < 90; Claude when reported. The strong seat prefers the family other than the Senior's own runtime. An unusable seat runs on the other CLI with `SEAT_FALLBACK` models (strong: claude-opus-5-5 high), a model missing from the runner's list is replaced the same way, and a seat identical to an earlier one is dropped (recorded in `summary.dropped`). Each seat stores `runtime`, `family`, `model`, `effort`, `note`; `get_code_review` shows `same_family` when one family covers every seat. No runtime at all: the review is `failed`, an `external` blocker is raised (actor `code-review`) and the event is sent. A model the CLI does not list is replaced by the seat's fallback on the same CLI, then by the other CLI's fallback, and otherwise the seat is dropped.

## Reviewer command (`scripts/code-review-run.ts`)

- Claude: `claude -p --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --permission-mode dontAsk --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources user --settings {"disableAllHooks":true} --disable-slash-commands --no-session-persistence --output-format json --json-schema <schema>`; env `ENABLE_CLAUDEAI_MCP_SERVERS=false`. No Bash, so the diff is in the prompt. The two settings flags keep the reviewed repository's hooks from running (checked 2026-10-15: without them a project hook ran under `claude -p`).
- Codex: `codex exec --skip-git-repo-check --json -s read-only -c approval_policy="never" -m -c model_reasoning_effort --disable hooks --disable plugins <every MCP server off> --output-schema <private file> -C <cwd> -`. `codexMcpDisableAllArgs` (`scripts/research-run.ts`) switches off every server of `codex mcp list --json`, the orchestrator too. **No `--ephemeral`**: telemetry reads the Codex plan window from session files, so an ephemeral run would be invisible to the budget guard.
- `codex review` is not used (spike, codex-cli 0.162.0): it refuses a prompt together with `--base`/`--commit`, a custom prompt only adds to its built-in one, and it prints no JSON or usage.
- Env is `staffStartEnv(process.env)`: no Triglav secret reaches a reviewer, and it has no session token.

## Output handling (untrusted)

`parseReviewerOutput(runtime, stdout, cwd)`: Codex = JSONL, last `agent_message` text, usage summed over `turn.completed`; Claude = JSON envelope, `structured_output` or `result` text, usage and `total_cost_usd`. The answer must be `{findings: [...]}`; each finding is validated alone (severity P0-P3, title <= 200, body <= 4000), bad ones are dropped and counted in `rejected`, never repaired. Caps: 100 findings, 20 sites each; control characters removed; sites must be relative paths inside the worktree (no `..`, no absolute path elsewhere). Text is stored and shown as data, never executed.

## Merge and verdict

`mergeFindings`: deterministic clustering; same cause when titles are alike (Jaccard >= 0.6), or sites are within 5 lines of one file and title+body overlap (>= 0.25), or one file and title >= 0.4. The merged finding has the union of sites, the highest severity, the text of its most severe report, and the seats that raised it. The thresholds are a first guess; checked only against the 2026-10-15 baseline outputs, where they merged nothing wrongly (there was no cross-seat duplicate in that data to confirm merging).

`blocks(finding)`: P0/P1 block unless triaged `invalid`; P2 blocks until triaged `debatable` or `invalid`; P3 never. A `valid` triage does not clear anything: a fix is a new head sha and a new review. `verdict` is `ok` or `changes`; any failed, timed-out or unparseable seat makes the review `failed`, which never passes. Failed seats do not raise blockers; the guide says retry once, then raise one. `timeoutReviewRuns` (scheduler tick) fails a running seat 25 min after it started (`started_at`, so a late pick-up still gets the runner's 20 min) and a queued seat 25 min after the request; `expireStaleLaunches` drops unpicked launches after 10 min, one conditional update per launch. A failed review lists no blocking finding (its findings stay visible).

## Event

`code_review.finished` (payload: review_id, job_id, head_sha, status, verdict, failure, findings counts) is emitted with `jobId: null` and `targets: [the Senior]`, so an `owned` read matches only the Senior. It is not in `STAFF_WAKE_TYPES`; do not add it.

## Tests

`test/code-review.test.ts` (argv, diff, seats, parsing, merge, verdict, prompt; no database), `test/code-review-flow.test.ts` (flow, fallback, failure, timeout, event routing, route auth; needs `ORCH_TEST_DATABASE_URL`).
