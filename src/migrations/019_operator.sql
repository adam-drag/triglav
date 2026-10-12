CREATE TABLE chats (
  id VARCHAR(40) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  token VARCHAR(80) NOT NULL,
  session_id VARCHAR(40) NULL,
  state VARCHAR(12) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX (updated_at)
);
CREATE TABLE chat_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(40) NOT NULL,
  role VARCHAR(10) NOT NULL,
  text MEDIUMTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX (chat_id, id)
);
CREATE TABLE chat_commands (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(40) NOT NULL,
  kind VARCHAR(10) NOT NULL,
  text MEDIUMTEXT NULL,
  created_at DATETIME(3) NOT NULL,
  taken_at DATETIME(3) NULL,
  INDEX (taken_at, id)
)
