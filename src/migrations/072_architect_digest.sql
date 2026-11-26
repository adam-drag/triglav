-- The last digest the Architect was woken with (architect-wake.ts, digestArchitects). Null until the first one.
ALTER TABLE initiatives ADD COLUMN architect_digest_at DATETIME(3) NULL;
