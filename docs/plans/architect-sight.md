# The Architect as a level above Staff

Date: 2026-11-26. Asked for by the Client in the Architect chat analysis of the same day: the Architect could not see
GitHub, git history or what Seniors do, and could not take part in reviews, so it was less useful than a Staff. The Client
asked for all four steps, one PR each, and removed the AGENTS.md sentence that required a Client decision for every new
tool. Each step is a Client decision by that request.

## What the Architect could do before

Read, Grep and Glob on its worktrees and the Client's checkouts, and the `initiative` MCP tools (design, threads,
blockers, reports, proposals). No `gh`, no `git`, no job status, no review findings, no way to start a conversation
with Staff, and it woke only on blockers, merges and Staff questions.

## Steps

1. **Sight (read-only).** `get_job` and `get_code_review` for the jobs of its initiative (`src/architect-jobs.ts`), and a
   local stdio `host` MCP server with fixed read-only commands: `gh pr view|diff|checks`, `gh run list`, `gh api` GET of a
   PR's inline review comments, and `git log|show|diff|blame` in its worktrees and checkouts
   (`scripts/architect-host-tools.ts`). Arguments are a repository slug of the initiative, a PR number, a ref, a path and
   small numbers. No option and no command string can be passed. Secret files are refused by path and cut out of diffs.
2. **Voice.** Plain messages on a job thread (`post_message`, `src/architect-post.ts`, merged in PR 112). The design-conformance seat is the `design` review lens (`src/design-review.ts`, `LENS_TEXT.design`): it is a shadow seat in the default panel, and it runs only on a job an initiative card started. The Architect does not run it; it reads the card's design as data in the review prompt.
3. **Initiative rounds.** Built: a wake on each delivery of a card's job (`delivered`), and a daily digest asked for only when a blocker is open or a job is delivering (`digestArchitects`, migration 072). Not built: durable notes. The Architect's chat keeps its own session, so a digest sees the earlier ones until the session is compacted; a notes store would be a new table and a new tool, and is a separate decision.
4. **Authority in small steps.** Budgeted auto-mode actions, with citations and undo. Merges, deploys, force pushes and
   secrets stay out.

## Decisions kept

- The GitHub slug of a repository comes from the initiative settings (the Client's import), never from the model.
- The host server has no connection to Triglav and no key. It runs with `staffStartEnv` and the Client's `gh` login, so it
  reads what that login can read within the repositories named in its config. This raises the bar and is not a hard
  boundary, as for every agent on this machine.
- Reads are not free: each call adds to the Architect's context. Measure turns and tokens before and after a step.
