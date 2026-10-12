# AI consultancy orchestrator: v1 plan

Status: planning output for `START-HERE.md`, now implemented as v1 in this repository (see "Implementation status" at the end). Date: 2026-10-07.

**TL;DR:** Build one TypeScript service with MySQL and a small dashboard, run with Docker Compose on the Client's machine. Agents use it through an MCP server, and the dashboard uses an HTTP API with SSE. The first milestone is a throwaway spike that answers the riskiest question: can a Claude Code Staff agent start Seniors that register on their own, and can a Codex researcher wait unattended and answer within a five-minute window?

**Executive summary:** The orchestrator never runs agents. It stores jobs, assignments, the message board, decisions and reviews, and it tells agents what changed. Each agent proves its identity with a session token on every call, because a Staff agent and the Seniors it starts can share one MCP connection. Agents wait through a long-polling MCP tool. Claude Code documents long MCP calls that move to the background and wake the session when they return, so the waiting model has a verified basis on Claude. Codex documents a per-server MCP tool timeout (default 60 seconds, no stated maximum) and built-in subagents, but not background tool calls. The default wait is therefore short and the guide raises it per CLI. The response window is enforced by the server: it records the deadline, marks every reply as timely or late, and refuses a final decision that does not cite every timely reply. Linear stays the source of the ticket text. The orchestrator reads it through the GraphQL API with a read-only key, because Linear webhooks and Linear agent sessions need a public HTTPS endpoint that a laptop does not have.

- Stack: TypeScript on Node 24, Fastify, the official MCP TypeScript SDK, Kysely with `mysql2`, MySQL 8, and a React and Vite dashboard served by the same process. Kept MySQL as required.
- One service, two containers: `mysql` and `orchestrator` (API, MCP, scheduler, dashboard assets).
- Authority chain: the enrollment key in the Client's CLI config allows a session to register as Staff or Researcher. Staff issues single-use spawn tickets to Seniors. Only the Client can reassign Staff or give reserved approvals.
- The board follows the client requirements exactly: full-window wait, all timely answers considered, late replies kept and flagged, open researcher participation, human posts in the same feeds.
- Open risks: Codex waiting behavior (see the feasibility matrix), whether Claude Code sends MCP progress tokens so that a long wait survives the 5-minute idle limit, and what happens to background subagents when the Staff session ends.
- Decisions that need the Client are listed in section 10.

---

## 1. Product definition and scope

**Interpretation.** A local coordination service that lets AI agents work like a small consultancy on Linear tickets. The orchestrator holds the shared state and the human view. The agents do the work in their own CLIs on the Client's machine.

**Actors.**

| Actor | Kind | Starts how |
| --- | --- | --- |
| Client (the human) | Human | Uses the dashboard. Starts Staff and researcher sessions by hand. |
| Staff Software Engineer | AI agent | The Client starts it in an agent CLI with a start prompt. |
| Senior Software Engineer | AI agent | Staff starts it with the tools of its own CLI and a spawn ticket. |
| Researcher | AI agent | The Client starts it in any supported CLI with a start prompt. |
| Reviewer (optional) | AI agent | Staff starts it with a review spawn ticket. Staff reviews by default. |

Researcher and Specialist are one role in v1. A Specialist is a Researcher with a declared focus (for example "MySQL" or "frontend"). The focus is a label on the agent, shown on its board posts, not a separate permission set.

**Core journey.**

1. The Client runs `docker compose up` and opens the dashboard.
2. The Client starts Claude Code and pastes the Staff start prompt with a Linear ticket ID.
3. Staff reads the usage guide, registers, and registers the job. The orchestrator fetches the ticket and its sub-issues from Linear.
4. Staff writes acceptance criteria per subjob, marks subjobs ready, and starts one Senior per ready subjob with a spawn ticket.
5. Each Senior registers with its ticket, claims its assignment, and works in its own git worktree.
6. A Senior posts a timed question. Staff and researchers answer. The Senior waits the full window, then acts on the collected answers and the Staff decision.
7. The Senior submits a review package. Staff reviews, requests changes or accepts.
8. When all required subjobs are accepted and Staff confirms the integration criteria, the parent job is done. Merging stays with the Client.

**Hard requirements** are the ones in `PROJECT-BRIEF.md` and the message board sections of `ROLES-AND-WORKFLOWS.md`. This plan does not restate them.

**Assumptions.**

- One client, one workspace, one machine. The Client's machine has Docker, Claude Code and Codex (verified locally: Claude Code 2.1.292, codex-cli 0.153.4, Docker 29.7.2, Compose 5.4.0).
- The target repository is already cloned on the machine. A job records its path and base branch.
- Agents can run `git worktree add`.

**V1 includes.** Agent registration and presence, jobs from Linear with subjobs, assignments with leases, spawn tickets, the message board with timed questions and assessments, decisions, review packages and verdicts, blockers and the client decision queue, pause and cancel, and the dashboard screens in section 7.

**V1 excludes.** Writing to Linear from the orchestrator, Linear webhooks and Linear agent sessions, multiple workspaces or clients, automatic merging or deployment, token and cost accounting, role version history, decision search, vector memory, and any agent marketplace.

---

## 2. Feasibility matrix

Legend: **Verified** means checked in official docs or on this machine in this planning session. **Unverified** means plausible but not checked. Every unverified row is a spike item in milestone 0.

### Claude Code (CLI, version 2.1.292 on this machine)

