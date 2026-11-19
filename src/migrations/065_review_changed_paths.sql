-- The paths a review run's change touches (rules commit..head), as the runner sent them with the seat's output (phase 5 of the
-- initiative room: the file overlap warning on Start). NULL when the seat sent no valid list. Stored as {paths, more}.
ALTER TABLE code_review_run_deltas ADD COLUMN changed_paths JSON NULL;
