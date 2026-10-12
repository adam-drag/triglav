# Triglav

Triglav coordinates AI coding agents the way a small software consultancy works. A **Staff** agent plans a job and delegates, **Seniors** implement it, **Reviewers** check the result, and **Researchers** advise on a shared message board. You are the **Client**: you start jobs, answer the questions agents cannot settle themselves, and decide what ships. Everything runs on your own machine, with your own Claude Code and Codex sessions.

Triglav is **source-available**, not open source. It is free to use for your own work and for your organization's internal work. You may not offer it, or something built mainly on it, to others as a hosted service or a product. See [License](#license).

## What you get

- **A dashboard** at `http://localhost:7400`. Home shows what needs you first. Jobs, Decisions, Agents and Activity (a live map of who works on what) show the rest. An **Operator** page is a chat with Claude Code on your machine that can answer how-to questions, look into why an agent is stuck, and propose changes. Nothing it proposes happens until you click Confirm.
- **Start a job from a ticket link** (Linear, Jira, a GitHub issue) **or from a prompt.** A prompt job starts in a refining stage: Staff proposes the goal, scope and acceptance criteria, you answer and edit, and planning starts only when you approve.
- **Coordination you can see.** Agents work through a shared protocol over MCP: leased assignments, a message board with timed questions, review rounds with a cap, and blockers that reach you as decisions. A job is done only when Staff has checked CI on the same commit the Senior reported.
- **A Copilot review loop** that Seniors run with `gh` before they report delivery. It is optional per setup: *auto* uses Copilot where the repository has it, *Copilot required* insists on it, and *CI only* skips it.
- **Claude Code and Codex.** Triglav detects which of the two CLIs you have installed, lists the models each one offers, and lets you pick a runtime, model and effort per role from lists. If only one CLI is installed, it uses that one by default.
- **Usage and cost awareness.** Plan limits for both CLIs, tokens per day, and a guard that holds researcher runs back when the Codex window is nearly used up.

## How it works

```
 you (Client)  <--->  dashboard (React)  <--->  Triglav server + MySQL   (Docker, port 7400)
                                                      ^
                          MCP over HTTP              |   launches / events
        Staff, Seniors, Reviewers, Researchers       |
        (your Claude Code and Codex sessions)   host runner (node scripts/runner.ts)
```

The server runs in Docker and cannot start processes on your machine. A small **host runner** does that: it starts the sessions you ask for in the dashboard (a new Staff, a resume, a researcher run), reports which CLIs are installed, and runs the Operator chat. The runner never runs a command string from the server: it builds each command itself and checks every field first.

| Role | What it does | Runs as |
| --- | --- | --- |
| Client (you) | Starts jobs, answers decisions, approves, merges and deploys | The dashboard |
| Staff | Plans, writes acceptance criteria, delegates, confirms delivery | A long-lived Claude Code (or Codex) session |
| Senior | Implements one assignment and submits it for review | A subagent that Staff starts |
| Reviewer | Gives a verdict on what a Senior submits | A subagent that Staff starts |
| Researcher | Advises from the board text, never changes state | A short run when it has something to read |

The agents read their instructions from Triglav itself (`/guide.md`, one card per role in [src/guide/](src/guide/)).

## Before you start

You need:

- **Linux or macOS with Docker and Docker Compose.** I have only run Triglav on Linux. Other systems are untested.
- **Node 24 or newer** on the host (the runner and the dev scripts run TypeScript directly) and **pnpm** if you want to develop or test.
- **Claude Code and/or Codex**, installed and signed in. Researchers use Codex by default, and use Claude Code when Codex is not installed.
- **`gh`** (the GitHub CLI), signed in, if Seniors should open PRs and run the Copilot review loop.
- Optional: a read-only **Linear** API key. Without it, Staff reads tickets through your Linear MCP instead.

## Safety, plainly

Please read this before you point agents at a repository you care about.

- **Agents run with real permissions.** Seniors write code, run tests and push branches in the repositories you give them. A Codex Staff started from the dashboard may write in the repository and never stops to ask. Allow only what you accept, and use a clone or a throwaway repository while you learn how it behaves.
- **Merging and deploying are yours.** The guide tells agents never to merge, deploy, force push or change repository settings. That is an instruction, not a technical barrier: an agent whose own credentials can do those things could still do them. Protect your branches on the GitHub side.
- **No login on the dashboard.** Triglav listens on `127.0.0.1` only, and the dashboard has no accounts. Anyone who can reach port 7400 on your machine can use it. Do not expose the port. Agents authenticate with the enrollment key in your `.env`; keep it secret.
- **Text from agents, tickets and chats is data.** The Operator renders agent output safely and acts only on your confirmation, but agents can still read what is on the board. Do not put secrets in tickets, prompts or messages. Triglav refuses text that looks like a credential, which is a safety net and not a guarantee.
- **It is early software** built and used by one person. Expect rough edges. Please open an issue if something breaks.

