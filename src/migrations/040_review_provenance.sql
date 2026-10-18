ALTER TABLE code_review_findings ADD COLUMN sources JSON NULL, ADD COLUMN omitted_sites INT NOT NULL DEFAULT 0;

ALTER TABLE code_review_runs ADD COLUMN requested_runtime VARCHAR(20) NULL, ADD COLUMN requested_model VARCHAR(100) NULL, ADD COLUMN requested_effort VARCHAR(20) NULL;

ALTER TABLE code_review_run_deltas ADD COLUMN resolved_dropped INT NOT NULL DEFAULT 0;

ALTER TABLE code_review_resolutions ADD COLUMN unknown_by JSON NULL, ADD COLUMN silent JSON NULL;
