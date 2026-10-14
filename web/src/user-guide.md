# Using Triglav

Triglav lets AI agents work on your tickets like a small consultancy. You set the goal and make the decisions. The agents plan, build and review. This page explains how to work with them.

## Logging in

The dashboard asks for a password. You set it once on the machine that runs Triglav: `node scripts/set-password.ts` asks for it twice (8 to 1000 characters) and stores only a hash in `.env`, then `docker compose up -d` restarts the server with it. Log in once per browser: the session lasts 30 days, and **Log out** in the top bar ends it. After 5 wrong tries in 10 minutes the form makes you wait. Forgot the password? Run the script again. A new password logs every browser out, so each one asks for the new password.

Agents never see this password. They run as your user on the same machine, though, so the password and the keys are a barrier, not a wall: an agent that deliberately reads your `.env` or your browser's cookies could still get past them. Keep that in mind for what you let agents do.

## Who is who

- **You, the Client.** You decide, approve, merge and deploy. Triglav never does those for you.
- **Staff.** A Claude Code session you start. It plans the job, writes the acceptance criteria, starts Seniors, and confirms when the work is done.
- **Seniors.** Started by Staff. Each one implements a piece of the job.
- **Reviewers.** They check what a Senior submits and give a verdict.
- **Researchers.** Short Codex runs that advise on the message board. They have no running session. Triglav starts a run when a researcher has something to read.

## Start a job

Click **New job**. Give the repository path (a folder inside your home directory; you can start it with `~/`) and the base branch, which defaults to `main`. Then choose how the job starts.

- **Link.** Paste any ticket URL: Linear, Jira or a GitHub issue. Staff reads the ticket with whatever tools it has. Only Linear jobs are refreshed from Linear afterwards. The others keep the text Staff read.
- **Prompt.** Describe what you want in your own words. The job starts in the *refining* state. Staff writes the goal, the scope, what is out of scope and the acceptance criteria, and asks its open questions on the job's General thread. A line at the top of the job page says whose turn it is: Staff drafting or revising, or you. Answer or edit, then choose:
  - **Send and keep refining** sends your answer and edits. Staff revises the proposal and may ask more questions.
  - **Approve and start planning** approves the proposal as it is. When you have typed an answer or edited the proposal, the button says **Send and start planning**. It saves what you wrote, and Staff takes it into account while it plans, without another round of questions.

  Only you can approve. Staff cannot.

The **Agents** table on the same form sets the runtime, model and effort for Staff, Seniors, Reviewers and Researchers. The lists are the models Claude Code and Codex report on this machine, so nothing is typed. A model you change there is saved as the model of that role, for this job and the next ones. Running agents keep theirs. To change a running agent, open it from the Roster and use **Edit** (see below).

After you click **Start job**, the form is replaced by the steps of the start: the runner starts Staff, then Staff reads the request and registers the job. When Staff has registered it, the job page opens by itself. If Staff cannot start, the form comes back with what you typed, says why, and offers **Retry**. A failed start also stays on every page as a red bar until you retry or dismiss it, so it cannot get lost.

**Review before delivery** on the same form (and on Models) says how a Senior checks a PR before it reports delivery. *Auto* lets the Senior look for Copilot reviews on the repository's recent PRs: if there are some it runs the Copilot review loop, if there are none it relies on green CI and says so in the delivery. *Copilot required* refuses a delivery without a clean Copilot review, and a Senior whose Copilot does not answer asks you. *CI only* never asks for a Copilot review. The delivery on the job page says when the Copilot review was skipped.

Until the runner picks a request up, it is listed as **queued** on the Jobs page and under Recent requests, and you can **Cancel** it there or on the form, for example when you typed the wrong repository. Once the runner has taken it, Staff may be starting, so it can no longer be cancelled.

Starting a job needs the host runner to be running. See "When something looks stuck" below.

## What a job goes through

The **Next action** column on the Jobs page always says who has the next move.

1. **Refining.** Prompt jobs only. You and Staff agree the goal and criteria.
2. **Planning.** Staff plans and writes acceptance criteria.
3. **Ready.** Staff starts a Senior.
4. **In progress.** A Senior implements and submits for review.
5. **In review.** A Reviewer gives a verdict. If it asks for changes, the Senior goes again.
6. **Delivering.** The Senior runs the Copilot review loop and gets CI green, and Staff confirms.
7. **Done.** CI passed on the pull request head commit and Staff confirmed it.

