import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
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
    `,
  },
];

export function openDb(filePath: string): Db {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
}
