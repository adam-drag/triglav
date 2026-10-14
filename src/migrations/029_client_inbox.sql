-- A board message can be tagged to the Client (mentions contains "client"). to_client mirrors that so the dashboard
-- can list the unread ones without scanning JSON; client_seen_at is when the Client opened or dismissed it.
ALTER TABLE messages ADD COLUMN to_client TINYINT NOT NULL DEFAULT 0, ADD COLUMN client_seen_at DATETIME(3) NULL, ADD KEY idx_messages_client (to_client, client_seen_at);

-- The Roster looks up the latest poke of each agent by event type.
CREATE INDEX idx_events_type ON events (type, id);
