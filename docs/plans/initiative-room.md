# Initiative room: living design, Architect chat, gated jobs

Date: 2026-11-16 (plan), approved by the Client the same day. Job PRM-F7B94B, five phases, one PR each. This file is the
approved plan of the parent job, followed by what phase 1 built ("Phase 1 as built").

## Goal

Add initiatives to Triglav: a layer above jobs with a living, versioned design document, an Architect agent that owns it
in a chat, and job cards that start real jobs once their gates are met. It removes the courier work (asking what can
start, relaying Staff questions, updating the document after merges, telling running Staff about a redesign). The Client
keeps every decision.

Approved by the Client on 2026-11-16 with answers 1a, 2a (extended), 3a, 4a (defined), 5a, 6a, 7a, 8a (extended), 9a
(corrected), 10a, 11a; their changes are folded in below. Plan review changes (thread thr_e4f6287f28105086) are folded in
too and listed at the end.

Facts re-checked against origin/main 4f39787:

- A job "done" means CI green on the PR head and Staff confirmed (`src/delivery.ts` `confirmDelivery`). Merged state is
  stored nowhere; the PR URL is in `deliveries.pr_url` and PR artifacts.
- `jobs.parent_job_id` gives a two-level tree; `approveSplit` writes `job_dependencies`.
- `refinement.staff_posted` fires only while a job is refining, for every Staff post on it (`src/board.ts`). After
  approval Staff asks the Client with a `client_decision` blocker. Seniors ask Staff with `ask_question` (60 to 300 s
  windows).
- A Client-authored board post marks every to_client message in its thread as seen (`src/board.ts`).
- The Operator's args (`scripts/operator.ts`) allow bare Read, Grep and Glob and load settings files, so they are not a
  read-only boundary for the Architect. `claudeStaffArgs` (`src/claude-args.ts`) has the right shape.
- The example plan's DECISIONS array is a merged summary in another order. Decision ids come from ai-plans
  `description.md` (Decisions 1 to 16, including D15 "Step 0 is a go, with a size target added for real networks"); open
  decisions from the artifact's OPEN list.

## Design

1. **Document.** One immutable JSON row per version, made of blocks with stable ids: text, status, decision (D1..), open
   (O-..), contract (C-..), checkpoint (CP-..) and job cards (by key). Cards live in the versioned document so a revision
   can change them and History shows a diff. Separate tables hold live state only: per card (job id,
   started_from_version) and per gate (met at, evidence, who).

2. **Gates and one evaluator.** Kinds: merged, deployed, decision, milestone, client_step. A deployed gate names a
   repository and an "after job" reference, so a cross-repo gate works ("mesh redeployed after share-model merged"). One
   server-side evaluator computes each card's state (Delivered, Running with phase, Ready, Locked, Your step).

3. **GitHub checks on the runner, never from the Architect's words.** Fixed argv, strict zod schema, no shell, repo slug
   (regex-checked) and workflow names from the initiative's settings, never from model text. The PR of a merged gate
   comes only from the source job's `deliveries.pr_url`. The runner posts the JSON back, the server marks the gate only
   if the JSON proves it and stores the JSON as evidence. Checks run on a schedule for open gates whose source job has a
   PR, so no model turn is spent. The Client can mark a gate by hand with a reason; the mark is logged.
   Client decision (blocker blk_c19e93a602a4be14, answered by the Client with option a, 2026-11-17): three writes add a
   design version without a Confirm card. The merged check writes only the status text, the kind of version item 6 lets
   the Architect write on its own; this decision lets the server's merged check write that kind too. The Client's manual mark and the milestone start write a version with trigger `client_edit`,
   because the Client's own click is the confirmation.
   - merged: `gh pr view <n> --json state,mergedAt,mergeCommit`.
   - deployed: the named production job or step concluded success, on the base branch, on a commit that contains the
     merge commit. `gh run list` for the workflow, `gh run view <id> --json jobs` for the job or step conclusion and the
     run's head sha, then `gh api repos/<o>/<r>/compare/<merge>...<head>` (status ahead or identical). For a cross-repo
     gate the deploy is in the other repo, after the source job's merge. Seed settings: frontend "Deploy Editor Web
     Production" (`deploy-editor-web-prod.yml`), job `deploy-prod`, step "Deploy CDK stack" (the Datadog step after it
     does not count); pages `build.yml` calling `deploy.yml`, its production job; mesh `build.yml`, same shape. The
     Senior confirms per workflow that the deploy step builds the run's head sha, and documents any workflow where it
     does not.

