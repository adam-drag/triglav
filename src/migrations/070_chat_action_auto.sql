-- An action the Architect ran in auto mode, without a Confirm: mark_pr_ready only (src/operator-actions.ts, runAutoAction).
-- The card shows it ran in auto mode, and the Architect is told it was not the Client who confirmed it.
ALTER TABLE chat_actions ADD COLUMN auto TINYINT(1) NOT NULL DEFAULT 0;
