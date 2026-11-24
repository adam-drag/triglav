# Researcher access, cost and specialists

Date: 2026-11-19 (plan, revised after a plan review the same day). Not yet approved by the Client. Phases are one PR
each. The changes from the plan review are listed at the end.

## Goal

Researchers should be able to check what they advise on, and they should not burn the Claude plan window while doing it.
Today they mostly cannot check: they advise from board text, a local checkout on an unknown branch, and memory. This plan
gives them pinned, read-only access to the code they talk about, then outside facts (CI, PR, web), then a sandboxed
shell, and it adds two predefined specialists (Security, Blast radius). Cost controls and measurement come first, so the
Client can see what a run costs and what it found before any ability is added.

Out of scope: researchers changing code, job state or anything outside Triglav; direct access to analytics, logs or
databases; GitHub tokens in a researcher process.

## Facts this plan rests on

Checked against origin/main 90647d0 and the live database on 2026-11-19.

**Where researchers get stuck.** Researchers wrote 737 board posts. About 512 of them say that something was not
checked or is unverified. Rough keyword counts over those posts: diff, PR head or branch not checked 220; a stale or
unknown local checkout 100; analytics such as PostHog 58; CI 55; docs, changelog or CVE lookups 52; "no shell" or
"not run" 37; dependency source read 34; PR body 25. These are regex counts, so read them as a ranking, not as exact
numbers. Every researcher post belongs to a job. Split by the inbox kind that led to the post, the "diff not checked"
posts come from mentions (77), review rounds (58), questions (42), decisions (24) and others, so pinned code is needed
for every item with a job, not only for review rounds.

**How they work around it.** 4 of the 5 personas have `/home/adam/workspace/` as their repository. A Claude research
run loads the user's settings, and the user's `Read(//home/adam/**)` rule lets it read every checkout, Senior worktrees
included. Posts say "Checked in worktree frontend-job-279fdb (sha not checked)" and "Local checkout (maybe stale vs PR
head)". The card forbids the diff, but the access is there, without a pinned commit.

**Cost.** November 2 to 19, from `usage_daily`:

| Role | Cache read | Cache write | Output |
| --- | --- | --- | --- |
| Researchers (all models) | 261M | 27.5M | 3.9M |
| Staff | 1.71B | 21.8M | 3.4M |
| Seniors | 2.23B | 45.8M | 2.1M |

Per research run in the same period:

| Model | Runs | Cache read per run | Cache write per run | Output per run |
| --- | --- | --- | --- | --- |
| claude-haiku-5-5 | 200 | 555k | 49k | 11.4k |
| claude-sonnet-5-5 | 326 | 228k | 30k | 2.4k |
| claude-opus-5-5 | 107 | 521k | 50k | 4.7k |
| claude-fable-5-2 | 69 | 286k | 42k | 4.0k |

Researchers share the Claude plan window with Staff and Seniors. The research dispatcher's budget guard only watches
the Codex window (`dispatchResearch`, `src/research.ts`), and every research run since 2026-10-30 ran on Claude. The
newest Claude `five_hour` reading in `claude_usage` was taken on 2026-11-17 by an Operator chat: research runs, Staff
and Seniors do not refresh it, so a guard that reads it today would mostly see an expired window.

**Why runs cost what they cost.**

- A run handles 1.02 to 1.09 items on average, so almost every item pays a whole run's fixed cost (a fresh session,
  the tool list, the card, `start_run`). Only 38 of 733 items arrived within 15 s (`BATCH_SEC`) of the persona's
  previous item; 203 arrived within 2 minutes and 312 within 5 minutes.
- Fan-out: of 321 events that made items, 123 went to 4 or 5 personas. Every enabled persona gets every question,
  proposal and Client decision (`routeToInbox`).
- A run's cache write (30k to 50k) is about the size of its prompt prefix, so cache reads per run suggest 7 to 11 turns.
  The prefix includes every orchestrator tool (48 in `src/mcp.ts`), and a researcher uses about 9.
- Tokens per run differ by model: Haiku used 2.4 times the cache reads of Sonnet per run. How the plan window weighs
  each model's tokens is not known, so this is not a cost ranking.

