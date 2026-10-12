CREATE TABLE copilot_waits (
  agent_id VARCHAR(40) PRIMARY KEY,
  await_at DATETIME(3) NULL,
  harvest_at DATETIME(3) NULL
);
