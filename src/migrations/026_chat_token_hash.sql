-- The Operator's chat token is no longer stored. The runner asks for a fresh one each time it starts a process for a chat, and only its SHA-256 is kept.
-- Existing chats lose their old token and get a fresh one on their next start.
-- One statement, so an interrupted start can never leave it half applied (the next start would fail on a column that is already there or already gone).
ALTER TABLE chats ADD COLUMN token_hash CHAR(64) NULL, DROP COLUMN token, ADD INDEX (token_hash)
