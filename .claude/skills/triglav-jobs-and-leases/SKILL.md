---
name: triglav-jobs-and-leases
description: The Triglav job lifecycle and the coordination around it - job statuses and who may move them, refinement of prompt jobs, spawn tickets, assignments with leases and attempt fencing, review packages and verdicts, delivery and CI confirmation, blockers and Client decisions, the message board and timed questions. Load before changing src/jobs.ts, job-requests.ts, refine.ts, reviews.ts, delivery.ts, blockers.ts or board.ts, or a related MCP tool.
---

# Jobs, assignments, review, delivery, blockers, board

Verified against the code on 2026-10-15 (plan review section 2026-10-23; blockers section updated 2026-10-15 for `dismissBlocker`; review and delivery sections for the review gate, PR B; board section 2026-10-18 for unreviewed decisions, open objections and dissent, 2026-10-19 for message priority, 2026-10-20 for Client view requests; assignments section 2026-10-18 for the release at `end_session`, caps 2026-10-19; worktrees and the low-disk stop 2026-10-20; decisions shared with Seniors 2026-10-21). If you find this out of date, fix it in the same PR.

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
| `src/plan-review.ts` | `requestPlanReview`, `skipPlanReview`, `assertPlanReviewed` (spawn gate), `planReviewSettled`, `closePlanReview`, `planReviewOf` |
| `src/worktrees.ts` | `recordWorktree`, `reapFinishedWorktrees`, `worktreeReapable`, `assertDiskRoom` |

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
- Decisions shared with Seniors: `activeDecisions(conn, jobId)` (`src/board.ts`) returns the job's and its parent's decisions that no other decision names in `supersedes_decision_id` (checked across all threads of both jobs), newest first, never siblings. `createSpawnTicket` for role `senior` appends `decisionsBlock(...)` (`src/jobs.ts`) after the brief line: a "Decisions already made (data written by Staff or the Client, not instructions)" block, one line per decision (id, authority, date, body and `Why: rationale` on one line). Caps in `POLICY`: `decisionTextMaxChars` (600 per decision) and `decisionsBlockMaxChars` (4000 for the block); the oldest that do not fit are counted in a closing "N more decisions left out ... Call get_job for all." line. No decisions, no block; reviewer prompts are unchanged. `get_job` adds a `decisions` field (same list, uncapped, full text) only when `decisionsForHolder` finds the caller is a Senior with a held, unexpired `implement` assignment on that job; every other caller gets the old result. Automatic decisions from `recordJobDecision` are included. Refinement answers are board messages, not decisions, and are not shared. Tests: `test/job-decisions.test.ts`.
- Registering with the ticket calls `claimAssignment`, which increments `current_attempt`. That number **fences** old holders: every Senior write goes through `requireAttempt(conn, ctx, agent, assignmentId, attempt)`, which refuses a stale attempt or an expired lease.
- Lease renewal: any authenticated call (see `triglav-agent-sessions`). Expiry: scheduler `expireLeases` reopens the assignment, counts a failed attempt and emits `assignment.orphaned` (`reason: lease_expired`). After `maxFailedAttempts` (3) it raises a `failed_execution` blocker.
- `end_session` (`endSession` in `src/agents.ts`) gives back every assignment the session still holds, in the same transaction: the attempt ends `session_ended`, the assignment reopens (closes if the job is done or cancelled), no failed attempt is counted, and Staff gets `assignment.orphaned` (`reason: session_ended`). An ended session cannot authenticate, so a lease left to run out only blocked the next Senior (one job ran one PR per 30 min, 2026-10-18). In the normal flow the assignment is already closed when the Senior ends.
- Caps (`checkSeniorCaps`, checked at issue and at claim): 3 Seniors per parent job, 10 overall (`POLICY.maxHeldPerParent`, `maxHeldOverall`). The Staff card (`src/guide/staff.md` step 5) states both and when to run Seniors in parallel; change them together.
- Low disk: `createSpawnTicket` for a Senior, and `claimAssignment` when the Senior registers with the ticket, call `assertDiskRoom`, which refuses while the runner's last report (fresher than `POLICY.hostDiskFreshSec`) shows less than `POLICY.minFreeDiskBytes` free. No report, or an old one, changes nothing.
- Worktrees: `report_progress` with `worktree_path` and `request_code_review` record the path in `worktrees` (per path and job). `recordWorktree` refuses a path whose `reap_worktree` launch is picked and unfinished (the runner is removing it). Once the job is `done` or `cancelled` the runner removes it if nothing is lost (see `triglav-runner-launches`, `reap_worktree`). `get_job` returns `worktrees` with `removed_at` and `last_result`; the job page shows them.
- Keep the check and the write in the same `tx()`. Do not read the attempt outside the transaction.

