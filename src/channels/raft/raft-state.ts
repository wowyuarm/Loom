import { DatabaseSync } from "node:sqlite";

export function initializeRaftState(database: DatabaseSync, activatedAt: string): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS wakes (
      message_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      delivery_order INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'failed', 'complete')),
      input_id TEXT,
      last_error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_retry_at TEXT,
      failure_category TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS refs (
      ref TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('message', 'place', 'destination', 'thread', 'task', 'member', 'reminder')),
      remote_value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS known_destinations (
      destination_ref TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('top_level', 'reply_thread')),
      label TEXT,
      observed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ambient_activity (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      place_ref TEXT NOT NULL,
      place_kind TEXT NOT NULL,
      place_label TEXT,
      visibility TEXT NOT NULL,
      actor_ref TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_label TEXT,
      message_ref TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS attention_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      presented_revision INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO attention_state (singleton, presented_revision) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS integration_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      activated_at TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare(`
    INSERT OR IGNORE INTO integration_state (singleton, activated_at) VALUES (1, ?)
  `).run(activatedAt);
}
