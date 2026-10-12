CREATE TABLE decision_advice (
  blocker_id VARCHAR(40) NOT NULL,
  agent_id VARCHAR(40) NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (blocker_id, agent_id)
);
