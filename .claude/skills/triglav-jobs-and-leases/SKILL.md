---
name: triglav-jobs-and-leases
description: The Triglav job lifecycle and the coordination around it - job statuses and who may move them, refinement of prompt jobs, spawn tickets, assignments with leases and attempt fencing, review packages and verdicts, delivery and CI confirmation, blockers and Client decisions, the message board and timed questions. Load before changing src/jobs.ts, job-requests.ts, refine.ts, reviews.ts, delivery.ts, blockers.ts or board.ts, or a related MCP tool.
---

# Jobs, assignments, review, delivery, blockers, board

Verified against the code on 2026-10-15 (blockers section updated 2026-10-15 for `dismissBlocker`; review and delivery sections for the review gate, PR B). If you find this out of date, fix it in the same PR.

## Files

| File | Owns |
| --- | --- |
| `src/jobs.ts` | `registerJob`, `updateJob`, `createSpawnTicket`, `requireAttempt`, `reportProgress`, `completeParent`, `setControl`, `reopenForDelivery`, `reassignStaff(In)`, `handoverSummary`, `refreshFromLinear`, `setStatus`, `lockJob` |
| `src/job-requests.ts` | The dashboard's New job request: validation, `staff_start` launch, `readJobRequest` (`get_job_request`), retry/dismiss/cancel |
| `src/refine.ts` | `clientRefine`, `approveRefinement` (prompt jobs) |
| `src/reviews.ts` | `submitReviewPackage`, `recordVerdict` |
| `src/delivery.ts` | `reportDelivery`, `confirmDelivery`, `markDone` |
| `src/blockers.ts` | `raiseBlocker(Tx)`, `resolveBlocker(Tx)`, `clientQueue`, `openDecisions`, `adviseDecision` |
| `src/board.ts` | Threads and messages, `askQuestion`, `reconcileQuestion`, `recordDecision`, Client inbox |

## Job statuses

`queued, refining, planning, ready, in_progress, in_review, delivering, blocked, done, cancelled` (`JOB_STATUSES`).

Who moves what:
- Staff via `updateJob` may only do `queued->planning`, `planning->ready`, `ready->planning` (`STAFF_TRANSITIONS`), or cancel with a reason. `ready` needs acceptance criteria. Everything else has a dedicated tool.
- `refining -> planning`: only the Client's `approveRefinement`. Staff cannot, and approval needs non-empty acceptance criteria.
- `ready/in_progress` via a Senior claiming (`claimAssignment` in `src/agents.ts` sets `in_progress`).
- `in_progress -> in_review`: `submitReviewPackage`. `in_review -> delivering` on accept; back to `in_progress` on changes.
- `delivering -> done`: only `confirmDelivery` (Staff), or the Client's `markDone`. A parent job completes with `completeParent` once subjobs are done.
- `blocked`: `raiseBlockerTx` stores `previous_status` and `resolveBlockerTx` restores it when the last blocker clears.
- `jobs.control` is separate: `continue | pause | cancel`, set by the Client (`setControl`, applies to subjobs too).

Always take the job lock first with `lockJob(conn, id)` and change status through `setStatus` (it emits `job.status`). On `done` it also resets `client_done_seen_at` (set at once when the actor is the Client), which feeds the Inbox's Finished jobs list (`clientFinished`, `markFinishedSeen`).

## Prompt jobs and refinement

Source is `linear | link | prompt`. A prompt job starts `refining`: Staff writes `plan` and `acceptance_criteria` with `updateJob` and asks on the General thread; each Client answer or edit emits `refinement.client_reply`; Approve emits `refinement.approved`. Only Linear jobs are refreshed from Linear (`refreshFromLinear` every 60 s, never changes job state, only flags `linear.changed`, `linear.diverged`, `linear.new_subissue`).

## Assignments, leases, attempts

- `createSpawnTicket` (Staff only): Seniors only for `ready/in_progress/delivering` leaf jobs with dependencies done; reviewers only for `in_review`. Creates (or reuses) one open assignment per kind (`implement` or `review`), single-use ticket, `POLICY.spawnTicketSec`.
- Registering with the ticket calls `claimAssignment`, which increments `current_attempt`. That number **fences** old holders: every Senior write goes through `requireAttempt(conn, ctx, agent, assignmentId, attempt)`, which refuses a stale attempt or an expired lease.
- Lease renewal: any authenticated call (see `triglav-agent-sessions`). Expiry: scheduler `expireLeases` reopens the assignment and emits `assignment.orphaned`. After `maxFailedAttempts` (3) it raises a `failed_execution` blocker.
- Caps (`checkSeniorCaps`, checked at issue and at claim): 2 Seniors per parent job, 10 overall.
- Keep the check and the write in the same `tx()`. Do not read the attempt outside the transaction.

