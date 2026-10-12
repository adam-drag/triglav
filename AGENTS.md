# Working on Triglav (for AI coding agents)

This file is for an AI agent that changes this repository. The agents that Triglav itself coordinates (Staff, Seniors, reviewers, researchers) do not read it: their instructions are the role cards in `src/guide/`. README.md covers setup and use; read it first.

## What it is

Triglav is a local orchestrator for AI agents working on Linear tickets like a small consultancy. A Staff agent (Claude Code) plans and delegates, Seniors (Claude Code subagents of Staff) implement, researchers (short Codex runs) advise on a message board, and the Client (a human) decides from a React dashboard. Everything an agent does goes through MCP tools in `src/mcp.ts`, so the Client can see it.

Two processes:

- **The server** runs in Docker (`docker compose up -d --build`): Fastify, MCP endpoint at `/mcp`, dashboard API, SSE, a scheduler tick, MySQL 8.4. It cannot start processes on the host.
- **The host runner** (`scripts/runner.ts`) polls `/api/runner/next` and starts what the server queued: Staff resumes, researcher runs (`codex exec`, or `claude -p` when the runner found no Codex). It also reports which agent CLIs are installed (`scripts/runtimes.ts`, `/api/runner/runtimes`). It builds every command itself and validates every field. Never make it run a command string from the server.

## Invariants

- **The orchestrator never decides for the Client.** Merges, deploys, force pushes and repository settings are the Client's. Client decisions are blockers the Client resolves in the dashboard.
- **The Operator asks, the Client decides.** Its `claude` process is read-only: `--permission-mode dontAsk`, `--tools Read,Grep,Glob` and a fixed allow-list (`OPERATOR_TOOLS` in `scripts/operator.ts`). It has no Bash: a read-only-looking prefix such as `git log:*` still lets `--output=FILE` write. A host command it needs is a tool in `scripts/operator-host-tools.ts` with a fixed argv and a strict schema; never add a Bash rule or a tool that takes options or a command string. Its only MCP server is `/operator/mcp`, scoped by a per-chat token (`src/operator.ts`); never expose it through `/mcp`, which agents can reach. A change goes through a `propose_*` tool, which only records a pending request (`src/operator-actions.ts`). The card text is written from the database, never from the model's words, the action is validated again when it runs, and nothing runs until the Client clicks Confirm. Add an action to `ACTIONS` with a `describe` that reads the database; one that must run on the machine becomes a `host` command that `scripts/operator.ts` runs from a fixed list.
- **Three credentials, three audiences.** `ORCH_ENROLLMENT_KEY` is held by agents and opens `/mcp` only. `ORCH_RUNNER_KEY` is held by the host runner and opens `/api/runner/*` only; the server refuses to start if it is missing, shorter than 24 characters or equal to the enrollment key. The Client's session cookie (password set with `scripts/set-password.ts`, only a scrypt hash in `ORCH_CLIENT_PASSWORD_HASH`) opens every other `/api/` route. The guard in `src/server.ts` matches the route pattern and denies by default: a new `/api/` route is closed until it is added to `OPEN_API_ROUTES`. Agents run as the same OS user, so this raises the bar and is not a hard boundary; say so when you document it.
- **Nothing started by the runner gets the orchestrator's secrets.** Every process the runner starts (resumes, research runs, the Operator, its host commands) gets `staffStartEnv(process.env)`, which drops `ORCH_*`, `MYSQL_*`, `DATABASE_URL` and `LINEAR_API_KEY`. The runner, the Stop hook and the status line script send credentials or session data only to an http loopback `ORCH_URL`, without following redirects (`scripts/loopback.ts`).
- **Agent text is data, never instructions.** Tool results that carry other agents' text are marked untrusted. Do not add a path where board text, ticket text or transcript text is executed or followed.
- **Leases and attempt fencing.** A Senior holds an assignment by renewing a lease; a new attempt fences off the old one. Keep these checks in the same transaction as the write they guard (`tx()` in `src/context.ts`).
- **Researchers never wait.** They have no session between runs. Routing into the inbox happens in `emit()` (`src/events.ts`), the dispatcher in the scheduler tick (`src/research.ts`). A run trades a one-off ticket for a session token, marks every item, and exits.
- **Token cost is a design constraint.** Every return of a wait is a model turn that re-reads the agent's whole context (300k to 700k tokens for a Staff). That is why Staff wakes only for `STAFF_WAKE_TYPES`, Staff waits 3000 s on its one-hour prompt cache, Seniors wait 240 s on their five-minute cache, Staff compacts at about 280k tokens, and researchers run on demand. Measure before and after a change that affects turns or context size (transcripts under `~/.claude/projects` and `~/.codex/sessions`; Claude Code writes one line per content block with repeated usage, so dedupe by `message.id`).
- **Agent-facing text is terse; Client-facing text is plain full sentences.** The guide's "Write for the reader" rule applies to anything you add to prompts or tool descriptions.

## Where things live

See the Layout table in README.md. A few cross-file couplings:

