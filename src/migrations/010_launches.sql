CREATE TABLE launches (
  id VARCHAR(40) PRIMARY KEY,
  agent_id VARCHAR(40) NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  cwd VARCHAR(500) NOT NULL,
  requested_at DATETIME(3) NOT NULL,
  picked_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  result TEXT NULL,
  INDEX (picked_at)
);
