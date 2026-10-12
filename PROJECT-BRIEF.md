# Project brief: AI consultancy orchestrator

## Product idea

The Client is the human commissioning the work and using the dashboard. The Client gives an AI team a job represented by a Linear ticket with subtickets. A Staff Software Engineer owns planning, high-level technical decisions, delegation, review, and delivery. Senior Software Engineer agents perform implementation. Researchers and specialists can contribute to job-linked discussions without owning coding work.

A shared orchestrator stores job state, agent registrations, assignments, discussions, and decisions. A dashboard lets the client see what is happening and step in when necessary. The intended experience resembles a software consultancy with the client setting the objective and the Staff engineer handling most delivery decisions.

The product must support Codex and Claude initially, while keeping its domain model and role definitions independent of a particular model or provider. An agent using any supported runtime should be able to adopt an appropriate role. Model choice must not determine authority.

## Intended operating model

This is how I expect to use the product. Treat it as a requirement. If the plan finds part of it infeasible, explain why and propose the closest alternative.

- The orchestrator is a standalone application. It is not tied to any codebase, and it must work for any project whose tickets are in Linear.
- The orchestrator service, its MySQL database, and the dashboard run with Docker on my machine.
- The orchestrator never starts an agent. Agents start other agents. The orchestrator provides orchestration state, the agent-facing interface, and the human view.
- Agents learn how to work with the orchestrator from a usage guide that the orchestrator serves, or through an MCP server that the orchestrator exposes. The plan should choose one or combine them.
- To start a Staff agent, I open an agent CLI such as Claude Code and type something like: "Read how to work with the orchestrator and start working on Linear ticket <ID> as Staff Software Engineer." The session registers as an active Staff agent and registers the job for the ticket. It then starts Senior agents with the tools of its own CLI.
- Each Senior follows the same registration pattern and registers as a Senior. Seniors take their assignments, do the work, and use the message board to communicate with other agents.
- To start a researcher, I open another agent CLI, for example Codex, and type something like: "Read how to work with the orchestrator. You are a researcher. Wait for questions on the message board and help." The session registers as a researcher and waits for board activity until I stop it. Any supported model can act as a researcher.
- Agents do their code work on my machine, outside the orchestrator containers. The orchestrator containers do not execute agent code.
- Because the orchestrator cannot start or stop agents, pause and cancel work by changing state that agents check. The plan must state when an agent checks that state and what happens when an agent does not respond to it.

## Explicit requirements

- Linear is the initial source of tickets and subtickets. Agents use Linear MCP as part of the workflow. Verify its actual capabilities before depending on specific operations.
- Each internal job request references its Linear source and has its own orchestration status stored in MySQL.
- Agents register with an ID, nickname, and role. Role descriptions include responsibilities and appropriate skills.
- Staff plans the work, makes high-level decisions, and delegates implementation to a Senior agent. Staff starts Senior agents with the tools of its own CLI. The planning phase must verify what each supported CLI actually provides for this.
- A job identifies the repository and working location it targets, because the orchestrator is not tied to one codebase.
- Assigned implementation work moves into progress and then into review. Staff receives updates for work it owns or follows, reviews the results, and sends actionable feedback to the implementer.
- A job-linked message board supports questions, Staff decisions, review feedback, and contributions from multiple agents, including non-coding specialists.
- A Senior posts a question with a declared response window, initially five minutes by default and configurable to a shorter duration when posting. The Senior waits the full declared window before acting on the answer, even if Staff replies early, and considers all answers received by the deadline.
- Each question explicitly includes the internal job ID, owning Staff agent ID, references to the job description and Linear ticket, and enough inline job and technical context for an unfamiliar researcher to help. Include the precise question, relevant criteria and constraints, and response deadline.
- The owning Staff agent polls or receives SSE updates for its jobs and answers on the board. Researchers monitor all messages across all accessible jobs and may answer or join discussions without an assignment or explicit invitation. The response window gives these participants time to contribute.
- Waiting until the deadline does not require every researcher to reply and does not imply approval. The plan must cover missing Staff decisions, conflicting answers, late replies, and durable recovery of response windows.
- All board messages and replies are persisted and available in the human Client's dashboard, including after job completion or agent disconnection. The Client can read full discussions and write messages or replies directly on the board.
- Researchers and other participating agents may support or approve human proposals, challenge them, disagree, or reject them with reasons. Human messages are delivered through the same job-owner and all-jobs feeds. Preserve these assessments and their reasoning in the UI; distinguish discussion approval or rejection from authoritative decisions and reserved human approvals.
- Staff resolves ordinary engineering questions. Work becomes blocked when it genuinely requires the client's intervention. The dashboard must make that intervention clear.
- The initial dashboard shows job requests and their statuses, plus useful information that is inexpensive to include in v1.
- The dashboard shows registered active agents, including healthy agents waiting for messages. Agents that die or stop renewing their presence disappear from the active roster.
- SSE or polling, including long polling, should provide owner-scoped updates to Staff and an all-jobs message feed to researchers within their authorized workspace. Evaluate which is feasible for each supported runtime.
- The deliverable at this stage is a plan, not implementation.

