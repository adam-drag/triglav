ALTER TABLE jobs ADD COLUMN client_done_seen_at DATETIME(3) NULL;

UPDATE jobs SET client_done_seen_at = updated_at WHERE status = 'done' AND updated_at < NOW(3) - INTERVAL 1 DAY;
