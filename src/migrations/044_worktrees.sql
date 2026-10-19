-- The worktrees Seniors made for a job (src/worktrees.ts). The host runner removes one once its job is done or
-- cancelled and nothing in it is uncommitted or unpushed. Without this every job left a checkout with its own
-- node_modules behind, and the host disk filled up (2026-10-20).
CREATE TABLE worktrees (
  path VARCHAR(500) NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  removed_at DATETIME(3) NULL,
  last_result VARCHAR(500) NULL,
  last_result_at DATETIME(3) NULL,
  PRIMARY KEY (path, job_id),
  INDEX (job_id)
);

INSERT IGNORE INTO worktrees (path, job_id, recorded_at)
  SELECT worktree_path, job_id, created_at FROM assignments WHERE worktree_path IS NOT NULL;

INSERT IGNORE INTO worktrees (path, job_id, recorded_at)
  SELECT worktree, job_id, MIN(created_at) FROM code_reviews GROUP BY worktree, job_id;

-- Free space on the host disk that holds the home directory, as the runner last reported it. One row.
CREATE TABLE host_disk (
  id TINYINT PRIMARY KEY,
  free_bytes BIGINT NOT NULL,
  total_bytes BIGINT NOT NULL,
  checked_at DATETIME(3) NOT NULL
);
