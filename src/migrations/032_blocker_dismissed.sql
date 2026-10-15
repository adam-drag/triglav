-- The Client looked at a decision and it no longer applies (job already finished another way, situation changed).
ALTER TABLE blockers ADD COLUMN dismissed_at DATETIME(3) NULL;