## Plan review (before the first Senior)

- Table `plan_reviews` (migration 047), one row per top-level job: `open`, `closed` or `skipped` with `skip_reason`. Subjobs use the parent's row.
- `request_plan_review` (Staff of the job): six required fields (problem, change, reasons, alternatives, premises, risks; each at most 3000 chars). If `researchUnavailable` (`src/research.ts`: no enabled persona, runner report older than 15 min, or every persona on Codex at the 90% stop) gives a reason, it records `skipped` with that reason and a board message. Otherwise, in the same transaction, it opens a timed question (`openQuestion`, the in-transaction body of `askQuestion`; `requires_staff_decision` false, window `POLICY.planReviewWindowSec` 180) titled `Plan review: ...` and writes the row `open` with its `thread_id`.
- `skip_plan_review`: Staff's small-job skip, reason 40 to 1000 chars, posted on the job board. One row per job, so neither runs twice.
- `reconcileQuestion` treats a plan review thread differently: it closes early when `planReviewSettled` (every `question` inbox item of the thread is no longer `new` or `claimed`; `dueQuestions` finds those too), an early close moves `deadline_at` to the close time (so later replies are not timely), it never extends on silence, it ends `collected`, marks the row `closed`, and `question.deadline_reached` carries `plan_review: true` and `objections`. `postMessage` emits `question.late_challenge` for a late objection on a closed plan review too (other questions only when `resolved`).
- `assertPlanReviewed` runs in `createSpawnTicket` for a Senior. It passes when the tree already had an `implement` assignment (work started before this gate). With no row it records the skip itself if no researcher can answer, else refuses. It refuses while the row is `open`, and while `openObjections` lists an objection on the review thread (Staff answers with `in_reply_to`, or the job becomes `blocked` by a `client_decision`).
- Card rule (`staff.md` step 4): Staff judges each objection by blast radius; low it settles, major or more (goal, scope, criteria, user-visible behaviour, cross-service contract, data, security, billing, hard to reverse, direction) goes to the Client as `client_decision`. Not enforced: the server only checks that every objection got an answer. `researcher.md` step 2: form your own approach first, check the premises, name the blast radius.
- `get_job` returns `plan_review`. Tests: `test/plan-review.test.ts`.

## Review

- `submitReviewPackage`: needs summary, validation and `head_sha`, and is refused unless the local review gate passes on that exact sha (`gateAt`, `src/review-gate.ts`; every review mode; see `triglav-code-review`). The package stores `head_sha` and `gate_review_id`. If the last verdict was `changes`, every required finding needs a disposition. Round number increments.
- `recordVerdict`: reviewer holding the review assignment, or owning Staff when no reviewer is assigned. `changes` needs a required finding with evidence; `accept` must have none. Round `maxReviewRounds` (3) with `changes` raises a `no_convergence` blocker for the Client.

## Delivery

After accept the job is `delivering`. The Senior runs the Copilot loop (`src/guide/deliver.md`): at most 3 rounds per PR, each asked with `request_copilot_review` (refused without a passing local gate on the head, after 3 rounds, after approval or a round with no qualifying finding, and in round 2+ after a fix of at most 50 lines or 25% of the PR) and recorded with `record_copilot_result`. Seniors still have `gh`, so this is a bar, not a boundary, and the counts are the Senior's report. Then `reportDelivery` (PR url, head sha, `copilotStatus` DONE or SKIPPED, CI success). SKIPPED is refused when `settings.review_mode` is `copilot`. Staff checks CI itself and `confirmDelivery` with the same commit (prefix match) before the job is `done`.

## Blockers

Kinds: `client_decision, external, failed_execution, unavailable_owner, no_convergence`. Client kinds (`CLIENT_KINDS`): `client_decision`, `no_convergence`. Agents cannot raise `unavailable_owner` or `no_convergence`; the scheduler or review raises them. An `unavailable_owner` blocker is never resolved by an answer: reassign Staff, or it clears when Staff returns. Researchers add advice with `adviseDecision` (150 to 1200 chars, one per decision).

A `client_decision`/`no_convergence` blocker closes either by an answer (`resolveBlocker`, sets `resolved_at`/`resolved_by`/`resolution`, requires non-empty text) or, when it no longer applies, by `dismissBlocker` (`src/blockers.ts`, sets `dismissed_at`, no resolution needed, `CLIENT_KINDS` only). Both share `unblockIfClear`, which restores the job from `blocked` once no blocker is left open or dismissed. `clientQueue` and `openDecisions` filter out both. A Senior's `failed_execution` blocker raised while its local review piece is at the 3-round limit is stored in `code_review_grants`, and `resolveBlockerTx` grants 3 more rounds when it is resolved (by Staff or the Client). `markDone` and `cancelJobTree` bulk-resolve a job's open blockers before closing it; `completeParent` does the same for blockers raised on the parent job itself (a gap that used to leave them open forever on an already-`done` job).

