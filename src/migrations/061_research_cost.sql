-- Phase 1 of docs/plans/researcher-access.md. What a research run used (from the final result of a Claude run's
-- stream-json; NULL for a Codex run or a run that was stopped before it printed one), and when its process exited, so a
-- persona stays busy until then. cost_usd is Claude Code's API-price figure, not a share of a plan window.
ALTER TABLE research_runs
  ADD COLUMN tokens_in BIGINT NULL,
  ADD COLUMN tokens_cache_write BIGINT NULL,
  ADD COLUMN tokens_cached BIGINT NULL,
  ADD COLUMN tokens_out BIGINT NULL,
  ADD COLUMN turns INT NULL,
  ADD COLUMN cost_usd DECIMAL(12,6) NULL,
  ADD COLUMN exited_at DATETIME(3) NULL;
-- The kinds a persona receives among question, proposal, review and client_decision. NULL means all of them, as before.
-- Mentions, view requests and decisions on its objections always reach it.
ALTER TABLE researcher_personas ADD COLUMN kinds JSON NULL;
