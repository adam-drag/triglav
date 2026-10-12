CREATE TABLE telemetry_files (
  path VARCHAR(500) PRIMARY KEY,
  size BIGINT NOT NULL,
  mtime_ms BIGINT NOT NULL
);

CREATE TABLE usage_daily (
  source VARCHAR(500) NOT NULL,
  agent_id VARCHAR(40) NULL,
  runtime VARCHAR(40) NOT NULL,
  model VARCHAR(100) NOT NULL,
  day DATE NOT NULL,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_read_tokens BIGINT NOT NULL,
  cache_write_tokens BIGINT NOT NULL,
  PRIMARY KEY (source, model, day),
  KEY idx_usage_day (day)
);

CREATE TABLE artifacts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  url VARCHAR(500) NOT NULL,
  label VARCHAR(300) NOT NULL,
  agent_id VARCHAR(40) NULL,
  job_id VARCHAR(40) NULL,
  at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_artifact (kind, url)
);
