-- The source a merged check picked when the runner took the launch, as slug#number (gateCheckLaunch in
-- src/initiative-jobs.ts). recordGateOutput keeps an answer only while the card's source is still that pull request. NULL is
-- a launch made before this column.
ALTER TABLE launches ADD COLUMN source_pr VARCHAR(200) NULL;