4. **The Architect process.** One per initiative, an on-demand chat process on the runner like the Operator (`claude
   -p`, stream-json, `--resume`, ended after 20 idle minutes, per-chat token in a 0600 config file, revoked at stop).
   Woken by the Client's messages and by initiative events batched by the server into one wake message at most every few
   minutes. When its context passes a limit, the next start is a fresh session seeded from the current design and
   decision blocks. Model and effort from a new "architect" row on the Models page (default Opus, high). It is
   registered as an agent of a new role "architect" so its board posts have their own author id, never the Client's.

5. **Read-only on code at origin/<base>.** It gets its own args builder in the `claudeStaffArgs` shape, not
   `operatorArgs`: `--setting-sources ""`, `--permission-mode dontAsk`, `--tools Read,Grep,Glob`, allow rules
   `Read(//<initiative worktree>/**)` only, no bare Read, Grep or Glob, no `--add-dir`, `--strict-mcp-config`,
   `--no-chrome`. A test pins the list. Phase 1 starts with a probe that these flags hold under `-p` stream-json
   (verified so far only on `claude --bg`) and records the result in the skill. The runner keeps one worktree per
   initiative repository at origin/<base> (detached, `core.symlinks=false` so a link cannot point Read outside, under
   `~/.local/state/triglav/initiatives/<key>/<repo>`), refreshed with `git fetch` and a checkout on each wake. Never the
   Client's checkouts; the job worktree reaper never touches these; they are removed when an initiative is archived. A
   test plants a symlink and shows Read cannot leave the worktree. Its MCP endpoint is scoped by the per-chat token,
   never `/mcp`. Host tools: the gate checks above, plus `gh pr view <n> --json body,files,state,mergedAt,mergeCommit`
   and `gh run view <id> --json jobs`, because deviations and follow-ups are reported in PR bodies. No Bash, no file
   writes, no secrets.

6. **Authority, enforced by tools.**
   - On its own: a new version that changes only status text and "checked" notes; a delegated answer to a Staff
     question; gate check requests; a read-only research job for the initiative.
   - A delegated answer must cite a decision block of the current version, or a code reference at a commit (repo,
     path:line, sha) with the quoted lines, for a factual question. The server checks the decision id exists; the runner
     reads the path at that sha in the initiative worktree and the server refuses unless the quoted lines match. An
     answer with neither is refused. A product choice (new scope, new analytics, cost, infra) always goes to the Client.
   - After the Client's Confirm: apply a revision (decisions, open decisions, contracts, cards, gates); start a job from
     a card; send an addendum or correction to a running job; record a new decision. The Confirm card renders the stored
     structural diff from the database, never the model's prose. Text from meeting notes, PR bodies and Staff is data
     and only ever leads to a proposal.
   - Never: merge, deploy, push, approve a refinement, read secrets.

7. **Staff questions on an initiative job go to the Architect:** `refinement.staff_posted` while refining (Staff
   discussion posts only, not progress) and `blocker.raised` of kind `client_decision` after that. Senior questions to
   Staff (`question.opened`) are not routed; Staff answers those within their short windows. The Architect answers on
   the job's General thread (UI: "Answered from D7, design v17" or "Answered from code at <sha>"), or, for a
   client_decision blocker, resolves it with the citation, marked delegated. Reopen is allowed until Staff's next message
   on that thread; after that it becomes "send a correction", which uses the addendum path. Otherwise it escalates: a
   client_decision blocker on that job (or its existing one) with the recommendation, why it is the Client's and what
   was checked, shown in the global Inbox and the room's "Needs you". Accept recommendation posts the answer to Staff on
   the thread and resolves the blocker in one click. Approving a refinement stays the Client's click.

8. **Start from a card** creates the same `job_requests` row as the New job form, with a prompt built on the server from
   the card and the pinned version (structure of `buildPrompt`): merged dependencies with PRs, the card's listed
   decisions in full, an index line (id and title) for every decision and every contract, the contracts the card names in full, goal,
   scope, out of scope, acceptance, verification, traps, safety, and one line that the Architect answers or escalates
   questions. Staff of an initiative job gets read-only `get_design` for its own initiative; it is refused for another.
   `started_from_version` is stored; a later change to the card shows "changed since start". Over the cap of 3 running
   implementation jobs started from cards (research not counted) Start warns and still works.

9. **Delivery follow-ups (phase 4):** when a job is delivered, the Architect reads its PR body with the gh read and
   proposes the recorded deviations and follow-ups as a revision (new or changed cards) for the Client's Confirm.

