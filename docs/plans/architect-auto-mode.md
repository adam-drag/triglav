# Architect auto mode: the Architect decides for the Client, within limits

Date: 2026-11-20 (plan). The Client agreed to the concept and to the five recommendations below on 2026-11-20, in the
session that built PR #85. This plan is for review before any code. It builds on PR #85 (blocker wakes, `list_blockers`,
escalations of every blocker kind but `unavailable_owner`), which is not merged at the time of writing.

## Goal

An initiative can run with as little Client time as possible. With auto mode on, the Architect takes the decisions that
Staff and the runner bring to it and reports them in the room, instead of waiting for the Client. The Client still makes
every decision that changes what is built or that cannot be undone, and can undo the Architect's decisions.

The Client's words: "architect in that mode replaces client(human) as much as possible to make to work autonomous".
Technical decisions on blockers are the Architect's. A product decision is the Architect's only when the Client stated
clearly what they want; otherwise the Client makes the final call.

## Changes to the invariants

AGENTS.md says "The orchestrator never decides for the Client" and "An Architect reads one initiative and proposes; the
Client decides." Auto mode is an exception to both, which the Client switches on per initiative. AGENTS.md gets one new
invariant that states it, and points to this plan as the Client's decision. Everything outside the exception stays as it
is.

## Decisions taken (the five recommendations)

1. **The gate is blast radius.** The Architect may decide only a blocker whose answer is low blast radius, by the rule in
   `src/guide/staff.md` step 4. A blocker is "major or more" when the answer changes the goal, scope or acceptance
   criteria; changes user-visible behaviour or a contract between services; touches data, migrations, security, auth or
   billing; or is hard to reverse. Major or more is always escalated, technical or not. When unsure, it is major.
   Technical or product is a second check, applied after the first.
2. **A product decision needs a citation.** The Architect may take a product decision only when it cites a decision block
   of the current design (`{decision: "D<n>"}`, which only the Client can add or change) or a stored Client answer
   (`{client_answer: "<blocker id>"}`, new: a blocker of this initiative that the Client resolved). A chat message alone
   is not a source. A technical decision needs a citation too, of any kind `answer_staff_question` takes today.
3. **A product decision waits before Staff sees it.** It is held for `AUTO_HOLD_MINUTES` (15) and then posted. The
   Client can undo it while it waits. A technical decision posts at once, and the Client can undo it until Staff replies
   (the same window as Reopen today).
4. **A budget.** At most `AUTO_DECISIONS_PER_DAY` (20) auto decisions per initiative in a rolling 24 hours, and at most
   one grant of more local review rounds per piece of work. Auto mode also turns itself off 24 hours after the Client last
   switched it on, and after three refused citations in a row. The numbers are starting values for the Client to change.
5. **Design revisions.** Auto mode applies no design revision by itself. Every revision still needs the Client's
   Confirm. (The option of applying status-text revisions automatically is left for later; see Non-goals.)

## Never automated

