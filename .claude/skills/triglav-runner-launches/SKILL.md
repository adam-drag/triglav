---
name: triglav-runner-launches
description: How the Triglav server queues launches and the host runner starts Staff, resumes, switches and research runs on the machine - launch kinds, validation, environment scrubbing, background-session handling, transcript telemetry. Load before changing scripts/runner.ts, staff-start.ts, forks.ts, loopback.ts, private-file.ts, runtimes.ts, the launches table, nextLaunch/finishLaunch in src/telemetry.ts, or the Resume/Restart cards.
---

# Server launches and the host runner

Verified against the code on 2026-10-15 (code_review rows added the same day). If you find this out of date, fix it in the same PR.

## Why it is split

The server runs in Docker and cannot start processes. It inserts a row in `launches`. The host runner (`node scripts/runner.ts`) polls `POST /api/runner/next` every 5 s (`ORCH_RUNNER_POLL_MS` for tests), builds the command itself, runs it, then calls `POST /api/runner/:id/done` with `ok: ...` or `failed: ...`. **The runner never runs a command string from the server.** The server sends ids and plain fields; the runner validates every one and builds argv.

## Launch kinds

| kind | Created by | Runner function | Command |
| --- | --- | --- | --- |
| `resume` | `requestResume` (`src/telemetry.ts`) | `resume()` | `claude --bg --settings ... --resume <session> <prompt>`, or `codex exec resume ...` with `codexRoleArgs(role)` |
| `staff_start` | `queueStaffStart` (`src/job-requests.ts`) | `startStaff` -> `runStaffStart` / `runCodexStaffStart` (`scripts/staff-start.ts`) | `claude --bg -n staff-<req> --model --effort <fixed prompt>`; Codex detached. The Claude prompt (`staffStartPrompt`) names `mcp__orchestrator__get_guide`, says the tools may take a few seconds to connect and that the first turn must not end without the call, because `--bg` starts the first turn before the MCP servers connect (3.5 to 13.7 s measured) and a full-name call waits for the connection. Codex has its own prompt (`codexStaffStartPrompt`, plain `get_guide`) |
| `staff_replace` | `replaceStaffForJob` | `replaceStaff` | stops the old Staff's live forks (after verifying lineage), then `startStaff` |
| `switch` | `requestSwitch` | `switchStaff` | stops live forks, then resumes the session with the new `--model`/`--effort`. Agent's model changes in DB only when the result starts with `ok` (`finishLaunch`) |
| `research_run` | `src/research.ts` dispatcher | `researchRun` -> `watchedRun` | see `triglav-research` |
| `code_review` | `requestCodeReview` (`src/code-review.ts`), one per seat | `codeReviewRun` | read-only `claude -p` or `codex exec` on a diff the runner computes itself; stdout goes to `POST /api/runner/:id/review-output`, not to `/exited`. See `triglav-code-review` |

