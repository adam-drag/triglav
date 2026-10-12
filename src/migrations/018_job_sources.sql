ALTER TABLE launches MODIFY agent_id VARCHAR(40) NULL;
CREATE TABLE job_requests (
  id VARCHAR(40) PRIMARY KEY,
  mode VARCHAR(10) NOT NULL,
  source_url VARCHAR(2000) NULL,
  prompt TEXT NULL,
  repo_path VARCHAR(500) NOT NULL,
  base_branch VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL,
  launch_id VARCHAR(40) NULL,
  staff_agent_id VARCHAR(40) NULL,
  job_id VARCHAR(40) NULL,
  error TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX (status, created_at)
);
ALTER TABLE jobs ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'linear'
