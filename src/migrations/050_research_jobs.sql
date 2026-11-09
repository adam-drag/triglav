-- A research job changes no code: its Staff runs read-only and writes a report the Client reads, sends back or publishes.
-- kind is implement (the default, every job before this) or research. options holds the Client's choices for a research
-- job (sources, depth). report_key names the job's reports folder on the host: the id of the request that created it.
ALTER TABLE jobs ADD COLUMN kind VARCHAR(12) NOT NULL DEFAULT 'implement';
ALTER TABLE jobs ADD COLUMN options JSON NULL;
ALTER TABLE jobs ADD COLUMN report_key VARCHAR(40) NULL;
ALTER TABLE job_requests ADD COLUMN kind VARCHAR(12) NOT NULL DEFAULT 'implement';
ALTER TABLE job_requests ADD COLUMN options JSON NULL;
-- An agent that took a research request is a read-only Staff from then on, and so is any agent the same conversation
-- registers later (src/job-requests.ts, inheritDocumentAccess). It holds the job's report_key. Never cleared.
ALTER TABLE agents ADD COLUMN document_key VARCHAR(40) NULL;
CREATE TABLE job_reports (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  version INT NOT NULL,
  summary VARCHAR(600) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  author_agent_id VARCHAR(40) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  publish_requested_at DATETIME(3) NULL,
  artifact_url VARCHAR(200) NULL,
  published_at DATETIME(3) NULL,
  UNIQUE KEY job_reports_version (job_id, version)
)
