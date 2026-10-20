# Orchestrator research: a vetted list of what is worth doing in Triglav

Date: 2026-10-20. Status: research only. No code, migration or guide was changed.

Code references are to `origin/main` at `c34f1a90a5e979c8582192a9820e72fb17061ea1`. Numbers from "the database" come from read-only queries on the live orchestrator MySQL (jobs from 2026-10-07 to 2026-10-20). Numbers from "transcripts" come from Claude Code transcripts under `~/.claude/projects`.

## TL;DR

Three changes are worth doing now: give Seniors the job's decisions, point the Stop hook at Triglav's own copy, and fix the wait length in the hook text. A small experiment with a `SubagentStop` hook could cut the many Senior attempts that end silently. Server-side file ownership needs your decision, and I lean against it for now.

## Executive summary

I re-read every source in the draft and checked every code claim against the code. Most of the draft holds. About ten source claims were wrong, misattributed or not verbatim. The most important correction is that Symphony selects issues by tracker state, and labels are only an optional filter.

The strongest new finding comes from Triglav's own runs. 74 of 207 Senior attempts ended because the lease expired, and a new Senior could start only 30 minutes after the old one went silent. The likely cause is that the Stop hook does not fire for Seniors, because Seniors run as subagents and subagents fire a different hook event (`SubagentStop`). This is a likely cause, not a proven one, so the recommendation is a small experiment and not a fix.

Decisions for you:

1. Server-side file ownership for parallel Seniors. I found no conflict between sibling Seniors in 15 overlapping pairs. The one real merge conflict I found was between two different parent jobs, and per-parent ownership would not catch it. My recommendation is not to build it now.
2. Your `~/.claude/settings.json` runs the Stop hook from the old `ai-orchestrator` checkout. That copy lacks the loopback check of Triglav's copy. This is machine config, so it is your change to make.
3. Whether to spend a small investigation on the 120-second background move of `wait_for_events`, which I saw 650 times since 2026-10-07.

## Bullet points

**What changed:** This file only.

**Verdicts:**
- Do: share the job's decisions with Seniors (item 1).
- Do, as a small experiment: a `SubagentStop` hook for Seniors that stop calling (item 2).
- Do: fix the wait length in the Stop hook text (item 6).
- Do, as your machine config: point the Stop hook at Triglav's copy (item 5).
- Your decision: server-side file ownership (item 3). I recommend not now.
- Do, as an investigation only: the 120-second background move of long waits (item 4).
- Do not: an evaluation harness for guide cards, a structured proof-of-work schema on review packages.
- Do not, already done: ratchets in target repositories (`src/guide/senior.md:17`).
- Not recommended: Linear label intake (your decision), a central merge queue, any dependence on Vibe Kanban (it is sunsetting).

**What was checked:**
- All 9 sources listed in the draft were re-read, plus the Imbue Offload post that the draft mentions without a link. Each claim is marked confirmed, wrong or not found in the source check below.
- The three retries: the OpenAI harness post (still 403, read through a Wayback copy), Imbue's "1000 agents" page (found, but only a talk summary), and Vibe Kanban's status (the README says it is sunsetting).
- The three open checks from the draft, each answered with file and line.
- Staff's four seeds for own findings, each verified or corrected.

**What is still open or risky:**
- The Stop hook explanation for lease expiries is likely, not proven. I did not check each of the 74 attempts.
- The hooks docs do not say whether `decision: "block"` works the same for a background subagent. The experiment has to measure that first.
- I did not test the setting that probably controls the 120-second background move.
- Researchers raised three objections. Staff accepted two and one was withdrawn, so no disagreement is still open ("Board review").

## The three open checks

**(a) Does a Senior's start prompt or brief carry the parent job's recorded decisions?** No. The start prompt has four lines: the guide, the ticket, the job and the brief (`src/jobs.ts:379-384`). Decisions reach a Senior only if Staff copies them into the brief, which the Staff card asks for in step 4 ("decisions already made", `src/guide/staff.md:14`). `get_job` returns no decisions (`src/jobs.ts:629-680`, and the tool wrapper at `src/mcp.ts:250-256` adds only `open_objections` and `review_mode`). Decisions appear only in `get_thread`, one thread at a time (`src/board.ts:444-458`). A Senior on a subjob also does not see the parent's threads, because `get_job` lists only the job's own threads. The refinement approval records a fixed text, "Approved the goal, scope and acceptance criteria" (`src/refine.ts:81`), so the Client's answers during refinement are board messages, not decisions. They reach the Senior only through the job's `plan` and `acceptance_criteria`, which Staff edits, or through the brief.

