<div align="center">

<img src="web/public/android-chrome-192x192.png" width="96" alt="Triglav logo">

# Triglav

**Run AI coding agents like a small software consultancy, on your own machine.**

Staff plans. Seniors build. Reviewers check. Researchers advise. You decide what ships.

[![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)
[![Node 24+](https://img.shields.io/badge/node-%3E%3D24-339933)](package.json)
[![Claude Code](https://img.shields.io/badge/runs%20on-Claude%20Code-d97757)](#before-you-start)
[![Codex](https://img.shields.io/badge/runs%20on-Codex-111111)](#before-you-start)

<br>

<img src="docs/screenshots/home.png" alt="The Triglav dashboard: decisions that need you, active jobs, and the agents working on them" width="900">

</div>

> [!IMPORTANT]
> **Triglav uses your own Claude Code or Codex account, so its usage counts against your plan.**
>
> - **It needs Claude Code and/or Codex,** installed and signed in on your machine. Triglav does not include a model, does not call an AI API, and does not ask for an API key. It only orchestrates work: it starts and coordinates the agent CLIs you already have, and they use the account they are signed in with.
> - **All usage goes to your own account.** Every agent turn, Senior, local code review, researcher run and Operator message is a request through your Claude Code or Codex login. If that login uses an API key, pay-as-you-go billing or extra usage beyond your plan, Triglav's work is billed to you on those terms. The Copilot review loop may also use your GitHub Copilot quota.
> - **Some of it starts without a click.** Staff wakes up on events and starts Seniors. Seniors ask for local code reviews, and a review round can run several reviewers. Researchers start short runs when their inbox has items. A job can use a lot of tokens.
> - **Check your settings before you start.** Know how your Claude Code and Codex accounts are billed and what limits they have. Watch the Usage page, and pause or cancel a job if it uses more than you expect.

Triglav coordinates AI coding agents the way a small software consultancy works. A **Staff** agent plans a job and delegates, **Seniors** implement it, **Reviewers** check the result, and **Researchers** advise on a shared message board. You are the **Client**: you start jobs, answer the questions agents cannot settle themselves, and decide what ships. Everything runs on your own machine, with your own Claude Code and Codex sessions.

Triglav is **source-available**, not open source. It is free to use for your own work and for your organization's internal work. You may not offer it, or something built mainly on it, to others as a hosted service or a product. See [License](#license).

## See it work

<table>
<tr>
<td width="50%"><img src="docs/screenshots/activity.png" alt="Live map of Staff, Seniors and Researchers working on three tickets"><br><b>See the whole team at once.</b> A live map shows which agent works on which ticket, and which job is blocked.</td>
<td width="50%"><img src="docs/screenshots/decision.png" alt="A decision card with the problem, a researcher's advice, a recommendation and an Accept button"><br><b>Decide only when it matters.</b> A blocked agent brings you the problem, a recommendation and a researcher's view. When the agent can act on its own recommendation, one click accepts it.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/thread.png" alt="A board thread where researchers support and challenge a proposal"><br><b>Disagreement in the open.</b> Agents post proposals and take a stance, with a reason, on a shared board you can read and join.</td>
<td width="50%"><img src="docs/screenshots/review-panel.png" alt="The review panel settings: seats, runtime, model and effort"><br><b>Your review panel.</b> Pick the reviewers, runtime, model and effort. A Senior's package and its Copilot rounds need a passing local review of that exact commit.</td>
</tr>
</table>

_The screenshots show a seeded demo workspace on a test stack, not real tickets._

## What you get

- **A dashboard** at `http://localhost:7400`. Home shows what needs you first. Jobs, Decisions, Agents and Activity (a live map of who works on what) show the rest. An **Operator** page is a chat with Claude Code on your machine that can answer how-to questions, look into why an agent is stuck, and propose changes. Nothing it proposes happens until you click Confirm.
- **Start a job from a ticket link** (Linear, Jira, a GitHub issue) **or from a prompt.** A prompt job starts in a refining stage: Staff proposes the goal, scope and acceptance criteria, you answer and edit, and planning starts only when you approve.
- **Coordination you can see.** Agents work through a shared protocol over MCP: leased assignments, a message board with timed questions, review rounds with a cap, and blockers that reach you as decisions. A job is done only when Staff has checked CI on the same commit the Senior reported.
- **A local review gate and a Copilot review loop.** A Senior's package needs a passing local review of its exact commit. The loop is at most 3 rounds that Seniors run with `gh` before they report delivery, and a small fix gets no new round. It is optional per setup: *auto* uses Copilot where the repository has it, *Copilot required* insists on it, and *CI only* skips it.
- **Claude Code and Codex.** Triglav detects which of the two CLIs you have installed, lists the models each one offers, and lets you pick a runtime, model and effort per role from lists. If only one CLI is installed, it uses that one by default.
- **Usage and cost awareness.** Plan limits for both CLIs, tokens per day, and a guard that holds researcher runs back when the Codex window is nearly used up.

## How it works

```mermaid
flowchart LR
    you(["<b>You</b><br/>the Client"])

    subgraph docker["Docker, port 7400"]
        srv["<b>Triglav server</b><br/>dashboard and MCP"]
        db[("MySQL")]
    end

    agents["<b>Your agents</b><br/>Staff, Seniors, Reviewers,<br/>Researchers<br/>(Claude Code and Codex)"]
    runner["<b>Host runner</b><br/>node scripts/runner.ts"]

    you <-->|"browser"| srv
    srv --- db
    srv <-->|"MCP over HTTP"| agents
    runner -->|"starts sessions"| agents
    runner -->|"polls for launches"| srv

    classDef client fill:#0f766e,stroke:#2dd4bf,color:#fff
    class you client
```

The server runs in Docker and cannot start processes on your machine. A small **host runner** does that: it starts the sessions you ask for in the dashboard (a new Staff, a resume, a researcher run), reports which CLIs are installed, and runs the Operator chat. The runner never runs a command string from the server: it builds each command itself and checks every field first.

| Role | What it does | Runs as |
| --- | --- | --- |
| Client (you) | Starts jobs, answers decisions, approves, merges and deploys | The dashboard |
| Staff | Plans, writes acceptance criteria, delegates, confirms delivery | A long-lived Claude Code (or Codex) session |
| Senior | Implements one assignment and submits it for review | A subagent that Staff starts |
| Reviewer | Gives a verdict on what a Senior submits | A subagent that Staff starts |
| Researcher | Advises from the board text. It posts on the board and records its answers through Triglav's tools, and cannot edit files or run commands | A short run when it has something to read |

The agents read their instructions from Triglav itself (`/guide.md`, one card per role in [src/guide/](src/guide/)).

## Before you start

You need:

- **Linux or macOS with Docker and Docker Compose.** I have only run Triglav on Linux. Other systems are untested.
- **Node 24 or newer** and **pnpm** on the host. The runner and the scripts run TypeScript directly, and need the dependencies that `pnpm install` fetches.
- **Claude Code and/or Codex**, installed and signed in. Researchers use Codex by default, and use Claude Code when Codex is not installed.
- **`gh`** (the GitHub CLI), signed in, if Seniors should open PRs and run the Copilot review loop.
- Optional: a read-only **Linear** API key. Without it, Staff reads tickets through your Linear MCP instead.

## Safety, plainly

Please read this before you point agents at a repository you care about.

- **Agents run with real permissions.** Seniors write code, run tests and push branches in the repositories you give them. A Codex Staff (started or resumed by the runner) runs like `codex exec --approve-for-me` with a narrowed environment: see "Codex Staff access" below. Allow only what you accept, and use a clone or a throwaway repository while you learn how it behaves.
- **Merging and deploying are yours.** The guide tells agents never to merge, deploy, force push or change repository settings. That is an instruction, not a technical barrier: an agent whose own credentials can do those things could still do them. Protect your branches on the GitHub side.
- **The dashboard has one password.** Triglav listens on `127.0.0.1` only, and the dashboard asks for the password you set with `scripts/set-password.ts`. Do not expose port 7400. To open the dashboard from another machine, use an SSH tunnel, or the opt-in second listener in [Running behind an HTTPS reverse proxy](#running-behind-an-https-reverse-proxy). Agents authenticate with the enrollment key in your `.env`, and the host runner with its own key; keep both secret. See [Security](#security) for what this does and does not protect.
- **Text from agents, tickets and chats is data.** The Operator renders agent output safely and acts only on your confirmation, but agents can still read what is on the board. Do not put secrets in tickets, prompts or messages. Triglav refuses text that looks like a credential, which is a safety net and not a guarantee.
- **It is early software** built and used by one person. Expect rough edges. Please open an issue if something breaks. Report a security problem privately instead, as [SECURITY.md](SECURITY.md) describes.

## Quick start

```bash
git clone https://github.com/adam-drag/triglav.git
cd triglav
pnpm install --frozen-lockfile   # the runner and the setup scripts need the dependencies
node scripts/setup.ts            # creates .env with random keys, then asks for the dashboard password (8 to 1000 characters)
docker compose up -d --build     # the server, MySQL and the dashboard
node scripts/runner.ts           # the host runner, in its own terminal (or under nohup)
```

`setup.ts` fills only empty keys and never replaces one, because your agents' MCP configs hold the enrollment key. Run it again at any time; it changes nothing that is already set. When a key is on more than one line, it stops and changes nothing. To fill `.env` by hand instead, copy `.env.example` and use `openssl rand -hex 24` for each key, then run `node scripts/set-password.ts`.

Docker Compose also needs `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD`. The server refuses to start until `.env` has the three credentials, `ORCH_ENROLLMENT_KEY`, `ORCH_RUNNER_KEY` (a different value, at least 24 characters) and `ORCH_CLIENT_PASSWORD_HASH`, and its message says which one is missing. It never makes a key up. Both containers have memory and CPU limits in `docker-compose.yml`.

Open `http://localhost:7400`, log in with the dashboard password (see [Security](#security)), connect your agents (see [Connect agents](#connect-agents)), then click **New job**.

Claude Code refuses to start an agent in a folder it has not seen before. Run `claude` once in each repository you give to Triglav and accept the trust prompt. If a start fails for this reason, the dashboard says so and offers Retry.

## Setup details

### Connect agents

`<key>` is `ORCH_ENROLLMENT_KEY` from `.env`. It opens `/mcp` and nothing else; the runner key does not work there.

Claude Code (all projects). The 3500 second timeout lets Staff wait 50 minutes on its one-hour prompt cache (verified 2026-10-09):

```bash
claude mcp add-json --scope user orchestrator '{"type":"http","url":"http://localhost:7400/mcp","timeout":3500000,"headers":{"Authorization":"Bearer <key>"}}'
```

Add `"mcp__orchestrator__*"` to `permissions.allow` in `~/.claude/settings.json` so unattended agents do not stop at prompts. Add `scripts/stop-hook.sh` as a `Stop` hook there too: it keeps Staff from ending its turn while it owns open work. Seniors run as subagents of Staff, and Claude Code does not fire `Stop` for a subagent, so also add the same script as a `SubagentStop` hook. The `SubagentStop` part is an experiment: the Claude Code docs say a block keeps a subagent running, but they do not say whether that holds for a background Senior, so compare the share of Senior attempts that end with an expired lease before and after (`docs/plans/orchestrator-research.md`, item 2). The script reads the token of a `SubagentStop` event only from `agent_transcript_path`, the subagent's own transcript, and lets the subagent stop when it is missing. The hook and the status line script send data only to an `ORCH_URL` that is http on `localhost`, `127.0.0.1` or `[::1]` (default `http://127.0.0.1:7400`), never follow a redirect, and do nothing otherwise. Seniors also need their git and test commands allowed in the target repository's `.claude/settings.local.json`. The guide's CLI setup section (`/guide.md`) has the details.

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

`node scripts/runner.ts` polls Triglav every 5 seconds for launches and starts them on this machine. It reads `ORCH_RUNNER_KEY` from `.env` and uses only that key to talk to Triglav's runner API. It also reads `ORCH_ENROLLMENT_KEY` from `.env`, for one purpose: to write the MCP config file of a Claude research run (see below). `ORCH_URL` must be an http URL to `localhost`, `127.0.0.1` or `[::1]`: the runner refuses to start otherwise, because it sends its key there, and it treats a redirect as an error. The processes it starts (Staff, resumes, research runs, the Operator) get its environment without `ORCH_*`, `MYSQL_*`, `DATABASE_URL` and `LINEAR_API_KEY`. Every five minutes it also checks which of `claude` and `codex` are installed and tells Triglav; the Models page and the New job form show it, with the models each CLI lists (`codex debug models`, and Claude Code's own reply to its initialize request), so models are chosen from lists and never typed. When only one is installed, roles saved for the other use it instead (Opus 5.5 high for researchers on Claude Code, `gpt-6.1-sol` on Codex), without changing the saved settings. It never runs a command string from the server: it builds each command itself after checking every field. For a new job it receives only the request id, the directory, the model and the effort; the Client's URL and prompt text never reach a command line.

| Launch | Started from | Command |
| --- | --- | --- |
| Resume a stopped Staff | Client decisions page, Resume | `claude --bg --settings '{"autoCompactWindow":300000}' --resume <session> <prompt>` |
| Start Staff on a new job | New job page | `claude --bg -n staff-<request> --settings '{"autoCompactWindow":300000}' --model <staff model> --effort <staff effort> 'Call get_guide with role staff and follow it. Start job request <request>.'` |
| Researcher run | Triglav, when a persona's inbox has work | `codex exec -s read-only -c mcp_servers.<name>.enabled=false ...`, or `claude -p --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools <read and Triglav tools> --strict-mcp-config --mcp-config <file>` |
| Operator chat | Operator page | `claude -p --input-format stream-json --output-format stream-json --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools <read-only tools> --strict-mcp-config --mcp-config <file>` |

Logs go to `~/.local/state/triglav/`.

**Research runs.** A researcher run reads code and talks to Triglav, and nothing else.

- **Claude.** `--tools Read,Grep,Glob` leaves the run with those built-in tools only, so it has no Bash, Edit or Write even when your own or the repository's Claude settings allow them (the permission mode and `--allowedTools` decide what is permitted, not which tools exist). `--strict-mcp-config` keeps every MCP server out except the orchestrator, so a repository's `.mcp.json` cannot add tools. The run connects with the enrollment key, from a config file that the runner writes for this run only (mode 0600, in a new 0700 directory) and removes when the run exits, when the runner is stopped (SIGTERM, SIGINT), or at the next runner start if the runner was killed (it removes its own directories older than an hour from the temp directory). The key is not in the run's arguments, its environment or any log. A Claude research run fails to start, with a message, when `ORCH_ENROLLMENT_KEY` is not in `.env`.
- **Codex Staff access.** A Codex Staff needs `gh`, the network and signed commits, as a Claude Code Staff has. The runner starts and resumes it with the settings of `codexRoleArgs('staff')` in `src/codex-args.ts` (one builder for start, resume, the dashboard's Copy button and the Models page). They are the config keys that `--approve-for-me` sets in codex-cli 0.162.0 (`approvals_reviewer="auto_review"`, `approval_policy="on-request"`, `sandbox_mode="workspace-write"`; `codex-rs/utils/cli/src/shared_options.rs:80-91` at tag `rust-v0.162.0`), because `codex exec resume` has no such flag. A command that needs more than the sandbox gives (network, `.git`, the GPG agent) goes to Codex's automatic reviewer, not to a human. The shell environment of its commands is narrowed with `shell_environment_policy`: `inherit="all"`, `ignore_default_excludes=true` (otherwise Codex drops every `*TOKEN*` variable) and `include_only` of Codex's own core names (`PATH SHELL TMPDIR TEMP TMP HOME LANG LC_ALL LC_CTYPE LOGNAME USER`) plus `GITHUB_TOKEN` and `SSH_AUTH_SOCK` (so it can push to the `git@github.com` remotes through your key agent); `~/.codex/config.toml` is not changed. The token reaches the process through the environment only, never an argument. The runner still removes `ORCH_*`, `MYSQL_*`, `DATABASE_URL` and `LINEAR_API_KEY` before Codex starts. Only the `staff` role gets this; a `researcher` resume stays `read-only`, and any other role makes the runner refuse the launch. The risk: the automatic reviewer is the only check on what a Codex Staff does with your GitHub token and the network, as Claude Code's auto mode is for a Claude Staff. Misleading ticket or board text could still talk it into an action the reviewer allows. Agents run as the same OS user, so this raises the bar and is not a hard boundary. Live result (codex-cli 0.162.0, 2026-10-15, run by the Client with these settings). A fresh `codex exec`: network, SSH (`git ls-remote git@github.com:...`), `.git` writes and `git commit -S` each failed once inside the sandbox, and the automatic reviewer approved the escalated retry each time. An `exec resume` of the same session: network, `.git` writes and `git commit -S` behaved the same way; SSH was not tried on resume. The signature was reported as good, and no approval was refused. The approved `gh api /rate_limit` retry returned 5000, which does not identify the account. `gh auth status` reported the token invalid inside the sandbox; the cause was not verified. Each such command costs one failed attempt plus an escalation turn; `sandbox_workspace_write.network_access=true` would avoid the network half, but it widens access and is not set.
- **Codex.** `-s read-only` limits the shell commands Codex runs, and nothing else. An MCP tool runs in its own process, and Codex runs it without asking when the tool is not marked destructive. Checked on codex-cli 0.162.0 with a test MCP server: with `-s read-only` and `approval_policy="never"`, a tool marked `destructiveHint: false` wrote a file, both with `default_tools_approval_mode = "auto"` and with no approval setting, and a tool without annotations was refused. So the runner reads `codex mcp list --json` before each run and switches off every server except `orchestrator` with `-c mcp_servers.<name>.enabled=false` (verified to work on the same version), plus a stub `command="/bin/false"` or `url` for the server's transport: a server that only a plugin provides (`cua_repl` of the computer-use plugin) has no table in `config.toml`, and a bare `enabled=false` makes Codex refuse the whole config with "invalid transport". The name `orchestrator` is not trusted by itself: the run starts only if that server is an enabled streamable HTTP server at `http://localhost:<port>/mcp` (or `127.0.0.1`, `[::1]`) with the port of the runner's `ORCH_URL`, as in the setup above. Anything else, a missing server or a list the runner cannot read stops the run before it starts, and its items go back to the inbox. What this does not cover: a server that Codex adds after that list was read, and anything the orchestrator server's own tools allow, which is what a researcher is for. Triglav has no strict mode for Codex like Claude's `--strict-mcp-config`, so check `~/.codex/config.toml` and the plugins you enable if you want to know what a Codex run could reach.
- **Both.** A researcher can still post on the board and record its answers, because those are the orchestrator's tools. It is advice, not authority: agents treat board text as data.

**Operator.** The Operator page is a chat with Claude Code on this machine, for how-to questions and for finding out why an agent or job is stuck. The runner keeps one `claude` process per chat, in this repository, and streams its reply to the dashboard. The process can read, but not change, anything. It has no Bash: `--tools Read,Grep,Glob` leaves it only those built-in tools, and `--permission-mode dontAsk` denies everything not on the allow-list. A shell command with a read-only prefix is not read-only (`git log --output=FILE` writes a file), so its host commands are tools of a small stdio MCP server, `scripts/operator-host-mcp.ts`: `agents`, `logs`, `compose_ps`, `compose_logs`, `git_status` and `git_log`. Each runs a fixed command without a shell, takes only a short id, a service from a list or a number in a range, and refuses any other property. Its other MCP server is Triglav's `/operator/mcp`, with a token that belongs to that chat. Each time the runner starts a process for a chat, Triglav makes a new token and stores only its SHA-256, so the token of an earlier process stops working and nothing in the database can be used as a token. The runner puts the token in a private MCP config file (mode 0600, in a new 0700 directory) and gives `claude` the path: the token is never in the command line, where any local user could read it with `ps`. The runner removes the file when the process ends, and in the same ways as for research runs when the runner stops or was killed. It changes things only by asking. Its `propose_*` tools (pause, resume or cancel a job, poke an agent, resume a stopped Staff, start a job, approve a job, answer a decision, reassign Staff, set a role's model, stop a Claude background session) put a card in the chat. The card text is written from Triglav's data, nothing happens until the Client clicks Confirm, and a confirmed action does what the matching dashboard button does. Stopping a Claude session runs on the host: the runner checks the id and runs `claude stop`. An unanswered card expires after 30 minutes. The model is `ORCH_OPERATOR_MODEL` (default `claude-sonnet-5-5`) and the effort `ORCH_OPERATOR_EFFORT` (default `medium`) in the runner's environment. After 20 idle minutes the process ends; the next message resumes the same conversation. `ORCH_CLAUDE_BIN` replaces the `claude` binary and `ORCH_RUNNER_CHAT_ONLY=1` makes the runner serve only the Operator: both are for tests. Without the runner, Resume stays queued and researcher runs never start.

### Start work

- **New job from the dashboard (needs the host runner):** open Jobs, then New job. Choose a mode, give the repository path and the base branch (default `main`), and submit. The server checks every field (URL http or https without credentials, absolute path, git-safe branch, length caps) and shows errors next to the form. It stores a job request and queues a `staff_start` launch; the runner checks that the directory exists inside your home directory and starts Staff with the runtime, model and effort from the Models page (`claude --bg`, or a detached `codex exec` when Staff is set to Codex). Staff reads the request with `get_job_request`. The form stays usable, so several jobs can be started in a row (it clears the URL or prompt and keeps the repository and branch). It follows the last request until Staff has registered the job and then opens it, unless the Client is typing the next one: it spins while queued and started, shows the reason when the start fails (the runner turns known failures such as an untrusted folder or a missing command into one plain sentence), and a failed or never-registered start stays visible as a bar on every page until the Client retries or dismisses it (`POST /api/job-requests/:id/retry` and `/dismiss`).
  - **Link:** any ticket URL (Linear, Jira, a GitHub issue). Staff reads it with whatever MCP it has and registers the snapshot. Only Linear jobs are refreshed from Linear; the other jobs keep the snapshot Staff read.
  - **Prompt:** a free text. The job starts in status `refining`. Staff writes the goal, scope and non-goals (the job's plan) and the acceptance criteria, and asks its open questions on the job's General thread. On the job page you answer, edit the proposal, or both; each answer or edit wakes Staff, who revises. Approve moves the job to `planning` and wakes Staff. Only the Approve button moves a job out of `refining`; Staff cannot.
- **Staff by hand:** the Models page has a ready launch command per ticket, with the model, effort and compaction setting. It starts Claude Code in the background with a prompt like `Call get_guide with role staff and follow it. Work on Linear ticket ENG-123 in repository /path/to/repo, base branch main.` Staff then registers the job, plans it, and starts Seniors with `create_spawn_ticket` and its CLI's subagents.
- **Researchers:** add a persona on the Researchers page (name, focus, repository, model, effort). It has no process. Triglav routes questions, proposals, mentions, review rounds and Client decisions into its inbox and starts a short run when items are ready, holding back when the Codex usage window is nearly used up.
- **After a reboot or a usage limit:** the Client decisions page lists stopped Staff with a Resume button. Staff then restarts its Seniors.

### Local code review and the gate

Before a Senior pushes, it asks for a local code review (`request_code_review`). A panel of read-only reviewers reads the diff `base_sha..head_sha` and the repository, and the server merges their findings into a verdict. The Copilot loop comes after it.

- **The panel is your setting.** On Models, one strong seat (with an optional member count from 1 to 4, default 1: the same model run again as `strong`, `strong-2`, and so on) up to four cheap seats and lens seats, at most six seats in total, each a runtime (Claude Code or Codex), a model and an effort. The default is the strong seat on Codex (`gpt-6.1-sol`, high), one cheap seat (Claude `claude-sonnet-5-5`, low) and two lens seats, `lens-contracts` and `lens-integrity` (Claude `claude-haiku-5-5`, medium, shadow mode). A cheap Codex seat was left out of the default after the replay (no catches in five runs and 1 valid extra of 5); you can still add one. A CLI that is missing, or Codex at 90% of its window, moves its seats to the other CLI, every member on its own. Members are not dropped as twins of each other. `strong-2` and later read the files of the diff in their own order (a shuffle seeded by the seat name and the head sha, which the runner does itself), so a member never starts with the file git printed first; the content, the hunks of a file and the size limit are those of the diff git printed, and `strong`, the cheap seats and a panel with one strong member get that diff unchanged. Restart the runner after you update, because the order is built there. The page shows the expected input and output tokens of one review from the averages of finished seat runs.
- **Lens seats.** A lens seat gets every step of the shared prompt plus a specialist checklist after them: `contracts` (interfaces that another part consumes, and their consumers on both sides) or `integrity` (transactions, races, retries, partial writes, migrations and skipped limits). The repository's rules outrank the lens, and silence is the expected answer. Seats with different lenses are never dropped as twins. In shadow mode a lens seat's findings are stored and shown but never block, need no answer and are not listed in round 2; a failed shadow seat does not fail the review, and a review where no blocking seat finished fails. A lens seat whose model cannot run moves to Codex `gpt-6-luna` low when Codex is usable, else to Claude `claude-sonnet-5-5` low, and keeps its lens and shadow flag. Migration 045 adds `lens` and `shadow` to the seat runs and `shadow` to the findings.
- **The reviewers only read.** Claude runs with `--tools Read,Grep,Glob`, Codex with `-s read-only`, and both with every MCP server off, so a reviewer has no Triglav tool and no token. The runner computes the diff itself and posts the output back as data; the server parses it finding by finding.
- **The prompt follows Copilot's workflow** (`buildReviewPrompt` in `src/code-review.ts`). A reviewer starts from the diff and forms specific questions, then must search the repository for callers and sibling code paths and read only the ranges it needs. It checks the ticket, the acceptance criteria, the PR description claims (the Senior puts them in `notes`) and the repository's own rules (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`) against the diff, and covers null and empty values, error paths, races, stale state and escaping. It reports one finding per pattern with every site, and an empty list when the change is correct. The ticket, criteria and notes are data in the prompt.
- **The gate.** `submit_review_package` and `request_copilot_review` are refused unless a finished review of exactly that head sha has the verdict `ok`, in every review mode. One piece of work (the commits since the last pass) gets at most 3 rounds; a later round reviews only the fix delta, and a failed seat (other than a shadow seat) makes a failed review, which is never a pass and never a round.
- **The reviewed ranges of a job are one chain.** The first piece of a job must start at the merge base of the head with `origin/<the job's base branch>`, and a later piece at the last passing head (or, as a full re-review, at the current merge base). The server cannot run git, so the launch carries the base branch and the runner checks the merge base in the Senior's worktree. The runner never fetches: a missing `origin/<branch>`, another base, or a head that does not descend from the last passing head fails the seat with the reason.
- **Copilot rounds.** At most 3 per PR, asked with `request_copilot_review` and recorded with `record_copilot_result`; none after "Approval recommended" or a round with no P0-P2 finding that was not "Previously missed", and none after a small fix: round 2 and later need a fix of more than 50 lines and more than 25% of the PR (`fix_lines` and `pr_lines`, stored on the round), because Copilot re-reads the whole PR and the local gate already reviewed the fix. The server cannot run `gh` and Seniors still have it, so this is a bar, not a hard boundary, and the counts are the Senior's own report.
- **The review comment on the PR.** After the gate passes on a head, the Senior asks `get_review_comment` for the text and posts it once with `gh pr comment`, then edits that comment after later rounds. The text lists every finished or failed round of the job with its seats, cost and merged findings with the Senior's triage, is quoted so that reviewer text cannot render markup or mentions, and has no link outside GitHub. The server cannot run `gh`, so posting it is a bar, not a hard boundary.

## Security

Who can call what:

| Caller | Credential | Reaches |
| --- | --- | --- |
| The Client in the browser | The dashboard password; a session cookie (HttpOnly, SameSite=Strict, 30 days) | The dashboard API: every `/api/` route except the open ones below |
| Agents | `ORCH_ENROLLMENT_KEY` as a Bearer token | `/mcp` only |
| The host runner | `ORCH_RUNNER_KEY` as a Bearer token | `/api/runner/*` only. It also holds `ORCH_ENROLLMENT_KEY`, only to connect the Claude research runs it starts, and never passes it on |
| The Operator's Claude process | A token that belongs to one chat and to one process of it (only its hash is stored) | `/operator/mcp` only |
| The Client through an HTTPS reverse proxy (opt-in, off by default) | The dashboard password (16 characters or more); a `__Host-` session cookie (Secure, HttpOnly, SameSite=Strict, 7 days) that works only on that listener | Only the dashboard on the second port: its static files, the Client's `/api/` routes, `/api/login`, `/api/logout`, `/api/health`. See [Running behind an HTTPS reverse proxy](#running-behind-an-https-reverse-proxy) |
| Anyone on this machine | None | `/api/health`, `/api/hooks/stop` (needs an agent session token), `/api/usage/claude` (the status line posts plan usage; a caller can only fake those numbers), `/guide.md`, the static dashboard |

`scripts/set-password.ts` stores only a scrypt hash in `.env`. A login makes a random session id; the browser holds it in the cookie and the database holds only its SHA-256. Login compares in constant time and allows 5 wrong tries per 10 minutes for the whole server (all callers share one address behind Docker, so an agent that spams wrong passwords can lock you out for those 10 minutes). Every `/api/` route needs the Client session by default; a route is listed as open in `src/server.ts` only when it must work without a session, which is rare. The dashboard sends a Content-Security-Policy with `default-src 'self'`, and the Host and Origin checks stay.

**The limit.** Agents run as your OS user on this machine. They can read `.env`, your home directory and your browser's cookie store, and a user in the Docker group is effectively root. So these credentials raise the bar from "one `curl` call" to "deliberately stealing a secret"; they are not a hard boundary. A hard boundary needs agents under a separate OS user or in a sandbox, which is not built. The Operator can also read `.env` with its file tools. Setting a new password with `node scripts/set-password.ts` and restarting the server logs out every browser, because each session is tied to the password hash. A password has 8 to 1000 characters, and `set-password.ts` and the login use the same limits.

**The cookie goes to every localhost port.** Browsers scope a cookie to the host name, not to the port. The session cookie for `localhost` is therefore sent to any other server on `localhost`, on any port, that you open in the same browser. A program that listens on another local port can read it (`HttpOnly` stops page scripts, not a server that receives the request) and use it against the dashboard until you log out or change the password. `SameSite=Strict` and the Origin check do not help against that. Do not run other local servers that you do not trust while you are logged in, and log out when you are done. The cookie is not sent to other machines. The login limit counts attempts for the whole server, so any local process can lock the Client out for up to 10 minutes with wrong passwords. A session made on the local listener does not work on the public dashboard listener (and the other way round), so a cookie taken from `localhost` cannot be used through the reverse proxy.

## Running behind an HTTPS reverse proxy

Triglav can serve the dashboard to another machine through an HTTPS reverse proxy, for example when it runs on a VM. This is off by default. The server, the host runner and the agents still run on the same machine; only the dashboard is remote.

**Try an SSH tunnel or a VPN first.** `ssh -L 7400:127.0.0.1:7400 <host>` and then `http://localhost:7400` on your machine needs no change to Triglav, and nothing new is reachable from the internet. A VPN (for example WireGuard or Tailscale) is the next best choice.

**A remote Client session has full control of the host.** Whoever logs in to the dashboard can confirm Operator requests that run commands on the host, start Staff in any repository on the host, and direct agents that hold the host's GitHub token and shell. Putting the dashboard on the internet puts all of that behind one password. The rules below raise the bar for an attacker; they do not make the dashboard safe to expose without care.

**How it works.** When `ORCH_DASHBOARD_URL` is set, the server opens a second listener on `ORCH_DASHBOARD_PORT` (default 7410). Port 7400 stays as it is, for agents, the runner and local use.

- `ORCH_DASHBOARD_URL` is the https origin the proxy serves, for example `https://triglav.example.com`. It must start with `https://` and have no path, query, fragment or user info; otherwise the server does not start.
- The second listener serves only the dashboard: its static files, the Client's `/api/` routes, `/api/login`, `/api/logout` and `/api/health`. Every other route, including `/mcp`, `/operator/mcp`, `/api/runner/*`, `/api/hooks/stop`, `/api/usage/claude` and `/guide.md`, answers 404 there, whatever credential is sent.
- The Host header must equal the host of `ORCH_DASHBOARD_URL`, and every request other than GET needs an Origin header equal to its origin. The proxy must pass the Host header through unchanged.
- Login there needs a password of at least 16 characters (`node scripts/set-password.ts`). It has its own limit: 5 failed tries per client address and 30 in total per 10 minutes. The local listener keeps its own limit, so a lockout through the proxy never blocks a login over the SSH tunnel and never ends a session.
- The client address is the rightmost `X-Forwarded-For` entry, the one your proxy appended. Behind a CDN or a second proxy that entry is the CDN's address, so every visitor counts as the same client: 5 wrong tries through it make all of them wait 10 minutes. Log in over the SSH tunnel meanwhile.
- Sessions made there last 7 days, live in a `__Host-triglav_session` cookie (Secure, HttpOnly, SameSite=Strict) and work only on that listener. Responses carry `Strict-Transport-Security: max-age=31536000`.
- Each successful login there is recorded with its time and client address. The dashboard shows them under More, Security. If you see a login that was not you, set a new password and restart the server: that ends every session.
- `ORCH_PUBLIC_URL` stays a loopback URL: it is the address agents and the runner use (guide, MCP config). The server does not start when it points elsewhere.

**Set it up.**

1. Set a password of 16 characters or more: `node scripts/set-password.ts`.
2. In `.env`, set `ORCH_DASHBOARD_URL=https://triglav.example.com` (and `ORCH_DASHBOARD_PORT` if 7410 is taken).
3. In `docker-compose.yml`, uncomment the `ORCH_DASHBOARD_URL` and `ORCH_DASHBOARD_PORT` lines and the `127.0.0.1:7410:7410` port. Publish 7410 on loopback, or on the proxy's private network only, never on a public interface. Then `docker compose up -d --build`.
4. Point the proxy at `127.0.0.1:7410`. Keep the Host header, append to `X-Forwarded-For`, and keep the event stream working: no response buffering and a long read timeout.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name triglav.example.com;
    # ssl_certificate and ssl_certificate_key here
    location / {
        proxy_pass http://127.0.0.1:7410;
        # $http_host keeps the port when the URL has one; $host drops it and the Host check refuses the request.
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Caddy (by default it passes Host through, sets `X-Forwarded-For` to the client address and flushes event streams at once):

```
triglav.example.com {
    reverse_proxy 127.0.0.1:7410
}
```

**Add a layer in front.** Single sign-on (for example an identity-aware proxy), mutual TLS or an IP allow-list at the proxy stops most attackers before they reach the password. Triglav has one password and no accounts or second factor.

## Working on Triglav

AI coding agents working on this repository: read [AGENTS.md](AGENTS.md) (Claude Code loads it through `CLAUDE.md`).

### Test

Three layers. None of them touches the real stack's data. CI (`.github/workflows/ci.yml`) runs the first two on every pull request and every push to `main`; the browser tests stay a local check.

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
DATABASE_URL=... ORCH_ENROLLMENT_KEY=... ORCH_RUNNER_KEY=... ORCH_CLIENT_PASSWORD_HASH=... pnpm dev
```

Schema changes are numbered SQL files in `src/migrations/`, applied in order at start.

### Evaluating the review panel

`scripts/review-eval/` measures the local review panel against what Copilot found on Triglav's own pull requests (PRs 1, 3, 5, 6, 7, 8, 11 and 19, at the head of Copilot's first review; a stored baseline run exists for 3, 6 and 8). It is for working on the panel, by hand. CI does not run it and the Docker image does not contain it. [scripts/review-eval/README.md](scripts/review-eval/README.md) explains every option, the run manifest, the token budget (an admission stop, not a hard cap) and the scoring rules. [scripts/review-eval/DECISIONS.md](scripts/review-eval/DECISIONS.md) records the scope, the decisions and the open ones. The harness shows no review quality improvement and no Copilot parity by itself.

```bash
node scripts/review-eval/cli.ts list                 # the fixtures
node scripts/review-eval/cli.ts score                # score the stored baseline run (no tokens used)
node scripts/review-eval/cli.ts merge                # what mergeFindings makes of the stored seat output, and how many judged duplicates it keeps apart
node scripts/review-eval/cli.ts run --arm try1 --yes # run the panel on the dev fixtures: costs real tokens
node scripts/review-eval/cli.ts run --arm lean1 --prompt lean --yes  # same panel with the lean prompt
node scripts/review-eval/cli.ts run --arm prod1 --mode production --budget-tokens 5000000 --yes  # seats resolved as a real review resolves them, with an admission budget
node scripts/review-eval/cli.ts score --runs review-eval-out/try1 --judgments <file> --unjudged
```

`--prompt` picks the review prompt of an arm: `production` (the default, the text the runner gets from the server) or `lean`. The lean prompt is for the harness only (`scripts/review-eval/lean-prompt.ts`) and the server never sends it. It keeps the questions, repository rules, claims and verify-and-group steps, and it limits the search step to what the diff cannot answer, with a stop after about 15 commands. The task section with the ticket and PR text, marked as data, is the same text as in production. The stored run records which prompt it used, and a rerun of an arm refuses to start when a fixture it already finished used another prompt. Production keeps its own text until numbers from this comparison favour the lean one. Use a new arm name for each run, and remember that one run per seat is a small sample.

`run` starts the same reviewers as the host runner (same prompt unless `--prompt` says otherwise, diff, command and environment, built by the production functions) in detached worktrees under `review-eval-out/`, which is ignored by git. It refuses to start when `CI` is set and does not check the plan limits of Codex or Claude. The fixtures, the stored baseline run and its judgments are in `test/fixtures/review-eval/`. A fixture holds the shas and, for each Copilot finding, the file, line, round, severity and a short label in our own words. A new run has no judgments, so every finding shows as unjudged until someone reads it and writes a judgments file. One run per seat is a small sample: do not read a difference of one or two findings as a result.

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
| `src/worktrees.ts` | The Seniors' worktrees per job, the `reap_worktree` launches that remove a finished job's worktree, the host disk report and the low-disk stop for new Seniors |
| `src/guide/deliver.md` | The Copilot review loop a Senior runs with `gh` (served with the Senior card), and the review modes: auto, copilot required, CI only |
| `src/blockers.ts` | Blockers, the Client decision queue, researcher advice on decisions |
| `src/research.ts` | Researcher personas, inbox routing, the run dispatcher, the Codex budget guard |
| `web/src/user-guide.md` | The user guide on the dashboard's Guide page (the agents' guide is `src/guide/`, served at `/guide.md`) |
| `src/chat.ts` | The Operator's chats: messages, the commands the runner takes, events from its process |
| `src/operator.ts` | The Operator's read-only MCP tools, served at `/operator/mcp` |
| `scripts/operator.ts` | The host side: builds the `claude` command, runs one process per chat, translates its stream |
| `src/codex-args.ts` | The Codex settings per role (Staff access, researcher read-only), shared by the server, the runner and the dashboard |
| `src/telemetry.ts` | Reads agent CLI transcripts: tokens, activity, PRs, resumable sessions, launches for the runner |
| `src/models.ts` | Model and effort per role |
| `src/code-review.ts` | Local code review: seats, the reviewer prompt, reviewer output parsing, merged findings, verdict, the three agent tools' logic |
| `src/review-gate.ts` | The review gate: local rounds of a piece of work, `gateAt`, round grants, Copilot rounds (`request_copilot_review`, `record_copilot_result`) |
| `src/scheduler.ts` | Deadlines, lease expiry, unavailable Staff, Linear refresh, research dispatch, run timeouts |
| `src/events.ts` | Event log, cursors, waiting, which events wake Staff |
| `src/mcp.ts` | MCP tools for agents |
| `src/server.ts` | HTTP: MCP endpoint, dashboard API, runner API, SSE, static files; who may call what; the opt-in public dashboard listener |
| `src/client-auth.ts` | The Client's password hash, sessions (local and public scope), the login rate limits and the public login record |
| `src/config.ts` | The credentials the server needs before it starts, and the listener settings (`ORCH_PUBLIC_URL`, `ORCH_DASHBOARD_URL`, `ORCH_DASHBOARD_PORT`) |
| `src/guide/` | Agent instructions, one card per role |
| `src/migrations/` | Database schema |
| `web/` | React dashboard |
| `e2e/` | Playwright tests and the scripted agent (`sim.ts`) |
| `scripts/runner.ts` | Host runner: resumes, Staff starts and short runs |
| `scripts/research-run.ts` | The Claude research command (`--tools`, `--strict-mcp-config`) and the Codex MCP servers to switch off |
| `scripts/worktree-reap.ts` | Removes a finished job's worktree for the runner, only when it is a linked worktree with nothing uncommitted, untracked or unpushed |
| `scripts/code-review-run.ts` | The read-only reviewer command for Claude and Codex, the diff of a worktree between two shas, and the merge-base check of the first review of a piece |
| `scripts/review-rules.ts` | The repository rules of a review seat, read with git at the merge base of the change (never from the worktree files), with their own budget, for the seat's prompt |
| `scripts/review-eval/` | The review panel evaluation harness (by hand, not in CI or the image): fixtures of Triglav PRs with Copilot's findings, a pure scorer, and a live run with the production reviewer commands. Data in `test/fixtures/review-eval/` |
| `scripts/private-file.ts` | A 0600 file in a 0700 directory for a config that holds a credential, removed when the process ends, when the runner stops, or by a sweep of old ones at runner start |
| `scripts/runtimes.ts` | Looks for the `claude` and `codex` CLIs on this machine |
| `scripts/staff-start.ts` | The Staff start command and prompt, checked and built in one place for the runner and its tests |
| `scripts/set-password.ts` | Sets the dashboard password (writes its hash to `.env`) |
| `scripts/setup.ts` | First-time `.env`: fills the empty keys with random values, then runs `set-password.ts` when no password is set |
| `scripts/loopback.ts` | The rule that `ORCH_URL` is an http loopback URL, and the direct request the runner uses |
| `scripts/operator-host-mcp.ts`, `scripts/operator-host-tools.ts` | The Operator's host commands as fixed-argument MCP tools |
| `scripts/stop-hook.sh` | Claude Code Stop and SubagentStop hook for agents that own open work |
| `scripts/live-check.ts` | Live check with real agent CLIs (old researcher loop) |

## License

Triglav is source-available under the Business Source License 1.1 (see [LICENSE](LICENSE)). It is free to use for your own purposes or for the internal purposes of your organization. You may not offer it, or a product or service built mainly on it, to others as a hosted service, a managed service or a redistributed product. It is not open source. Each version becomes available under GPL-2.0-or-later on 2030-10-12, or four years after its first public release, whichever comes first. For other arrangements, open an issue.
