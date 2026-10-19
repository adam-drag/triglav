-- The summary of the repository rules a code review seat was given (rules commit, source, files, cut and omitted files,
-- rule files the change edits), as the runner reported it and parseRulesSummary checked it. NULL when none was valid.
ALTER TABLE code_review_run_deltas ADD COLUMN rules JSON NULL;
