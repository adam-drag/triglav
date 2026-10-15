ALTER TABLE code_reviews ADD COLUMN seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, ADD COLUMN previous_review_id VARCHAR(40) NULL;

ALTER TABLE review_packages ADD COLUMN head_sha CHAR(40) NULL, ADD COLUMN gate_review_id VARCHAR(40) NULL;

CREATE TABLE code_review_grants (
  blocker_id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  piece_first_review_id VARCHAR(40) NOT NULL,
  rounds INT NOT NULL DEFAULT 3,
  created_at DATETIME(3) NOT NULL,
  granted_at DATETIME(3) NULL,
  INDEX (piece_first_review_id)
);

CREATE TABLE copilot_rounds (
  id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  assignment_id VARCHAR(40) NOT NULL,
  pr INT NOT NULL,
  round_no INT NOT NULL,
  head_sha CHAR(40) NOT NULL,
  gate_review_id VARCHAR(40) NOT NULL,
  requested_by VARCHAR(40) NOT NULL,
  requested_at DATETIME(3) NOT NULL,
  recorded_at DATETIME(3) NULL,
  approval_recommended TINYINT NULL,
  p0 INT NULL,
  p1 INT NULL,
  p2 INT NULL,
  p3 INT NULL,
  previously_missed INT NULL,
  UNIQUE KEY (job_id, pr, round_no)
);
