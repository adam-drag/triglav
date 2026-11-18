-- A client_step mark keeps a hash of its checkpoint's steps when it was made (src/card-state.ts, checkpointHash). A
-- changed checkpoint then re-opens the mark. NULL is a mark made before this column: it adopts the current hash the first
-- time the room reads it (adoptCheckpointHashes in src/initiative-jobs.ts), without re-opening.
ALTER TABLE initiative_gates ADD COLUMN checkpoint_hash CHAR(64) NULL;
