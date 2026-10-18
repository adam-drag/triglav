CREATE TABLE dissents (
  decision_id VARCHAR(40) NOT NULL,
  agent_id VARCHAR(40) NOT NULL,
  message_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (decision_id, agent_id)
);
