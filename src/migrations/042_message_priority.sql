-- A message tagged to the Client can be marked critical (production down, data loss, an unauthorized
-- irreversible action). The inbox pins critical messages above normal ones and excludes them from
-- "mark all as read"; see postMessage's validation in board.ts.
ALTER TABLE messages ADD COLUMN priority ENUM('normal','critical') NOT NULL DEFAULT 'normal', ADD KEY idx_messages_priority (to_client, priority, client_seen_at);
