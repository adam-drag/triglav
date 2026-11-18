-- Routing to the Architect (docs/plans/initiative-room.md, phase 3). architect_woken_at is the last wake of the Architect's
-- chat; architect_wake_pending holds the questions that arrived inside the interval, as JSON, until the scheduler flushes
-- them. NULL means nothing is waiting.
ALTER TABLE initiatives
  ADD COLUMN architect_woken_at DATETIME(3) NULL,
  ADD COLUMN architect_wake_pending TEXT NULL;
