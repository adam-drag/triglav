-- Architect auto mode (the triglav-initiatives skill, "Auto mode"). The Client switches it on per initiative; it is on while
-- auto_mode_until is in the future. auto_mode_refusals counts the Architect's refused citations in a row while it is on.
-- 068, not 067: two jobs in flight each add a 067 file (chat images, suggested replies).
ALTER TABLE initiatives
  ADD COLUMN auto_mode_until DATETIME(3) NULL,
  ADD COLUMN auto_mode_refusals INT NOT NULL DEFAULT 0;

-- An auto decision is an architect_answers row with auto = 1 and target blocker. decision_kind is technical or product.
-- hold_until is when a held product decision is posted. reviewed_at is set when the Client marks it Keep. The states add
-- held (a product decision waiting out its hold) and undone (the Client took it back before it was posted).
ALTER TABLE architect_answers
  ADD COLUMN auto TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN decision_kind VARCHAR(10) NULL,
  ADD COLUMN hold_until DATETIME(3) NULL,
  ADD COLUMN reviewed_at DATETIME(3) NULL,
  ADD INDEX architect_answers_held (state, hold_until);
