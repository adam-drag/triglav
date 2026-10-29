-- A cancelled job no longer holds its ticket key, so the same ticket can be registered again. The key stays in
-- linear_issue_id for history; uniqueness moves to a column that is NULL while the job is cancelled.
ALTER TABLE jobs ADD COLUMN active_issue_key VARCHAR(64) GENERATED ALWAYS AS (IF(status = 'cancelled', NULL, linear_issue_id)) STORED;
ALTER TABLE jobs ADD UNIQUE KEY uq_jobs_active_issue (active_issue_key);
ALTER TABLE jobs ADD KEY idx_jobs_linear (linear_issue_id);
ALTER TABLE jobs DROP INDEX uq_jobs_linear;
