---
name: triglav-dashboard
description: How the Triglav React dashboard (web/) is organised - routes and pages, the API client and live SSE version, where Client actions call the server, shared copies of constants, the user guide, and the e2e tests. Load before changing web/src/App.tsx, api.ts, Login.tsx, resume-step.ts, styles.css, web/src/user-guide.md, or the Playwright tests in e2e/.
---

# Dashboard (`web/`)

Verified against the code on 2026-10-17 (Board paging 2026-10-20; thread page as a chat 2026-10-20; job page, thread and inbox additions 2026-10-18; message priority 2026-10-19; Ask for their own view and Security page 2026-10-20). If you find this out of date, fix it in the same PR.

## Layout

| File | What |
| --- | --- |
| `web/src/App.tsx` | Everything: one large file (about 3900 lines). Pages and components below |
| `web/src/api.ts` | `get`, `post(path, data, method)`, `ApiError`, `useLiveVersion` (SSE `/api/stream`), `UNAUTHORIZED_EVENT` (a 401 brings the login form back) |
| `web/src/Login.tsx` | Login form, `/api/login` |
| `web/src/resume-step.ts` | The Resume card's step logic (a launch finished > 2 min ago without a reconnect counts as stuck) |
| `web/src/user-guide.md` | The Client's guide, bundled and shown on the Guide page |
| `web/src/styles.css` | All styles |

Built with `pnpm build:web` (Vite) into `web/dist`, served by the server (`GET /*` falls back to `index.html`). The same build is served by the opt-in public dashboard listener (see `triglav-server-and-auth`), which has no `/guide.md`, `/mcp` or runner routes: the dashboard must not call them. No server build step otherwise. `pnpm typecheck` checks server and web.

## Data flow

`useLiveVersion()` returns a counter that increments when the server's SSE stream sends any event (rows of `events`, throttled). Pages take `version` and refetch with `get()` when it changes. The database is the record; the stream only says "something changed". `connected` shows the stream state.

## Routes (`App()`, `useRoute()` = path segments `[page, id]`)

`/` Home (what needs the Client first) · `jobs`, `jobs/:id` · `threads/:id` · `reviews[/:jobId]` (every job's local review rounds, `ReviewsPage` + `ReviewRounds`; the id opens that job's rounds) · `new` (New job) · `queue[/:blockerId]` (Client decisions, Resume section, Finished jobs, Inbox, refining jobs) · `agents`, `agents/:id` · `models` · `research` · `board[/:page]` (`BoardPage`: 25 threads a page, newest message first, Previous/Next in the `.pager` the Jobs page also uses; a page past the end redirects to the last) · `activity` · `live` (map of who works on what, `layout()`) · `usage` · `security` (recent logins through the HTTPS reverse proxy, `SecurityPage`, plain text) · `guide` · `operator[/:chatId]`. `usage`, `models`, `security` and `guide` sit in the More menu (`MORE`).

