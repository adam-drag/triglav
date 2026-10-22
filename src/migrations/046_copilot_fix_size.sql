-- The fix a Senior made since the previous Copilot round, as the Senior reported it with request_copilot_review: lines
-- changed in the fix and lines of the PR at the previous round's head. Null on round 1 and on rows stored before this.
ALTER TABLE copilot_rounds ADD COLUMN fix_lines INT NULL, ADD COLUMN pr_lines INT NULL;