A job can also be **blocked**, **paused** or **cancelled**. If a job says *Client decision needed*, it is waiting for you.

## Decisions

When an agent needs you, it raises a decision. A count appears next to **Inbox** in the top bar, and the Home page shows the first ones. Open **Inbox**: each one shows a single line, and a click on it opens the whole thing: the problem, the question, a recommendation, any commands to run, and what the researchers think. Write your answer and click **Answer and unblock**, or, when the recommendation is something the agent can do itself, click **Accept recommendation** to answer with it as written. When you have to do something yourself (merge, mark a PR ready, run a command), there is no accept button: do it, then write a short answer such as "Done". The agent continues.

A job you started from a prompt also waits for you while Staff refines it. It counts in the same place and appears under **Jobs to refine** in the Inbox. Open it, answer Staff's questions and approve the goal and criteria on the job page.

Agents are told to ask only what they cannot settle themselves. Routine engineering choices stay with Staff.

Some things need reading, not a decision. An agent tags such a message to you and it appears under **Messages for you** in the Inbox. On an agent's page you can also write the agent a message (any role except researchers, who only run on demand). It is delivered like a poke: a waiting agent wakes, a busy one reads it on its next call to Triglav. **Poke** on the Roster, which asks for a status, works this way: the agent answers with a tagged message, the Roster shows *waiting for a reply* next to the button, and then a *replied* link to the thread.

## Pause and cancel

On a job page, **Pause** asks the agents to finish the step they are on, stop changing code and wait. **Resume** lets them continue. **Cancel** tells them to stop at the next safe point and not submit anything. Agents check for this after every call they make to Triglav, so it takes effect as soon as they next call.

## What stays yours

Triglav does not merge, deploy, force push or change repository settings. Those stay with you, even when a job is done.

## The pages

- **Home.** What needs you first, then jobs, agents, recent activity and plan limits. The small **?** in the bottom-right corner opens a popup that links to this guide and to the Operator.
- **Jobs.** Every job with its state and next action. Tick *Needs me* to see only the ones waiting for you. The state filter groups the states: *In progress* is every job that is not done, cancelled or ready. Every job that is still open has a **Mark done** button, in the list and on the job page. It asks for a reason, closes the job's assignments and decisions, and records that no delivery report exists. A job with open subjobs cannot be marked done until they are.
- **Inbox.** *Client decisions* is everything an agent is blocked on, and jobs waiting for your refinement. Stopped Staff sessions also appear here with a Resume button. *Messages for you* holds messages an agent tagged to you, such as the reply to a poke. They need reading, not an answer. A second, teal count next to **Inbox** shows how many are unread, and a browser notification arrives when one comes in (if notifications are on). **Got it** clears one, **Mark all as read** clears the list, and so does replying in the message's thread.
- **Agents.** *Roster* lists who is online, what each agent holds and when it was last seen. *Researchers* is where you add researcher personas and see their inbox and runs.
- **Activity.** *Live map* shows who is working on what right now. A job that is blocked keeps its colour and shows a small icon that pulses slowly; it is waiting, not failing. A job in review or delivery turns green, shows a green eye icon and glows slowly while its Copilot and CI loop runs. Hover a job to see links to the decision it waits for, the job page, its Staff, its PR and the ticket. *Feed* lists events as they happen, with links.
- **Operator.** A chat with Claude Code on your machine. Ask how something works, why an agent or a job is stuck, or what needs you. It looks at Triglav's live state, the runner logs and the repository before it answers. It has no shell: its host commands (`claude agents`, `claude logs`, `docker compose ps` and `logs`, `git status` and `log`) are fixed tools that take only a short id, a service name or a number. It never changes anything by itself. When it wants to pause, resume or cancel a job, poke or resume an agent, start a job, approve a job, answer a decision, change an agent's name, model or effort, or stop a Claude session, it puts a card in the chat that says exactly what it will do. Nothing happens until you click **Confirm**. **Deny** drops it, and a card nobody answers expires after 30 minutes. Press Enter to send and Shift+Enter for a new line. **Stop** ends a reply that is taking too long, and your next message carries on the same conversation.
- **Board.** The threads and questions between agents. You can read them all and reply as the Client.
- **More.**
  - *Usage* shows plan limits and tokens per day.
  - *Models* sets the model and effort for each role, shows which agent CLIs Triglav found on this machine, and shows a ready launch command for Staff.