`nextLaunch` (`src/telemetry.ts`) takes the oldest unpicked row `FOR UPDATE`, and returns a shape per kind. An unknown kind is finished as `failed: unknown launch kind`, never run as a resume. A `staff_replace` is re-checked at pick-up (request still queued, job's Staff unchanged, old Staff owns no other open job).

Expiry (`expireStaleLaunches`, scheduler): unpicked after 10 min becomes `expired: no runner picked it up` (a `code_review` seat is failed with it); a picked `staff_start`/`staff_replace` with no report after 5 min becomes `failed: the runner did not report back`. Both call `settleRequestOfLaunch` so the job request shows the failure.

A runner `ok` only means the background session exists. `failUnregisteredStarts` (`src/job-requests.ts`, scheduler tick) fails a request that is still `started` with no `staff_agent_id` 3 min after the report (nothing read it with `get_job_request`; the server cannot see `get_guide`. A request that was read is left alone, however long `register_job` takes. Seen 2026-10-14: the first turn said it had no `get_guide` tool and the session idled, the MCP race above), then queues the same request once more (`retryJobRequest`, or `startStaffForJob` for a takeover); a second failure of the same request within 30 min (counted from when the earlier one failed) is left to the Client. It skips dismissed requests (re-checked under the row lock), emits `job_request.failed`, and a Staff that reads or registers the failed request later is refused (`readJobRequest`, `lockRequestForRegistration`). The idle session it leaves is not stopped yet.

## Adding a launch kind (checklist from AGENTS.md)

1. Insert into `launches` (`kind`, `run_id`, `ticket`, ...). Migration if a column is needed.
2. Branch in `nextLaunch()`.
3. Branch in `resume()` in `scripts/runner.ts` (and a unit test beside `test/staff-start.test.ts` / `test/runner-security.test.ts`).
4. Handle it in `/api/runner/:id/exited` and `/done` in `src/server.ts` if it has a process to watch.

## What the runner checks

- `checkLaunchId` (`lch_<16 hex>`): the id goes into a log file name and a URL.
- `checkedCwd`: `realpath` inside `$HOME` and a directory.
- Session ids must match the UUID regex; model `MODEL` regex (no leading `-`); effort `EFFORT` regex (Claude levels: low, medium, high, xhigh, max; Codex any lowercase word, the model list decides).
- `staffStartEnv(process.env)` on **every** child: drops `ORCH_*`, `MYSQL_*`, `DATABASE_URL`, `LINEAR_API_KEY`.
- Server URL: `loopbackBase(ORCH_URL)` must be `http` to localhost, 127.0.0.1 or [::1]; `loopbackFetch` uses its own `http.Agent` (ignores proxy env) and treats a redirect as an error. The runner key is used only for `/api/runner/*`. The enrollment key is read only to write a research run's private MCP config.
- `private-file.ts`: 0600 file in a fresh 0700 dir for configs that hold a token; removed on process exit, runner stop, and swept (older than 1 h) at start.
- `startFailureHint` turns known start failures (untrusted folder, ENOENT, timeout) into one sentence for the dashboard.

## Background sessions (Claude Code)

- Staff runs as a `claude --bg` session. `scripts/forks.ts` finds live forks of a session's lineage with `claude agents --json`: `runningFork` ignores idle forks, `liveForkIds` returns every live one (idle or busy).
- Resume skips with `ok: skipped: ...` when a busy fork of that lineage exists; `stopIdleForks` stops idle ones first (an idle fork holds the session but will never act, seen after `API Error: Connection lost mid-response`).
- `STAFF_CLAUDE_SETTINGS` = `{"autoCompactWindow":300000}` exists in 3 places: `src/telemetry.ts`, `scripts/runner.ts`, `web/src/App.tsx`. Change all three.
- Codex has no background mode: the runner spawns it detached with output in `~/.local/state/triglav/codex-<session>.log`. Logs go to `~/.local/state/triglav/`.

## Telemetry (what the server learns from transcripts)

`ingestTelemetry` runs every 60 s (scheduler) over `~/.claude/projects` and `~/.codex/sessions`: tokens, last activity (`transcript_at`), PRs/artifacts, resumable sessions (`resumeList`), `transcript_error`, Claude/Codex plan limits. It skips files whose size and mtime did not change (`telemetry_files`; delete the row to force a re-read). Only model and tool lines count as activity. `copilotLoop` matches the `gh` commands in `src/guide/deliver.md`; change them together.

## Runtimes

`scripts/runtimes.ts` detects `claude` and `codex` and their model lists; the runner posts them to `/api/runner/runtimes` at start and every 5 min. See `triglav-models-and-usage`.

## Restarting

After editing `scripts/runner.ts`: `pkill -f "^node scripts/runner.ts$"` (anchored), then `nohup node scripts/runner.ts >> ~/.local/state/triglav/runner.log 2>&1 &`.

## Tests

`test/runner-security.test.ts`, `test/staff-start.test.ts`, `test/forks.test.ts`, `test/runtimes.test.ts`, `test/telemetry.test.ts`.
