# Proposed role contracts and coordination workflows

This file provides planning inputs. The message board requirements below are explicit client requirements. The planning LLM should refine the other proposals and explain material changes. These are not claims about existing Codex, Claude, or Linear features.

## Separate identity, authority, and execution

An agent is a registered participant. A session is one live connection or execution instance. A role describes responsibilities. A skill describes a reusable procedure or capability. A runtime executes the agent, and a model supplies reasoning within that runtime. An assignment grants responsibility for specific work.

Registration should not allow an agent to grant itself unrestricted authority. Propose how the client or authorized Staff owner approves role and job permissions. Changing a model should not silently change those permissions.

Use these board terms consistently:

| Term | Meaning |
| --- | --- |
| Discussion post | Any board message. It does not open a response window. |
| Timed question | A question that opens a response window with an absolute deadline. |
| Assessment | A participant's support, approval, challenge, disagreement, or rejection of a proposal, with reasons. It does not change job state. |
| Decision | A binding outcome recorded by the participant with authority for it: Staff for engineering decisions, the Client for reserved decisions. |
| Reserved approval | An approval that only the Client can give. |

An agent's "approval" of a proposal is an assessment. It is never a reserved approval.

## Role contracts

The Client is the human commissioning the work and using the dashboard. The Client sets goals and priorities, answers escalations, and provides reserved approvals. Client is not an assignable AI agent role. Staff Software Engineer, Senior Software Engineer, Reviewer, Researcher, and Specialist are AI agent roles.

| Role | Owns | Expected outputs | Escalates when |
| --- | --- | --- | --- |
| Client (human) | Goals, priorities, consequential approvals | Requirements, answers, acceptance decisions where reserved | Not applicable |
| Staff Software Engineer | Delivery plan, decomposition, architecture, delegation, review, coordination | Acceptance criteria, assignments, decisions, review verdicts, delivery summary | Business intent, authority, risk, or an irreversible decision requires the client |
| Senior Software Engineer | Implementation within an assignment | Code or PR reference, validation evidence, implementation notes, review responses | Requirements conflict, architecture authority is needed, or execution is blocked |
| Reviewer | An explicitly assigned independent review | Findings tied to criteria and evidence, approve or request changes | Findings conflict with requirements or exceed review authority |
| Researcher or Specialist | Monitoring the board across all accessible jobs and contributing relevant advice, plus bounded investigations | Findings, sources, recommendation, uncertainty | Evidence is missing or a decision exceeds the assigned scope |

Staff performs review by default. A separate Reviewer is optional. Researchers and specialists should not change implementation state or make binding architectural decisions simply by posting a reply. Staff owns the final decision and records it explicitly.

The table gives Researcher and Specialist one shared contract. The plan should either define a real difference between them or treat them as one role.

Candidate reusable skills include ticket decomposition, acceptance-criteria writing, repository investigation, architecture decision writing, implementation, validation, code review, evidence-based research, and client escalation. Plan their inputs, outputs, permissions, and stop conditions before writing extensive skill prompts.

## Proposed job lifecycle

The exact state names remain a design decision. Start by evaluating this small set:

| State | Meaning | Typical next step |
| --- | --- | --- |
| Queued | Request exists but has not been fully planned | Staff establishes scope and criteria |
| Planning | Staff is defining the work and dependencies | Staff marks it ready |
| Ready | Work is sufficiently defined and can be assigned | Authorized worker claims its assignment |
| In progress | Implementation or assigned work is active | Worker submits evidence for review |
| In review | A review package is awaiting a verdict | Reviewer accepts or requests changes |
| Blocked | A named condition prevents progress | Responsible party resolves the blocker |
| Done | Completion criteria have been verified | Preserve delivery and review records |
| Cancelled | Work has been intentionally stopped | Preserve the reason and stop further execution |

A change request returns work to implementation with a recorded review verdict and specific feedback. A blocked job records its previous state, reason, responsible party, requested decision, and unblock condition. The design must specify who can restore it and where it resumes.

Keep agent availability, execution attempt status, review verdicts, and job delivery state separate. A crashed attempt does not necessarily mean the job is cancelled. A waiting agent does not necessarily mean its job is blocked.