## Proposed defaults to evaluate

These defaults clarify the idea without claiming that the client has already chosen them.

- Start with one client and one workspace. Keep provider credentials and agent permissions separate even without full multi-tenant support.
- Use one accountable Staff owner per job. An implementation assignment has one active owner at a time. Other agents contribute through explicit assignments or threads.
- Keep provider-specific details, such as how each CLI starts other agents or waits for events, out of the coordination layer. Keep jobs, roles, messages, decisions, and review history in the common coordination layer.
- Prefer a modular service over microservices for v1 unless a verified runtime boundary requires separation.
- Treat the board as durable job history. Treat live events as notifications that something changed, with the database as the durable record.
- Preserve historical agent identity when its live session expires. Distinguish a person-readable nickname from a stable agent ID and a session ID.
- Make blocked reasons explicit, including client decision, external dependency, failed execution, and unavailable owner. Only client-action blockers should automatically demand the client's attention.
- Accept an implementation only when review criteria and evidence are satisfied. Do not equate an agent saying "done" with verified completion.
- Keep code execution out of the dashboard process. Require an explicit execution environment, with a workspace strategy suitable for concurrent agents. Several agents work on the same machine, so they must not edit the same checkout at the same time.
- Completion, merging, and deployment are distinct actions. Define which actions need client approval before enabling them.

## Open inputs from the Client

I have not stated these yet. If the plan depends on one of them, ask me. If I have written an answer next to an item, treat it as a requirement.

- Which accounts and billing modes the agents use for Claude and Codex, for example a subscription plan or an API key. This can change which product surfaces are allowed and what the system costs to run.
- Preferred implementation language and stack, if any.
- Which repository the demo works on and where it is hosted.
- Which identity agents use in Linear, and whether Staff may create or edit Linear subtickets or only read them.
- Which actions are reserved for me, for example merging, deploying, force pushing, or changing branch protection.
- How I am told about a client blocker when I am not looking at the dashboard.

## Candidate features, in rough priority order

The planning LLM should select a small v1 subset and defer the rest.

| Feature | Purpose | Suggested phase |
| --- | --- | --- |
| Job timeline with owner and next action | Explain current status and how it was reached | V1 |
| Client decision queue | Surface the exact question blocking progress | V1 |
| Structured review and attached evidence | Make acceptance and revision requests actionable | V1 |
| Healthy, waiting, stale, and offline presence | Distinguish idle agents from dead sessions | V1 |
| Dependency-aware subtickets | Prevent work from starting before prerequisites exist | V1 if kept simple |
| Pause, cancel, and bounded retries | Give the client control over runaway or stuck work | V1 |
| All-jobs researcher feed and timed questions | Let researchers join any accessible discussion while the Senior waits for all timely answers | V1 |
| Mentions and explicit specialist requests | Supplement open participation with targeted requests | V1 or next |
| PR, commit, test, and artifact links | Connect reported progress to inspectable work | V1 with manual links first |
| Cost and concurrency limits | Bound autonomous work | Basic v1 controls; richer reporting later |
| Role and skill version history | Explain which instructions governed an assignment | Next |
| Searchable decision history | Reuse decisions and avoid repeated questions | Next |
| Provider usage and quality reporting | Compare outcomes across runtimes and models | Later |
| Multiple clients and workspaces | Support an actual consultancy operating model | Later |

## Scope traps to avoid

Do not assume every provider exposes a daemon, resumable session, identical tools, or the same event model. Do not treat an MCP tool call as a complete background execution system. Do not use presence expiry alone as permission for an old worker's side effects to be repeated elsewhere.

Avoid a marketplace, arbitrary agent hierarchies, automatic model selection, vector memory infrastructure, elaborate billing, and unrestricted agent-to-agent spawning in v1 unless the core workflow cannot work without them. Staff starting Senior agents is part of the core workflow. Spawning beyond that needs a stated reason and a limit.