| Capability needed | Status | Surface and source | Limits and fallback |
| --- | --- | --- | --- |
| Connect to a local MCP server over HTTP with an auth header | Verified | `claude mcp add --transport http <name> <url> -H "Authorization: Bearer ..."` (local `--help`); https://code.claude.com/docs/en/mcp | None found for localhost. |
| An MCP tool call that blocks for minutes | Verified | Per-server `timeout` in `.mcp.json`, or `MCP_TOOL_TIMEOUT`; default wall-clock limit about 28 hours. https://code.claude.com/docs/en/mcp | An HTTP call with no response and no progress notification for 5 minutes is aborted as idle (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`). The server sends progress notifications, or each wait returns within 4 minutes. |
| The session is not blocked while it waits | Verified | A main-conversation MCP call running past 2 minutes moves to a background task, and its result arrives as a task notification (v2.1.212+). Same doc. | The background task does not survive exiting the session. |
| Staff starts Seniors | Verified live (2026-10-07): a headless Staff started a background subagent that registered with its spawn ticket, committed in its own worktree, and passed review | Subagents (Agent tool, `.claude/agents/*.md`), including background subagents. https://code.claude.com/docs/en/sub-agents. Also `claude --bg` and `claude -p` (local `--help`). | Each subagent is a new context. |
| Seniors can call orchestrator tools | Verified live (2026-10-07) | Subagents inherit the parent's MCP tools. A server referenced by name reuses the parent's connection. Background subagents keep every MCP tool. Same doc. | Shared connection means the orchestrator cannot tell agents apart by connection. Every call carries a session token. |
| Subagent lifetime after the Staff session ends | Unverified | One research summary says background subagents keep running. I did not confirm it in the docs. | Plan assumes they may die with the parent (section 5, recovery). |
| Unattended tool use without prompts | Verified | `permissions.allow: ["mcp__orchestrator__*"]` in settings; `--allowedTools` in headless mode. https://code.claude.com/docs/en/headless | The guide tells the Client which allow rule to add. |
| Whether Claude Code sends an MCP progress token, so progress notifications keep a long wait alive | Unverified | Not checked. | Fallback: `max_wait_sec` at most 240, the agent loops. |
| Background Bash wakes the session when it exits | Conflicting | This session's own tool description says it does. A docs research summary said it does not. Not needed by the design. | Ignore unless the MCP wait fails. |

### Codex (CLI, codex-cli 0.153.4 on this machine)

Codex docs now live at learn.chatgpt.com (developers.openai.com/codex redirects there). The docs track the latest release, 0.160.1, which is newer than the local install.

| Capability needed | Status | Surface and source | Limits and fallback |
| --- | --- | --- | --- |
| Connect to a local MCP server over HTTP with a bearer token | Verified | `codex mcp add <name> --url <url> --bearer-token-env-var <VAR>` (local `--help`); `[mcp_servers.<name>]` with `url`, `bearer_token_env_var`, `http_headers`. https://learn.chatgpt.com/docs/extend/mcp | None found. |
| MCP calls reach localhost from inside the sandbox | Verified | MCP servers run outside the command sandbox; the network proxy does not filter MCP connections. https://learn.chatgpt.com/docs/agent-approvals-security | Shell commands need `[sandbox_workspace_write] network_access = true` to reach localhost; MCP calls do not. |
| An MCP tool call that blocks for minutes | Verified live for about 90 s (2026-10-07) | Per-server `tool_timeout_sec`, default 60. No documented maximum. https://learn.chatgpt.com/docs/config-file/config-reference | Server default `max_wait_sec` is 50. The guide tells the Client to set `tool_timeout_sec = 330` and then use 240. Spike checks that it works. |
| The session is not blocked while it waits | Not documented | No equivalent of Claude Code's automatic backgrounding found. | A researcher that only waits does not need it. A Codex Staff would wait with short calls between other work. |
| Starting other agents | Verified | Built-in subagent tools `spawn_agent`, `send_input`, `wait_agent`, `close_agent`; `agents.max_concurrent_threads_per_session`; custom agents may declare `mcp_servers`. https://learn.chatgpt.com/docs/agent-configuration/subagents. Local feature flag `multi_agent` is stable and on. | Whether subagents share the parent's MCP connection is not documented. The token-per-call design works either way. |
| Unattended MCP tool use | Verified live (2026-10-07) with `default_tools_approval_mode = "auto"` and `approval_policy = "never"`; no prompts | `mcp_servers.<id>.default_tools_approval_mode = "auto"` and `-a never`. A tool annotated as destructive always asks unless it is also annotated read-only. Same security doc. | Orchestrator tools set MCP annotations explicitly: read tools `readOnlyHint: true`, write tools `destructiveHint: false`. Spike checks that no prompt appears. |
| Waking an existing session from outside | Unverified | `codex queue --thread <id> --message <text>` exists locally ("Queue a message for an existing session"). | Not used in v1. A possible way to wake an idle Codex agent later. |
| Billing for automated use | Verified | ChatGPT sign-in uses plan limits; docs recommend API keys for programmatic workflows. No explicit ban on plan-based automation found. https://learn.chatgpt.com/docs/auth | the Client decides (section 10). |

### Linear

