-- An implementation job started from a research report. The request and the job name the research job and the report
-- version, so the new Staff may read that report (get_report) and the job page links back to it.
ALTER TABLE job_requests ADD COLUMN from_job_id VARCHAR(40) NULL;
ALTER TABLE job_requests ADD COLUMN from_report_version INT NULL;
ALTER TABLE jobs ADD COLUMN from_job_id VARCHAR(40) NULL;
ALTER TABLE jobs ADD COLUMN from_report_version INT NULL;
-- A prompt may be up to 50,000 characters (MAX_PROMPT), more than TEXT holds in utf8mb4.
ALTER TABLE job_requests MODIFY prompt MEDIUMTEXT NULL;
-- Staff splits a job into subjobs, one per repository, and the Client approves the split before any Senior starts.
-- subjobs is the proposed list (key, title, repo_path, base_branch, scope, depends_on). status: pending, approved, returned.
CREATE TABLE job_splits (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  version INT NOT NULL,
  subjobs JSON NOT NULL,
  status VARCHAR(12) NOT NULL,
  note TEXT NULL,
  proposed_by VARCHAR(40) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  UNIQUE KEY job_splits_version (job_id, version)
)
