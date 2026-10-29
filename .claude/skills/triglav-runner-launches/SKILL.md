---
name: triglav-runner-launches
description: How the Triglav server queues launches and the host runner starts Staff, resumes, switches and research runs on the machine - launch kinds, validation, environment scrubbing, background-session handling, transcript telemetry. Load before changing scripts/runner.ts, staff-start.ts, forks.ts, loopback.ts, private-file.ts, runtimes.ts, the launches table, nextLaunch/finishLaunch in src/telemetry.ts, or the Resume/Restart cards.
---

# Server launches and the host runner

Verified against the code on 2026-10-15 (code_review rows added the same day); the staff_start row on 2026-10-18; the reap_session row on 2026-10-19; the reap_worktree row and the disk report on 2026-10-20; the busy-sessions report on 2026-10-29. If you find this out of date, fix it in the same PR.

## Why it is split

The server runs in Docker and cannot start processes. It inserts a row in `launches`. The host runner (`node scripts/runner.ts`) polls `POST /api/runner/next` every 5 s (`ORCH_RUNNER_POLL_MS` for tests), builds the command itself, runs it, then calls `POST /api/runner/:id/done` with `ok: ...` or `failed: ...`. **The runner never runs a command string from the server.** The server sends ids and plain fields; the runner validates every one and builds argv.

## Launch kinds

| kind | Created by | Runner function | Command |
| --- | --- | --- | --- |
| `resume` | `requestResume` (`src/telemetry.ts`) | `resume()` | `claude --bg --settings ... --resume <session> <prompt>`, or `codex exec resume ...` with `codexRoleArgs(role)` |
| `staff_start` | `queueStaffStart` (`src/job-requests.ts`) | `startStaff` -> `runStaffStart` / `runCodexStaffStart` (`scripts/staff-start.ts`) | `claude --bg -n staff-<req> --model --effort <fixed prompt>`; Codex detached. The Claude prompt (`staffStartPrompt`) has the first turn run `timeout 20 tail -f /dev/null; true` in Bash (again, up to 3 times, while the tool is missing), then call `mcp__orchestrator__get_guide`, and never end without the call, because `--bg` starts the first turn before the MCP servers connect (3.5 to 13.7 s measured) and the model will not call a tool it cannot see. The session runs in a pre-started `claude bg-spare` process, so the runner's environment does not reach it. Codex has its own prompt (`codexStaffStartPrompt`, plain `get_guide`) |
| `staff_replace` | `replaceStaffForJob` | `replaceStaff` | stops the old Staff's live forks (after verifying lineage), then `startStaff` |
| `switch` | `requestSwitch` | `switchStaff` | stops live forks, then resumes the session with the new `--model`/`--effort`. Agent's model changes in DB only when the result starts with `ok` (`finishLaunch`) |
| `research_run` | `src/research.ts` dispatcher | `researchRun` -> `watchedRun` | see `triglav-research` |
| `code_review` | `requestCodeReview` (`src/code-review.ts`), one per seat | `codeReviewRun` | read-only `claude -p` or `codex exec` on a diff the runner computes itself (the launch carries the shas, the seat name, `base_branch`, `expect_merge_base` and `expect_ancestor`; the runner checks the seat name and puts the diff files of `strong-2` and later in a seeded order, see the code-review skill; the runner checks the merge base or that the head descends from the last passing head when asked, and never fetches); stdout goes to `POST /api/runner/:id/review-output`, not to `/exited`. See `triglav-code-review` |
| `reap_session` | `reapAbandonedSessions` (`src/scheduler.ts` tick) | `reapSession` | stops every live fork of the recorded session's lineage (`liveForksOf`, `scripts/forks.ts`); see "Reaping an abandoned session" below for the full set of safety conditions |
| `reap_worktree` | `reapFinishedWorktrees` (`src/worktrees.ts`, scheduler tick; at most `POLICY.maxQueuedWorktreeReaps` waiting, a failed path again after `worktreeReapRetrySec`) | `reapWorktree` (`scripts/worktree-reap.ts`) | `git worktree remove <path>` from the main checkout, only for a linked worktree inside `$HOME`, not locked, clean (ignored files do not count) and with every commit of HEAD on a remote-tracking branch. A missing path is `ok: already gone`. `nextLaunch` rechecks `worktreeReapable` at pickup; `finishLaunch` calls `finishWorktreeReap` (sets `removed_at` on `ok`, `last_result` either way). runtime `git`, `agent_id` NULL |

