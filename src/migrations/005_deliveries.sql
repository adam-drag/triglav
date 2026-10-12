CREATE TABLE deliveries (
  id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  assignment_id VARCHAR(40) NOT NULL,
  attempt_number INT NOT NULL,
  reported_by VARCHAR(40) NOT NULL,
  pr_url VARCHAR(500) NOT NULL,
  head_sha VARCHAR(40) NOT NULL,
  copilot_summary TEXT NOT NULL,
  ci_summary TEXT NOT NULL,
  reported_at DATETIME(3) NOT NULL,
  confirmed_by VARCHAR(40) NULL,
  confirmed_at DATETIME(3) NULL,
  confirmation TEXT NULL,
  KEY idx_deliveries_job (job_id)
);
