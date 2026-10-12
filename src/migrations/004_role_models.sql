CREATE TABLE role_models (
  role VARCHAR(20) PRIMARY KEY,
  runtime VARCHAR(40) NOT NULL,
  model VARCHAR(100) NOT NULL,
  effort VARCHAR(20) NOT NULL,
  updated_at DATETIME(3) NOT NULL
);

INSERT INTO role_models (role, runtime, model, effort, updated_at) VALUES
  ('staff', 'claude-code', 'claude-opus-5-5', 'high', UTC_TIMESTAMP(3)),
  ('senior', 'claude-code', 'claude-sonnet-5-5', 'high', UTC_TIMESTAMP(3)),
  ('reviewer', 'claude-code', 'claude-sonnet-5-5', 'high', UTC_TIMESTAMP(3)),
  ('researcher', 'codex', 'gpt-6-astra', 'low', UTC_TIMESTAMP(3));