- Merges, deploys, force pushes, repository settings and secrets (already the Client's under AGENTS.md).
- `unavailable_owner` blockers: no answer clears them.
- Design revisions (decision 5).
- Anything major or more (decision 1).
- Turning auto mode on or off. Only the Client's session can change it; the Architect has no tool for it.

## Design

1. **The switch.** Migration 067 adds `initiatives.auto_mode_until` (a time; auto mode is on while it is in the future)
   and `initiatives.auto_mode_by` (who switched it on). A Client-session route
   `POST /api/initiatives/:key/auto-mode` with `{on: boolean}` sets or clears it. It is not in `OPEN_API_ROUTES`. Every
   change writes a system line in the room's chat and an entry in the event log, so the Architect and History see it.
2. **The decision tool.** A new initiative tool, `decide_blocker`, with `blocker_id`, `decision` (the text Staff gets),
   `kind` (`technical` or `product`), `reach` (the blast-radius items the answer touches, from the fixed list in decision
   1, or empty) and `citation`. The server refuses it, and tells the Architect to escalate, when:
   - auto mode is off, or the budget is used up;
   - the blocker is not an open blocker of a card job of this initiative, or its kind is `unavailable_owner`, or the
     Architect raised it;
   - `reach` is not empty;
   - the citation does not check out (the same checks as `answer_staff_question`, plus `client_answer`), or a product
     decision cites anything but a decision block or a Client answer;
   - an escalation of the blocker is open (the Client is already deciding it).
   The tool is registered only when auto mode is on, and the server checks again on every call, because the mode can
   change during a session.
3. **Storage.** An auto decision is a row in `architect_answers`, so the Inbox, Reopen and the citation checks keep one
   home. Migration 067 adds `auto` (boolean), `decision_kind` (`technical` or `product`) and `hold_until` (a time, for
   product decisions), and a new state `held`. A held row is posted by the scheduler tick when `hold_until` passes, in
   the same way `flushArchitectWakes` sends a batch.
4. **What a decision does.**
   - A `client_decision` or `no_convergence` blocker is resolved with the decision as its resolution, as a delegated
     answer is today, with the Architect as resolver.
   - An `external` or `failed_execution` blocker is resolved the same way. This is the one place where the Architect
     resolves a blocker that is not a client decision; it does so only in auto mode, and the resolution is posted on the
     General thread, so Staff acts on it.
   - A round-limit `failed_execution` grants more local rounds when resolved (`grantRoundsFor`), so the budget counts it.
5. **Undo.** The Client's Undo on an auto decision:
   - while it is held: the row becomes `undone` and nothing is posted;
   - after it is posted, until Staff replies: the Architect's answer is taken back as Reopen does today. For a blocker
     that was not a client decision, Undo raises a new `client_decision` on the job ("The Client took back the
     Architect's decision on blocker X"), with the Architect's decision as its recommendation. That blocker is the
     Client's own, so the Reopen rule of PR #85 (Reopen only for client decisions) still holds for the original.
6. **The Inbox as the ledger.** The room's Inbox gets a section "Decided for you": every auto decision of the last 7
   days, with its kind, its citation, the blast-radius check ("low") and its state (held with the time left, posted,
   undone). Each has Undo while Undo is allowed, and **Keep** (marks it reviewed). The global Inbox counts the unreviewed
   ones.
7. **The room.** The switch sits in the room header. While auto mode is on:
   - an animated ring runs around the switch: a slow conic gradient, calm while nothing happens, with one pulse when the
     Architect takes a decision. Under `prefers-reduced-motion` the ring is still and the pulse is a colour change;
   - a banner under the header says "Auto mode: the Architect decides low-risk blockers for you. Ends at <time>.", with a
     link to the "Decided for you" section.
8. **The Architect's card.** `src/guide/architect.md` gets an "Auto mode" section: the gate in decision 1 in the card's
   own words, the citation rule, the hold, "report every decision in the room in one line", and "when unsure, escalate".
   The wake text says when auto mode is on.
9. **Safety.** Agent text is still data. The Architect cannot cite a blocker's own text, a Staff message or a chat line
   as a source: the server accepts only a decision block, a code line it checks with the runner, a linked report version,
   or a Client answer row. `architectArgs` does not change, and no tool is added outside the initiative server.

## Phases (one PR each, in this repository, after PR #85)

1. **Server.** Migration 067, the switch route, `decide_blocker` with its checks and budget, the `held` state and the
   scheduler post, Undo for both cases, the expiry and the refused-citation stop, the AGENTS.md invariant, the card
   section, and the triglav-initiatives skill. Tests in `test/initiative-jobs.test.ts`.
2. **Room.** The switch with the ring and the reduced-motion variant, the banner, and the "Decided for you" section with
   Undo and Keep. `web/src/user-guide.md` gets a short "Auto mode" entry. e2e: switch on, an auto decision appears, Undo
   while held posts nothing, the ring is still under reduced motion.
3. **Measure.** After a week in use: count auto decisions, escalations, Undos and refused calls per initiative, and the
   Architect's turns and tokens with auto mode on and off. Adjust the numbers in decision 4 from that.

## Tests (phase 1)

- `decide_blocker` is refused when auto mode is off, after expiry, over the budget, for `unavailable_owner`, for the
  Architect's own blocker, for a blocker of another initiative, with a non-empty `reach`, with an escalation open, and for
  a product decision that cites code or a report.
- A technical decision resolves a `failed_execution` blocker and posts on the General thread; a product decision is held,
  posts after the hold, and posts nothing when undone first.
- Undo after posting raises a client decision for an `external` blocker and reopens a client decision as today; Undo is
  refused after Staff replied.
- The budget counts a round grant; three refused citations in a row switch auto mode off.
- The switch route needs the Client session; the Architect's MCP token cannot reach it.

## Non-goals

- Automatic design revisions, including status text only. Possible later, if the Client wants it.
- Auto mode for the Operator or for Staff.
- Deadlines on escalations ("decide for me if I do not answer in N hours"). It came up as an idea; it would let silence
  count as a decision, which the Client did not ask for.
- Any change to how blockers are raised, or to what wakes the Architect (PR #85).

## Open points for the Client

- The numbers in decision 4: 15 minutes, 20 per day, one round grant per piece, 24 hours, three refusals.
- Whether "Keep" in the ledger is needed, or whether a decision counts as reviewed once the Client has seen the Inbox.
