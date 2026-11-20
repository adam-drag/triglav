-- Images the Client sends with a message to an Architect (design v4, C-chat-images). The bytes stay in the table: no file on disk
-- for any agent to read. A chat's images live as long as the chat (no retention work in this change).
CREATE TABLE chat_images (
  id VARCHAR(40) PRIMARY KEY,
  chat_id VARCHAR(40) NOT NULL,
  message_id BIGINT NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  media_type VARCHAR(20) NOT NULL,
  bytes LONGBLOB NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX (chat_id, message_id, position)
);
-- The message a Client send carries. A command without images, and every command of another kind, keeps NULL.
ALTER TABLE chat_commands ADD COLUMN message_id BIGINT NULL;