## Review

- `submitReviewPackage`: needs summary, validation and `head_sha`, and is refused unless the local review gate passes on that exact sha (`gateAt`, `src/review-gate.ts`; every review mode; see `triglav-code-review`). The package stores `head_sha` and `gate_review_id`. If the last verdict was `changes`, every required finding needs a disposition. Round number increments.
- `recordVerdict`: reviewer holding the review assignment, or owning Staff when no reviewer is assigned. `changes` needs a required finding with evidence; `accept` must have none. Round `maxReviewRounds` (3) with `changes` raises a `no_convergence` blocker for the Client.

## Delivery

After accept the job is `delivering`. The Senior runs the Copilot loop (`src/guide/deliver.md`): at most 3 rounds per PR, each asked with `request_copilot_review` (refused without a passing local gate on the head, after 3 rounds, after approval or a round with no qualifying finding) and recorded with `record_copilot_result`. Seniors still have `gh`, so this is a bar, not a boundary, and the counts are the Senior's report. Then `reportDelivery` (PR url, head sha, `copilotStatus` DONE or SKIPPED, CI success). SKIPPED is refused when `settings.review_mode` is `copilot`. Staff checks CI itself and `confirmDelivery` with the same commit (prefix match) before the job is `done`.

## Blockers

Kinds: `client_decision, external, failed_execution, unavailable_owner, no_convergence`. Client kinds (`CLIENT_KINDS`): `client_decision`, `no_convergence`. Agents cannot raise `unavailable_owner` or `no_convergence`; the scheduler or review raises them. An `unavailable_owner` blocker is never resolved by an answer: reassign Staff, or it clears when Staff returns. Researchers add advice with `adviseDecision` (150 to 1200 chars, one per decision).

A `client_decision`/`no_convergence` blocker closes either by an answer (`resolveBlocker`, sets `resolved_at`/`resolved_by`/`resolution`, requires non-empty text) or, when it no longer applies, by `dismissBlocker` (`src/blockers.ts`, sets `dismissed_at`, no resolution needed, `CLIENT_KINDS` only). Both share `unblockIfClear`, which restores the job from `blocked` once no blocker is left open or dismissed. `clientQueue` and `openDecisions` filter out both. A Senior's `failed_execution` blocker raised while its local review piece is at the 3-round limit is stored in `code_review_grants`, and `resolveBlockerTx` grants 3 more rounds when it is resolved (by Staff or the Client). `markDone` and `cancelJobTree` bulk-resolve a job's open blockers before closing it; `completeParent` does the same for blockers raised on the parent job itself (a gap that used to leave them open forever on an already-`done` job).

## Board

- Message types and stances in `board.ts` (`MESSAGE_TYPES`, `STANCES`). `systemMessage` posts server-written text.
- `askQuestion` opens a timed question: window 60 to 300 s (default 180), server clock. At the deadline the scheduler calls `reconcileQuestion`: no replies extends the window (`question.extended`); an intended decision from the owning Staff with no objection is promoted to a decision; otherwise `awaiting_staff_decision`. Emits `question.deadline_reached`.
- Staff card rule (`src/guide/staff.md`): at `awaiting_staff_decision`, an objection that still stands and that Staff partly accepts goes to the Client as a `client_decision` blocker, not to `record_decision`. The server does not enforce this.
- Card rules on Seniors (`senior.md` intro, step 7; `staff.md` step 5; `researcher.md` step 2): a Senior may challenge any thread with evidence and mentions Staff (a plain message does not wake Staff), may answer a wrong required finding with `disputed`; Staff and researchers verify a Senior's cited claim before acting. Cards only, nothing enforced.
- Reply cap per agent per thread: `maxRepliesPerThread` (5).

## Gotchas

- All agent-supplied text goes through `assertNoSecrets`.
- Reassigning Staff (`reassignStaffIn`) also moves questions and resolves `unavailable_owner` blockers, and emits `job.handover` with `handoverSummary`.
- New event type or status: see `triglav-agent-sessions` (wake lists) and the dashboard (`web/src/App.tsx`, `web/src/user-guide.md`).

## Tests

`test/coordination.test.ts`, `test/protocol.test.ts`, `test/plan-limits.test.ts`, `test/job-sources.test.ts`.
