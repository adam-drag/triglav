-- Initiative jobs and gates (docs/plans/initiative-room.md, phase 2). Live state only: the design itself stays in the
-- immutable initiative_versions rows. A gate row exists once the gate has been checked or marked; no row means open.
-- met_by is 'check' (a runner check proved it) or 'client' (a manual mark with a reason). evidence is what the check saw.
CREATE TABLE initiative_gates (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  card_key VARCHAR(64) NOT NULL,
  gate_key VARCHAR(160) NOT NULL,
  met_at DATETIME(3) NULL,
  met_by VARCHAR(10) NULL,
  reason VARCHAR(500) NULL,
  evidence JSON NULL,
  checked_at DATETIME(3) NULL,
  UNIQUE KEY initiative_gates_key (initiative_id, card_key, gate_key)
);
-- A Start from a job card. The job comes through the request (job_requests.job_id, set when Staff registers the job), and
-- started_from_version is the design version the prompt was built from.
CREATE TABLE initiative_card_starts (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  card_key VARCHAR(64) NOT NULL,
  request_id VARCHAR(40) NOT NULL,
  started_from_version INT NOT NULL,
  started_at DATETIME(3) NOT NULL,
  INDEX initiative_card_starts_card (initiative_id, card_key, started_at)
);