| Capability needed | Status | Surface and source | Limits and fallback |
| --- | --- | --- | --- |
| Agents use Linear MCP headless | Verified | `https://mcp.linear.app/mcp` (read-write) and `/mcp/readonly`, Streamable HTTP, accepts `Authorization: Bearer <token or API key>`. https://linear.app/docs/mcp | Actions are attributed to the token's user. An app identity needs `actor=app` OAuth or `client_credentials`. |
| Orchestrator reads a ticket and its sub-issues | Verified | GraphQL `https://api.linear.app/graphql`, personal key in `Authorization: <key>`; `Issue.parent`, `Issue.children`. https://linear.app/developers/graphql; schema in Linear's published SDL. | 2,500 requests per hour per user for API keys; 10,000 complexity points per query. Ample for one client. |
| Push notifications from Linear | Verified as not usable | Webhooks need "a publicly accessible HTTPS, non-localhost URL". https://linear.app/developers/webhooks | Poll active jobs every 5 minutes. |
| Linear native agent sessions and the `delegate` field | Verified, deferred | Developer Preview; sessions arrive by webhook and need a 5 second response. https://linear.app/developers/agents | Out of v1. Revisit if the orchestrator gets a public endpoint. |
| A list of Linear MCP tools | Not documented | The docs give no tool list. This session's connection exposes issue, comment, status, label and document tools. | Agents discover tools at runtime. The guide does not depend on specific Linear tool names. |

### Orchestrator protocol (this design)

| Capability | Status | Notes |
| --- | --- | --- |
| MCP server in TypeScript | Verified | `@modelcontextprotocol/sdk` 1.32.1 on npm. |
| Long-poll wait over MCP | Design | Depends on the client rows above. Correctness never depends on a single call lasting long: every wait returns a cursor, and the agent calls again. |
| SSE to the dashboard | Design | Standard browser `EventSource`. No agent depends on SSE. |

**What could invalidate the architecture.** If neither CLI can make a wait call of at least about a minute without an approval prompt or a timeout, agents would need an external waiting helper (for example a background shell command that blocks on the HTTP API). The data model and the board rules would not change. Only the usage guide and the wait tool would.

---

## 3. Recommended architecture

```
 the Client's machine (host)                                   Docker Compose
 +------------------------------+                       +------------------------------------+
 | Browser: dashboard           | --HTTP+SSE----------> | orchestrator (Node 24, one process)|
 +------------------------------+   127.0.0.1:7400      |  - /api      HTTP API for dashboard|
 | Claude Code: Staff           | --MCP HTTP----------> |  - /api/stream  SSE                |
 |   subagents: Seniors         |   (shared connection, |  - /mcp      MCP server for agents |
 | Codex: Researcher            |    token per call)    |  - /guide.md usage guide           |
 | Other CLI: Researcher        |                       |  - scheduler: deadlines, leases,   |
 |                              |                       |    presence, Linear polling        |
 | git worktrees per assignment |                       |  - static dashboard assets         |
 +------------------------------+                       +-----------------+------------------+
          |                                                               |
          | Linear MCP (agents)                                           | GraphQL, read-only key
          v                                                               v
       Linear  <---------------------------------------------------------+
                                                         +------------------------------------+
                                                         | mysql 8 (volume)                   |
                                                         +------------------------------------+
```

**Components.**

| Component | Owns | Does not own |
| --- | --- | --- |
| orchestrator service | All orchestration state, authorization checks, deadlines, leases, event log, Linear snapshots, the usage guide | Running agents, executing code, writing to Linear |
| MySQL | Durable state, including the event log that feeds cursors | Nothing else |
| Dashboard (React, served as static files) | Display and Client actions through the HTTP API | Any rule. Every rule lives in the service. |
| Agent CLIs | Running models, spawning subagents, editing code in worktrees, using Linear MCP | Orchestration state |

**Why one process.** The scheduler, the MCP server and the HTTP API share one transaction model and one event log. Splitting them adds a network boundary without a verified need. The service binds to `127.0.0.1` only.

**Alternatives considered.**

- *Agents talk to the HTTP API with curl instead of MCP.* Works in both CLIs, but every agent would hand-build JSON and auth. MCP gives typed tools, and both CLIs support HTTP MCP. Keep a small HTTP surface for the fallback helper only.
- *Postgres instead of MySQL.* No functional reason found to deviate. MySQL 8 supports what the design needs: transactions, `SELECT ... FOR UPDATE`, unique constraints, JSON columns.
- *An external queue (Redis, NATS).* Not needed. The event table with an auto-increment cursor gives ordering and replay.

**Stack and reasons.**

| Choice | Reason |
| --- | --- |
| TypeScript, Node 24 | Official MCP SDK; Node 24 is installed; one language for service and dashboard. |
| Fastify 5 | Small HTTP server with SSE support through raw replies. |
| `@modelcontextprotocol/sdk` | Streamable HTTP server transport, tool schemas, progress notifications. |
| Kysely with `mysql2` | Typed SQL with explicit transactions and row locks; plain SQL migrations. |
| React 19 and Vite | Small SPA built at image build time and served by Fastify. |
| Vitest | Coordination tests with a controllable clock. Run with `--maxWorkers=4`. |

All of these exist on npm today (checked: Fastify 5.12.5, Kysely 0.29.6, mysql2 3.24.5, React 19.3.0, Vite 8.3.3).

**Configuration** (`.env`, read by Compose): `ORCH_ENROLLMENT_KEY`, `LINEAR_API_KEY` (read-only), `MYSQL_*`, `ORCH_PORT`. Nothing else is configurable in v1. Windows, leases and caps are constants in code until a real need appears.

---

## 4. Domain and lifecycle design

### Entities