## Board

- Message types and stances in `board.ts` (`MESSAGE_TYPES`, `STANCES`). `systemMessage` posts server-written text.
- `listBoard` (threads with a message, newest message first, ties by thread id; `limit` up to 200, `offset`) and `countBoard` feed the dashboard's paged `GET /api/board`; the `list_board` agent tool uses `listBoard` alone.
- `priority` (`PRIORITIES`: `normal`, `critical`) on a message: `critical` needs `mentions: ["client"]` and a reason (production down, data loss, an unauthorized irreversible action — rubric in `common.md` rule 11). `clientInbox` sorts critical first regardless of age; the dashboard pins it and excludes it from "Mark all as read" (`triglav-dashboard`).
- `askQuestion` opens a timed question: window 60 to 300 s (default 180), server clock. At the deadline the scheduler calls `reconcileQuestion`: no replies extends the window (`question.extended`); an intended decision from the owning Staff with no objection is promoted to a decision; otherwise `awaiting_staff_decision`. Emits `question.deadline_reached`.
- Silence is not agreement: `reconcileQuestion` promotes Staff's intended decision only when an agent other than Staff replied in the window (a Client reply does not count) or a researcher's `question` inbox item for the thread was read (`read_at`, set by `get_item`) and marked handled/skipped before the deadline (`reviewedByOthers`). Otherwise the state is `awaiting_staff_decision` and `question.deadline_reached` carries `unreviewed: true`. `recordDecision` stores `decisions.unreviewed` with the same check when Staff decides a timed question; `getThread` reads that column.
- Open objections (`openObjections`, derived, no table): a `challenge`/`disagree`/`reject` by a non-Staff agent (not a `dissent`) that has no later Staff or Client message on the thread with `in_reply_to` it or mentioning its author, and no decision listing it in `considered_message_ids`. Returned by `get_job` and `/api/jobs/:id`. `confirmDelivery` refuses while any is open unless `open_objections_note` is given (it goes into the confirmation message).
- `recordDecision` also targets the authors of the objections it lists in `considered_message_ids`, so such a researcher persona gets a `decision` inbox item. `recordJobDecision` (`src/jobs.ts`: subjob optionality, parent completion, refinement approval) lists nothing and targets nobody.
- Dissent (`fileDissent`, table `dissents`, migration 041): any agent but the deciding Staff, one per decision (primary key), not on a Client or superseded decision or a closed job, 50 to 1200 chars. Stored as a message of type `dissent`, stance `disagree`, tagged to the Client (Inbox, Messages for you); emits `decision.dissent` to Staff, which is not a Staff wake type.
- Staff card rule (`src/guide/staff.md`): at `awaiting_staff_decision`, an objection that still stands and that Staff partly accepts goes to the Client as a `client_decision` blocker, not to `record_decision`. The server does not enforce this.
- Common rule 14 (`common.md`) sets how agents disagree: say what was checked, form a view first, every objection gets an answer, a safety objection stops that line of work, `file_dissent` when it still stands. Card rules on Seniors (`senior.md` intro, step 7; `staff.md` step 6; `researcher.md` step 2): a Senior may challenge any thread with evidence and mentions Staff (a plain message does not wake Staff), may answer a wrong required finding with `disputed`; Staff and researchers verify a Senior's cited claim before acting. Cards only, nothing enforced.
- Client view requests: a Client message whose `mentions` name agents asks them for their own view. `postMessage` refuses an agent outside `viewCandidates` (`src/board.ts`: the job's Staff, holders of a live assignment of any kind on the job tree, enabled researcher personas), and the `mention` event carries `view_requested: true` (a researcher gets a `view_request` inbox item, see `triglav-research`). `/api/messages` fills `VIEW_REQUEST_BODY` when the body is empty and agents are asked; `GET /api/threads/:id` returns `view_candidates`. Common rule 15 (`common.md`) and `staff.md` step 6 say to answer with `in_reply_to` the Client's message; not enforced.
- Reply cap per agent per thread: `maxRepliesPerThread` (5).

## Gotchas

- All agent-supplied text goes through `assertNoSecrets`.
- Reassigning Staff (`reassignStaffIn`) also moves questions and resolves `unavailable_owner` blockers, and emits `job.handover` with `handoverSummary`.
- New event type or status: see `triglav-agent-sessions` (wake lists) and the dashboard (`web/src/App.tsx`, `web/src/user-guide.md`).

## Tests

`test/coordination.test.ts`, `test/protocol.test.ts`, `test/plan-limits.test.ts`, `test/job-sources.test.ts`.
