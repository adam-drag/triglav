-- The Architect marks a job's draft PR ready for review (src/architect-pr-ready.ts). The runner runs `gh pr ready` for a
-- row in state marking; state is then marked or refused (result says why). blocker_id is the blocker the request resolves
-- once the PR is ready, if the Architect named one.
CREATE TABLE initiative_pr_ready (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  blocker_id VARCHAR(40) NULL,
  pr_url VARCHAR(500) NOT NULL,
  state VARCHAR(12) NOT NULL,
  result TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  INDEX initiative_pr_ready_pr (initiative_id, pr_url)
);