**Defects found while planning.**

- `watchedRun` (`scripts/runner.ts`) never kills a run. `timeoutRuns` closes the run row after 15 minutes, the persona
  then counts as free, and a second run can start on the returned items while the first process still runs.
- The exit report sends the last 15 lines of the log with no character cap, and `/api/runner/:id/exited` refuses a tail
  over 4000 characters. One long line makes the report fail, and the run then closes only at the timeout.
- `mark_item` notes and `update_notebook` do not run `assertNoSecrets`, and the notebook is read by every later run.

**Sandboxes, probed on this machine.**

- Codex 0.162.0, `codex sandbox` with the default policy (writes were refused, as with `-s read-only`): a command
  listed `~/.ssh`, read `~/.aws/credentials` and read Triglav's `.env`. Network was blocked.
- Claude Code 2.1.304, `claude -p --setting-sources "" --permission-mode dontAsk --tools Bash` with a `sandbox` block
  in `--settings`: the sandbox applied in print mode. With `denyRead: ["/home/adam"]` and `allowRead: [<one repo>]`, the
  command saw only that repository in `~/workspace`, could not read Triglav's `.env`, could not write into the
  repository, could write to the working directory and to an `allowWrite` directory, and ran `git log origin/main` and
  `node -e`. Network commands (`curl`, node `https.get`) did not run: the permission layer refused them in `dontAsk`
  mode, so the sandbox's own network block was not observed.
- Two traps: a `denyRead` entry for a single file (`.../triglav/.env`) did not hide it, and a `denyWrite` on a
  directory beat an `allowWrite` on a directory inside it. Use allow lists, and never nest a writable directory inside a
  denied one.
- The Claude sandbox covers Bash only. Read, Grep, Glob, WebFetch and MCP tools are controlled by permission rules,
  not by the sandbox (Claude Code sandboxing docs). It has no memory cap, and `--setting-sources ""` also drops the
  user's `heavy` PreToolUse hook.

**Deterministic checks that already exist.** The calculations, pages and mesh repositories run `hive schema:check` in
CI, so a GraphQL field removal is already caught there. A researcher's cross-repo work should cover what a schema check
cannot see: REST and event payloads, file formats, sync cursors, enum values a client switches on, and changed meaning
behind the same field.

**What the evidence says about specialists.** Persona prompts alone did not improve accuracy (arXiv 2311.10054).
Gains come from narrow scope with the right tools, from several independent passes, and from a strict filter for false
positives (Anthropic's security-review prompt; SWR-Bench, arXiv 2509.01494). Products that check consumers across
repositories (Qodo, CodeRabbit, Greptile) work from an explicit list of linked repositories.

## Principles

1. **Pinned, not live.** A researcher reads a fixed commit that the runner prepared: tracked files only. It never
   reads a Senior's live worktree, the Client's checkout, a branch, or the PR.
2. **Accidents first.** Triglav runs locally for one user. The risks that matter are a test that reaches a real API
   with real credentials, a command that fills the memory, a secret quoted on the board, and a write in the wrong
   directory. Prompt injection is a smaller risk here, and the guards below cover most of it anyway.
3. **Allow lists, one builder.** The runner builds every researcher command in one function from checked fields, as
   `claudeStaffArgs` does for Staff. Settings files of the user and the repository do not apply.
4. **Every ability is paid for.** Measurement comes first, each phase is judged on tokens per handled item, and an
   ability that costs more than it finds can be switched off per persona.
5. **Advice only.** Researchers keep their current tools for output: board posts, advice, dissents, item marks and the
   notebook.

## Design

### A. Abilities, in the order they are added

| Ability | What the researcher gets | Guard |
| --- | --- | --- |
| A1 Pinned job code | For every item with a job: a read-only tree of the job's repository (the subjob's for a split) at the newest head a review package named, else at `origin/<base branch>`. For a review round also the PR diff as a file. | A detached, locked worktree with `core.symlinks=false` and no hooks, as `scripts/initiative-worktrees.ts` builds for the Architect, cached by commit; `--setting-sources ""`; path-scoped `Read(//<tree>/**)` rules; no bare `Read` in `--allowedTools` |
| A2 Smaller fixed context | A researcher-only MCP endpoint with the 9 or so tools a run uses | Measured with B1: first-turn cache write before and after |
| A3 CI and PR state | PR body, check states, review comments, as data in `get_item` | Fetched by the runner with a fixed `gh pr view` argv, as `gate_check` does; no token reaches the researcher |
| A4 Related repositories | Consumer repositories at `origin/<default branch>` as pinned trees, the same cache as A1 | A Client setting maps a repository to its related repositories |
| A5 Web | WebSearch and WebFetch | A per-persona switch, the same shape as a research job's web sources |
| A6 Sandboxed shell | Bash for `git log`, `git blame`, `git show`, `rg` and `node -e` | Claude sandbox (`failIfUnavailable`, `allowUnsandboxedCommands: false`, `denyRead` of the home directory with `allowRead` of the pinned trees, writes only in a scratch directory, no allowed domains); the run under a memory cap (`heavy` or `systemd-run --user -p MemoryMax`); an allow-listed environment; a per-persona switch. Test runs only after a probe shows how dependencies reach a pinned tree without network |

