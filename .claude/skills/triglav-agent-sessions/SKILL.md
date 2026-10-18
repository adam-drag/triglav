---
name: triglav-agent-sessions
description: How agent registration, session tokens, presence, heartbeats, the event log and wait_for_events work in Triglav. Load before changing src/agents.ts, src/events.ts, src/context.ts, src/scheduler.ts, the wait_for_events tool, presence on the dashboard, or which events wake Staff or a researcher.
---

# Agent sessions, presence and events

Verified against the code on 2026-10-15 (`endSession` 2026-10-18). If you find this out of date, fix it in the same PR.

## Files

| File | Owns |
| --- | --- |
| `src/agents.ts` | `registerAgent`, `authenticate`, `markWaiting`, `endSession`, `presenceOf`, `listAgents`, `pokeAgent`, `openWorkFor` (Stop hook), `controlFor` |
| `src/events.ts` | `emit`, `readEvents`, `waitUntil`, `STAFF_WAKE_TYPES`, `RESEARCHER_WAKE_TYPES` |
| `src/context.ts` | `POLICY` constants, `Ctx` (pool, clock, linear, bus, baseUrl), `tx()` |
| `src/scheduler.ts` | `tick()` every second, `startScheduler` |
| `src/mcp.ts` | `wait_for_events` tool, `waitSecFor` |

## Registration and tokens

- Roles: `staff`, `senior`, `reviewer`, `researcher` (`ROLES`).
- A Senior or reviewer must register with a **spawn ticket** (issued by its Staff, single use, expires after `POLICY.spawnTicketSec`). Staff and researcher must not send one.
- Registering a ticket holder claims its assignment in the same transaction (`claimAssignment`), which starts a new attempt number. See the `triglav-jobs-and-leases` skill.
- The session token is `newSecret(TOKEN_PREFIX)`; only its SHA-256 is stored in `agent_sessions.token_hash`.
- `authenticate()` runs on every agent call. It updates `last_seen_at` and **renews the lease of every held assignment** (`POLICY.leaseSec`, 30 min). Any call is a heartbeat.
- `endSession()` marks the session ended (it can never authenticate again) and gives back the assignments it holds at once; see the `triglav-jobs-and-leases` skill.

## Presence (derived, never stored)

`presenceOf()` from `last_seen_at`, `waiting_until`, `transcript_at`, `ended_at`:
`ended` > `waiting` (inside a wait) > `active` (idle < `presenceActiveSec`, 2 min) > `working` (transcript moved recently, from telemetry) > `stale` (< `presenceOfflineSec`, 15 min) > `offline`.

- Researcher personas have no session between runs. `listAgents()` overrides their presence (`starting` when a run is queued, else `waiting`, `offline` when disabled).
- `LIVE_SESSION_SQL` / `liveSessionParams` is the one definition of "live session". The scheduler and `ownerIsLive` share it. `ownerIsLive` locks the session rows, so take the job lock first, then these rows.

## Events

- Every state change calls `emit(conn, ctx, {type, jobId, threadId, actor, targets, payload})` inside the caller's transaction. `targets` is stored in `payload.targets`.
- `emit` also calls `routeToInbox` (`src/research.ts`) so researchers get inbox items in the same transaction. They do not poll.
- `readEvents` scopes: `owned` (targeted at me, my staff jobs, jobs where I hold an assignment) or `all_jobs`. The agent's own events are excluded. The cursor always advances to the newest event scanned.
- `tx()` emits `change` on `ctx.bus` after commit. `waitUntil` re-checks on every `change`.

## wait_for_events

- Staff wakes only for `STAFF_WAKE_TYPES`. Other events are collected and returned with the next waking event or the timeout. Reason: every return is a model turn that re-reads 300k to 700k tokens. See AGENTS.md "Token cost".
- Staff waits `staffWaitSec` (3000 s), others `waitDefaultSec` (240 s). A session whose client aborts a long wait early gets `wait_cap_sec` set to the default.
- `markWaiting` sets `waiting_until` for the duration and clears it in `finally`.
- Adding an event type: decide if Staff or researchers must wake for it. If yes add it to the matching list. A wake is a cost; default to not waking.

## Scheduler `tick()`

Order: due question deadlines (`reconcileQuestion`), `expireLeases` (3 failed attempts raise a `failed_execution` blocker), `flagUnavailableStaff` (offline owner raises `unavailable_owner`), `clearReturnedStaff`, `dispatchResearch`, `expireStaleLaunches`. Separate intervals: Linear refresh and telemetry ingest, 60 s each. `every()` never overlaps itself.

## Control signal and Stop hook

- `controlFor` returns `continue`, `pause` or `cancel`. A Senior keeps seeing `cancel` for a cancelled job so it learns to stop.
- `openWorkFor` backs `scripts/stop-hook.sh`: Staff owning open non-paused jobs, or a Senior/reviewer holding a live lease, may not end its turn.

## Tests

`test/coordination.test.ts`, `test/protocol.test.ts` (need the throwaway MySQL, see AGENTS.md).
