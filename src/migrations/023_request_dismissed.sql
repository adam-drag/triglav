-- The Client has seen a request that did not start (or never registered a job) and is done with it.
ALTER TABLE job_requests ADD COLUMN dismissed_at DATETIME(3) NULL;