Not given: GitHub tokens, Linear tools, analytics, logs, databases, writes outside the scratch directory, network from
the shell. A data question goes to Staff or the Client on the board.

Codex personas keep today's access, which reads the whole disk (probed above). This is an accepted risk while no
persona uses Codex; the extended abilities are Claude-only.

### B. Cost controls

| Control | What | Expected effect |
| --- | --- | --- |
| B1 Measure | Claude runs use `--output-format stream-json --verbose`. The runner reads the stream: the final `result` gives tokens and `total_cost_usd` (an API-price figure, not plan-window use), the newest `rate_limit_event` gives the plan windows. Both go to Triglav as typed fields with the exit report. `research_runs` stores them; the Researchers page shows them per run and per persona for 7 days | A baseline, and a fresh plan reading after every run |
| B2 Claude budget guard | The dispatcher applies the Codex thresholds to Claude runs with the `five_hour` reading in `claude_usage` (urgent kinds only from 70%, nothing from 90%) | Researchers yield to Staff and Seniors when the plan window is tight |
| B3 Kill at the timeout | The runner stops a research run after 14 minutes (SIGTERM, then SIGKILL). A persona stays busy until its run's process has exited, or 5 minutes past the server timeout | No second run on the same items, no runaway run |
| B4 Route by kind | A persona lists the kinds it receives among question, proposal, review and Client decision. Targeted kinds (mention, view request, decision on its objection) always arrive | Less fan-out: a persona does not run on kinds it is not for |
| B5 Slower batch for non-urgent kinds | `review`, `proposal`, `mention` and `decision` items wait up to 120 s; an urgent item starts the run at once and takes the waiting items with it | More items per run. 203 of 733 items arrived within 2 minutes of the previous one |
| B6 Read discipline | The card: open the diff's file list first, Grep before Read, read line ranges, stop when the answer is found, skip at once an item outside your focus | Fewer turns. Turns drive cache reads |
| B7 Files, not prompt | The diff and the trees are files the researcher opens in ranges, never text in the prompt or in a tool result | A 250k-character diff costs only what is read |
| B8 Model choice | The Researchers page shows tokens per run per persona; the Client picks models with that in view | The Client decides; nothing changes by default |

### C. Specialists

First as persona presets, not new code paths: "Security" and "Blast radius" fill the focus (a fixed checklist), the
kinds (B4) and a model on the Researchers page, and the Client can edit them. A `SPECIALTIES` table in code follows only
if the presets show they need abilities a generalist does not have.

- **Security.** Kinds: question, proposal, review. Plan reviews: the trust boundary a plan crosses, who can call the
  new thing, tenant scoping, secrets. Reviews: authorization on new routes and resolvers, workspace scoping, injection
  into SQL, shell, HTML and MDX, secrets in code and logs, token handling. Exclusions follow Anthropic's security-review
  prompt (no DoS, rate limiting, theoretical races, outdated libraries or test-only files; UUIDs are not guessable).
