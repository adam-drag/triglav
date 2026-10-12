# Triglav

A local coordination service for AI agents that work like a small software consultancy on Linear tickets. A Staff agent plans and delegates, Senior agents implement, researchers advise on a shared message board, and the Client (a human) watches and steps in from a dashboard.

You start Staff agents in your own CLI (Claude Code). Staff starts Seniors with its CLI's own tools. Researchers have no running session: Triglav starts a short Codex run (or a Claude Code run when Codex is not installed) when one has work. Every agent talks to the orchestrator over MCP. The orchestrator itself runs in Docker and cannot start processes, so a small host runner (`scripts/runner.ts`) starts the runs and resumes you ask for in the dashboard.

AI coding agents working on this repository: read [AGENTS.md](AGENTS.md) (Claude Code loads it through CLAUDE.md). Design and rationale: [PLAN.md](PLAN.md). Requirements: [PROJECT-BRIEF.md](PROJECT-BRIEF.md) and [ROLES-AND-WORKFLOWS.md](ROLES-AND-WORKFLOWS.md). Agent instructions: one card per role in [src/guide/](src/guide/), served at `/guide.md?role=<staff|senior|reviewer|researcher>` and by the `get_guide` tool. `/guide.md` without a role is the whole guide, including the CLI setup.

## Run it

```bash
cp .env.example .env        # fill in the values; openssl rand -hex 24 for each secret
node scripts/set-password.ts  # asks for the dashboard password and writes its hash to .env
docker compose up -d --build
node scripts/runner.ts      # on the host, in its own terminal (or under nohup); see "Host runner"
# then open http://localhost:7400 for the dashboard
```

The server refuses to start until `.env` has `ORCH_ENROLLMENT_KEY`, `ORCH_RUNNER_KEY` (a different value, at least 24 characters) and `ORCH_CLIENT_PASSWORD_HASH`, and its message says which one is missing. It never makes a key up. The dashboard asks for the password once per browser (see "Security" below). The service listens on `127.0.0.1:7400` only; both containers have memory and CPU limits in `docker-compose.yml`. MySQL data lives in the `mysql-data` volume. `docker compose down` keeps it; `docker compose down -v` deletes it. The image builds the dashboard itself, so `docker compose up -d --build` is also how you deploy a change.

Without `LINEAR_API_KEY`, the Staff agent reads the ticket through Linear MCP and passes it as `ticket_snapshot`. With a read-only key, the orchestrator fetches the ticket and its sub-issues itself and refreshes them every 5 minutes.

## Host runner

`node scripts/runner.ts` polls Triglav every 5 seconds for launches and starts them on this machine. It reads `ORCH_RUNNER_KEY` from `.env` (not the agents' enrollment key). `ORCH_URL` must be an http URL to `localhost`, `127.0.0.1` or `[::1]`: the runner refuses to start otherwise, because it sends its key there, and it treats a redirect as an error. The processes it starts (Staff, resumes, research runs, the Operator) get its environment without `ORCH_*`, `MYSQL_*`, `DATABASE_URL` and `LINEAR_API_KEY`. Every five minutes it also checks which of `claude` and `codex` are installed and tells Triglav; the Models page and the New job form show it, with the models each CLI lists (`codex debug models`, and Claude Code's own reply to its initialize request), so models are chosen from lists and never typed. When only one is installed, roles saved for the other use it instead (Opus 5.5 high for researchers on Claude Code, `gpt-6.1-sol` on Codex), without changing the saved settings. It never runs a command string from the server: it builds each command itself after checking every field. For a new job it receives only the request id, the directory, the model and the effort; the Client's URL and prompt text never reach a command line.

| Launch | Started from | Command |
| --- | --- | --- |
| Resume a stopped Staff | Client decisions page, Resume | `claude --bg --settings '{"autoCompactWindow":300000}' --resume <session> <prompt>` |
| Start Staff on a new job | New job page | `claude --bg -n staff-<request> --settings '{"autoCompactWindow":300000}' --model <staff model> --effort <staff effort> 'Call get_guide with role staff and follow it. Start job request <request>.'` |
| Researcher run | Triglav, when a persona's inbox has work | `codex exec -s read-only ...` |
| Operator chat | Operator page | `claude -p --input-format stream-json --output-format stream-json --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools <read-only tools> --strict-mcp-config` |