**(b) Is a silent Senior nudged before its 30-minute lease expires?** No. Every orchestrator call renews the lease (`authenticate`, `src/agents.ts:149-153`), so a Senior that waits keeps its lease. A Senior that stops calling gets no nudge. The scheduler expires the lease after 30 minutes (`POLICY.leaseSec`, `src/context.ts:12`) and emits `assignment.orphaned` to Staff (`expireLeases`, `src/scheduler.ts:30-58`). Until then Staff cannot start a replacement: `create_spawn_ticket` refuses while the lease is live (`src/jobs.ts:360-363`). The dashboard shows presence as stale after 2 minutes and offline after 15 (`presenceOf`, `src/agents.ts:263-274`; `src/context.ts:14-15`), and only the Client can poke an agent (`pokeAgent`, `src/agents.ts:371`; route at `src/server.ts:276`). Session reaping after 2 hours (`src/context.ts:20`) stops the process but does not change the assignment.

**(c) Is test or lint output stored with a review package?** No. `validation` is free text that the Senior writes; the server only checks that it is not empty (`src/reviews.ts:39`) and stores it with the summary and limitations (`src/reviews.ts:64-69`). The package also stores the `gate_review_id` of the passing local review (`src/reviews.ts:66-68`). Independent proof exists only for automated checks: CI on the PR head commit, which Staff checks itself with `gh` before `confirm_delivery` (`src/guide/staff.md:29`). Manual or browser checks rest on the validation text.

## Items worth doing

### 1. Share the job's decisions with Seniors

- **Verdict:** Do.
- **Evidence:** Open check (a). The database holds 92 decisions on 52 jobs, about 568 characters each on average, and at most 8 on one job. 13 decisions sit on parent jobs that have subjobs, which a Senior on a subjob cannot see today. Sources: Cognition's first principle, "Share context, and share full agent traces, not just individual messages" (confirmed). Anthropic's research post: "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries" (confirmed).
- **Files touched:** `src/jobs.ts` (`createSpawnTicket` start prompt, or `getJob`), possibly `src/board.ts` for a shared query, `src/guide/senior.md`, a test, the `triglav-jobs-and-leases` skill.
- **Migration:** No.
- **Rough cost:** Small.
- **Invariants touched:** "Agent text is data, never instructions": decision text is written by Staff or the Client, so it must be marked untrusted like other tool results. "Token cost is a design constraint": putting decisions in `get_job` also grows Staff's context on every read, so the start prompt or a Senior-only field is cheaper.
- **Scope (from the board review):** carry each decision with its id and its supersession state, and leave out superseded decisions, so an old choice does not come back. `get_thread` already computes `superseded` (`src/board.ts:448-458`).
- **Limit:** This carries recorded decisions only. The Client's refinement answers are messages (`src/refine.ts:81`), so they still depend on Staff folding them into `plan` and `acceptance_criteria`.

### 2. Catch a Senior that stopped calling