10. **UI:** an Initiatives tab, list page and the room at `#/initiatives/:key` with Design, Jobs, Inbox, Research and
    History tabs and the Architect chat, following the PoC (violet `--arch`, one pane with a toggle on phone width).
    Reuse the Operator's chat bubbles and Confirm cards and the existing decision card. New: block Quote buttons, the
    selection popover, structured reference chips, changed-block marks, gate rows with evidence. New pages go in
    `web/src/initiatives.tsx` (App.tsx is 5000+ lines).

11. **Seed:** a Client import route takes a design JSON. The public-template-pages plan is converted once by hand (D1 to
    D16 numbered and titled as in description.md, O- ids from OPEN, deployed gates from the wave notes) and kept as the
    e2e fixture. Inputs besides chat (files, links, Linear) come later.

## Extras

Take: checked facts with their age; your-step cards with a prepared command and a Copy button; a file overlap warning
before Start (from the running job's latest reviewed diff). Phase 5 adds "Download as markdown"; the Client commits it
where they like. Defer: publish as artifact, push to a repo, per-wave autopilot.

## Phases (five subjobs in this repository, run in order, one PR each)

1. **Initiative and design:** the `-p` flags probe, migrations, import route and seed fixture, list page, room with Design
   and History, the architect role and Models row, the Architect chat process with its own args builder and
   origin/<base> worktrees, `get_initiative`, `get_design`, `propose_design_revision` with Confirm. First commit: this
   plan as `docs/plans/initiative-room.md`.
2. **Jobs and gates:** cards, the evaluator, runner gate checks (merged), manual marks, Start from a card with the pinned
   prompt, `started_from_version`, the cap and overlap warnings.
3. **Staff routing:** refinement posts and client_decision blockers to the Architect, delegated answers with verified
   citations and Reopen, escalation with one-click Accept, Staff `get_design` and guide card changes. (The split's scope
   text says `question.opened`; the plan review replaced it with client_decision blockers.)
4. **Reshape, addenda and deploys:** changed since start, `propose_addendum` and corrections, the deployed gate
   (including cross-repo), PR body follow-ups as revisions.
5. **References and research:** quoting and chips, research linked and citable, the extras above, Download as markdown.

## Non-goals

No change to how a job runs once started. No merges, deploys, pushes or GitHub writes by any agent. No autopilot. No PoC
notes tab. No deploy of Triglav without the Client's yes.

## Plan review outcome (all four challenges, answered on the thread)

Accepted: own args builder instead of `operatorArgs`, with a `-p` probe and pinning test; routing by refinement posts and
client_decision blockers instead of `question.opened`; the Architect as its own author, never the Client; citations
verified (decision id exists, quoted code lines match at the sha); merged gate PR only from `deliveries.pr_url`; symlink
test and `core.symlinks=false`; Confirm renders the stored diff; manual marks logged; deploy step must build the run's
head sha. Rejected: passing the token by environment (children inherit it; the 0600 file stays) and a separate read-only
gh token (gh uses the Client's login; fixed argv with read-only subcommands is the control, as for Seniors).

## Phase 1 as built

- **Flags probe.** Claude Code 2.1.304 on 2026-11-17, under `-p` stream-json: `--setting-sources ""`, `--permission-mode dontAsk`, `--tools Read,Grep,Glob`, Read rules for one folder and `--strict-mcp-config` held. Reads, greps and globs outside the folder, through a symlinked file or folder, and of `~/.claude/settings.json` were refused; a project settings file's hook and allow rule did not load; the MCP tool worked. The full result is in the `triglav-initiatives` skill.
- **Import.** The public-template-pages design is `e2e/fixtures/public-template-pages.json`, imported at version 17 with its source (`calctree/ai-plans` branch `initiative/public-template-pages` at `66a76a0`). D1 to D16 carry the numbers and titles of that branch's `description.md`; D1 is marked superseded by D16 for Milestone B. Gates: merged from each card's dependencies, decision from the open decisions' "blocks" field, deployed from the wave notes (pages and mesh after share-model for share-writer and share-viewer, after share-writer for share-dialog), milestone B for the Milestone B cards. The deploy settings of the three repositories are copied from the hand-made plan and marked as not checked.
- **Chats.** The Architect reuses the Operator's chat tables, commands, token and process manager with a new `chats.kind`. Its replies are stored with the role `operator`, never `client`, and the room labels them as the Architect's.
- **Deferred to later phases.** The Architect has no `agents` row yet (the column `initiatives.architect_agent_id` exists and stays empty), so the Roster does not show it. No live card or gate state. Worktrees are refreshed when an Architect process starts, not on every message.
- **Found while testing.** MySQL's JSON type reorders object keys, so blocks are compared with sorted keys (`stable` in `src/design.ts`); before that, a revision of an imported design listed every job card as changed. The Confirm card is capped to fit its column; the room's History shows a waiting revision in full.