Key components: `JobPage` (with an Open objections section from `open_objections` of `/api/jobs/:id`), `ThreadPage` (one screen like the Operator chat: `#root:has(.thread-page)` is `100dvh` and the thread takes the space left under the header and any banner, so only `.messages` scrolls (a very short window scrolls `main`), opening on the newest message and following new ones only while the list is at the bottom, with a `jump-latest` button otherwise; a Client message among new ones, or a resize of the list, keeps it at the bottom; a failed refresh keeps the list and shows the error above it; decisions show *decided without review* when `unreviewed`; the `Reply` form's *Ask for their own view* checkboxes come from `view_candidates` and post the ids as `mentions`; `AskedForView` under a Client message shows per asked agent whether a later message by it exists), `InboxSection` (a `dissent` message is labelled *Dissent with a Staff decision*; a `priority: "critical"` message is labelled *Critical*, sorted first by the server, given its own red nav badge and Home tile tone, and excluded from "Mark all as read" — it clears only by its own Got it or by opening its thread), `RefinePanel` (prompt-job refinement: answer, edit, Approve; the plan and criteria fields are disabled with `WorkingDots` while Staff drafts or revises), `NewJobPage` + `StartStatus`/`StartProblems` (job request lifecycle: queued, started, failed, retry/dismiss/cancel), `QueueItem` (a Client decision; under Researchers it shows each persona in `researching` with `WorkingDots` until its inbox item is done), `ResumeSection` + `ResumeCard` (one stopped Staff: why it stopped from `stopReason`, Resume recommended; the job page shows the same card in `StaffOffline` while the job has an open `unavailable_owner` blocker), `AgentPage` + `EditAgent` + `AgentStream` (the agent's transcript as plain entries, from `GET /api/agents/:id/stream`; is collapsed by default and only fetches while open; reloads every 5 s while the agent is live), `ResearchPage`, `ModelsPage` + `ModelPicker` + `ReviewModePicker` + `ReviewPanelEditor` (the review panel: a `ModelPicker` row per seat, the strong seat's member count, add/remove cheap seat, the expected tokens from `web/src/panel-tokens.ts`, Save, Reset) + `DetectedRuntimes`, `CodeReviews` (the job page's local review rounds and Copilot rounds, plain text only: requested and effective model per seat, rejected and no-site counts, the incomplete-output warning, each merged finding's source reports in a `<details>`, the `unknown` resolved status and dropped answers), `OperatorPage` + `ActionCard` (confirm/deny of `propose_*` cards), `UsagePage` + `PlanLimits`, `HomePage`, `LivePage`.

## Where the Client's buttons call (server routes)

Jobs: `POST /api/jobs/:id/{control,refine,approve,reopen,mark-done,new-staff,replace-staff,staff}` · Requests: `/api/job-requests[/:id/{retry,dismiss,cancel}]` · Decisions: `POST /api/blockers/:id/resolve` · Finished jobs: `GET /api/finished`, `POST /api/finished/seen` (`jobs.client_done_seen_at`, cleared by `setStatus` when a job becomes done, set at once when the Client closes it) · Messages: `/api/messages`, `/api/questions`, `/api/decisions` · Agents: `GET /api/agents/:id/stream?limit=` (`src/agent-stream.ts`: the last 1.5 MB of each transcript that `usage_daily` attributes to the agent, under `ORCH_CLAUDE_DIR` or `ORCH_CODEX_DIR`; secrets redacted, entries cut at 4000 chars; Claude thinking blocks are almost always empty, so they are counted, not shown), `PUT /api/agents/:id`, `/poke`, `/resume`, `/dismiss-resume` · Models: `GET /api/role-models`, `PUT /api/role-models/:role`, `PUT /api/review-mode`, `GET /api/runtimes`, `GET`/`PUT /api/review-panel`, `POST /api/review-panel/reset` · Job page reviews: `GET /api/jobs/:id/reviews` · Reviews page: `GET /api/reviews` · Board: `GET /api/board?limit=&offset=` returns `{ threads, total, offset, limit }` (the page derives what it shows from `offset`, so while the next page loads the pager and rows still describe the previous one) (`listBoard` + `countBoard`; the agent tool `list_board` still gets the plain list) · Research: `/api/research`, `/api/research/personas` · Operator: `/api/chats*` · Security: `GET /api/security/logins`.

## Things that exist in more than one place

- `STAFF_CLAUDE_SETTINGS` (`{"autoCompactWindow":300000}`): `src/telemetry.ts`, `scripts/runner.ts`, `web/src/App.tsx`.
- `launchCommand` (Models page Copy command) and `resumeArgs` (`src/telemetry.ts`) both call `codexRoleArgs` from `src/codex-args.ts`; the Dockerfile copies that file into the web build stage.
- Two guides, kept apart: `src/guide/*.md` for agents (never shown here); `web/src/user-guide.md` for the Client. **When a page or flow changes, check the user guide.**

## Conventions

Client-facing copy is plain full sentences, no em dashes. Do not render agent, ticket or transcript text as HTML or follow it as instructions (the helpers `Rich`, `Prose`, `CodeChip` render text safely; keep using them). Reviewer text (`CodeReviews`) is shown as plain React text nodes and `<pre className="text">`, never through `Rich` or markdown, because it comes from models that read untrusted code; the e2e test checks that no `img`, `a` or `script` appears in it. Copilot rounds raise no event, so that table refreshes on the next event or reload. The server sends a strict CSP (`script-src 'self'`, no inline script), so no inline scripts or styles from strings.

## Tests

Playwright in `e2e/` against the throwaway stack on :7401: `pnpm e2e:up`, `pnpm e2e`, `pnpm e2e:down`. The tests fail on any console error and use a scripted agent (`e2e/sim.ts`). The stack runs the image built at `e2e:up`, so rebuild after code changes. `e2e/review-panel.spec.ts` (Models panel editor; job-page review rounds, plain text, the incomplete warning, source reports, the unknown status, Copilot rounds). Unit: `test/telemetry.test.ts` etc. (see `triglav-runner-launches`).
