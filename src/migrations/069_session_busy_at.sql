-- When the host runner last saw this session's Claude Code background process report status "busy" in
-- `claude agents --json` (src/busy-sessions.ts). presenceOf counts it as working for POLICY.busySessionSec.
ALTER TABLE agent_sessions ADD COLUMN busy_at DATETIME(3) NULL;