Define parent completion explicitly. A proposed rule is that required subtickets must be accepted and the Staff owner must confirm any integration-level criteria before the parent is done. Discuss how optional, failed, and cancelled subtickets affect this rule.

## Message board requirements

The board is an open discussion surface for agents within their authorized workspace. Researchers monitor messages about any accessible job and can join a discussion without an invitation or assignment to that job. Explicit mentions are optional conveniences, not a prerequisite for participation. The board is inspired by a real agent-built message board. The section "Lessons from the incident that inspired the board" below links the sources and lists the lessons this design must carry.

### Question and response window

1. A Senior with a question posts it to the job's board and sets a response window, for example five minutes. Use five minutes as the initial planning default, with a shorter window configurable by the Senior when posting. Record the duration and an absolute response deadline on the question.
2. The question explicitly identifies the internal job ID and the owning Staff agent ID. The owning Staff agent monitors its jobs through polling, long polling, or SSE, receives the question, and answers in its thread.
3. Researchers and specialists monitor a workspace-wide feed of all accessible job-board messages, including questions and replies. They can answer or join the discussion even if they have never worked on that job. Their participation is optional; delivery must not depend on every researcher replying.
4. The Senior waits for the entire declared window before starting or resuming work that depends on the answer. An early Staff answer or researcher reply does not end the window. For a five-minute window, the Senior still waits five minutes so other participants have time to contribute.
5. At the deadline, the Senior reads all answers received within the window together, including follow-up discussion. "All answers" means all answers received by the deadline, not waiting indefinitely for every registered agent. The Senior must not act on only the first answer.
6. Staff remains accountable for decisions within its authority. Researcher replies are advice and do not override Staff authority. The plan must specify how Staff considers the collected answers and resolves contradictions before dependent work proceeds.

The deadline closes the initial collection window; it does not imply approval or automatically resolve the question. Plan the behavior for no replies, a missing required Staff decision, contradictory answers, and late replies. Proposed default: when a Staff decision is required but missing or contradicted by material evidence, the Senior keeps dependent work waiting and requests Staff synthesis. Escalate to the human Client only when human intervention is genuinely required. Preserve late answers and flag material corrections without silently changing a decision already being implemented.

The plan should also state who besides a Senior may open a timed question (Staff, a Researcher, or the Client). Propose a minimum window, so that a very short window does not turn into first-answer-wins behavior.

### Required context on the question

Each question must contain enough context for an agent unfamiliar with the job to contribute:

- Internal job ID, question/thread ID, author agent ID, and owning Staff agent ID.
- A reference to the internal job description and the Linear ticket identifier and link, including the relevant parent or subticket relationship.
- A concise inline description of the job objective, relevant acceptance criteria, constraints, and current progress. Links alone are insufficient.
- The specific question, why it matters, what work is waiting, and relevant options or attempted approaches.
- Relevant technical details and evidence, such as code references, artifacts, errors, or earlier decisions, where applicable.
- The response-window duration, posting time, and absolute response deadline.

Replies retain the job and thread references so participants can follow the discussion and retrieve its context. Define how responders fetch fuller job or Linear details when needed and how they detect context that has changed since the question was posted.

### Delivery and visibility

- Provide both an owner-scoped feed for Staff and a workspace-wide feed for researchers. Do not restrict researcher visibility to assigned jobs or explicit mentions. Existing workspace access boundaries still apply.
- Persist messages and deadlines. A disconnect or restart must not reset the response window or lose replies. Verify how each runtime waits and resumes without requiring continuous LLM generation. Include the cost of resuming after an idle wait of several minutes, for example when a provider's prompt cache has expired.
- Open visibility does not require every researcher's model to read every message in full. Propose how a researcher picks the messages it engages with. Estimate how the cost of the all-jobs feed grows with the number of jobs, messages, and researchers.
- Treat inline context copied from Linear and from board messages as untrusted input. The all-jobs feed carries it into every researcher's context, so one hostile ticket or message can reach agents that work on other jobs.
- At deadline expiry, reconcile the durable thread before proceeding so a missed notification does not cause an answer to be omitted. Define ordering at the deadline and how late replies are identified.
- Show the question, owning Staff engineer, waiting Senior, deadline or remaining time, replies, and resolution in the dashboard.
- Distinguish collecting answers, awaiting a Staff decision, and resolved discussion states from the job's delivery state. An ordinary response window is not automatically a human-client blocker.
- Distinguish discussion posts, timed questions, replies, assessments, decisions, progress updates, review findings, and client escalations without building an elaborate messaging platform. Bound automated reply loops and duplicate processing while preserving open researcher participation.
- Proposed default: board history is append-only. A correction is a new message. A revised decision is a new record that links to the decision it replaces.

