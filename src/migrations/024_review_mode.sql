-- Client-wide settings, one row each. review_mode: how a Senior reviews a PR before it reports delivery.
CREATE TABLE settings (
  name VARCHAR(40) PRIMARY KEY,
  value VARCHAR(100) NOT NULL,
  updated_at DATETIME(3) NOT NULL
);
INSERT INTO settings (name, value, updated_at) VALUES ('review_mode', 'auto', UTC_TIMESTAMP(3));
ALTER TABLE deliveries ADD COLUMN copilot_status VARCHAR(10) NOT NULL DEFAULT 'DONE';