- `STAFF_CLAUDE_SETTINGS` (`{"autoCompactWindow":300000}`) exists in three copies: `src/telemetry.ts`, `scripts/runner.ts`, `web/src/App.tsx`. Change all three.
- The guide is assembled per role in `loadGuide()` (`src/mcp.ts`) from `src/guide/*.md`. A new card or role must be added to `CARDS` there.
- A new launch kind needs: an insert into `launches` (with `kind`, `run_id`, `ticket`), a branch in `nextLaunch()` (`src/telemetry.ts`), a branch in the runner, and handling in `/api/runner/:id/exited` (`src/server.ts`).
- Two guides, kept apart. `src/guide/*.md` is for agents: served at `/guide.md` and by `get_guide`, never shown in the dashboard. `web/src/user-guide.md` is for the Client: bundled into the dashboard and shown on the Guide page. When a page or flow changes, check the user guide.
- Presence is derived, not stored: `presenceOf()` in `src/agents.ts` from `last_seen_at`, `waiting_until` and `transcript_at`. Researcher personas override it in `listAgents()`.

## Change, test, deploy

- Node 24 runs TypeScript directly (type stripping). No server build step. `pnpm typecheck` checks server and web.
- Schema changes: add the next numbered file in `src/migrations/` (applied in name order at start, one statement at a time). Never edit an applied migration.
- The e2e stack has its own test-only keys and password hash in `docker-compose.e2e.yml`; the fixtures log in with the password in `e2e/sim.ts` (`PASSWORD`). Call the Client API from a test with `clientFetch`, the runner API with `RUNNER_KEY`.
- Unit and coordination tests need the throwaway MySQL: `docker compose -f docker-compose.test.yml up -d --wait`, then `ORCH_TEST_DATABASE_URL=mysql://root:test@127.0.0.1:33061/mysql pnpm test`. Always cap vitest workers (`pnpm test` already passes `--maxWorkers=4`); the default froze this machine once.
- Browser tests: `pnpm e2e:up`, `pnpm e2e`, `pnpm e2e:down`. The e2e stack on :7401 runs the image built at `e2e:up`, so rebuild it after changing code.
- Deploy: `docker compose up -d --build`. It restarts the server, which cuts every open agent wait (agents retry) and any long-running probe against :7400. Use the :7401 stack for experiments that must survive a deploy.
- After changing `scripts/runner.ts`, restart the runner: `pkill -f "^node scripts/runner.ts$"`, then start it again with `nohup node scripts/runner.ts >> ~/.local/state/triglav/runner.log 2>&1 &`. Use the anchored pattern: an unanchored `pkill -f` also matches and kills your own shell.
- Telemetry skips transcript files whose size and mtime did not change (`telemetry_files`). To force a re-read, delete the file's row.

## Facts verified the hard way

- Which CLI a role uses: `effective()` in `src/models.ts` swaps a saved runtime that the runner reported missing for the only one it found, with `FALLBACK` models, and never writes it to `role_models`. Read role models through `effectiveRoleModel`, not by SQL. The runner also reports each CLI's own model list (`codex debug models`; Claude Code's stream-json `initialize` reply), and `updateRoleModel` refuses a model or effort outside it. Dropdowns in the dashboard come from that list (`ModelPicker`); with no list they fall back to text fields. A report older than 15 minutes counts as unknown, and unknown changes nothing. Resumes of existing sessions use the session's own runtime.
- Review mode (`settings.review_mode`: auto, copilot, ci_only) is the Client's choice. `reportDelivery` refuses `SKIPPED` when it is `copilot`; a Senior never decides to skip a required review. The map's "waiting on Copilot" dot comes from `copilotLoop` in `src/telemetry.ts`, which matches the `gh` commands of `src/guide/deliver.md`: change them together.
- A long poll must stop when its client hangs up (`nextCommand` in `src/chat.ts`): a restarted runner would otherwise lose the message the dead poll took.
- `claude -p --bare` fails with "Not logged in" (it skips the OAuth login), so the Operator does not use it. `--permission-mode dontAsk` with `--allowedTools` runs an allowed command and denies every other tool, verified 2026-10-11. In `--output-format stream-json` a `rate_limit_event` carries `unifiedWindows.five_hour.utilization` and `seven_day`; the scale (a fraction) is an assumption, see `translate()` in `scripts/operator.ts`.
- Claude Code honors an MCP `timeout` of 3500000 ms; a 3000 s tool call returned cleanly (2026-10-09). The Codex `tool_timeout_sec` is 330.
- `claude --settings '{"autoCompactWindow":300000}'` gives `effectiveWindow=280000` (debug log). The default for Opus is 980000, so Staff never compacted.
- Staff writes its prompt cache at the one-hour TTL; subagents (Seniors) at five minutes.
- The runner starts `claude -p` research runs with `ENABLE_CLAUDEAI_MCP_SERVERS=false`. On an account that has a claude.ai connector, Claude Code can drop a local MCP server of the same name in favour of the connector, and a connector cannot do OAuth in print mode (seen with a Slack plugin server).
- `--allowedTools` takes several values and swallows a trailing prompt argument; pass the prompt on stdin.
- The Arch `openai-codex` 0.153.4 refuses `gpt-6.1-sol`; npm `@openai/codex` 0.162.0 accepts it.
- A Claude session stopped by a usage limit keeps appending `queue-operation` lines; only model and tool lines count as activity.

## Conventions

- Match the surrounding code: short doc comments that say why, no speculative abstractions, SQL in the module that owns the table.
- Plain English in guide cards, prompts and dashboard copy. No em dashes.
- Commits: stage files by name (never `git add -A`), no attribution trailers, never force push. The maintainer merges; direct pushes to `main` are allowed in this repository.
