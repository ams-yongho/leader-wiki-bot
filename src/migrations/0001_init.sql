-- 슬랙 멘션 질의/응답 1건당 1 row
CREATE TABLE queries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  received_at     TEXT NOT NULL,
  completed_at    TEXT,
  channel         TEXT NOT NULL,
  thread_ts       TEXT NOT NULL,
  slack_user      TEXT NOT NULL,
  question        TEXT NOT NULL,
  question_raw    TEXT NOT NULL,
  prior_turns     INTEGER NOT NULL DEFAULT 0,
  answer          TEXT,
  citations_json  TEXT,
  model           TEXT NOT NULL,
  latency_ms      INTEGER,
  status          TEXT NOT NULL,
  error_message   TEXT
);

CREATE INDEX idx_queries_received_at ON queries (received_at);
CREATE INDEX idx_queries_user        ON queries (slack_user);
CREATE INDEX idx_queries_channel     ON queries (channel);
CREATE INDEX idx_queries_status      ON queries (status);
