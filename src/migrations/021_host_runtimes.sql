-- Which agent CLIs the host runner found on the machine. Triglav runs in Docker and cannot look, so the runner reports.
CREATE TABLE host_runtimes (
  runtime VARCHAR(40) PRIMARY KEY,
  available TINYINT(1) NOT NULL,
  version VARCHAR(100) NULL,
  checked_at DATETIME(3) NOT NULL
);
