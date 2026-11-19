-- The gate mark log (phase 4 of the initiative room, docs/plans/initiative-room.md): one append-only row for every change of a
-- gate's met state, written in the same transaction as that change. A merged or deployed mark writes no design version, so this
-- log is the trace of it, and a cleared mark keeps the entry of the mark it removed. action is set (a mark was made; met_by is
-- check or client), cleared (a mark was removed; evidence holds the mark it removed, and old_text or new_text hold the gate text
-- when a revision changed or removed the gate) or keep_met (the Client kept a met gate met through a revision that changed its
-- text; old_text and new_text hold both texts). Rows are never updated or deleted. seq gives the order of the writes.
CREATE TABLE initiative_gate_marks (
  seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  card_key VARCHAR(64) NOT NULL,
  gate_key VARCHAR(160) NOT NULL,
  action VARCHAR(12) NOT NULL,
  met_by VARCHAR(10) NULL,
  reason TEXT NULL,
  old_text TEXT NULL,
  new_text TEXT NULL,
  evidence JSON NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX initiative_gate_marks_gate (initiative_id, card_key, gate_key, seq)
);
