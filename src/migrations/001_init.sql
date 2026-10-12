CREATE TABLE agents (
  id VARCHAR(40) PRIMARY KEY,
  nickname VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL,
  focus VARCHAR(200) NULL,
  runtime VARCHAR(40) NOT NULL,
  model VARCHAR(100) NULL,
  parent_agent_id VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL
);

CREATE TABLE agent_sessions (
  id VARCHAR(40) PRIMARY KEY,
  agent_id VARCHAR(40) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  started_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  waiting_until DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  end_reason VARCHAR(40) NULL,
  KEY idx_sessions_agent (agent_id)
);

CREATE TABLE jobs (
  id VARCHAR(40) PRIMARY KEY,
  parent_job_id VARCHAR(40) NULL,
  linear_issue_id VARCHAR(64) NOT NULL,
  linear_identifier VARCHAR(40) NOT NULL,
  linear_url VARCHAR(500) NOT NULL,
  title VARCHAR(500) NOT NULL,
  required TINYINT NOT NULL DEFAULT 1,
  repo_path VARCHAR(500) NOT NULL,
  base_branch VARCHAR(200) NOT NULL,
  staff_agent_id VARCHAR(40) NULL,
  status VARCHAR(20) NOT NULL,
  previous_status VARCHAR(20) NULL,
  control VARCHAR(10) NOT NULL DEFAULT 'continue',
  acceptance_criteria TEXT NULL,
  plan TEXT NULL,
  linear_snapshot JSON NOT NULL,
  linear_state VARCHAR(100) NULL,
  linear_updated_at DATETIME(3) NULL,
  linear_fetched_at DATETIME(3) NOT NULL,
  linear_diverged TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_jobs_linear (linear_issue_id),
  KEY idx_jobs_parent (parent_job_id)
);

CREATE TABLE job_dependencies (
  job_id VARCHAR(40) NOT NULL,
  depends_on_job_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (job_id, depends_on_job_id)
);

CREATE TABLE assignments (
  id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  owner_agent_id VARCHAR(40) NULL,
  current_attempt INT NOT NULL DEFAULT 0,
  failed_attempts INT NOT NULL DEFAULT 0,
  lease_expires_at DATETIME(3) NULL,
  worktree_path VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_assignments_job (job_id)
);

CREATE TABLE attempts (
  assignment_id VARCHAR(40) NOT NULL,
  number INT NOT NULL,
  agent_id VARCHAR(40) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  outcome VARCHAR(30) NULL,
  last_progress TEXT NULL,
  PRIMARY KEY (assignment_id, number)
);

CREATE TABLE spawn_tickets (
  code_hash CHAR(64) PRIMARY KEY,
  issued_by VARCHAR(40) NOT NULL,
  assignment_id VARCHAR(40) NOT NULL,
  role VARCHAR(20) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  used_by VARCHAR(40) NULL
);

CREATE TABLE threads (
  id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  title VARCHAR(500) NOT NULL,
  assignment_id VARCHAR(40) NULL,
  created_by VARCHAR(40) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_threads_job (job_id)
);

CREATE TABLE messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  thread_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  author VARCHAR(40) NOT NULL,
  type VARCHAR(20) NOT NULL,
  stance VARCHAR(20) NOT NULL,
  reason TEXT NULL,
  body TEXT NOT NULL,
  in_reply_to BIGINT NULL,
  mentions JSON NOT NULL,
  intended_decision TINYINT NOT NULL DEFAULT 0,
  received_at DATETIME(3) NOT NULL,
  timely TINYINT NULL,
  KEY idx_messages_thread (thread_id)
);

CREATE TABLE questions (
  thread_id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  message_id BIGINT NOT NULL,
  asker VARCHAR(40) NOT NULL,
  owner_staff_id VARCHAR(40) NULL,
  window_sec INT NOT NULL,
  posted_at DATETIME(3) NOT NULL,
  deadline_at DATETIME(3) NOT NULL,
  requires_staff_decision TINYINT NOT NULL,
  state VARCHAR(30) NOT NULL,
  linear_updated_at DATETIME(3) NULL,
  KEY idx_questions_state (state, deadline_at)
);

CREATE TABLE decisions (
  id VARCHAR(40) PRIMARY KEY,
  thread_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  decided_by VARCHAR(40) NOT NULL,
  authority VARCHAR(10) NOT NULL,
  body TEXT NOT NULL,
  rationale TEXT NULL,
  considered_message_ids JSON NOT NULL,
  supersedes_decision_id VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_decisions_thread (thread_id)
);

CREATE TABLE review_packages (
  id VARCHAR(40) PRIMARY KEY,
  assignment_id VARCHAR(40) NOT NULL,
  attempt_number INT NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  round INT NOT NULL,
  summary TEXT NOT NULL,
  artifacts JSON NOT NULL,
  validation TEXT NOT NULL,
  limitations TEXT NULL,
  finding_dispositions JSON NOT NULL,
  submitted_at DATETIME(3) NOT NULL,
  KEY idx_packages_job (job_id)
);

CREATE TABLE review_verdicts (
  id VARCHAR(40) PRIMARY KEY,
  package_id VARCHAR(40) NOT NULL,
  reviewer VARCHAR(40) NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  findings JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_verdict_package (package_id)
);

CREATE TABLE blockers (
  id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  kind VARCHAR(30) NOT NULL,
  responsible VARCHAR(40) NOT NULL,
  requested_decision TEXT NOT NULL,
  recommendation TEXT NULL,
  unblock_condition TEXT NOT NULL,
  raised_by VARCHAR(40) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  resolved_by VARCHAR(40) NULL,
  resolution TEXT NULL,
  KEY idx_blockers_job (job_id)
);

CREATE TABLE events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(60) NOT NULL,
  job_id VARCHAR(40) NULL,
  thread_id VARCHAR(40) NULL,
  actor VARCHAR(40) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_events_job (job_id)
);

CREATE TABLE idempotency (
  actor VARCHAR(40) NOT NULL,
  request_id VARCHAR(100) NOT NULL,
  response JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (actor, request_id)
);
