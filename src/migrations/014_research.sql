CREATE TABLE researcher_personas (
  id VARCHAR(40) PRIMARY KEY,
  agent_id VARCHAR(40) NOT NULL,
  nickname VARCHAR(100) NOT NULL UNIQUE,
  focus TEXT NOT NULL,
  repo_path VARCHAR(500) NOT NULL,
  model VARCHAR(100) NOT NULL,
  effort VARCHAR(20) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL
);
CREATE TABLE research_inbox (
  id VARCHAR(40) PRIMARY KEY,
  persona_id VARCHAR(40) NOT NULL,
  kind VARCHAR(30) NOT NULL,
  job_id VARCHAR(40) NULL,
  thread_id VARCHAR(40) NULL,
  blocker_id VARCHAR(40) NULL,
  event_id BIGINT NOT NULL,
  title VARCHAR(300) NOT NULL,
  due_at DATETIME(3) NULL,
  status VARCHAR(20) NOT NULL,
  note TEXT NULL,
  run_id VARCHAR(40) NULL,
  attempts INT NOT NULL DEFAULT 0,
  open_key VARCHAR(120) NULL UNIQUE,
  created_at DATETIME(3) NOT NULL,
  done_at DATETIME(3) NULL,
  INDEX (persona_id, status)
);
CREATE TABLE research_runs (
  id VARCHAR(40) PRIMARY KEY,
  persona_id VARCHAR(40) NOT NULL,
  ticket_hash CHAR(64) NOT NULL UNIQUE,
  session_id VARCHAR(40) NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  started_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  result TEXT NULL,
  budget_pct_before DECIMAL(5,1) NULL,
  INDEX (persona_id, status)
);
CREATE TABLE researcher_notebook (
  persona_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (persona_id, job_id)
);
CREATE TABLE codex_budget (
  id TINYINT PRIMARY KEY,
  used_percent DECIMAL(5,1) NOT NULL,
  window_minutes INT NULL,
  resets_at DATETIME(3) NULL,
  weekly_used_percent DECIMAL(5,1) NULL,
  weekly_resets_at DATETIME(3) NULL,
  observed_at DATETIME(3) NOT NULL
);
ALTER TABLE launches ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'resume', ADD COLUMN run_id VARCHAR(40) NULL, ADD COLUMN ticket VARCHAR(100) NULL, MODIFY session_id VARCHAR(64) NULL;