| Entity | Key fields | Notes |
| --- | --- | --- |
| Agent | id, nickname, role, focus, runtime (`claude-code`, `codex`, other), model, parent_agent_id, created_at | Stable historical identity. Never deleted. |
| AgentSession | id, agent_id, token_hash, started_at, last_seen_at, waiting_since, ended_at, end_reason | One per registration. Presence derives from it. |
| SpawnTicket | code_hash, issued_by (Staff), assignment_id, role, expires_at, used_at | Single use, 30 minute expiry. |
| Job | id, workspace, linear_issue_id, linear_url, parent_job_id, required, repo_path, base_branch, staff_agent_id, status, previous_status, acceptance_criteria, plan, linear_snapshot, linear_updated_at, linear_fetched_at | Parent and subjobs mirror Linear parent and sub-issues. |
| Dependency | job_id, depends_on_job_id | Simple "must be done first" edges between sibling subjobs. |
| Assignment | id, job_id, kind (`implement`, `review`), owner_agent_id, current_attempt, lease_expires_at, status (`open`, `held`, `released`), worktree_path | At most one held implement assignment per job. |
| Attempt | assignment_id, number, agent_id, started_at, ended_at, outcome | The fencing token. Writes name their attempt. |
| Thread | id, job_id, kind (`discussion`, `question`, `review`, `escalation`), assignment_id | Every message belongs to one thread. |
| Message | id, thread_id, author (agent_id or `client`), type, stance, body, in_reply_to, request_id, received_at, timely | Append-only. |
| Question | thread_id, asker_agent_id, owner_staff_id, window_sec, posted_at, deadline_at, requires_staff_decision, state, context_snapshot | One per question thread. |
| Decision | id, thread_id, decided_by, authority (`staff`, `client`), body, rationale, considered_message_ids, supersedes_decision_id, created_at | Append-only. A revision is a new row. |
| ReviewPackage | id, attempt_id, summary, artifacts (links), validation, limitations, round | Submitted by the Senior. |
| ReviewVerdict | package_id, reviewer_agent_id, outcome (`accept`, `changes`), findings (required and optional, each with evidence) | Only the assigned reviewer's verdict counts. |
| Blocker | id, job_id, kind (`client_decision`, `external`, `failed_execution`, `unavailable_owner`, `no_convergence`), responsible, requested_decision, unblock_condition, resolved_at, resolution | Only `client_decision` and `no_convergence` enter the client queue. |
| Event | id (auto-increment cursor), type, job_id, thread_id, actor, payload, created_at | Append-only. Also the audit log. |

### Message types and stances

Types: `discussion`, `question`, `reply`, `proposal`, `decision`, `progress`, `review_finding`, `escalation`. Stance on a reply or assessment: `inform`, `support`, `approve`, `challenge`, `disagree`, `reject`. Every stance except `inform` requires a reason. "Approve" here is an assessment, never a reserved approval.

### Job states