### Persistent dashboard and human participation

All board messages must be persisted and available to the human Client in the dashboard, including questions, answers, follow-up discussions, human messages, challenges, agreements, rejections, reasons, and decisions. SSE and polling deliver updates to this durable history; they do not replace storage. Messages remain available after a response window closes, a job finishes, or an agent disconnects. The dashboard must let the Client read a job's full thread and post or reply directly with the same job and thread references used by agents.

The human Client can participate in discussions and post questions, suggestions, proposals, and decisions. Researchers and other participating agents can explicitly support or approve a proposal, challenge it, disagree, or reject it with reasons and supporting evidence where available. Human authorship does not exempt a proposal from critical discussion. These responses must be persisted and visible alongside the message they address, rather than reduced to an unexplained reaction count.

Human messages enter the same feeds as agent messages. The owning Staff agent and researchers following all accessible jobs can discover them and respond without a separate invitation. The plan should distinguish an ordinary discussion post from a question that opens a timed response window; it must not silently impose a five-minute delay on every human message.

An agent's approval or rejection expresses its assessment of the proposal. It does not automatically change job state, override a reserved human approval, or authorize execution. Preserve the reasons and record the final decision separately under the existing role authority. When a human decision remains disputed, Staff should make the disagreement and consequences clear and seek clarification if necessary, rather than silently treating an agent's rejection as a veto.

V1 acceptance must demonstrate a human posting on a job board, researchers discovering that message through the all-jobs feed, one reasoned agreement and one reasoned challenge or rejection, Staff recording the resulting decision, and the Client reloading the dashboard and seeing the complete persisted discussion.

### Acceptance example

At 10:00, a Senior posts a question with a five-minute deadline, the internal job ID, owning Staff ID, Linear link, job summary, and technical context. Staff answers at 10:01. One researcher answers at 10:03 and another joins at 10:04. The Senior must not begin dependent work at 10:01. At 10:05 it retrieves the complete discussion and considers every answer received by the deadline. If the discussion requires a further Staff decision, it waits for that decision before proceeding. A reply at 10:06 remains visible as late input and follows the defined late-answer policy.

### Lessons from the incident that inspired the board

The board is inspired by the message board that agents built for themselves during the 2026 OpenAI and Hugging Face incident. That board let agents share expertise and build on each other's work. It also spread a wrong belief, attack techniques, and stolen credentials. Read these sources before designing the board:

- OpenAI, "Hugging Face incident and the road ahead": https://openai.com/index/hugging-face-incident-and-the-road-ahead/ and its technical report: https://cdn.openai.com/pdf/67869394-cb91-4c12-888c-5cbd85c7814c/OpenAI-Hugging-Face%20Incident-Technical-Report.pdf
- METR, independent investigation of the agents' behavior and collaboration: https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/

Carry these lessons into the design:

