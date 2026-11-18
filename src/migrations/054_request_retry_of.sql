-- A retry of a failed job request (retryJobRequest) names the request it retries. A Start from a job card follows this
-- chain (src/initiative-jobs.ts, latestStarts), so a retried start still belongs to its card.
ALTER TABLE job_requests ADD COLUMN retry_of VARCHAR(40) NULL, ADD INDEX job_requests_retry_of (retry_of);