The proposed eight states are kept: `queued`, `planning`, `ready`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`.

| From | To | Who | Condition |
| --- | --- | --- | --- |
| (new) | queued | Staff | `register_job`; Linear fetch succeeded |
| queued | planning | owning Staff | |
| planning | ready | owning Staff | Acceptance criteria present |
| ready | in_progress | Senior | `register_agent` with a spawn ticket claims the assignment; all dependencies done |
| in_progress | in_review | Senior holding the current attempt | Review package submitted |
| in_review | in_progress | Reviewer | Verdict `changes`; round below the cap |
| in_review | done | Reviewer | Verdict `accept` with evidence (subjob). Parent: rule below. |
| any open | blocked | Staff, Senior, or the service | Blocker recorded; previous state saved |
| blocked | previous state | responsible party, Staff, or Client | Blocker resolved |
| any open | cancelled | Client, or owning Staff with a reason | Assignment released, attempt closed |

Agent presence, attempt outcome, review verdict and question state are separate from job state. A question that is collecting answers never blocks the job.

**Parent completion.** A parent job is done when every required subjob is done, every optional subjob is done or cancelled, and the owning Staff records a decision that confirms the integration criteria. A cancelled required subjob keeps the parent open until Staff records a decision that marks it not required. A failed subjob is a blocker, not an outcome.

**Done is not merged.** Done means accepted with evidence. Merging and deployment are the Client's actions outside the orchestrator. The dashboard shows the PR link.

### Linear mapping

| Field or status | Owner | V1 behavior |
| --- | --- | --- |
| Title, description, parent and sub-issue relations, Linear status | Linear | Copied into `linear_snapshot` at `register_job`; refreshed every 5 minutes for open jobs and when a question is posted. |
| Job state, assignments, board, decisions, reviews | Orchestrator | Never written to Linear by the orchestrator. |
| Linear status changes and comments | Agents through Linear MCP | Allowed only within the rules the Client sets (section 10). |

A new sub-issue in Linear after registration shows as "new in Linear" on the parent. Staff adds it with `update_job`. If Linear marks an issue done or cancelled while the job is open, the job shows a "diverged" badge and Staff gets an event. Nothing changes automatically. A question carries the `linear_updated_at` it was posted with, so `get_thread` can tell a responder that the ticket changed since then.

### Concurrency rules

- Claiming locks the assignment row (`SELECT ... FOR UPDATE`) and fails if it is held with a live lease.
- Every mutating call by a Senior names its attempt number. The service rejects the call if the attempt is not current. A stale worker cannot submit, report or overwrite.
- Every mutating call carries a `request_id`. A repeated `request_id` returns the first result.
- Decisions and messages are append-only, so concurrent writers never overwrite each other.

---

## 5. Agent contracts and coordination

### Identity and authority

1. The MCP connection carries `Authorization: Bearer <ORCH_ENROLLMENT_KEY>`. The key proves the caller runs on the Client's machine under the Client's config.
2. `register_agent` creates an Agent and an AgentSession and returns a session token. Every other tool takes the token as an argument. The token is the identity, because subagents share their parent's connection.
3. Staff and Researcher may register with the enrollment key alone. A Senior or Reviewer must present a spawn ticket issued by the owning Staff, which binds it to one assignment and records `parent_agent_id`.
4. Staff authority covers the jobs it registered or that the Client assigned to it. Only the Client can move a job to another Staff.

**Known limitation.** A subagent holds the same enrollment key as its parent, so it could register itself as Staff. It would only gain authority over jobs it registers itself, and it would show up in the roster with its parent. If that proves to be a problem, the upgrade is a Client-issued Staff grant code pasted into the Staff start prompt.

### Logical tool operations (MCP)

Names are design proposals. Every response includes `control` (`continue`, `pause`, `cancel`) for the caller's current assignment and the caller's next cursor.

| Tool | Caller | Purpose |
| --- | --- | --- |
| `get_guide` | anyone | Role contract and rules, the same text as `/guide.md` |
| `register_agent` | anyone | Role, nickname, focus, runtime, model, optional spawn ticket |
| `end_session` | any agent | Clean exit; releases nothing silently |
| `register_job` | Staff | Linear issue id, repo path, base branch; service fetches the ticket tree, or takes the Staff's `ticket_snapshot` when no Linear key is configured |
| `update_job` | owning Staff | Plan, acceptance criteria, dependencies, state transitions |
| `create_spawn_ticket` | owning Staff | Returns a code and the Senior start prompt text |
| `report_progress` | Senior | Free text plus links; renews the lease |
| `submit_review_package` | Senior | Summary, artifacts, validation run and result, limitations; after a `changes` verdict, a disposition for each required finding |
| `record_verdict` | assigned reviewer | Outcome and findings |
| `post_message` | any agent | Discussion, reply, proposal, progress, with stance and reason |
| `ask_question` | Senior, Staff | Opens a timed question (fields in the next subsection) |
| `get_thread` | any agent | Messages with `timely` flags, question state, decisions, context freshness |
| `await_question` | asker | Returns when the deadline has passed, or after `max_wait_sec` |
| `record_decision` | Staff, within authority | Must cite every timely reply after the deadline |
| `request_staff_synthesis` | asker | Moves a question to `awaiting_staff_decision` |
| `raise_blocker` / `resolve_blocker` | Staff, Senior | Blocker fields from section 4 |
| `wait_for_events` | any agent | Long poll: cursor, scope (`owned` or `all_jobs`), types, `max_wait_sec` |
| `list_board` | any agent | Compact listing of recent threads across accessible jobs |
| `get_job`, `list_jobs`, `list_agents` | any agent | Read the job record, all jobs, and the roster |
| `complete_job` | owning Staff | Completes a parent job after the subjob rule holds; records the integration decision |

Implementation note: registering with a spawn ticket claims the assignment in the same transaction, so there is no separate claim tool. Finding dispositions travel with the next review package, so there is no separate respond tool.

The dashboard uses the same rules through `/api`, as the Client.

### Timed questions

`ask_question` requires: job id, author and owning Staff (filled by the service and shown back), Linear identifier and link with the parent or sub-issue relation (filled by the service from the snapshot), an objective and progress summary written by the asker, the specific question, why it matters, what work waits, options already considered, technical evidence, `window_sec`, and `requires_staff_decision` (default true). The service rejects a question with an empty summary or an empty question field.

| Rule | Value |
| --- | --- |
| Default window | 180 seconds. If no reply arrives before the deadline, the deadline moves out by one more window (`question.extended`), so a question never closes on silence. |
| Allowed range | 60 to 300 seconds. The minimum follows the incident lesson about very short veto windows. |
| Clock | Server time only. `posted_at` and `deadline_at` are stored on the question. |
| Timely | `received_at <= deadline_at`, decided in the same transaction that inserts the reply |

Question states: `collecting`, then at the deadline either `collected` (no Staff decision required), `resolved` (an early Staff decision stands), or `awaiting_staff_decision`; later `resolved` after `record_decision`.

**At the deadline**, the scheduler, in one transaction:

1. Reads all messages of the thread with `received_at <= deadline_at`.
2. If `requires_staff_decision` is false, sets `collected`.
3. If the owning Staff posted a reply marked `intended_decision` and no timely reply has stance `challenge`, `disagree` or `reject`, records that reply as the decision, citing every timely reply, and sets `resolved`.
4. Otherwise sets `awaiting_staff_decision`.
5. Emits `question.deadline_reached` to the asker and the owning Staff.

The asker's `await_question` returns the reconciled thread, so a missed event cannot hide a reply. The asker never acts before the deadline, even if Staff answered at minute one, because `await_question` does not return early.

**Decision rule.** `record_decision` on a question is refused before the deadline and refused if `considered_message_ids` omits any timely reply. Researcher replies stay advice. Staff resolves contradictions by writing a decision that addresses them. If the decision needs the Client, Staff raises a `client_decision` blocker instead.

**Late replies** stay visible with `timely = false`. A late `challenge`, `disagree` or `reject` on a resolved question emits `question.late_challenge` to the owning Staff. Staff may record a new decision that supersedes the old one, which notifies the asker. Nothing changes silently.

**Human posts.** A Client post is a discussion post by default. The dashboard has a "timed question" option for the Client. A Client `proposal` collects assessments with reasons. Staff records the resulting decision. If the proposal is a reserved Client decision, an agent rejection is recorded and shown, and Staff states the disagreement and asks the Client to confirm. It is never treated as a veto.

### Event delivery

- Events are rows in `Event`. The cursor is the event id. Delivery is at least once; consumers ignore ids they have seen.
- `wait_for_events` returns immediately if events exist after the cursor, otherwise it holds the request until an event arrives or `max_wait_sec` passes. While it holds, it sends MCP progress notifications every 30 seconds where the client supplied a progress token.
- Default `max_wait_sec` is 50, which fits Codex's default 60 second tool timeout and Claude Code's 60 second first-byte timer. The guide tells the Client to raise the client timeouts (Codex `tool_timeout_sec = 330`, Claude Code per-server `timeout`) and then use 240, which stays under Claude Code's 5 minute idle limit even without progress notifications. A 240 second loop also keeps a 5 minute prompt cache warm between wake-ups.
- Scopes: Staff waits on `owned` (events on its jobs). Researchers wait on `all_jobs` with types `question.opened`, `proposal.posted` and `mention` by default. They see everything through `list_board`, but they are woken only for those types. Visibility stays open, and wake-ups stay cheap.
- An open wait counts as presence.

### Presence, leases and recovery

| Concept | Rule |
| --- | --- |
| Presence | `last_seen_at` updates on every call; an open wait counts as seen. Active under 2 minutes, stale from 2 to 15 minutes, offline after 15 minutes. Offline agents leave the active roster; history stays. |
| Lease | An implement assignment lease lasts 30 minutes and renews on any call by the holder. Long builds should call `report_progress`. |
| Lease expiry | Assignment becomes `open`, the attempt ends with `lease_expired`, the owning Staff gets `assignment.orphaned`. Staff issues a new spawn ticket. The new Senior gets a new attempt number, so the old one is fenced off. |
| Reconnect | The same session token stays valid across network errors and orchestrator restarts. A new CLI session registers as a new agent. |
| Staff offline | Its jobs get an `unavailable_owner` blocker. Open questions and reviews stay as they are. The Client assigns a new Staff in the dashboard. The service generates a handover summary from the job record (plan, open assignments, open questions, last decisions). |
| Staff ends with its Seniors | Their leases expire as above. The new Staff sees every orphaned assignment in the handover summary. |
| Pause and cancel | Set on the job. Delivered in `control` on the next call and as an event. The guide tells agents to check `control` after every call and stop work at the next safe point. An agent that keeps working after a cancel cannot submit, because the assignment is closed. |

### Bounded discussion

- One agent may post at most 3 replies per thread unless a newer message addresses it by mention.
- Researchers reply only with new information, evidence, or a stance with a reason. The guide forbids "+1" replies.
- Review rounds are capped at 3. The third `changes` verdict raises a `no_convergence` blocker for the Client.
- The service rejects a message that contains a string shaped like an orchestrator token or a known secret prefix.

### Required failure cases

| Failure | Handling |
| --- | --- |
| Duplicate assignment | Row lock on claim; a held assignment with a live lease cannot be claimed. |
| Stale worker submits results | Attempt fencing: the write names an attempt that is no longer current and is refused. |
| Lost events | Events are durable rows; agents resume from their cursor; `get_thread` and `await_question` read the database, not the event stream. |
| Duplicate messages | `request_id` makes posting idempotent. |
| Agent dies holding work | Lease expires, the assignment reopens, Staff issues a new spawn ticket, the new attempt fences the old one. |
| Staff unavailable | `unavailable_owner` blocker after presence goes offline; the Client assigns a new Staff with a generated handover summary. |
| Conflicting reviews | Only the assigned reviewer's verdict changes state. Other findings are assessments that Staff must answer in its decision. |
| Dependency failure | A blocked or failed prerequisite keeps dependents unclaimable; the parent shows which subjob is in the way. |
| Linear downtime | `register_job` fails with a retryable error; open jobs continue on their snapshot; the dashboard shows the last fetch time. |
| Review loop never converges | Three rounds, then a `no_convergence` blocker in the client queue. |

### Usage guide and start prompts

The guide is one Markdown document served at `/guide.md` and returned by `get_guide`. It has a common part (identity, tokens, `control`, waiting loop, board rules, the incident lessons) and one section per role. Per-CLI notes (allow rules, timeout settings, how to spawn) go in an appendix. Start prompts:

- **Staff:** "Read http://localhost:7400/guide.md and follow the Staff section. Work on Linear ticket <ID> in repository <path>."
- **Researcher:** "Read http://localhost:7400/guide.md and follow the Researcher section. Your focus is <topic>. Wait for questions on the message board and help until I stop you."
- **Senior** (generated by `create_spawn_ticket`): "Read http://localhost:7400/guide.md and follow the Senior section. Register with spawn ticket <code>. Your assignment is <summary>."

---

## 6. End-to-end walkthrough

Parent ticket ENG-100 "Export reports as PDF" with sub-issues ENG-101 "PDF service endpoint" and ENG-102 "Export button in UI". ENG-102 depends on ENG-101.

| Time | Event |
| --- | --- |
| 09:00 | The Client runs `docker compose up`, starts Claude Code with the Staff prompt for ENG-100. Starts Codex with the Researcher prompt (focus: backend) and a second Claude Code session with focus: security. |
| 09:01 | Staff registers as `staff-ada`, calls `register_job`. The service fetches ENG-100 and its children and creates three jobs in `queued`. |
| 09:05 | Staff writes acceptance criteria, adds the dependency, moves ENG-101 to `ready`. ENG-102 stays in `planning`. |
| 09:06 | Staff calls `create_spawn_ticket` for ENG-101 and starts a background subagent with the returned prompt. It registers as `senior-ben`, claims attempt 1, creates a worktree. |
| 09:40 | Ben posts a timed question: "Generate PDFs in-process or through a worker queue?" with context, options and a 300 second window. Deadline 09:45:00. |
| 09:41 | Staff replies "in-process for v1", marked `intended_decision`. |
| 09:43 | The Codex researcher replies with stance `challenge`: large reports can exceed the request timeout, with a link to the timeout config. |
| 09:44 | The security researcher replies `inform`: sanitize HTML input to the renderer. |
| 09:41 to 09:45 | Ben's `await_question` does not return. Ben does no dependent work. |
| 09:45:00 | The scheduler reconciles. A timely `challenge` exists, so the question goes to `awaiting_staff_decision`. |
| 09:46 | A late reply from a third researcher is stored with `timely = false`. It is `support`, so no event fires. |
| 09:47 | Staff records a decision: in-process with a size limit and a follow-up ticket, citing all three timely replies. Ben continues. |
| 10:30 | Ben's Claude Code background subagent dies (the Client kills it to test). |
| 10:45 | Ben is offline. At 11:00 the lease expires; attempt 1 ends `lease_expired`; Staff gets `assignment.orphaned`. |
| 11:01 | Staff issues a new ticket. `senior-cy` claims attempt 2 and reuses the worktree after reading Ben's last progress report. A late `report_progress` from attempt 1 would be refused. |
| 12:10 | Cy submits a review package: diff link, `pnpm test` output, one limitation. |
| 12:20 | Staff verdict `changes`: one required finding (missing size limit test) with evidence. Optional: rename a function. |
| 12:50 | Cy responds to the finding, submits round 2. Staff accepts. ENG-101 is done. ENG-102 becomes claimable. |
| 13:00 | Planning ENG-102 shows the ticket asks for both "one-click export" and "choose page size first". Staff raises a `client_decision` blocker with a recommendation. ENG-102 is blocked; nothing else is. |
| 13:30 | The Client answers in the decision queue. The blocker resolves, ENG-102 returns to `planning`. |
| 15:00 | ENG-102 is accepted. Staff records the integration decision. ENG-100 is done. The Client merges the PRs. |

Human participation (also demonstrated): the Client posts a proposal on ENG-100 "skip PDF metadata in v1". The researcher that follows all jobs finds it through `list_board`. One agent replies `support` with a reason, one `reject` because of an accessibility requirement. Staff records the decision. The Client reloads the dashboard and sees the full thread.

---

## 7. V1 dashboard

| Screen | Fields | Client actions |
| --- | --- | --- |
| Job list | Linear id and title, state, owning Staff, next action, blocked reason, last activity | Filter by state and by "needs me" |
| Job detail | Linear snapshot with "changed in Linear" badge, acceptance criteria, subjobs and dependencies, assignments with holder and lease, timeline of events | Pause, cancel, reassign Staff, open a thread |
| Thread view | Messages with author, role, stance and reason, timely or late, question countdown, question state, decisions with considered replies | Post, reply, propose, open a timed question |
| Review | Packages by round, verdicts, required findings with dispositions | None in v1 beyond reading |
| Active agents | Nickname, role, focus, runtime, model, parent, presence, current assignment, last seen | None |
| Client decision queue | Every open `client_decision` and `no_convergence` blocker with question, recommendation and affected work | Answer, which resolves the blocker |

Updates arrive over SSE. The page title shows the count of open client decisions. That is the only v1 notification.

Later: agent history pages, decision search, Linear write-back, desktop notifications.

---

## 8. Operational boundaries

- **Network:** the service binds to `127.0.0.1:7400`. MySQL is not exposed outside the Compose network.
- **Credentials:** the enrollment key and the Linear key live in `.env`, which is not committed. Session tokens are stored as hashes. Agents use their own Linear MCP auth.
- **Untrusted content:** Linear text and board messages are returned to agents inside clearly delimited fields with a note that they are data. The guide repeats that instructions only come from the Client and the role contract.
- **Secrets on the board:** refused by the pattern check in section 5. The guide forbids posting credentials.
- **Blocked means stop:** the guide tells every agent to report a blocking control with `raise_blocker` and stop. It must not look for a way around it, and must not share one on the board.
- **Workspace isolation:** one git worktree per implement assignment, recorded on the assignment. No two held assignments share a path.
- **Reserved actions:** merging, deploying, force pushing and changing branch protection are outside the orchestrator and reserved for the Client. The guide states this.
- **Caps:** at most 2 held implement assignments per parent job and 4 overall, enforced at `create_spawn_ticket`. This also limits load on the machine.
- **Retries:** a failed attempt may be retried twice. The third failure raises a `failed_execution` blocker.
- **Audit:** the event table is append-only and records actor, time and payload for every change.
- **Backups:** the MySQL volume. `docker compose down` keeps it; the README warns that `down -v` deletes it.

---

## 9. Delivery plan

No estimates. Each milestone ends with a demo that the Client can run.

| # | Milestone | Depends on | Acceptance and demo |
| --- | --- | --- | --- |
| M0 | Feasibility spike (throwaway): a stub MCP server with `register_agent`, `post_message`, `wait_for_events`, in memory | none | In Claude Code, Staff starts a background subagent that registers with its own token and posts. A Codex researcher waits for 10 minutes unattended and answers a question within a 5 minute window. Record the results in the feasibility matrix, including subagent lifetime after the parent exits and progress-token support. |
| M1 | Service skeleton: Compose with MySQL, migrations, agents, sessions, presence, event log, MCP endpoint, `/guide.md`, SSE, active agents screen, scripted-agent test harness with a controllable clock | M0 | `docker compose up`; two sessions register and appear on the roster; killing one moves it to stale then offline. Harness tests pass. |
| M2 | Jobs and assignments: Linear fetch, subjobs, dependencies, assignments, spawn tickets, leases, attempts, fencing, job list and detail | M1 | Staff registers a real Linear parent ticket. A Senior claims a subjob. A stale attempt's write is refused in a harness test and in a live demo. |
| M3 | Board: threads, messages, stances, timed questions, deadline reconciliation, decisions, late replies, researcher feed, Client posting | M2 | The 10:00 acceptance example from `ROLES-AND-WORKFLOWS.md` passes in the harness with a fake clock and live with real agents. The human proposal flow works end to end. |
| M4 | Review and completion: packages, verdicts, rounds, parent completion, blockers, client decision queue, pause and cancel | M3 | One subjob goes through changes and acceptance. A client blocker is raised and answered in the dashboard. Cancel stops a Senior at its next call. |
| M5 | Two-provider demonstration | M4 | The full walkthrough in section 6 with Claude Code as Staff and Seniors and Codex as a researcher, including the killed Senior and the client blocker. |

The usage guide grows with each milestone and is part of each demo.

---

## 10. Decision log and open questions

**Decisions made in this plan** (reversible unless noted): TypeScript stack; one service; MCP for agents and HTTP plus SSE for the dashboard; session token per call; enrollment key plus spawn tickets; 60 to 300 second windows; automatic decision promotion only without a timely challenge; 50 second default wait, 240 after client config; 30 minute leases; 3 review rounds; Researcher and Specialist merged with a focus label; no Linear writes from the orchestrator; polling Linear instead of webhooks.

**Assumptions:** one machine, target repos cloned locally, agents can create git worktrees.

**Verified facts:** see the Verified rows in section 2.

**Unresolved feasibility checks (M0):** a Codex MCP call held for 240 seconds after raising `tool_timeout_sec`; no approval prompts on orchestrator tools in Codex with `auto` approval and explicit annotations; Claude Code progress tokens; subagent lifetime after the Staff session ends in both CLIs.

**Decisions that need the Client:**

1. Which Linear identity agents use through Linear MCP (the Client's key, which attributes actions to the Client, or an app user), and whether Staff may create or edit sub-issues and comments.
2. A read-only Linear API key for the orchestrator.
3. Billing modes for Claude and Codex agents (subscription or API key). This decides whether many background subagents and long waits are affordable.
4. The demo repository and its Linear team.
5. Whether the enrollment key alone may register Staff (this plan's default), or Staff needs a Client grant code.

**How the open decisions were defaulted for v1** (the Client asked not to be asked; each default is easy to change):

1. Linear identity: agents use whatever Linear MCP auth their CLI already has. The guide does not tell agents to write to Linear; Staff may comment through Linear MCP only within the rules the Client gives in the start prompt.
2. Linear key: optional. Without it, Staff passes the ticket snapshot it read through Linear MCP and the job records `snapshot_source: agent`. With a read-only key, the orchestrator fetches and refreshes the ticket itself.
3. Billing: not decided by the code. The defaults keep cost low: 50 second waits, researchers woken only by questions, proposals and mentions, and at most 4 Seniors at a time.
4. Demo repository: any local clone; the job records its path.
5. Staff registration: the enrollment key alone is enough, as planned.

## Implementation status

Built in this repository: every component in sections 3 to 8, the MCP tools in section 5, the dashboard in section 7, Docker Compose, and the usage guide. M0 was merged into M1: with the real service available, the feasibility checks ran against it instead of a throwaway stub.

Verified on 2026-10-07:

- Typecheck, dashboard build, and the Docker image build and healthcheck.
- 23 vitest tests against MySQL 8.4: protocol and HTTP boundary, the 10:00 acceptance example, decision promotion, fencing, spawn tickets, review rounds and parent completion, Client posts and assessments, secrets and reply caps, unavailable Staff and handover, pause and cancel, client blockers, Linear downtime.
- 5 Playwright browser tests on a throwaway stack: roster and jobs, the Client proposal flow, a full timed-question window with a late reply, the client decision queue, and pause, resume and cancel.
- Live, with real CLIs: a headless Claude Code researcher and a Codex researcher waited unattended, found a timed question through the all-jobs feed, and answered within the window. A headless Claude Code Staff started a Senior subagent that registered with its spawn ticket, worked in its own worktree, committed, and passed review; the job completed.
- The live runs found two real problems, both fixed or documented: `end_session` failed on reasons over 40 characters (fixed), and a PreToolUse hook in the local Claude Code setup made allowed `git` commands ask for approval in headless runs, so the first Senior raised a blocker and stopped as the guide says (documented in the guide's CLI setup).

First real ticket (2026-10-08): Staff raised a `client_decision` blocker and then ended its CLI turn, so it went stale and could not see the answer. Fixes: the guide and the `raise_blocker` response tell agents to keep calling `wait_for_events` until `blocker.resolved` arrives; the dashboard can poke an agent (`agent.poked`) and shows each agent's activity; the default question window is now 180 seconds and extends while nobody replies. The `unavailable_owner` blocker now clears by itself when the Staff agent calls again; before, the job stayed blocked after Staff returned. The Client sets the model and effort per role on the Models page (defaults: Staff claude-opus-5-5 high, Senior and reviewer claude-sonnet-5-5 high, researcher gpt-6-astra low); spawn tickets carry them, so a change applies to the next Senior without touching running agents. An accepted review now moves a job to `delivering`, not `done`: the Senior runs the `deliver` Copilot loop and gets CI green, reports the head commit, and Staff checks CI itself and confirms the same commit (a real job was once marked done while CI was failing). The Client can reopen a job wrongly marked done. Researchers are now woken by review rounds and comment from the board text only: they may read code for evidence but never open the PR, its diff or its branch, and they ask Staff for a specific check when the text is not enough. 27 vitest and 7 Playwright tests pass after these changes.

Still open: Claude Code progress-token support, subagent lifetime after the Staff session ends, a Codex Staff starting Seniors with `spawn_agent`, and a real Linear key (`LINEAR_API_KEY`) in place of agent-supplied snapshots.
