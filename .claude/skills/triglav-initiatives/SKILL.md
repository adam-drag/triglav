---
name: triglav-initiatives
description: How Triglav initiatives work - the versioned design document (blocks, ops, diffs), import, the initiative room in the dashboard, the Architect (a read-only Claude Code chat per initiative with its own args builder, worktrees at origin/<base> and token-scoped /architect/mcp), design revisions with Client Confirm, and the Claude Code flag probe. Load before changing src/design.ts, src/initiatives.ts, src/architect.ts, src/architect-args.ts, scripts/initiative-worktrees.ts, the Architect parts of scripts/operator.ts or src/chat.ts, src/guide/architect.md, web/src/initiatives.tsx, or migration 052.
---

# Initiatives

Verified against the code on 2026-11-17 (phase 1 of docs/plans/initiative-room.md). If you find this out of date, fix it in the same PR. The invariant is in AGENTS.md ("An Architect reads one initiative and proposes; the Client decides"); this is the map. Phases 2 to 5 (startable job cards, gate checks, `gh` host tools, Staff routing, addenda) are not built.

## Pieces

| Piece | File | Role |
| --- | --- | --- |
| Design document | `src/design.ts` | Pure. `BlockSchema` (strict, one kind per id scheme: `D<n>` decision, `O-` open, `C-` contract, `CP-` checkpoint, `W-` wave, `T-` text, `DOD-`, job card by key), `GateSchema` (merged, deployed, decision, milestone, client_step), `checkDoc` (schema, unique ids, references), `OpsSchema` (add, update with `set`, null drops a field, remove; max 100), `applyOps`, `describeRevision`, `blockDiff`, `stable` |
| Store | `src/initiatives.ts` | `importInitiative`, `getInitiative` (with `updated_in`), `versionDiff`, `revisionView`, `storeRevision`, `describeStoredRevision` + `cardText`, `applyRevision`, `closeRevision` |
| Tables | `src/migrations/052_initiatives.sql` | `initiatives`, `initiative_versions` (immutable, PK initiative + version, `changed` ids, `trigger_kind` import or chat, `trigger_ref`), `initiative_revisions` (pending, applied, denied, expired, stale), `chats.kind` + `chats.initiative_id`, the `architect` row of `role_models` |
| Architect tools | `src/architect.ts` | `buildArchitectServer(ctx, chatId, initiativeId)`: `get_initiative`, `get_design`, `propose_design_revision`. Scoped to the chat's initiative; another key is refused |
| Confirm action | `src/operator-actions.ts` | `ARCHITECT_ACTIONS.apply_design_revision`; `actionsFor(chat kind)`: an Architect chat proposes only this, an Operator chat never can. `close` marks the revision denied or expired |
| Architect args | `src/architect-args.ts` | `architectArgs`, `architectPrompt`. Pure, its own builder. Never `operatorArgs` |
| Worktrees | `scripts/initiative-worktrees.ts` | `prepareWorktrees(root, key, repos, home, env)` |
| Host process | `scripts/operator.ts` | `OperatorChats.start` branches on `cmd.chat_kind === 'architect'`: `checkedArchitect`, worktrees, `architectMcpConfig` (server `initiative` only), `architectArgs`, cwd = the initiative folder |
| Routes | `src/server.ts` | `/architect/mcp` (Architect chat token only), `GET`/`POST /api/initiatives`, `GET /api/initiatives/:key[?version=]`, `.../versions/:v/diff`, `.../revisions/:id` (Client) |
| Room | `web/src/initiatives.tsx` | `InitiativesPage` (list, import), `InitiativePage` (Design tab, History tab, version picker, Architect pane, phone pane toggle). The chat pane is shared with the Operator in `web/src/chat.tsx` |
| Card | `src/guide/architect.md` | The Architect's system prompt (`--append-system-prompt`), also served by `get_guide` role `architect` |

## Flow

