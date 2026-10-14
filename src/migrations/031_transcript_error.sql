ALTER TABLE agent_sessions ADD COLUMN transcript_error VARCHAR(300) NULL, ADD COLUMN transcript_error_at DATETIME(3) NULL;