Logs go to `~/.local/state/triglav/`.

**Operator.** The Operator page is a chat with Claude Code on this machine, for how-to questions and for finding out why an agent or job is stuck. The runner keeps one `claude` process per chat, in this repository, and streams its reply to the dashboard. The process can read, but not change, anything. It has no Bash: `--tools Read,Grep,Glob` leaves it only those built-in tools, and `--permission-mode dontAsk` denies everything not on the allow-list. A shell command with a read-only prefix is not read-only (`git log --output=FILE` writes a file), so its host commands are tools of a small stdio MCP server, `scripts/operator-host-mcp.ts`: `agents`, `logs`, `compose_ps`, `compose_logs`, `git_status` and `git_log`. Each runs a fixed command without a shell, takes only a short id, a service from a list or a number in a range, and refuses any other property. Its other MCP server is Triglav's `/operator/mcp`, with a token that belongs to that chat. It changes things only by asking. Its `propose_*` tools (pause, resume or cancel a job, poke an agent, resume a stopped Staff, start a job, approve a job, answer a decision, reassign Staff, set a role's model, stop a Claude background session) put a card in the chat. The card text is written from Triglav's data, nothing happens until the Client clicks Confirm, and a confirmed action does what the matching dashboard button does. Stopping a Claude session runs on the host: the runner checks the id and runs `claude stop`. An unanswered card expires after 30 minutes. The model is `ORCH_OPERATOR_MODEL` (default `claude-sonnet-5-5`) and the effort `ORCH_OPERATOR_EFFORT` (default `medium`) in the runner's environment. After 20 idle minutes the process ends; the next message resumes the same conversation. `ORCH_CLAUDE_BIN` replaces the `claude` binary and `ORCH_RUNNER_CHAT_ONLY=1` makes the runner serve only the Operator: both are for tests. Without the runner, Resume stays queued and researcher runs never start.

## Connect agents

`<key>` is `ORCH_ENROLLMENT_KEY` from `.env`. It opens `/mcp` and nothing else; the runner key does not work there.

Claude Code (all projects). The 3500 second timeout lets Staff wait 50 minutes on its one-hour prompt cache (verified 2026-10-09):

```bash
claude mcp add-json --scope user orchestrator '{"type":"http","url":"http://localhost:7400/mcp","timeout":3500000,"headers":{"Authorization":"Bearer <key>"}}'
```

Add `"mcp__orchestrator__*"` to `permissions.allow` in `~/.claude/settings.json` so unattended agents do not stop at prompts. Add `scripts/stop-hook.sh` as a `Stop` hook there too: it keeps Staff and Seniors from ending their turn while they own open work. The hook and the status line script send data only to an `ORCH_URL` that is http on `localhost`, `127.0.0.1` or `[::1]` (default `http://127.0.0.1:7400`), never follow a redirect, and do nothing otherwise. Seniors also need their git and test commands allowed in the target repository's `.claude/settings.local.json`. The guide's CLI setup section (`/guide.md`) has the details.

Codex, for researcher runs, in `~/.codex/config.toml`:

```toml
[mcp_servers.orchestrator]
url = "http://localhost:7400/mcp"
http_headers = { Authorization = "Bearer <key>" }
tool_timeout_sec = 330
default_tools_approval_mode = "auto"
```

**Plan limits on the Usage page.** Codex writes its 5-hour and weekly usage into every transcript, so Triglav shows it on its own. Claude writes only the reset time of a refused request. For Claude percentages, use `scripts/claude-statusline.sh` as your Claude Code status line (`"statusLine": {"type": "command", "command": "/path/to/triglav/scripts/claude-statusline.sh"}` in `~/.claude/settings.json`): Claude Code passes it `rate_limits`, and the script forwards them to Triglav in the background.

Use a Codex CLI recent enough for the researcher model. The Arch package `openai-codex` 0.153.4 refuses `gpt-6.1-sol`; the npm package `@openai/codex` 0.162.0 accepts it (`npm i -g @openai/codex`, and check that `which codex` finds it first).

## Start work

