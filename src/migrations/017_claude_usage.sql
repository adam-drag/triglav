CREATE TABLE claude_usage (
  window_kind VARCHAR(20) PRIMARY KEY,
  used_percent DECIMAL(5,1) NOT NULL,
  resets_at DATETIME(3) NULL,
  observed_at DATETIME(3) NOT NULL,
  source VARCHAR(20) NOT NULL
);