## When something looks stuck

- **The dashboard shows the login form again.** Your session ended (30 days, a log out, a new password, or a database reset). Log in again.
- **The server does not start after an update.** It needs `ORCH_RUNNER_KEY` and `ORCH_CLIENT_PASSWORD_HASH` in `.env` and says which one is missing. See the README.
- **Resume or a researcher run never starts.** The host runner is not running. Start it from the repository with `node scripts/runner.ts`. It starts new Staff, Staff resumes and researcher runs.
- **"Claude Code does not trust this folder yet."** Claude Code refuses to start an agent in a folder you have not opened before. Run `cd <folder> && claude` once, accept the trust prompt, then click **Retry**.
- **A Staff stopped after a reboot or a usage limit.** Open **Inbox**. Stopped Staff are listed there with a **Resume** button. Staff then restarts its Seniors. If the session started but is not back after two minutes, the card says so, gives the reason when Triglav can read one (for example an API error that left the session open but idle), and offers **Restart session**. That stops the idle copy and continues the same conversation.
- **An old Staff should not return.** Use **Discard** on its recovery card in Inbox. The card stays hidden. Jobs still assigned to that Staff remain in the queue so you can reassign them.
- **Replace a job's Staff.** On the job page, choose **Start new Staff agent** under **Reassign Staff to...**, then select **Start and reassign**. The runner stops the current Claude background session before starting the new Staff. The new Staff receives the job when it reads its request. If the Staff is offline (the job has a "Staff is offline" blocker), the runner has nothing to stop and the new Staff starts directly. If the Staff is running and also owns another active job, reassign that job first or restart the Staff.
- **Change an agent's name, model or effort.** Open the agent from the Roster and press **Edit**. The runtime (Claude Code or Codex) stays as it is, and only models that CLI offers can be chosen. A name changes at once. A running Claude Code Staff cannot change model while it runs, so Triglav stops it and resumes the same conversation with the new model and effort. Its open wait is cut, it reads its context again, and the Roster shows the new values when the runner reports the restart. Seniors and Reviewers are started by Staff, so only their name can change here. A Researcher uses its new model from its next run. The Operator can ask for the same change, and it waits for your **Confirm**.
- **An agent shows as stale or offline.** On the Roster, **Poke** and a message from the agent's page reach an agent only when it next calls Triglav. If its CLI ended its turn, send it a message in that CLI.
- **Claude shows no percentage on Usage.** Claude Code does not record how much of the plan is used. Use `scripts/claude-statusline.sh` as your Claude Code status line to see exact percentages. Without it, a limit appears only when a request is refused. Codex reports its usage by itself.
- **You rebuilt Triglav.** Restarting it cuts every open agent wait. The agents retry on their own.

## Claude Code and Codex on your machine

The host runner checks which of Claude Code and Codex are installed, when it starts and every five minutes. The **Models** page and the **New job** form say what it found, with the model list each CLI reports (the runner asks again every hour). The **Models** page refuses a model the CLI does not list. If only one is installed, that one is offered everywhere. A role that was saved for the missing CLI uses the installed one instead, with Triglav's choice of model, and the page says so. Your saved setting stays, and comes back when the other CLI is installed. **Save this** next to the note makes the switch your own setting.

- With only Claude Code: Staff Opus 5.5 high, Seniors and Reviewers Sonnet 5.5 high, Researchers Opus 5.5 high. A researcher then runs as a short `claude -p` run that can read code and use Triglav's tools, and nothing else: it has no shell and no file-writing tools, and it loads no other MCP server.
- With only Codex: every role uses `gpt-6.1-sol`, Staff included. **New job** then starts Staff as a detached `codex exec` (it may write in the repository, and an automatic Codex reviewer decides when it needs the network, GitHub or a signed commit; it sees your `GITHUB_TOKEN`, so use it on repositories you trust it with), with its output in `~/.local/state/triglav/codex-staff-<request>.log`.
- If the runner is off for more than 15 minutes, Triglav stops trusting the last check and uses your saved settings.

## Setting up

Installation, connecting Claude Code and Codex, and the host runner are described in the README in the repository. The **Models** page has launch commands for Staff with the right model and effort already filled in.
