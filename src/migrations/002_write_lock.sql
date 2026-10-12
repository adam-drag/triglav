-- One row that every write transaction locks first. Writes are serialized, so event ids are
-- assigned in commit order (cursors never skip an event) and row locks cannot deadlock.
CREATE TABLE write_lock (
  id TINYINT NOT NULL PRIMARY KEY
);

INSERT INTO write_lock (id) VALUES (1);
