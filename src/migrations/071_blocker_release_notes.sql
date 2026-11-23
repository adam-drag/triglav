-- The release notes block a Senior or Staff asks to have confirmed (raise_blocker release_notes). Only a client decision
-- that carries one can be answered with answer_release_notes, the Architect's one answer without a citation.
ALTER TABLE blockers ADD COLUMN release_notes TEXT NULL;
