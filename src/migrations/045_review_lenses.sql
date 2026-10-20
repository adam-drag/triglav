-- Lens seats of the local review panel (src/code-review.ts, LENSES): the lens of a seat's prompt and whether the seat runs
-- in shadow mode. A shadow finding (only shadow seats reported it) is stored and shown but never blocks.
ALTER TABLE code_review_runs ADD COLUMN lens VARCHAR(20) NULL, ADD COLUMN shadow TINYINT NOT NULL DEFAULT 0;

ALTER TABLE code_review_findings ADD COLUMN shadow TINYINT NOT NULL DEFAULT 0;
