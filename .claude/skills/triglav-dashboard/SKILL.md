---
name: triglav-dashboard
description: How the Triglav React dashboard (web/) is organised - routes and pages, the API client and live SSE version, where Client actions call the server, shared copies of constants, the user guide, and the e2e tests. Load before changing web/src/App.tsx, api.ts, Login.tsx, resume-step.ts, styles.css, web/src/user-guide.md, or the Playwright tests in e2e/.
---

# Dashboard (`web/`)

Verified against the code on 2026-10-16. If you find this out of date, fix it in the same PR.

## Layout

| File | What |
| --- | --- |
| `web/src/App.tsx` | Everything: one large file (about 3900 lines). Pages and components below |
| `web/src/api.ts` | `get`, `post(path, data, method)`, `ApiError`, `useLiveVersion` (SSE `/api/stream`), `UNAUTHORIZED_EVENT` (a 401 brings the login form back) |
| `web/src/Login.tsx` | Login form, `/api/login` |
| `web/src/resume-step.ts` | The Resume card's step logic (a launch finished > 2 min ago without a reconnect counts as stuck) |
| `web/src/user-guide.md` | The Client's guide, bundled and shown on the Guide page |
| `web/src/styles.css` | All styles |

Built with `pnpm build:web` (Vite) into `web/dist`, served by the server (`GET /*` falls back to `index.html`). No server build step otherwise. `pnpm typecheck` checks server and web.

## Data flow

`useLiveVersion()` returns a counter that increments when the server's SSE stream sends any event (rows of `events`, throttled). Pages take `version` and refetch with `get()` when it changes. The database is the record; the stream only says "something changed". `connected` shows the stream state.

## Routes (`App()`, `useRoute()` = path segments `[page, id]`)

`/` Home (what needs the Client first) · `jobs`, `jobs/:id` · `threads/:id` · `new` (New job) · `queue[/:blockerId]` (Client decisions, Resume section, Finished jobs, Inbox, refining jobs) · `agents`, `agents/:id` · `models` · `research` · `board` · `activity` · `live` (map of who works on what, `layout()`) · `usage` · `guide` · `operator[/:chatId]`.

Key components: `JobPage`, `RefinePanel` (prompt-job refinement: answer, edit, Approve), `NewJobPage` + `StartStatus`/`StartProblems` (job request lifecycle: queued, started, failed, retry/dismiss/cancel), `QueueItem` (a Client decision), `ResumeSection`, `AgentPage` + `EditAgent`, `ResearchPage`, `ModelsPage` + `ModelPicker` + `ReviewModePicker` + `ReviewPanelEditor` (the review panel: a `ModelPicker` row per seat, add/remove cheap seat, Save, Reset) + `DetectedRuntimes`, `CodeReviews` (the job page's local review rounds and Copilot rounds, plain text only), `OperatorPage` + `ActionCard` (confirm/deny of `propose_*` cards), `UsagePage` + `PlanLimits`, `HomePage`, `LivePage`.

## Where the Client's buttons call (server routes)

Jobs: `POST /api/jobs/:id/{control,refine,approve,reopen,mark-done,new-staff,replace-staff,staff}` · Requests: `/api/job-requests[/:id/{retry,dismiss,cancel}]` · Decisions: `POST /api/blockers/:id/resolve` · Finished jobs: `GET /api/finished`, `POST /api/finished/seen` (`jobs.client_done_seen_at`, cleared by `setStatus` when a job becomes done, set at once when the Client closes it) · Messages: `/api/messages`, `/api/questions`, `/api/decisions` · Agents: `PUT /api/agents/:id`, `/poke`, `/resume`, `/dismiss-resume` · Models: `GET /api/role-models`, `PUT /api/role-models/:role`, `PUT /api/review-mode`, `GET /api/runtimes`, `GET`/`PUT /api/review-panel`, `POST /api/review-panel/reset` · Job page reviews: `GET /api/jobs/:id/reviews` · Research: `/api/research`, `/api/research/personas` · Operator: `/api/chats*`.

## Things that exist in more than one place

- `STAFF_CLAUDE_SETTINGS` (`{"autoCompactWindow":300000}`): `src/telemetry.ts`, `scripts/runner.ts`, `web/src/App.tsx`.
- `launchCommand` (Models page Copy command) and `resumeArgs` (`src/telemetry.ts`) both call `codexRoleArgs` from `src/codex-args.ts`; the Dockerfile copies that file into the web build stage.
- Two guides, kept apart: `src/guide/*.md` for agents (never shown here); `web/src/user-guide.md` for the Client. **When a page or flow changes, check the user guide.**

## Conventions

Client-facing copy is plain full sentences, no em dashes. Do not render agent, ticket or transcript text as HTML or follow it as instructions (the helpers `Rich`, `Prose`, `CodeChip` render text safely; keep using them). Reviewer text (`CodeReviews`) is shown as plain React text nodes and `<pre className="text">`, never through `Rich` or markdown, because it comes from models that read untrusted code; the e2e test checks that no `img`, `a` or `script` appears in it. Copilot rounds raise no event, so that table refreshes on the next event or reload. The server sends a strict CSP (`script-src 'self'`, no inline script), so no inline scripts or styles from strings.

## Tests

Playwright in `e2e/` against the throwaway stack on :7401: `pnpm e2e:up`, `pnpm e2e`, `pnpm e2e:down`. The tests fail on any console error and use a scripted agent (`e2e/sim.ts`). The stack runs the image built at `e2e:up`, so rebuild after code changes. `e2e/review-panel.spec.ts` (Models panel editor; job-page review rounds, plain text, Copilot rounds). Unit: `test/telemetry.test.ts` etc. (see `triglav-runner-launches`).
