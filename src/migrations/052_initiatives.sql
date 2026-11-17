-- Initiatives: a layer above jobs with a living, versioned design that an Architect chat owns (docs/plans/initiative-room.md).
-- repos is a JSON list of {slug, path, base, github, deploy}; the runner keeps a read-only worktree of each at origin/<base>.
-- chat_id is the Architect's chat (chats.kind = 'architect'). architect_agent_id is set when the Architect first posts
-- on the board (phase 3), so its posts have their own author and are never the Client's.
CREATE TABLE initiatives (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  title VARCHAR(300) NOT NULL,
  repos JSON NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'active',
  cap INT NOT NULL DEFAULT 3,
  milestones_open JSON NOT NULL,
  current_version INT NOT NULL,
  chat_id VARCHAR(40) NULL,
  architect_agent_id VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY initiatives_key (`key`)
);
-- One immutable row per version. doc is the whole document (blocks with stable ids). changed lists the block ids that
-- differ from the previous version, so the room can mark them "updated in vN". trigger_kind: import, chat, event,
-- decision or client_edit; trigger_ref points at what caused it (a revision id, an event id, the import source).
CREATE TABLE initiative_versions (
  initiative_id VARCHAR(40) NOT NULL,
  version INT NOT NULL,
  doc JSON NOT NULL,
  changed JSON NOT NULL,
  trigger_kind VARCHAR(20) NOT NULL,
  trigger_ref VARCHAR(300) NULL,
  summary VARCHAR(1000) NOT NULL,
  created_by VARCHAR(40) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (initiative_id, version)
);
-- A revision the Architect proposed: a structural diff (ops) against base_version. The Client's Confirm card is written
-- from this row, never from the model's words. state: pending, applied, denied, stale (the design moved on) or expired.
CREATE TABLE initiative_revisions (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  base_version INT NOT NULL,
  ops JSON NOT NULL,
  summary VARCHAR(1000) NOT NULL,
  state VARCHAR(12) NOT NULL,
  action_id VARCHAR(40) NULL,
  applied_version INT NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  INDEX (initiative_id, created_at)
);
-- The Operator and the Architects share the chat plumbing. A token of one kind never opens the other kind's tools.
ALTER TABLE chats ADD COLUMN kind VARCHAR(12) NOT NULL DEFAULT 'operator';
ALTER TABLE chats ADD COLUMN initiative_id VARCHAR(40) NULL;
INSERT INTO role_models (role, runtime, model, effort, updated_at) VALUES ('architect', 'claude-code', 'claude-opus-5-5', 'high', UTC_TIMESTAMP(3));
