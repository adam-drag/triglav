-- milestones_open listed the milestones still open; it now lists the milestones the Client started (a milestone gate is
-- met once its milestone is in the list). The column is renamed so no reader can take one meaning for the other. Rows
-- written under the old meaning are reset to no started milestone, so every milestone gate is Locked until the Client
-- starts it, which fails closed.
ALTER TABLE initiatives RENAME COLUMN milestones_open TO milestones_started;
UPDATE initiatives SET milestones_started = '[]';
