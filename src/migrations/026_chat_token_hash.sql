-- The Operator's chat token is no longer stored. The runner asks for a fresh one each time it starts a process for a chat, and only its SHA-256 is kept.
-- Existing chats lose their old token and get a fresh one on their next start.
ALTER TABLE chats ADD COLUMN token_hash CHAR(64) NULL;
ALTER TABLE chats DROP COLUMN token;
ALTER TABLE chats ADD INDEX (token_hash)
