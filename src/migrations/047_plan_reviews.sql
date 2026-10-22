-- One plan review per top-level job, before its first Senior starts: a timed question to the researchers, or a skip
-- with its reason (no researcher could answer, or Staff judged the job small). The spawn ticket gate reads this row.
CREATE TABLE plan_reviews (
  job_id VARCHAR(40) NOT NULL PRIMARY KEY,
  thread_id VARCHAR(40) NULL,
  state ENUM('open', 'closed', 'skipped') NOT NULL,
  skip_reason VARCHAR(1200) NULL,
  created_by VARCHAR(40) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  UNIQUE KEY plan_reviews_thread (thread_id)
)
