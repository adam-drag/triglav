CREATE TABLE dissents (
  decision_id VARCHAR(40) NOT NULL,
  agent_id VARCHAR(40) NOT NULL,
  message_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (decision_id, agent_id)
);

ALTER TABLE decisions ADD COLUMN unreviewed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE research_inbox ADD COLUMN read_at DATETIME(3) NULL;