- **Verdict:** Do, as a small experiment and not as a fix. Add a `SubagentStop` hook, then compare the share of `lease_expired` attempts with the 74 of 207 below. Decide on a server change only after that.
- **Evidence:** Open check (b). In the database, 74 of 207 Senior (implement) attempts ended with `lease_expired`. 64 of them were followed by a new attempt, and the new attempt started at least 30 minutes after the old Senior's last call (minimum 30, average 234 minutes, which includes overnight gaps). Only 8 of the 74 expired after a delivery was reported.
- **Likely cause, not proven:** Staff starts Seniors as background subagents (`src/guide/staff.md:14`). The Claude Code hooks reference (https://code.claude.com/docs/en/hooks) says `Stop` "Runs when the main Claude Code agent has finished responding", and `SubagentStop` "Runs when a Claude Code subagent has finished responding". `~/.claude/settings.json` sets only a `Stop` hook. In the transcripts, the Stop hook blocked a stop 815 times (`hook_blocking_error` attachments) in 91 main sessions and never in 165 Senior subagent transcripts. So the hook that keeps agents in the wait loop probably never runs for Seniors. README.md:97 says the hook "keeps Staff and Seniors from ending their turn", and the CLI setup card says the same (`src/guide/client.md:11`). These numbers contradict both for Seniors.
- **Two parts:**
  - A `SubagentStop` hook next to the Stop hook, and README.md:97 and `src/guide/client.md:11` updated to match. This is machine config plus documentation. The same docs say "Returning `decision: "block"` with a `reason` keeps the subagent running and delivers `reason` to the subagent as its next instruction", and that `agent_transcript_path` "is the subagent's own transcript", which is where the hook would find the Senior's session token.
  - **What the docs do not say:** the `SubagentStop` section does not describe background subagents. So the experiment must first measure two things: whether a block keeps a background Senior running, and whether Staff still gets the Senior's completion afterwards.
  - **What the data does not prove:** a hook that never fired does not prove that a hook that fires would have finished the work. Some Seniors may stop for other reasons, such as the API errors described in AGENTS.md.
  - A server change, only if the hook is not enough: let Staff release a held assignment once its owner has been offline (15 minutes, `src/context.ts:15`) with no transcript activity, so a replacement can start before the 30-minute lease ends.
- **Files touched:** `scripts/stop-hook.sh` (or a sibling script), `README.md`, `src/guide/client.md`. For the server part: `src/jobs.ts` or `src/agents.ts`, `src/mcp.ts`, `src/guide/staff.md`, tests, the `triglav-jobs-and-leases` skill.
- **Migration:** No for the hook. Probably no for the release tool.
- **Rough cost:** Small for the hook. Small to medium for the release tool.
- **Invariants touched:** "Leases and attempt fencing": an early release must fence the old attempt in the same transaction, as `expireLeases` does. "Nothing started by the runner gets the orchestrator's secrets" and the loopback rule for hook scripts: a new hook must keep the loopback-only `ORCH_URL` check of `scripts/stop-hook.sh:13-16`.
- **Sources:** Gas Town's Witness "detects stuck agents, triggers recovery" and its daemon heartbeats "every 3 min" (confirmed, self-reported design). The agent-teams docs also say "teammates sometimes fail to mark tasks as completed" (confirmed).

### 3. Server-side file ownership for parallel Seniors

- **Verdict:** Client decision. I recommend not building it now.
- **Evidence for the gap:** Only the Staff card says to run Seniors in parallel when the parts touch different files (`src/guide/staff.md:14`). The server checks only that two held assignments do not share a worktree path (`src/jobs.ts:426-427`) and caps Seniors at 3 per parent and 10 overall (`src/jobs.ts:391-402`, `src/context.ts:52-53`). Sources agree that overlapping edits are a risk: the agent-teams docs say "Break the work so each teammate owns a different set of files" (confirmed), and Cognition says "Actions carry implicit decisions, and conflicting decisions carry bad results" (confirmed).
- **Evidence against building it now:** 6 of 54 parent jobs had subjobs. The database shows 15 pairs of sibling Senior attempts that overlapped in time. A search of the 454 board messages on subjobs for "conflict", "same file", "rebase" and "overlap" found no conflict between siblings. The one real merge conflict it found (message 1083: CTP-4780 against CTP-4595 in `CalculationSelectors.ts`) was between jobs under two different parents, which a per-parent rule would not catch. Declaring paths up front is also a guess before the Senior has read the code.
- **Files touched:** `src/jobs.ts` (`createSpawnTicket`, `checkSeniorCaps`), `src/mcp.ts`, `src/guide/staff.md`, a test, the skill.
- **Migration:** Yes (paths on the spawn ticket or assignment).
- **Rough cost:** Medium.
- **Invariants touched:** "Leases and attempt fencing" (the overlap check belongs in the claim transaction).
- **Cheaper alternative, not designed:** a warning, not a refusal, when two open jobs in the same repository change the same files. The runner already computes each review diff (`scripts/code-review-run.ts`), so the data exists at gate time. This would also cover conflicts across parent jobs.

### 4. Investigate the 120-second background move of long waits

- **Verdict:** Do, as an investigation only. Decide on any change after it.
- **Evidence:** In the transcripts, Claude Code answered 650 `wait_for_events` calls with "MCP tool \"orchestrator/wait_for_events\" is still running after 120s. It was moved to the background", out of about 14,600 waits since 2026-10-07. It happened on Claude Code 2.1.292 (612 times) and 2.1.304 (38 times), so it is not new in 2.1.304. Each move ends the tool call early and gives the agent a model turn, which works against the long Staff wait (`staffWaitSec: 3000`, `src/context.ts:47`). AGENTS.md records that a 3000-second call returned cleanly on 2026-10-09. Both observations can be true if the move happens only in some sessions or modes, which I did not check.
- **A likely setting, not tested:** the installed Claude Code binary (2.1.304) contains the name `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`. Secondary sources say that a value of `0` restores blocking calls, and that the move applies to the main conversation only, which would mean Staff and not Seniors (for example https://startdebugging.net/2026/07/fix-long-mcp-tool-call-auto-backgrounded-after-two-minutes/). I found no official documentation of it.
- **First step:** read the Claude Code release notes for 2.1.292 and 2.1.304, check this variable and `MCP_TOOL_TIMEOUT`, and count the moves per role.
- **Files touched:** None for the investigation. A fix could touch `src/context.ts`, `src/guide/client.md` and AGENTS.md "Facts verified the hard way".
- **Migration:** No.
- **Rough cost:** Small for the investigation.
- **Invariants touched:** "Token cost is a design constraint".

### 5. Point the Stop hook at Triglav's own copy

- **Verdict:** Do. It is a change to your machine config, so you make it.
- **Evidence:** `~/.claude/settings.json:440` runs `/home/adam/workspace/ai-orchestrator/scripts/stop-hook.sh`. That checkout is at `bd64b60` (2026-10-15). Its script accepts any `ORCH_URL` and calls `curl -sf` without `--proto =http`, `--max-redirs 0` or `--noproxy`. Triglav's `scripts/stop-hook.sh:13-16` refuses an `ORCH_URL` that is not plain http on loopback and adds those flags.
- **Files touched:** `~/.claude/settings.json` only. No repository change.
- **Migration:** No.
- **Rough cost:** Trivial.
- **Invariants touched:** "Nothing started by the runner gets the orchestrator's secrets": the hook sends a session token, and the AGENTS.md rule says such scripts send only to a loopback `ORCH_URL` without following redirects.

### 6. Fix the wait length in the Stop hook text

- **Verdict:** Do.
- **Evidence:** The hook's block reason tells every agent to "keep calling wait_for_events (max_wait_sec 240)" (`scripts/stop-hook.sh:18`). The guide tells agents to leave `max_wait_sec` out, and says Staff waits up to 50 minutes and should never pass a shorter value (`src/guide/waiting.md:9`). So Staff gets two conflicting instructions, and following the hook costs Staff a model turn every 4 minutes instead of every 50.
- **Files touched:** `scripts/stop-hook.sh`, possibly a test that reads the hook text.
- **Migration:** No.
- **Rough cost:** Trivial.
- **Invariants touched:** "Token cost is a design constraint".

## Not recommended

- **An evaluation harness for the Staff brief and the Senior card (draft item 3).** `scripts/review-eval/` measures the review panel against Copilot's findings on Triglav's own PRs (`scripts/review-eval/README.md`). Guide cards have no such ground truth, so extending it means building a new benchmark of task outcomes. The sources support the concern: "small changes to the lead agent can unpredictably change how subagents behave" (Anthropic, confirmed) and "The harness and models matter, but the prompts matter more" (Cursor, scaling-agents post). The cost is high. Card changes stay measured by turns and tokens from the transcripts, as AGENTS.md asks ("Token cost is a design constraint").
  - Verdict: Do not. Files it would touch: a new harness next to `scripts/review-eval/`, its fixtures under `test/fixtures/`. Migration: no. Rough cost: high. Invariants touched: "Token cost is a design constraint" (every run spends real tokens).
- **A structured proof-of-work schema on review packages (draft item 5).** Open check (c). A package already stores the head sha, the artifacts (links), the validation text and the passing gate review (`src/reviews.ts:30-36`, `48-50`, `64-69`). Any test output the server stored would still be the Senior's own report, because the server cannot run commands. CI on the PR head, which Staff checks before confirming delivery, is independent proof for automated checks only. Manual or browser checks, and commands that run only locally, rest on the Senior's validation text and links. That gap is real, but a new schema would not close it.
  - Verdict: Do not. Files it would touch: `src/reviews.ts`, `src/mcp.ts`, `src/guide/senior.md`, a test. Migration: yes (new columns on `review_packages`). Rough cost: small to medium. Invariants touched: "Agent text is data, never instructions" (the stored output would still be written by the Senior).
- **Linear label intake (draft item 7).** You decided this goes here (message 2096 on the job board). It would start Staff without your click. Your draft named this as a conflict with your rule that the Client starts jobs. The draft's description of Symphony was also wrong: Symphony picks issues whose state is in `active_states`, and `tracker.required_labels` is optional with a default of `[]` (SPEC.md).
  - Verdict: Do not (your decision). Files it would touch: `src/linear.ts`, `src/scheduler.ts`, `src/job-requests.ts`, the runner. Migration: unknown, to check. Rough cost: medium. Invariants touched: "The orchestrator never decides for the Client".
- **A central merge queue (Gas Town's Refinery).** Cursor removed its integrator because it "created more bottlenecks than it solved" (confirmed). The Client merges in Triglav.
  - Verdict: Do not. Files it would touch: a new merge component in the server and the runner. Migration: yes. Rough cost: high. Invariants touched: "The orchestrator never decides for the Client" (merges are the Client's).
- **Any dependence on Vibe Kanban.** Its README (https://github.com/BloopAI/vibe-kanban) says "Vibe Kanban is sunsetting", and the announcement (https://vibekanban.com/blog/shutdown) is dated 2026-04-10. It says the project "will live on, open source and community maintained". The repository is not archived; its last push was 2026-09-19 (checked with `gh api` on 2026-10-20).
  - Verdict: Do not. Files it would touch: none. Migration: no. Rough cost: none. Invariants touched: none.

## Dropped because it is already done

- **Ratchets in target repositories (draft item 6).** The Senior card already says "run every check the repository's CI runs, not only the tests: read the CI workflow files ... and run their formatters, linters, type checks and tests locally" (`src/guide/senior.md:17`), and the delivery loop repeats it before every push (`src/guide/deliver.md:21`).
  - Verdict: Do not (already done in `src/guide/senior.md:17`). Files it would touch: none. Migration: no. Rough cost: none. Invariants touched: none.

## Where Triglav already matches the sources

- Bounded parallelism: at most 3 Seniors per parent job and 10 overall (`src/context.ts:52-53`, checked in `checkSeniorCaps`, `src/jobs.ts:391-402`). The agent-teams docs say "Start with 3-5 teammates for most workflows" (confirmed).
- Per-role models: `role_models` (`src/models.ts:102`) and the Models page. Cursor: "GPT-5.2 is a better planner than GPT-5.1-Codex, even though the latter is trained specifically for coding" (confirmed).
- Leases with attempt fencing: a 30-minute lease (`src/context.ts:12`), and `requireAttempt` refuses a stale attempt (`src/jobs.ts:405-415`).
- No central merge gate: the review gate runs per Senior, and the Client merges.
- In the agent workflow, a parent completes only when every required subjob is done (`src/jobs.ts:451-452`), and a job without subjobs completes through an accepted review and a delivery that Staff confirms on green CI (`src/guide/staff.md:29`). The Client can override both: `markDone` lets the Client mark a job done without a delivery, and a parent once every subjob is done or cancelled (`src/delivery.ts:98-114`).
- A deliberate difference worth stating: OpenAI's harness post says "Humans may review pull requests, but aren't required to", and Symphony's demo says "When accepted, the agents land the PR safely". Triglav keeps merging with the Client by design.

## Source check

Each claim the draft took from a source, re-read on 2026-10-20. Numbers marked "self-reported" come from the vendor or author and were not checked independently.

**Cognition, "Don't Build Multi-Agents"** (https://cognition.com/blog/dont-build-multi-agents, read).
- Two principles, share full context and implicit decisions: confirmed ("Share context, and share full agent traces, not just individual messages"; "Actions carry implicit decisions, and conflicting decisions carry bad results").
- Parallel subagents are "very fragile": confirmed.
- Default single-threaded linear agent, compression model for long tasks: confirmed.
- Claude Code subagents do not work in parallel with the main agent: confirmed, but dated. The source says "As of June 2025". Claude Code now has background subagents and agent teams.
- Opinion piece from 2025: confirmed (Walden Yan, 2025-06-12, no measurements).

**Cursor, "Scaling long-running autonomous coding"** (https://cursor.com/blog/scaling-agents, read, 2026-01-14).
- Dynamic coordination among peers failed: confirmed.
- Locking: 20 agents slowed to the throughput of 2 or 3, and agents failed while holding locks: confirmed (self-reported).
- Optimistic concurrency, then "With no hierarchy, agents became risk-averse": confirmed.
- Planners, workers and a judge: confirmed.
- Integrator removed, "created more bottlenecks than it solved": confirmed.
- GPT-5.2 a better planner than GPT-5.1-Codex: confirmed.
- "The harness and models matter, but the prompts matter more": this sentence is in this post. The draft attributed it to the follow-up post, which was wrong.
- Scale ("hundreds of concurrent agents"): self-reported.

**Cursor, "Towards self-driving codebases"** (https://cursor.com/blog/self-driving-codebases, read, 2026-02-05).
- Bottlenecked by the slowest worker: confirmed.
- Upfront planning made mid-run changes hard: confirmed.
- Recursive subplanners that own slices, handoffs back up: confirmed.
- The "prompts matter more" quote: wrong attribution (see above). The closest line here is "Architecture and instructions matter."
- Numbers ("~1,000 commits per hour"; 20 agents slowed "to the throughput of 1-3"): self-reported. The two Cursor posts give 1-3 and 2-3 for the same experiment.

**Anthropic, "Effective harnesses for long-running agents"** (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents, read, 2025-11-26).
- The initializer creates `init.sh`, a progress file, an initial commit and a feature list: confirmed.
- JSON because the model is less likely to corrupt it: confirmed with a wording fix. The source says "less likely to inappropriately change or overwrite JSON files compared to Markdown files".
- Agents change only the `passes` field; "It is unacceptable to remove or edit tests": confirmed.
- Session start routine: partly confirmed. The listed steps are `pwd`, reading the git log and progress files, and choosing a feature. The end-to-end check before new work is stated separately.
- Four failure modes: partly wrong. The source's table lists declaring victory too early, leaving the environment with bugs or undocumented progress, marking features done prematurely, and spending time working out how to run the app. "One-shot" and "unit tests" are in the body text, not the table.

**Anthropic, "How we built our multi-agent research system"** (https://www.anthropic.com/engineering/multi-agent-research-system, read, 2025-06-13).
- About 4x tokens for an agent and 15x for multi-agent, compared with chat: confirmed (self-reported).
- "Most coding falls here": not verbatim. The source says "most coding tasks involve fewer truly parallelizable tasks than research".
- Brief contents (objective, output format, tools and sources, task boundaries): confirmed.
- "Dozens of subagents for trivial questions": wrong number. The source says "spawning 50 subagents for simple queries".
- "Agents are stateful and errors compound", resume from checkpoints: confirmed.
- Small lead-agent changes shift subagent behaviour: confirmed.
- Synchronous execution, the lead cannot steer subagents: confirmed.

**Claude Code agent teams** (https://code.claude.com/docs/en/agent-teams, read).
- Experimental, off by default: confirmed.
- 3 to 5 teammates, 5 to 6 tasks each: confirmed.
- "Break the work so each teammate owns a different set of files": confirmed.
- Sequential or dependent work is better in one session or with subagents: confirmed.
- Significantly more tokens: confirmed.

**OpenAI Symphony** (https://github.com/openai/symphony and its SPEC.md, read).
- Apache-2.0, an engineering preview: confirmed.
- Linear-only: wrong for the spec, which selects a tracker adapter (`tracker.kind`). The reference implementation supports Linear and an in-memory tracker.
- Poll every 30 s by default: confirmed (`polling.interval_ms` default 30000).
- Concurrency default 10, plus per-state limits: confirmed.
- One workspace per issue, reused across runs; hooks `after_create`, `before_run`, `after_run`, `before_remove`: confirmed.
- Handoff state such as Human Review: confirmed.
- Restart with no database: confirmed ("without a durable orchestrator DB"). "The tracker is the source of truth" is not the spec's wording.
- No proof-of-work mechanism in the spec; the README lists "CI status, PR review feedback, complexity analysis, and walkthrough videos": confirmed.
- Implementations must document their approval, sandbox and operator-confirmation posture; hooks are fully trusted: confirmed.
- Starts agents from labels: wrong. Selection is by `active_states`; `required_labels` is optional and defaults to `[]`.
- Adoption: no usage figures found. GitHub shows about 27.7k stars, which is not adoption.

**Imbue, mngr** (https://imbue.com/blog/mngr, read, 2026-04-02).
- Three costs: slow sequential runs, an overloaded machine, too many PRs to review: confirmed.
- Group outputs by type for review: confirmed.
- Make each agent observable, for example in tmux: confirmed.

**Imbue, Offload** (https://imbue.com/blog/offload, read, 2026-03-17). The draft called this secondary coverage. It is the primary source.
- "We consider tools such as typecheckers, style guides, linting and ratchets indispensable": confirmed.
- Verification is the bottleneck: confirmed as a paraphrase of its "testing bottleneck".
- Speed and cost numbers ("more than 6 times faster"): self-reported.

**Gas Town** (https://github.com/steveyegge/gastown, README read).
- Mayor, Polecats, Refinery ("polecats never push directly to main"), Witness, Deacon, Beads: confirmed.
- Daemon heartbeat every 3 minutes: confirmed.
- "Scale comfortably to 20-30 agents" and stuck agents hard to spot "At scale (20-50+ agents)": confirmed (self-reported).

**Retries.**
- OpenAI, "Harness engineering": openai.com still answers 403. A Wayback Machine snapshot from 2026-10-16 was readable (https://web.archive.org/web/20261016135644/https://openai.com/index/harness-engineering/; the post is dated 2026-02-11, by Ryan Lopopolo). It names "custom linters" and "structural tests" as mechanical guardrails. It does not mention typecheck, so the draft's claim that it names typecheck was wrong. Its numbers ("roughly 1,500 pull requests", "3.5 PRs per engineer per day") are self-reported.
- Imbue, "How to usefully run 1000 agents in parallel": found at https://imbue.com/blog/how-to-usefully-run-1-000-agents-in-parallel. It is a short summary of a talk and makes no claim this file can use.
- Vibe Kanban: sunsetting, as above.
- Cursor Projects: the changelog entry (https://cursor.com/changelog/projects) is dated 2026-09-10. Nothing in this file depends on it.

**Relevant points the draft missed.**
- Imbue, "How AI code review can make correct code worse" (https://imbue.com/blog/2026-04-29-how-ai-code-review-can-make-correct-code-worse): the harm came from the fixer going beyond the finding, and softer fixer instructions reduced regressions (small sample, self-reported). I read this through a summary only. Triglav's card already says not to fix a wrong finding to please the reviewer, so I do not list it as an item.
- Agent-teams docs: "The lead can stop early too, deciding the team is finished before all tasks are actually complete". Triglav's completion rules cover this for subjobs.

## Changes from the draft

- Draft item 2 (decisions): kept as Do, now with the answer to the open check.
- Draft item 4 (stuck work): from Do to a small experiment. The cause moved from "no nudge" to the Stop hook not covering subagent Seniors, with numbers from the database and transcripts.
- Draft item 1 (file ownership): from the top recommendation to a Client decision with a lean against, because the observed conflict was across parents.
- Draft item 3 (measure prompt changes): from Do to Not recommended.
- Draft item 5 (proof of work): from Do to Not recommended, narrowed to "no new structured schema", with the gap for manual checks stated.
- Draft item 6 (ratchets): dropped, already in the Senior card.
- Draft item 7 (Linear label intake): moved to Not recommended, as you decided, with the Symphony description corrected.
- New items 4, 5 and 6 come from Triglav's own runs and machine config.

## Board review

I posted the draft verdicts as a timed question on the job board (thread `thr_a1cdd578882f11d8`, 300 seconds). Two researchers and Staff replied. Staff recorded the decision `dec_63a8c78888451c44`, and this file follows it.

- **Proof of work (message 2108, challenge):** CI at delivery does not prove manual or browser checks, and packages already store the evidence fields. Accepted. The verdict is now narrower: no new structured schema, and the gap is stated.
- **Stuck Seniors (message 2106, part b):** a hook that did not fire does not prove that firing it would finish the work. Accepted. Item 2 is now an experiment, not a fix.
- **Stuck Seniors (message 2106, part a):** a blocked subagent might hold Staff's Agent call open. Withdrawn by its author (message 2110), because Seniors run as background subagents. The remaining condition, to measure background behaviour first, is in item 2.
- **Decisions (message 2107):** carry decision ids and supersession state. Adopted in item 1.
- **Staff conditions (messages 2105 and 2109):** keep the cross-parent conflict in item 3, keep transcript measurement for card changes, and contrast the 120-second move with the AGENTS.md fact from 2026-10-09. All are in the file.

No disagreement is still open.
