-- Delegated answers and escalations of the Architect (docs/plans/initiative-room.md, phase 3). target is where the answer
-- goes: thread (a Staff question in a job thread) or blocker (a client_decision blocker, resolved by the answer). blocker_id
-- is the client_decision blocker an escalation raised, or the one a delegated answer resolved. The states add escalated
-- (waiting for the Client) and reopened (a delegated answer the Client took back into an escalation).
ALTER TABLE architect_answers
  ADD COLUMN target VARCHAR(10) NOT NULL DEFAULT 'thread',
  ADD COLUMN blocker_id VARCHAR(40) NULL,
  ADD INDEX architect_answers_blocker (blocker_id);