`nextLaunch` (`src/telemetry.ts`) takes the oldest unpicked row `FOR UPDATE`, and returns a shape per kind. An unknown kind is finished as `failed: unknown launch kind`, never run as a resume. A `staff_replace` is re-checked at pick-up (request still queued, job's Staff unchanged, old Staff owns no other open job).

Expiry (`expireStaleLaunches`, scheduler): unpicked after 10 min becomes `expired: no runner picked it up` (a `code_review` seat is failed with it); a picked `staff_start`/`staff_replace`/`reap_session` with no report after 5 min becomes `failed: the runner did not report back`, a picked `reap_worktree` after `POLICY.worktreeReapLostSec` (20 min, longer than the runner's git timeouts, because `recordWorktree` refuses the path only while the launch is unfinished; the worktree row gets the same `last_result`). Both call `settleRequestOfLaunch` so the job request shows the failure (a no-op for `reap_session`, which has no `run_id`).

A runner `ok` only means the background session exists. `failUnregisteredStarts` (`src/job-requests.ts`, scheduler tick) fails a request that is still `started` with no `staff_agent_id` 3 min after the report (nothing read it with `get_job_request`; the server cannot see `get_guide`. A request that was read is left alone, however long `register_job` takes. Seen 2026-10-14: the first turn said it had no `get_guide` tool and the session idled, the MCP race above), then queues the same request once more (`retryJobRequest`, or `startStaffForJob` for a takeover); a second failure of the same request within 30 min (counted from when the earlier one failed) is left to the Client. It skips dismissed requests (re-checked under the row lock), emits `job_request.failed`, and a Staff that reads or registers the failed request later is refused (`readJobRequest`, `lockRequestForRegistration`). The idle session it leaves is not stopped at once; `reap_session` above collects it once it has been inactive past `POLICY.reapAgentSessionSec`.

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

## Reaping an abandoned session

`reapAbandonedSessions` (scheduler tick) queues a `reap_session` launch for a claude-code `agent_sessions` row inactive
past `POLICY.reapAgentSessionSec` (2 h, well past `presenceOfflineSec` and `waitMaxSec`: `flagUnavailableStaff` has
long since reassigned the job). Added 2026-10-19 after 18 background sessions and 80 `agent_sessions` rows were found
never closed, some over a week old, holding several gigabytes of host memory; four Copilot review rounds on PR 37
then found the races and failure-handling gaps below, each covered by a mutation-tested regression in
`test/coordination.test.ts` / `test/runner-security.test.ts`.

A reap stops the process only; the conversation is kept. A reaped Staff that still owns an open job, on its newest
session, stays on the Resume list (`REAPED_RESUMABLE_SQL` in `src/telemetry.ts`, used by `resumeList`, `requestResume`
and `dismissResume`). `requestResume` reopens that session (`ended_at`, `end_reason` cleared) so its token
authenticates again; if the resume never reconnects, the reaper stops it again. Added 2026-10-23: a Staff whose wait
result never arrived was reaped, dropped off the Resume list, and its job could only get a new Staff.

**Staleness** (`STALE_FOR_REAP_SQL`, `src/agents.ts`, reused by `reapAbandonedSessions` and `nextLaunch`'s pickup
recheck) is `last_seen_at`/`waiting_until`/`transcript_at` all past the cutoff, `busy_at` NULL or older than
`busySessionSec` (a busy session is never reaped; the runner would refuse it), **and**:
- no sibling agent sharing this session's exact `transcript_session` is itself within that same condition
  (`NO_LIVE_SIBLING_SQL`): `register_agent` never ends a caller's previous registration, so a conversation that
  re-registers without `end_session` leaves two agent rows pointing at one process, and reaping the older row would
  stop a process the newer one is using. This uses the same two-hour-scale condition as the reap decision itself, not
  the two-minute `LIVE_SESSION_SQL` window, so a sibling busy in a long tool call with only fresh `transcript_at`
  still vetoes cleanup (`clearReturnedStaff` treats that same case as "still here").
- no `resume`/`switch` launch for this agent finished `ok` within `POLICY.reconnectGraceSec` (5 min): a resumed
  session's first orchestrator call can be several seconds away (`claude --bg` starts the model turn before MCP
  servers connect, 3.5-13.7 s measured), so it needs a window before it looks stale again. This is read back from
  `launches`, not written to `agent_sessions` — a `waiting_until` column was tried and reverted, since `presenceOf`,
  `resumeList` and `clearReturnedStaff` all read it as a real orchestrator wait and would hide the stuck-session
  recovery card, or clear an `unavailable_owner` blocker, for a resume that never actually reconnected.
- no `reap_session` launch for this agent finished within `POLICY.reapRetryCooldownSec` (10 min), regardless of
  outcome: without this, a reap that fails for a persistent reason (a busy fork, an unverifiable lineage, a listing
  read failure) was retried on every scheduler tick.

**Host-side stop** (`reapSession`, `scripts/runner.ts`): stops every live fork of the recorded session's *lineage*
(`liveForksOf`), not just its exact id, so a usage-limit continuation under a new id is not missed — the same reason
a re-registration can defeat `NO_LIVE_SIBLING_SQL` (it only compares exact `transcript_session` values, which cannot
relate different ids on one lineage). A fork the listing reports `busy` is never stopped and fails the launch
instead: a host-side backstop that does not depend on which agent row the database thinks is current. A lineage that
cannot even be verified (missing or unreadable transcript) also fails the launch rather than trusting the empty fork
list that `liveForksOf` returns for it, the same check `replaceStaff` already makes; a failure to even read the
listing is not caught either, for the same reason: `ok: already gone` must mean verified gone, not "could not check".

**Known residual gap, not yet fixed** (Copilot review on PR 37, 2026-10-19, round 5): that lineage check only covers
the *recorded* session's own transcript. If a live continuation under a different id is listed but *its* transcript
is itself missing or unreadable, `liveForksOf` silently excludes that entry (its lineage cannot be computed, so it
never matches), which can still report `ok: already gone` without stopping it. Closing this needs a reap-specific
listing check that fails whenever any candidate's lineage can't be determined, not just the recorded session's; left
open as a deliberate stopping point after four review rounds, stacked on an already narrow scenario (a re-registered
conversation whose continuation's own transcript is separately broken).

**Concurrency and completion**: `reapAbandonedSessions`, `requestResume` and `requestSwitch` all run inside `tx()`,
and `write_lock` (`src/db.ts`) serializes every `tx()` in the app, so the three can never both queue a launch for the
same agent — no separate locking needed. An explicit resume/switch request cancels a still-unpicked reap instead of
being blocked by it (`cancelUnpickedReap`); one already picked (stopping right now) still blocks the request.
`nextLaunch` rechecks the full staleness condition again at pickup and cancels the launch without touching the
session if it recovered first. A launch already finished (expired, cancelled, or a duplicate report) is never
overwritten by a late report (`finishLaunch`'s `UPDATE ... WHERE id = ? AND finished_at IS NULL`), so a slow runner
cannot un-expire a reap or close a session after the fact. `finishLaunch` sets `agent_sessions.ended_at`/`end_reason`
and emits `agent.left` (so the Roster and agent-detail pages refetch) only once the result starts with `ok`; the
conversation is kept, same as any `claude stop`, and can still be resumed by hand. A picked launch the runner never
reports back on is expired like `staff_start`/`staff_replace` (`expireStaleLaunches`), as `failed`, so it is retried
after the cooldown rather than wedging the agent's resume path forever. `recentLaunches` can exclude kinds (applied
before its own `LIMIT 10`, not by filtering its result after, which could drop a real resume/switch out of the ten
altogether), and `/api/resume` excludes `reap_session` with it: `ResumeSection` otherwise treats the newest launch of
any kind as resume progress and would show a queued stop as one, disabling the Resume button. A resume blocked by a
reap already picked (in flight, so stopping right now) is refused with a conflict rather than reported as "already
queued", since that launch is excluded from what `/api/resume` returns and the Client's optimistic "Resume request
sent..." would otherwise have nothing in the list to ever replace it; `requestSwitch` already refused any pending
launch this way, so only `requestResume`'s dual-shaped return needed the split.

## Telemetry (what the server learns from transcripts)

`ingestTelemetry` runs every 60 s (scheduler) over `~/.claude/projects` and `~/.codex/sessions`: tokens, last activity (`transcript_at`), PRs/artifacts, resumable sessions (`resumeList`), `transcript_error`, Claude/Codex plan limits. It skips files whose size and mtime did not change (`telemetry_files`; delete the row to force a re-read). Only model and tool lines count as activity. `copilotLoop` matches the `gh` commands in `src/guide/deliver.md`; change them together.

## Runtimes

`scripts/runtimes.ts` detects `claude` and `codex` and their model lists; the runner posts them to `/api/runner/runtimes` at start and every 5 min. See `triglav-models-and-usage`. It also posts the free space of the disk that holds `$HOME` (`statfsSync`) to `/api/runner/disk` at the same times (`recordHostDisk`, table `host_disk`).

## Restarting

After editing `scripts/runner.ts`: `pkill -f "^node scripts/runner.ts$"` (anchored), then `nohup node scripts/runner.ts >> ~/.local/state/triglav/runner.log 2>&1 &`.

## Tests

`test/runner-security.test.ts`, `test/staff-start.test.ts`, `test/forks.test.ts`, `test/runtimes.test.ts`, `test/telemetry.test.ts`, `test/coordination.test.ts` (`reap_session` and `reap_worktree` end to end: scheduler queue, `nextLaunch`, `finishLaunch`), `test/worktree-reap.test.ts` (the git checks on real repositories).

Every 60 s the runner also runs `claude agents --json` (fixed argv, no `--cwd`, `staffStartEnv`, 30 s timeout with SIGKILL, 4 MB output cap, a tick is skipped while the last runs, `busyReporter`) and posts only `{sessionId, status, state}` of `busy` entries (`busyOf` in `scripts/forks.ts`: full UUID and a pid, `blocked` dropped, unknown state as null, max 200) to `/api/runner/busy-sessions`. Errors log a fixed line, never the output. See `triglav-agent-sessions` for what the server does with it.
