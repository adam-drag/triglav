-- The report sources of a design revision (phase 5, criterion 3): {job_id, version} of research reports linked to the initiative,
-- checked when the Architect proposes the revision and rendered on the Confirm card from the database. NULL when none.
ALTER TABLE initiative_revisions ADD COLUMN sources JSON NULL;
