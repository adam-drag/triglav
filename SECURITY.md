# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include the version or commit, what you did, what happened, and what you expected.

Triglav is maintained by one person. I will reply as soon as I can, but I cannot promise a fixed response time.

## Supported versions

Only the latest commit on `main` gets fixes. There are no release branches.

## What counts as a vulnerability

Triglav runs on your own machine and starts AI agents with real permissions. A report is in scope when it breaks a guarantee that the README or AGENTS.md states, for example:

- A route that is reachable without the credential the README says it needs (the dashboard session, the enrollment key, the runner key, or a chat token).
- A way for the server, a ticket, the message board or agent text to make the host runner run a command it did not build itself.
- A secret (`ORCH_*`, `MYSQL_*`, `DATABASE_URL`, `LINEAR_API_KEY`, a session id or a chat token) that reaches a child process, a command line, a log or the dashboard.
- A research run, a code reviewer or the Operator that can edit files, run a shell command or use a tool outside its fixed list.
- Agent, ticket or reviewer text that renders as HTML, a link or markdown where the README says it is plain text.
- An Operator action that runs without the Client's Confirm.

## Known limits, not vulnerabilities

The README's [Security](README.md#security) section lists these, and they are not bugs:

- Agents run as your OS user. They can read `.env`, your home directory and your browser's cookies, so the credentials raise the bar and are not a hard boundary.
- The session cookie for `localhost` is sent to every server on `localhost`, on any port.
- The login limit is shared by the whole server, so a local process can lock you out for 10 minutes.
- The Copilot review limits and the PR comment rules are checked by the agents' own reports, because the server cannot run `gh`.
- An agent whose own credentials can merge, deploy or force push could still do it. Protect your branches on the Git host.
