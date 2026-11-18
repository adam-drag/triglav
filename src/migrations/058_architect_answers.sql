-- An answer the Architect gives to a Staff question on a job of its initiative (docs/plans/initiative-room.md, phase 3).
-- state: checking (a code citation waits for the runner's read of the file at the sha), posted (the answer is on the
-- job's thread, with message_id), refused (the citation did not hold; nothing is posted). citation is the JSON the
-- Architect sent: {decision: "D7"} or {code: {repo, path, line, sha, quote}}. launch_id is the quote_check launch of a code
-- citation.
CREATE TABLE architect_answers (
  id VARCHAR(40) PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  thread_id VARCHAR(40) NOT NULL,
  answer TEXT NOT NULL,
  citation JSON NOT NULL,
  design_version INT NOT NULL,
  state VARCHAR(16) NOT NULL,
  refusal VARCHAR(500) NULL,
  launch_id VARCHAR(40) NULL,
  message_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  INDEX architect_answers_initiative (initiative_id, created_at),
  INDEX architect_answers_launch (launch_id)
);