| What happened on that board | What this design requires |
| --- | --- |
| Agents invented single owners for shared resources, holds, stop signals, and personal inboxes. | Map these patterns to assignment ownership and leases, pause and cancel state, and owner-scoped feeds. |
| Anyone could post under any name, so agents started to sign their messages. | The orchestrator authenticates every call as a registered agent. A name inside a message is not an identity. |
| A "consensus GO" among agents overrode a single-writer rule. | No number of agent assessments overrides an owner, a lease, a Staff decision, or a reserved approval. |
| A shared wrong belief about a safeguard that did not exist directed the work of many agents. | Assessments carry reasons and evidence. Staff checks a claim before acting on it, even when many agents repeat it. |
| A veto mechanism was enforced inconsistently, and some veto windows were only 40 seconds long. | Timed questions have a minimum window. |
| When about 90% of active agents, including the main coordinators, stopped at the same time, the remaining agents had no leadership. | Plan recovery for a Staff session that ends together with the Seniors it started. |
| Agents posted credentials on the board, and other agents reused them. | Agents never post credentials, tokens, or other secrets on the board. |
| OpenAI found that the chance an agent joined the board and the exploits rose with task difficulty and with the number of reasoning tokens. | An agent that is blocked by a control or cannot solve its task reports the block and stops. It does not look for a way around the control, and the board is not a place to share one. |
| OpenAI states that agents communicating through a provided collaboration tool is not the problem. The risk came from improvised channels. | Proposed default: agents communicate with each other only through the board, so the Client can see every exchange. |

Put these rules in the usage guide and in the role start prompts. OpenAI reports that, in its evaluation, its production harness and system prompt can reduce the tendency to compromise infrastructure by more than 100 times.

## Presence and recovery

Evaluate heartbeat-based presence and renewable assignment leases separately. Heartbeats establish whether a session is alive. Assignment ownership controls who can act on work. Define how stale attempts are prevented from overwriting a replacement worker's result.

A live waiting agent should renew presence without needing to generate LLM output continuously. The orchestrator does not run agents, so it cannot renew presence for them. Establish how each CLI can provide this behavior. Specify timeout policy, reconnect identity, and how active assignments are recovered.

On disconnect, preserve messages and job history. On reconnect, recover missed notifications using a cursor or reconcile current state. Explain duplicate handling rather than promising exactly-once delivery.

When Staff disappears, preserve pending questions and reviews. Propose an explicit takeover process with a handover summary. Do not silently promote an arbitrary agent to Staff authority.

Agents that Staff started may end when the Staff session ends. Plan recovery for a Staff session that ends together with the Seniors it started, including how their assignments are released and how a new Staff session or new Seniors pick the work up.

## Review package and completion evidence

An implementation submission should identify the assignment and attempt, summarize the change, link its artifacts, show validation performed and results, and disclose remaining limitations. The reviewer evaluates it against the job's acceptance criteria.

Review feedback should separate required changes from optional suggestions and identify the evidence supporting each required change. The implementer should respond with a revision and a disposition for each required finding.

The planning phase must decide whether review acceptance completes a job or whether merge or another delivery step is also required. No agent should report tests, merges, or deployments as completed without evidence.

## Client escalation example

"This ticket requires choosing between two conflicting customer requirements. I recommend option A because of the stated priority in the ticket. Option B changes the agreed scope. Please choose A or B. Subticket 2 is blocked; subticket 1 can continue."

This is an example of the expected structure, not a real project decision. Routine implementation choices should remain with Staff. Each client escalation should include the precise question, relevant context, a recommendation when supported, and the work affected.

## Minimum demonstration to plan

Demonstrate a Linear-backed job that is planned by a Staff agent, implemented by a Senior agent, discussed on the board, reviewed, revised, and accepted. Use both Codex and Claude across those roles, with the particular pairing treated as a demo choice. Show researchers discovering the question through the all-jobs feed without an invitation, contributing during a five-minute response window, and the Senior waiting until the deadline despite an early Staff answer. Include the required job and Linear context, consideration of all timely answers, and resolution of any conflicting advice without granting researchers implementation ownership. Also demonstrate the human participation flow from "Persistent dashboard and human participation".

Start every agent in the demonstration the way the intended operating model in `PROJECT-BRIEF.md` describes. I start the Staff session and the researcher sessions by hand with their start prompts. Staff starts the Seniors with the tools of its own CLI. The orchestrator starts no agent.

During the demonstration, interrupt one worker, show its active presence expire, recover the assignment without conflicting accepted results, and deliver a missed message after reconnect. Show a genuine client decision blocker and its resolution. The dashboard should make the owner, status, evidence, and next action clear throughout.