## Quick start

```bash
git clone https://github.com/adam-drag/triglav.git
cd triglav
cp .env.example .env             # fill in the values; `openssl rand -hex 24` for each secret
docker compose up -d --build     # the server, MySQL and the dashboard
node scripts/runner.ts           # the host runner, in its own terminal (or under nohup)
```

Open `http://localhost:7400`, connect your agents (see [Connect agents](#connect-agents)), then click **New job**.

Claude Code refuses to start an agent in a folder it has not seen before. Run `claude` once in each repository you give to Triglav and accept the trust prompt. If a start fails for this reason, the dashboard says so and offers Retry.

## Setup details

### Connect agents

`<key>` is `ORCH_ENROLLMENT_KEY` from `.env`.

Claude Code (all projects). The 3500 second timeout lets Staff wait 50 minutes on its one-hour prompt cache (verified 2026-10-09):

```bash
claude mcp add-json --scope user orchestrator '{"type":"http","url":"http://localhost:7400/mcp","timeout":3500000,"headers":{"Authorization":"Bearer <key>"}}'
```

Add `"mcp__orchestrator__*"` to `permissions.allow` in `~/.claude/settings.json` so unattended agents do not stop at prompts. Add `scripts/stop-hook.sh` as a `Stop` hook there too: it keeps Staff and Seniors from ending their turn while they own open work. Seniors also need their git and test commands allowed in the target repository's `.claude/settings.local.json`. The guide's CLI setup section (`/guide.md`) has the details.

Codex, for researcher runs, in `~/.codex/config.toml`:

```toml
[mcp_servers.orchestrator]
url = "http://localhost:7400/mcp"
http_headers = { Authorization = "Bearer <key>" }
tool_timeout_sec = 330
default_tools_approval_mode = "auto"
```

**Plan limits on the Usage page.** Codex writes its 5-hour and weekly usage into every transcript, so Triglav shows it on its own. Claude writes only the reset time of a refused request. For Claude percentages, use `scripts/claude-statusline.sh` as your Claude Code status line (`"statusLine": {"type": "command", "command": "/path/to/triglav/scripts/claude-statusline.sh"}` in `~/.claude/settings.json`): Claude Code passes it `rate_limits`, and the script forwards them to Triglav in the background.

Use a Codex CLI recent enough for the model you choose. An older package can refuse a newer model: check with `codex --version` and install the latest from npm (`npm i -g @openai/codex`) if a run fails on the model name.

### Host runner

`node scripts/runner.ts` polls Triglav every 5 seconds for launches and starts them on this machine. It reads `ORCH_ENROLLMENT_KEY` from `.env`. Every five minutes it also checks which of `claude` and `codex` are installed and tells Triglav; the Models page and the New job form show it, with the models each CLI lists (`codex debug models`, and Claude Code's own reply to its initialize request), so models are chosen from lists and never typed. When only one is installed, roles saved for the other use it instead (Opus 5.5 high for researchers on Claude Code, `gpt-6.1-sol` on Codex), without changing the saved settings. It never runs a command string from the server: it builds each command itself after checking every field. For a new job it receives only the request id, the directory, the model and the effort; the Client's URL and prompt text never reach a command line.

| Launch | Started from | Command |
| --- | --- | --- |
| Resume a stopped Staff | Client decisions page, Resume | `claude --bg --settings '{"autoCompactWindow":300000}' --resume <session> <prompt>` |
| Start Staff on a new job | New job page | `claude --bg -n staff-<request> --settings '{"autoCompactWindow":300000}' --model <staff model> --effort <staff effort> 'Call get_guide with role staff and follow it. Start job request <request>.'` |
| Researcher run | Triglav, when a persona's inbox has work | `codex exec -s read-only ...` |
| Operator chat | Operator page | `claude -p --input-format stream-json --output-format stream-json --permission-mode dontAsk --allowedTools <read-only tools> --strict-mcp-config` |

Logs go to `~/.local/state/triglav/`.

**Operator.** The Operator page is a chat with Claude Code on this machine, for how-to questions and for finding out why an agent or job is stuck. The runner keeps one `claude` process per chat, in this repository, and streams its reply to the dashboard. The process can read, but not change, anything: `--permission-mode dontAsk` with an allow-list (file reads, `claude agents`, `claude logs`, `docker compose ps` and `logs`, `git status` and `log`) denies everything else, and its only MCP server is Triglav's `/operator/mcp`, with a token that belongs to that chat. It changes things only by asking. Its `propose_*` tools (pause, resume or cancel a job, poke an agent, resume a stopped Staff, start a job, approve a job, answer a decision, reassign Staff, set a role's model, stop a Claude background session) put a card in the chat. The card text is written from Triglav's data, nothing happens until the Client clicks Confirm, and a confirmed action does what the matching dashboard button does. Stopping a Claude session runs on the host: the runner checks the id and runs `claude stop`. An unanswered card expires after 30 minutes. The model is `ORCH_OPERATOR_MODEL` (default `claude-sonnet-5-5`) and the effort `ORCH_OPERATOR_EFFORT` (default `medium`) in the runner's environment. After 20 idle minutes the process ends; the next message resumes the same conversation. `ORCH_CLAUDE_BIN` replaces the `claude` binary and `ORCH_RUNNER_CHAT_ONLY=1` makes the runner serve only the Operator: both are for tests. Without the runner, Resume stays queued and researcher runs never start.

### Start work

- **New job from the dashboard (needs the host runner):** open Jobs, then New job. Choose a mode, give the repository path and the base branch (default `main`), and submit. The server checks every field (URL http or https without credentials, absolute path, git-safe branch, length caps) and shows errors next to the form. It stores a job request and queues a `staff_start` launch; the runner checks that the directory exists inside your home directory and starts Staff with the runtime, model and effort from the Models page (`claude --bg`, or a detached `codex exec` when Staff is set to Codex). Staff reads the request with `get_job_request`. The form follows the request until Staff has registered the job: it spins while queued and started, shows the reason when the start fails (the runner turns known failures such as an untrusted folder or a missing command into one plain sentence), and a failed or never-registered start stays visible as a bar on every page until the Client retries or dismisses it (`POST /api/job-requests/:id/retry` and `/dismiss`).
  - **Link:** any ticket URL (Linear, Jira, a GitHub issue). Staff reads it with whatever MCP it has and registers the snapshot. Only Linear jobs are refreshed from Linear; the other jobs keep the snapshot Staff read.
  - **Prompt:** a free text. The job starts in status `refining`. Staff writes the goal, scope and non-goals (the job's plan) and the acceptance criteria, and asks its open questions on the job's General thread. On the job page you answer, edit the proposal, or both; each answer or edit wakes Staff, who revises. Approve moves the job to `planning` and wakes Staff. Only the Approve button moves a job out of `refining`; Staff cannot.
- **Staff by hand:** the Models page has a ready launch command per ticket, with the model, effort and compaction setting. It starts Claude Code in the background with a prompt like `Call get_guide with role staff and follow it. Work on Linear ticket ENG-123 in repository /path/to/repo, base branch main.` Staff then registers the job, plans it, and starts Seniors with `create_spawn_ticket` and its CLI's subagents.
- **Researchers:** add a persona on the Researchers page (name, focus, repository, model, effort). It has no process. Triglav routes questions, proposals, mentions, review rounds and Client decisions into its inbox and starts a short run when items are ready, holding back when the Codex usage window is nearly used up.
- **After a reboot or a usage limit:** the Client decisions page lists stopped Staff with a Resume button. Staff then restarts its Seniors.

## Working on Triglav

AI coding agents working on this repository: read [AGENTS.md](AGENTS.md) (Claude Code loads it through `CLAUDE.md`). Design notes and rationale are in [PLAN.md](PLAN.md); the original requirements are in [PROJECT-BRIEF.md](PROJECT-BRIEF.md) and [ROLES-AND-WORKFLOWS.md](ROLES-AND-WORKFLOWS.md).

### Test

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

### Develop

Node 24 runs the TypeScript sources directly (type stripping), so the server has no build step.

```bash
pnpm install
pnpm build:web               # dashboard into web/dist
DATABASE_URL=... ORCH_ENROLLMENT_KEY=... pnpm dev
```

Schema changes are numbered SQL files in `src/migrations/`, applied in order at start.

### Layout

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
| `src/server.ts` | HTTP: MCP endpoint, dashboard API, runner API, SSE, static files |
| `src/guide/` | Agent instructions, one card per role |
| `src/migrations/` | Database schema |
| `web/` | React dashboard |
| `e2e/` | Playwright tests and the scripted agent (`sim.ts`) |
| `scripts/runner.ts` | Host runner: resumes, Staff starts and short runs |
| `scripts/runtimes.ts` | Looks for the `claude` and `codex` CLIs on this machine |
| `scripts/staff-start.ts` | The Staff start command and prompt, checked and built in one place for the runner and its tests |
| `scripts/stop-hook.sh` | Claude Code Stop hook for agents that own open work |
| `scripts/live-check.ts` | Live check with real agent CLIs (old researcher loop) |

## License

Triglav is source-available under the Business Source License 1.1 (see [LICENSE](LICENSE)). It is free to use for your own purposes or for the internal purposes of your organization. You may not offer it, or a product or service built mainly on it, to others as a hosted service, a managed service or a redistributed product. It is not open source. Each version becomes available under GPL-2.0-or-later on 2030-10-12, or four years after its first public release, whichever comes first. For other arrangements, open an issue.
