CREATE TABLE chat_actions (
  id VARCHAR(40) PRIMARY KEY,
  chat_id VARCHAR(40) NOT NULL,
  kind VARCHAR(30) NOT NULL,
  args MEDIUMTEXT NOT NULL,
  summary VARCHAR(1500) NOT NULL,
  reason VARCHAR(1000) NULL,
  state VARCHAR(12) NOT NULL,
  result TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  INDEX (chat_id, created_at)
)