- **Blast radius.** Kinds: question, proposal, review. Needs A4. Plan reviews: a consumer map of what the plan changes,
  in the job's repository and the related ones, with deploy order. A missed consumer is a missing subjob, so this is the
  cheapest moment to find it. Reviews: each changed interface, every consumer at `file:line` and the commit read, and
  whether it still works. Classes: breaking, likely breaking, needs a look. General bug hunting stays with the review
  panel's generalist seats.

Review rounds reach a persona today only on jobs it already posted on (`routeToInbox`). A persona that lists `review`
in its kinds (B4) gets every review round, so a specialist sees the code of a job it did not plan-review.

On the code review panel, a `security` lens and a section for consumers in related repositories in the `contracts`
lens come before the specialist presets, in shadow mode and measured with `scripts/review-eval/`. A lens seat gives
structured findings on every round; a specialist researcher follows its own plan-review objections into the code and
posts on the board.

### D. Safety details

- Pinned trees live under `~/.local/state/triglav/research-trees/<repository>/<commit>`, are shared by every run that
  needs that commit, and are removed when no queued or running run needs them and they are older than a day.
- A Claude run's working directory is one stable folder per persona under `~/.local/state/triglav/research/`, so Claude
  Code does not create a new project folder for every run, and a repository's `CLAUDE.md` is not loaded on every run
  (a researcher reads the repository's rules when it needs them).
- A pinned tree holds tracked files only, so local `.env`, `.env.local` and `.npmrc` files are not in it. Read deny
  rules for `.env` files stay as a second layer.
- The runner sweeps leftover private files and unused trees when it starts.
- `mark_item` notes and notebook entries go through `assertNoSecrets`, like board posts.
- Researcher text stays data for every other agent (unchanged).

## Phases

Each phase is one PR. Phase 1 is measured for a few days before phase 2 starts.

1. **Measure, guard, route.** B1, B2, B3, B4, B5, the exit tail cap and `assertNoSecrets` on notes and the notebook.
   Migration: usage and `exited_at` columns on `research_runs`, `kinds` on `researcher_personas`. Researchers page:
   kinds per persona, tokens and cost per run and per persona.
2. **Pinned job code.** A1, B6, B7, and the explicit read access. Card, `RESEARCH_PROMPT`, README, AGENTS.md invariant
   and the `triglav-research` skill change from "board text only" to "the pinned tree of the job, never the live
   branch". Launch field: the trees to prepare, checked by the runner.
3. **Smaller context.** A2, measured with B1.
4. **Review lenses.** The `security` lens and the consumers section of `contracts`, in shadow, with eval fixtures.
5. **Specialists and related repositories.** C as presets, A4, and review routing for personas that list `review`.
6. **Outside facts.** A3, A5.
7. **Sandboxed shell.** A6, last: the most new risk for the least proven gain.

The measure of success, per phase: the share of researcher posts that say "not checked" or "unverified" goes down,
and tokens per handled item do not go up by more than the Client accepts.

## Decisions for the Client

1. Change the invariant "A research run reads and advises; it never edits or runs commands" to allow pinned trees
   (phase 2) and later a sandboxed shell (phase 7).
2. Extended abilities are Claude-only, and Codex personas keep reading the whole disk until they are probed.
3. A persona whose repository is a folder of many repositories (today 4 of 5) reads its jobs' pinned trees under A1.
   For items without a job it either keeps that folder or must name one repository.
4. Web access per persona (proposed) or for everyone.
5. Related repositories at the last fetched `origin/<default branch>`, or the runner fetches before it builds a tree.
6. Models of the current personas, once B1 has a few days of numbers.

## Rejected options

- **A better free-text focus only.** Persona prompts alone did not help in the evidence above, and the current
  specialists already have such a focus and still cannot check.
- **Reading the Senior's worktree or the Client's checkout.** Both move while they are read, can be on any branch, and
  hold untracked files such as `.env.local`.
- **`git archive` for pinned trees.** It recreates symlinks and applies `export-ignore` and `export-subst`, so the tree
  can differ from the commit. The Architect's worktree pattern does not have these problems.
- **A GitHub token or the GitHub MCP server in the researcher.** The runner can fetch the same data with a fixed argv.
- **One extra seat per specialist on every review.** Each seat costs about 0.5M input tokens; seats come only after
  shadow-mode numbers.

## Phase 1 as built

- B1: Claude research runs print `--output-format stream-json --verbose`. `scripts/claude-stream.ts` reads the plan
  windows and the final usage (the Operator uses the same window parser now). The runner sends them with the exit
  report; `/api/runner/:id/exited` parses them apart from the exit, so a bad number never blocks it. `research_runs` has
  `tokens_in`, `tokens_cache_write`, `tokens_cached`, `tokens_out`, `turns`, `cost_usd` and `exited_at` (migration 061).
- B2: `claudeUsedNow` reads the `five_hour` row of `claude_usage`; the dispatcher and `researchUnavailable` use the
  window of each run's own CLI. Research run exits write readings with source `research`. Only the 5-hour window is
  used; the weekly window is shown on the Usage page but does not hold researchers back.
- B3: `watchedRun` stops a research run after 14 minutes. A persona stays busy while a started run's process has not
  exited, for at most 5 minutes after the run closed.
- B4: `researcher_personas.kinds`, edited under Receives on the Researchers page. Review rounds still reach only
  personas that posted on the job; that rule changes in phase 5.
- B5: `batchReady` waits 15 s for questions, Client decisions and view requests, 120 s for the other kinds.
- The exit tail is cut to 4000 characters, and `mark_item` notes and notebook entries go through `assertNoSecrets`.
- The Researchers page shows both windows, a "Cost, last 7 days" table per persona, and turns, cache reads and API
  price per run.

## Changes from the plan review (2026-11-19)

- Added B3: the runner kills a run at the timeout, and a persona stays busy until its process exits.
- B1 and B2 read `stream-json`, so every run refreshes the Claude plan reading; the old reading came only from chats.
- A1 pins every item with a job, not only review rounds, because most "diff not checked" posts came from other kinds.
  It uses the Architect's worktree pattern instead of `git archive`.
- Added A2, a smaller tool list, measured with B1.
- The sandboxed shell moved last and gained a memory cap and an allow-listed environment; test runs need a probe first.
- Specialists start as presets, after the review lenses, and review routing changes for personas that list `review`.
- Added the exit tail cap, `assertNoSecrets` on notes and the notebook, a stable working directory per persona, a
  startup sweep, and the note that `total_cost_usd` is an API-price figure.

## Phase 2 as built (2026-11-24)

- Server: `src/research-trees.ts` decides the commit of each job: its newest delivery head or review package head, else
  `origin/<base>`. A run reads at most four jobs; the others are "not pinned" in the prompt. The launch carries `persona`
  and `trees`. `get_item` shows the job's `repo_path`, `base_branch`, `head_sha`, `head_source` and `pr_url`.
- Runner: `scripts/research-trees.ts` makes a detached, locked worktree per commit under
  `~/.local/state/triglav/research-trees/<repository hash>/<commit>` (`core.symlinks=false`, `core.hooksPath=/dev/null`),
  reuses it, and writes a review diff as `pr-<job>.diff` (capped at 1 MB) in the persona's folder. It never fetches: a
  commit that is not in the checkout is a note on that job. The sweep removes trees unused for a day, through git and
  without `--force`.
- Claude run: the working folder is `~/.local/state/triglav/research/<persona>`, `--setting-sources ""` is set, and Read,
  Grep and Glob are allowed only inside the trees and the persona folder, with the secret files denied.
- Codex runs are unchanged (the persona's repository and the whole disk), as the plan says.
- The card, `RESEARCH_PROMPT`, the AGENTS.md invariant and the `triglav-research` skill no longer say "board text only".
- Not measured yet: tokens per handled item with pinned trees, and the share of "not checked" posts, which the plan
  names as the success measure. Read the Researchers page for a few days before phase 3.
