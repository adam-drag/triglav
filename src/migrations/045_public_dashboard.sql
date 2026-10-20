-- Sessions of the opt-in public dashboard listener (README "Running behind an HTTPS reverse proxy") are kept apart from
-- local ones: each listener accepts only its own scope. Every session that exists now was made on the local listener.
ALTER TABLE client_sessions ADD COLUMN scope VARCHAR(10) NOT NULL DEFAULT 'local';

-- Successful logins on the public listener, with the client address, for the dashboard's Security page. Rows older than
-- 90 days are deleted when a new one is written (src/client-auth.ts). Local logins are not recorded.
CREATE TABLE client_logins (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  at DATETIME(3) NOT NULL,
  address VARCHAR(64) NOT NULL,
  INDEX (at)
);
