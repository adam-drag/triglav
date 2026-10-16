ALTER TABLE code_review_findings ADD COLUMN outside_delta TINYINT NULL;

CREATE TABLE code_review_run_deltas (
  run_id VARCHAR(40) PRIMARY KEY,
  ranges JSON NULL,
  resolved JSON NULL
);

CREATE TABLE code_review_resolutions (
  id VARCHAR(40) PRIMARY KEY,
  review_id VARCHAR(40) NOT NULL,
  previous_finding_id VARCHAR(40) NOT NULL,
  status VARCHAR(10) NOT NULL,
  sites JSON NOT NULL,
  fixed_by JSON NOT NULL,
  not_fixed_by JSON NOT NULL,
  INDEX (review_id)
);
