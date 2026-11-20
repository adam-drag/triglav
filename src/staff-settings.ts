/**
 * The `--settings` value of a Claude Code Staff session. A constant, never read from the environment, and no imports: the
 * server (`src/telemetry.ts`), the host runner (`scripts/runner.ts`) and the dashboard (`web/src/App.tsx`) all use it, so
 * the dashboard's web build stage copies this one file (Dockerfile).
 *
 * Staff sessions compact at about 280k tokens instead of the default 980k (Claude Code 2.1.292: autoCompactWindow 300000
 * gives effectiveWindow=280000). Each turn re-reads the whole context, so this is the main cost lever.
 */
export const STAFF_CLAUDE_SETTINGS = '{"autoCompactWindow":300000}' as const;
