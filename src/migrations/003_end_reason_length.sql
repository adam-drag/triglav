-- end_session accepts a reason of up to 200 characters.
ALTER TABLE agent_sessions MODIFY end_reason VARCHAR(200) NULL;
