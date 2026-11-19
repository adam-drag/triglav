-- Phase 4 of the initiative room (docs/plans/initiative-room.md): changed since start, addenda to running jobs and the PR
-- body reads of delivered jobs. ack_* records how a card's change since its start was answered: an addendum sent to the
-- job (ack_kind 'addendum') or a logged dismiss by the Client (ack_kind 'dismiss', with ack_reason).
ALTER TABLE initiative_card_starts
  ADD COLUMN ack_version INT NULL,
  ADD COLUMN ack_kind VARCHAR(10) NULL,
  ADD COLUMN ack_reason VARCHAR(500) NULL,
  ADD COLUMN ack_at DATETIME(3) NULL;

-- An addendum the Architect proposed (state pending), then posted, denied, expired or refused at Confirm.
CREATE TABLE initiative_addenda (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  card_key VARCHAR(64) NOT NULL,
  design_version INT NOT NULL,
  body TEXT NOT NULL,
  card_diff TEXT NULL,
  reason VARCHAR(500) NULL,
  state VARCHAR(12) NOT NULL,
  refusal VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  INDEX initiative_addenda_state (initiative_id, state)
);

-- The PR body read of a job of an initiative, made by the server when the merged gate of that job becomes met. state is
-- reading, read (result is the body) or refused (result is the reason). The Architect is woken with the result.
CREATE TABLE initiative_pr_reads (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) NOT NULL,
  pr_url VARCHAR(500) NOT NULL,
  state VARCHAR(12) NOT NULL,
  result TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  INDEX initiative_pr_reads_state (state)
);

-- The met-gate rule (docs/plans/initiative-room.md, phase 4). A met gate whose text a revision changes reopens when the
-- revision is applied, unless the Client kept it met for that revision first. This table is that keep, and its log: both
-- texts, the reason and when. A key change reopens the gate by itself (its row is keyed by the key).
CREATE TABLE initiative_gate_keeps (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  gate_id VARCHAR(40) NOT NULL,
  revision_id VARCHAR(40) NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX initiative_gate_keeps_gate (gate_id, revision_id)
);