1. The Client imports a JSON file (`ImportSchema`: key, title, repos, cap, milestones_open, version, source, doc). The design is checked whole; the first version is the given `version` (default 1), trigger `import`, `trigger_ref` = source. An Architect chat (kind `architect`, state stopped) is created with it.
2. A Client message in the room's pane is a normal chat `send` command. `nextCommand` adds `chat_kind: 'architect'` and `architect` (key, title, repos, model and effort from the `architect` role, Claude Code only).
3. The runner prepares the worktrees (below), mints the chat token, writes the 0600 MCP config, and starts `claude` with `architectArgs` in the initiative folder. A repository it could not prepare becomes a system message in the chat and a line in the prompt.
4. `propose_design_revision` checks the ops against the current version, stores the revision (pending) and proposes `apply_design_revision`. The card text is `describeStoredRevision`: built from the base version and the stored ops, never from the model's words, capped by `cardText` (the room's History has every change).
5. Confirm: `applyRevision` locks the initiative, refuses (and marks stale) a revision whose base is no longer current, and inserts version N+1 with trigger `chat`, `trigger_ref` = the revision id and the changed ids. Deny or expiry: `closeRevision`. A second click does nothing (the action moves state in one locked step).

## Worktrees

`~/.local/state/triglav/initiatives/<key>/<slug>` (folder 0700; `ORCH_INITIATIVES_DIR` overrides it for tests). Each is a linked, detached, locked worktree of the Client's checkout at `refs/remotes/origin/<base>`, after `git fetch origin <base>`. Every git call has `core.symlinks=false` (a link becomes a plain file holding its target), `core.hooksPath=/dev/null` and `GIT_TERMINAL_PROMPT=0`. The repository path must be inside the home folder and the top of a checkout; an existing folder is refreshed only when it is a worktree of the same repository. Refreshed only when an Architect process starts, not per message. `reapWorktree` refuses any path under the initiatives folder.

The fetch runs with `staffStartEnv(process.env)`, which keeps `SSH_AUTH_SOCK` and `HOME`, so an SSH remote and the user's git credential helper work as for a Staff. A failed fetch keeps the commit the worktree has and says so.

## The flags probe (Claude Code 2.1.304, 2026-11-17)

Run under `-p --input-format stream-json --output-format stream-json` with the Architect's flags, in a scratch folder with an `inside/` (allowed) and `outside/` folder, a stdio MCP ping server, and a project `.claude/settings.json` with a SessionStart hook and an allow rule for `outside/`:

- The init tool list was `Glob, Grep, Read, mcp__probe__ping`: no Bash, Write or ToolSearch, and MCP tools were not deferred.
- Read and Grep inside the allowed folder were allowed. Read, Grep and Glob outside were denied.
- A symlinked file and a symlinked folder inside, pointing outside, were both denied on Read. Grep inside did not follow the linked folder.
- `~/.claude/settings.json` could not be read, although the user's own settings allow `Read(//home/adam/**)`: `--setting-sources ""` loaded none.
- The project settings did not load: the hook did not run and the outside allow rule did not apply.
- The MCP tool was allowed by `mcp__probe`.

Re-run it after a Claude Code upgrade that changes permissions or settings loading.

## Gaps (phase 1)

- No `agents` row for the Architect yet (`initiatives.architect_agent_id` stays null); the Roster does not show it.
- Job cards are design blocks only: no job starts from them, no gate is checked, no live card state.
- The Architect's replies are stored with chat role `operator`, the same as the Operator's; the room labels them as the Architect's. They are never stored as `client`.

## Tests

`test/design.test.ts` (fixture D1 to D16, ops, key order, card length), `test/architect-args.test.ts` (args pinned, worktrees with a planted symlink, reaper), `test/initiatives.test.ts` (import at v17, start payload, scope, propose, Confirm, Deny, stale, tokens on `/mcp`, `/operator/mcp`, `/architect/mcp`), `e2e/initiatives.spec.ts` (stub Architect, Confirm, v18 marks, History, phone toggle, Models row). The fixture is `e2e/fixtures/public-template-pages.json`.
