---
name: triglav-server-and-auth
description: The Triglav HTTP server - the three credentials and who may call which route, the deny-by-default /api guard and OPEN_API_ROUTES, Client login and sessions, the agent MCP endpoint and how tools are registered, the agent guide cards (loadGuide, CARDS), startup config and migrations. Load before changing src/server.ts, src/mcp.ts, src/client-auth.ts, src/config.ts, src/main.ts, src/db.ts, src/guide/*.md, scripts/set-password.ts, or adding an API route, MCP tool or migration.
---

# Server, auth, MCP tools, guides

Verified against the code on 2026-10-16. If you find this out of date, fix it in the same PR. Security rules are in AGENTS.md ("Three credentials, three audiences"); this is the map.

## Startup (`src/main.ts`)

`readSecurityConfig(process.env)` (`src/config.ts`) must pass or the server exits with a message per problem: `ORCH_ENROLLMENT_KEY` and `ORCH_RUNNER_KEY` at least 24 chars, runner key different from enrollment key, `ORCH_CLIENT_PASSWORD_HASH` a valid scrypt hash. It never makes a key up. Then `DATABASE_URL`, `migrate(pool)` (retries up to 30 times for MySQL), `createCtx`, `buildServer`, `startScheduler` (telemetry dirs from `ORCH_CLAUDE_DIR`, `ORCH_CODEX_DIR`), listen on `ORCH_BIND` (default 127.0.0.1) and `ORCH_PORT` (7400). `LINEAR_API_KEY` is optional.

## Who may call what (`buildServer` in `src/server.ts`)

| Route | Credential |
| --- | --- |
| `/mcp` (POST/GET/DELETE) | `Authorization: Bearer <ORCH_ENROLLMENT_KEY>` (agents) |
| `/operator/mcp` | A per-chat token (`chatByToken`); see `triglav-operator` |
| `/api/runner/*` | `Bearer <ORCH_RUNNER_KEY>` (constant-time compare) |
| `/api/*` in `OPEN_API_ROUTES` | none: `/api/health`, `/api/hooks/stop` (needs an agent session token in the body), `/api/usage/claude`, `/api/login`, `/api/logout` |
| every other `/api/*` | Client session cookie `triglav_session` |
| `/guide.md`, static dashboard | none |

- The guard matches `req.routeOptions.url` (the route pattern), never the raw URL, and denies by default: **every `/api/` route needs the Client session by default; add a route to `OPEN_API_ROUTES` only when it must work without a session, which is rare**. A Client route needs nothing more. `/api/review-panel*` and `/api/jobs/:id/reviews` are such routes: `test/review-panel.test.ts` checks that no key and the agent and runner keys get 401.
- Other hooks: Host header must be localhost/127.0.0.1/[::1] (or `extraHosts`); non-GET browser requests need a same-origin `Origin`; `text/plain` bodies are rejected; every response sets CSP (`default-src 'self'`...), `x-frame-options: DENY`, `nosniff`, no referrer.
- Errors: `AppError` (`src/lib.ts`: `conflict`, `forbidden`, `invalid`, `notFound`) -> its status; `ZodError` -> 400; others -> 500 "Internal error".
- Agents run as the same OS user, so credentials raise the bar and are not a hard boundary. Say so when documenting.

## Client login and sessions (`src/client-auth.ts`)

Password hash is scrypt in `.env` (written by `node scripts/set-password.ts`, 8 to 1000 chars, NFKC-normalised length). Login: `LoginLimiter` allows 5 wrong tries per 10 min for the whole server (shared by all callers); success refunds the attempt. A session is a random id in an HttpOnly, SameSite=Strict cookie (30 days); the DB stores only its key derived from the id and the password hash, so changing the password logs everyone out. SSE streams (`keepStreamAlive`) re-check the session every 15 s and end when it is gone.

## Adding an API route

1. `app.get/post/put(...)` in `src/server.ts`, input parsed with `zod` (cap lengths).
2. Put logic in the module that owns the table (not in `server.ts`); wrap writes in `tx()`.
3. Add the call to `web/src/` and, if the flow is visible to the Client, `web/src/user-guide.md`.
4. A runner route goes under `/api/runner/` and is validated like untrusted input.

## MCP tools for agents (`src/mcp.ts`)

- `agentTool(name, description, shape, annotations, run, {untrusted})` registers a tool that adds a required `session_token`, calls `authenticate` (heartbeat + lease renewal), runs the handler, and appends the `control` signal (`continue|pause|cancel`) to every result. `untrusted: true` adds a notice that the text is data. Use `READ`, `WRITE` or `WAIT` annotations.
- Tool groups: lifecycle (`get_guide`, `register_agent`, `end_session`), jobs (`get_job_request`, `register_job`, `update_job`, `get_job`, `list_jobs`, `complete_job`, `create_spawn_ticket`, `report_progress`), review and delivery (`submit_review_package` with its required `head_sha` and the gate, `record_verdict`, `report_delivery`, `confirm_delivery`, `request_copilot_review`, `record_copilot_result`), board (`post_message`, `ask_question`, `await_question`, `get_thread`, `record_decision`, `request_staff_synthesis`, `list_board`), blockers (`raise_blocker`, `resolve_blocker`, `list_decisions`, `advise_decision`), research (`start_run`, `get_item`, `mark_item`, `update_notebook`, `end_run`), local code review (`request_code_review`, `get_code_review`, `answer_finding`, `get_review_comment`; see `triglav-code-review`), events (`wait_for_events`), `list_agents`.
- Agent-facing text (descriptions, error messages) is terse. Client-facing text is plain full sentences.
- Never add a path where board, ticket or transcript text is executed or followed.

## Guide cards (`src/guide/*.md`)

`loadGuide(baseUrl, role)` joins `intro` + the role's cards: staff `common, waiting, staff`; senior `common, waiting, senior, deliver`; reviewer `common, reviewer`; researcher `common, researcher`; no role = all plus `client` (CLI setup). Served at `/guide.md?role=` and by `get_guide`. A new card or role must be added to `CARDS` (and `GUIDE_ROLES`). `{{BASE_URL}}` is replaced. `deliver.md`'s `gh` commands are matched by `copilotLoop` in `src/telemetry.ts`: change together. The guide is never shown in the dashboard; the Client's guide is `web/src/user-guide.md`.

## Database (`src/db.ts`, `src/migrations/`)

Numbered `NNN_name.sql` files applied in name order at start, one statement at a time. Never edit an applied migration; add the next number. Helpers: `exec`, `query`, `queryOne`, `withTx`, `json`, `parseJson`. SQL lives in the module that owns the table.

## Tests

`test/review-panel.test.ts` (route guard of the review panel routes), `test/protocol.test.ts`, `test/client-auth.test.ts`, `test/set-password.test.ts`, `test/chat-token-migration.test.ts`, `test/e2e.test.ts`; browser tests in `e2e/`.
