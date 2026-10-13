-- 1 when the agent can carry out its recommendation itself if the Client accepts it. The dashboard shows Accept recommendation only then.
ALTER TABLE blockers ADD COLUMN recommendation_actionable TINYINT(1) NOT NULL DEFAULT 0;