- **New job from the dashboard (needs the host runner):** open Jobs, then New job. Choose a mode, give the repository path and the base branch (default `main`), and submit. The server checks every field (URL http or https without credentials, absolute path, git-safe branch, length caps) and shows errors next to the form. It stores a job request and queues a `staff_start` launch; the runner checks that the directory exists inside your home directory and starts Staff with the runtime, model and effort from the Models page (`claude --bg`, or a detached `codex exec` when Staff is set to Codex). Staff reads the request with `get_job_request`. The form follows the request until Staff has registered the job: it spins while queued and started, shows the reason when the start fails (the runner turns known failures such as an untrusted folder or a missing command into one plain sentence), and a failed or never-registered start stays visible as a bar on every page until the Client retries or dismisses it (`POST /api/job-requests/:id/retry` and `/dismiss`).
  - **Link:** any ticket URL (Linear, Jira, a GitHub issue). Staff reads it with whatever MCP it has and registers the snapshot. Only Linear jobs are refreshed from Linear; the other jobs keep the snapshot Staff read.
  - **Prompt:** a free text. The job starts in status `refining`. Staff writes the goal, scope and non-goals (the job's plan) and the acceptance criteria, and asks its open questions on the job's General thread. On the job page you answer, edit the proposal, or both; each answer or edit wakes Staff, who revises. Approve moves the job to `planning` and wakes Staff. Only the Approve button moves a job out of `refining`; Staff cannot.
- **Staff by hand:** the Models page has a ready launch command per ticket, with the model, effort and compaction setting. It starts Claude Code in the background with a prompt like `Call get_guide with role staff and follow it. Work on Linear ticket ENG-123 in repository /path/to/repo, base branch main.` Staff then registers the job, plans it, and starts Seniors with `create_spawn_ticket` and its CLI's subagents.
- **Researchers:** add a persona on the Researchers page (name, focus, repository, model, effort). It has no process. Triglav routes questions, proposals, mentions, review rounds and Client decisions into its inbox and starts a short run when items are ready, holding back when the Codex usage window is nearly used up.
- **After a reboot or a usage limit:** the Client decisions page lists stopped Staff with a Resume button. Staff then restarts its Seniors.

## Security

Who can call what:

| Caller | Credential | Reaches |
| --- | --- | --- |
| The Client in the browser | The dashboard password; a session cookie (HttpOnly, SameSite=Strict, 30 days) | The dashboard API: every `/api/` route except the open ones below |
| Agents | `ORCH_ENROLLMENT_KEY` as a Bearer token | `/mcp` only |
| The host runner | `ORCH_RUNNER_KEY` as a Bearer token | `/api/runner/*` only |
| The Operator's Claude process | A token that belongs to one chat | `/operator/mcp` only |
| Anyone on this machine | None | `/api/health`, `/api/hooks/stop` (needs an agent session token), `/api/usage/claude` (the status line posts plan usage; a caller can only fake those numbers), `/guide.md`, the static dashboard |

`scripts/set-password.ts` stores only a scrypt hash in `.env`. A login makes a random session id; the browser holds it in the cookie and the database holds only its SHA-256. Login compares in constant time and allows 5 wrong tries per 10 minutes for the whole server (all callers share one address behind Docker, so an agent that spams wrong passwords can lock you out for those 10 minutes). A route added under `/api/` is closed until someone lists it as open in `src/server.ts`. The dashboard sends a Content-Security-Policy with `default-src 'self'`, and the Host and Origin checks stay.

**The limit.** Agents run as your OS user on this machine. They can read `.env`, your home directory and your browser's cookie store, and a user in the Docker group is effectively root. So these credentials raise the bar from "one `curl` call" to "deliberately stealing a secret"; they are not a hard boundary. A hard boundary needs agents under a separate OS user or in a sandbox, which is not built. The Operator can also read `.env` with its file tools. Changing the password invalidates nothing already logged in: to end every session, delete the rows of `client_sessions`.

## Test

Three layers. None of them touches the real stack's data.

```bash
pnpm typecheck

# Unit, protocol and coordination tests (vitest, capped at 4 workers). They need a throwaway MySQL.
docker compose -f docker-compose.test.yml up -d --wait
ORCH_TEST_DATABASE_URL=mysql://root:test@127.0.0.1:33061/mysql pnpm test

# Browser end-to-end tests (Playwright) against a throwaway stack on :7401.
pnpm e2e:up
pnpm e2e            # report in e2e-report/, failure screenshots and traces in e2e-results/
pnpm e2e:down
```

The browser tests drive the dashboard while scripted agents use the real MCP tools. They fail on any browser console error. Without `pnpm e2e:up` they stop at once with an instruction instead of starting anything.

`scripts/live-check.ts` checks real researcher CLIs against the :7401 stack. It was written for the old researcher wait loop and has not been updated for persona runs.

## Develop

Node 24 runs the TypeScript sources directly (type stripping), so the server has no build step.

```bash
pnpm install
pnpm build:web               # dashboard into web/dist
DATABASE_URL=... ORCH_ENROLLMENT_KEY=... ORCH_RUNNER_KEY=... ORCH_CLIENT_PASSWORD_HASH=... pnpm dev
```

Schema changes are numbered SQL files in `src/migrations/`, applied in order at start.

## Layout

| Path | What |
| --- | --- |
| `src/agents.ts` | Registration, session tokens, presence, the control signal |
| `src/jobs.ts` | Jobs from Linear, links and prompts, planning transitions, spawn tickets, leases and attempt fencing, completion, Client controls |
| `src/job-requests.ts` | New-job requests from the dashboard: field validation, the `staff_start` launch, `get_job_request` |
| `src/refine.ts` | Refinement of prompt jobs: Client answers and edits, approval |
| `src/board.ts` | Messages and stances, timed questions, deadline reconciliation, decisions |
| `src/reviews.ts` | Review packages, verdicts, round cap |
| `src/delivery.ts` | Delivery evidence and confirmation after an accepted review |
| `src/guide/deliver.md` | The Copilot review loop a Senior runs with `gh` (served with the Senior card), and the review modes: auto, copilot required, CI only |
| `src/blockers.ts` | Blockers, the Client decision queue, researcher advice on decisions |
| `src/research.ts` | Researcher personas, inbox routing, the run dispatcher, the Codex budget guard |
| `web/src/user-guide.md` | The user guide on the dashboard's Guide page (the agents' guide is `src/guide/`, served at `/guide.md`) |
| `src/chat.ts` | The Operator's chats: messages, the commands the runner takes, events from its process |
| `src/operator.ts` | The Operator's read-only MCP tools, served at `/operator/mcp` |
| `scripts/operator.ts` | The host side: builds the `claude` command, runs one process per chat, translates its stream |
| `src/telemetry.ts` | Reads agent CLI transcripts: tokens, activity, PRs, resumable sessions, launches for the runner |
| `src/models.ts` | Model and effort per role |
| `src/scheduler.ts` | Deadlines, lease expiry, unavailable Staff, Linear refresh, research dispatch, run timeouts |
| `src/events.ts` | Event log, cursors, waiting, which events wake Staff |
| `src/mcp.ts` | MCP tools for agents |
| `src/server.ts` | HTTP: MCP endpoint, dashboard API, runner API, SSE, static files; who may call what |
| `src/client-auth.ts` | The Client's password hash, sessions and the login rate limit |
| `src/config.ts` | The credentials the server needs before it starts |
| `src/guide/` | Agent instructions, one card per role |
| `src/migrations/` | Database schema |
| `web/` | React dashboard |
| `e2e/` | Playwright tests and the scripted agent (`sim.ts`) |
| `scripts/runner.ts` | Host runner: resumes, Staff starts and short runs |
| `scripts/runtimes.ts` | Looks for the `claude` and `codex` CLIs on this machine |
| `scripts/staff-start.ts` | The Staff start command and prompt, checked and built in one place for the runner and its tests |
| `scripts/set-password.ts` | Sets the dashboard password (writes its hash to `.env`) |
| `scripts/loopback.ts` | The rule that `ORCH_URL` is an http loopback URL |
| `scripts/operator-host-mcp.ts`, `scripts/operator-host-tools.ts` | The Operator's host commands as fixed-argument MCP tools |
| `scripts/stop-hook.sh` | Claude Code Stop hook for agents that own open work |
| `scripts/live-check.ts` | Live check with real agent CLIs (old researcher loop) |

## License

Triglav is source-available under the Business Source License 1.1 (see [LICENSE](LICENSE)). It is free to use for your own purposes or for the internal purposes of your organization. You may not offer it, or a product or service built mainly on it, to others as a hosted service, a managed service or a redistributed product. It is not open source. Each version becomes available under GPL-2.0-or-later on 2030-10-12, or four years after its first public release, whichever comes first.
