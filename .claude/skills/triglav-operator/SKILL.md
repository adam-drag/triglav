---
name: triglav-operator
description: How the Operator (the read-only Claude Code chat in the dashboard) works - its process on the host runner, per-chat token, read-only tool allow-list, the triglav and host MCP servers, propose_* actions with Client Confirm, chat commands and events. Load before changing src/chat.ts, src/operator.ts, src/operator-actions.ts, scripts/operator.ts, scripts/operator-host-tools.ts, scripts/operator-host-mcp.ts, the Operator page, or adding an Operator action or host tool.
---

# The Operator

Verified against the code on 2026-10-15. If you find this out of date, fix it in the same PR. The invariants are in AGENTS.md ("The Operator asks, the Client decides"); this is the map.

## Pieces

| Piece | File | Role |
| --- | --- | --- |
| Chat store + commands | `src/chat.ts` | `chats`, `chat_messages`, `chat_commands`, `chat_actions`; `createChat`, `sendChatMessage`, `stopChat`; SSE `publish`/`subscribe`; `issueChatToken`, `revokeChatToken`, `chatByToken`; `nextCommand` (long poll); `resetChatStates`; `ingestChatEvents` |
| Operator tools (server) | `src/operator.ts` | `buildOperatorServer(ctx, chatId)`: read tools `overview`, `list_agents`, `get_agent`, `list_jobs`, `get_job`, `client_decisions`, `launches`, `usage`, plus one `propose_<kind>` per entry of `ACTIONS` |
| Actions | `src/operator-actions.ts` | `ACTIONS` map, `proposeAction`, `decideAction`, `finishHostAction`, `expireHostActions` |
| Host process | `scripts/operator.ts` | `OperatorChats`: one `claude -p` per chat, `operatorArgs`, `operatorMcpConfig`, `translate` of stream-json |
| Host tools | `scripts/operator-host-tools.ts`, `scripts/operator-host-mcp.ts` | stdio MCP server `host` with fixed commands: `agents`, `logs`, `compose_ps`, `compose_logs`, `git_status`, `git_log` |
| Routes | `src/server.ts` | `/api/chats*` (Client), `/api/runner/chat/*` (runner key), `/operator/mcp` (chat token) |

## Flow

1. Client posts to `/api/chats/:id/messages` -> a `send` row in `chat_commands`.
2. The runner's long poll (`/api/runner/chat/next`, 20 s) takes it. `OperatorChats.handle` starts a process if none runs: asks `/api/runner/chat/:id/token` for a fresh token, writes the MCP config to a private file, spawns `claude` with `staffStartEnv`, and writes the message to its stdin as stream-json.
3. The process's stream is translated (`translate`) into events and posted to `/api/runner/chat/:id/events`, batched (text deltas 80 ms).
4. After 20 idle minutes (`IDLE_MS`) the process ends. The next message resumes the same conversation (`session_id`).
5. Process end: config file removed, token revoked (`revokeChatToken` clears the hash only if it is still that token). Runner shutdown stops the processes first (`OperatorChats.shutdown`, up to 3 s). A killed runner leaves tokens; `resetChatStates` clears them on the next `hello`.

## Read-only guarantee

- `--permission-mode dontAsk`, `--tools Read,Grep,Glob`, `--allowedTools` = `OPERATOR_TOOLS` (`Read, Grep, Glob, mcp__triglav, mcp__host`), `--strict-mcp-config`.
- **No Bash.** A read-only-looking prefix is not read-only (`git log --output=FILE`). A host command it needs becomes a `HOST_TOOLS` entry with a fixed argv, a `.strict()` zod schema, and values limited to a short id, an enum or a bounded number. Never add a tool that takes options or a command string.
- The token never appears in argv. The config is a 0600 file in a 0700 directory.
- `/operator/mcp` is reachable only with a chat token. Never expose it through `/mcp`, which agents can reach.

## Adding an action

1. Add an entry to `ACTIONS` in `src/operator-actions.ts`: `description`, zod `schema`, `describe(ctx, args)` and `run(ctx, args)`.
2. `describe` writes the card text **from the database** (use `jobRow`/`agentRow`), never from the model's words. The schema is parsed when proposed and again when run.
3. `run` does exactly what the matching dashboard button does. A tool `propose_<kind>` appears automatically in `src/operator.ts`.
4. If it must run on the machine, give `host: (args) => ({...})` instead of `run`; `decideAction` then inserts a `host` chat command, and `OperatorChats.host` in `scripts/operator.ts` runs it from a fixed list (today only `stop_session`, checking `ACTION_ID` and `SHORT_SESSION`). Extend that list and its validation too.
5. Update `OPERATOR_PROMPT` if the Operator needs guidance, and the Operator section of `web/src/user-guide.md`.

Behaviours already in place: max 10 pending cards per chat, a card expires after 30 min, a host action unanswered for 2 min fails (`expireHostActions`), a second click does nothing (state moves in one locked step), a denied request is reported to the Operator with "do not ask again".

## Settings

`ORCH_OPERATOR_MODEL` (default `claude-sonnet-5-5`) and `ORCH_OPERATOR_EFFORT` (default `medium`) in the runner's environment. `ORCH_CLAUDE_BIN` replaces the binary and `ORCH_RUNNER_CHAT_ONLY=1` makes the runner serve only the Operator; both are for tests.

## Tests

`test/chat.test.ts`, `test/operator-actions.test.ts`, `test/operator-host.test.ts`, `test/operator-runner.test.ts`, `test/chat-token-migration.test.ts`.
