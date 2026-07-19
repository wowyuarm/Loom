import type { DatabaseSync } from "node:sqlite";

export function initializeRuntimeSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS inputs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('interaction', 'opportunity')),
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'consumed', 'blocked')),
      active_turn_id TEXT,
      UNIQUE (source, source_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled', 'interrupted')),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'no_reply')),
      lease_owner TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      transcript_anchor_json TEXT,
      context_plan_json TEXT,
      error TEXT
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn
    ON turns ((1)) WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS turn_inputs (
      turn_id TEXT NOT NULL REFERENCES turns(id),
      input_id TEXT NOT NULL REFERENCES inputs(id),
      position INTEGER NOT NULL CHECK (position > 0),
      inclusion_status TEXT NOT NULL CHECK (inclusion_status IN ('prepared', 'included', 'rejected')),
      included_at TEXT,
      inclusion_anchor_json TEXT,
      PRIMARY KEY (turn_id, input_id),
      UNIQUE (turn_id, position)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS runtime_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    ) STRICT;

    INSERT OR IGNORE INTO runtime_counters (name, value) VALUES ('fencing_token', 0);

    CREATE TABLE IF NOT EXISTS effects (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id),
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      route_ref TEXT,
      input_position INTEGER NOT NULL CHECK (input_position > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'reconciliation_required', 'abandoned')),
      created_at TEXT NOT NULL,
      ended_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL REFERENCES effects(id),
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      status TEXT NOT NULL CHECK (status IN ('prepared', 'dispatching', 'delivered', 'not_sent', 'unknown')),
      idempotency_key TEXT NOT NULL,
      lease_owner TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      remote_id TEXT,
      error TEXT,
      UNIQUE (effect_id, attempt_number),
      UNIQUE (idempotency_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS transitions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      fencing_token INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS active_context_window (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    PRAGMA user_version = 2;
  `);
}
