-- Dashboard login sessions of the Client. Only the SHA-256 of the session id is stored.
CREATE TABLE client_sessions (
  id_hash CHAR(64) PRIMARY KEY,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX (expires_at)
)
