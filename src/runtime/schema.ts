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
      segment_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled', 'interrupted')),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'no_reply')),
      lease_owner TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      recording_day TEXT NOT NULL,
      ended_at TEXT,
      transcript_anchor_json TEXT,
      execution_record_json TEXT,
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

    CREATE TABLE IF NOT EXISTS turn_tool_activity (
      turn_id TEXT NOT NULL REFERENCES turns(id),
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      call_arguments_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      input_position INTEGER NOT NULL CHECK (input_position > 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (turn_id, tool_call_id)
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

    CREATE TABLE IF NOT EXISTS active_execution_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS active_segment (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL UNIQUE,
      opened_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      starting_state_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'closing')),
      close_owner TEXT,
      close_fencing_token INTEGER,
      close_lease_expires_at TEXT,
      closed_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS activities (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      recording_day TEXT NOT NULL,
      frozen_activity_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'recording', 'recorded')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_owner TEXT,
      fencing_token INTEGER,
      lease_expires_at TEXT,
      receipt_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      recorded_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS activity_attempts (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL REFERENCES activities(id),
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      status TEXT NOT NULL CHECK (status IN ('recording', 'recorded', 'failed', 'interrupted')),
      lease_owner TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      error TEXT,
      receipt_json TEXT,
      UNIQUE (activity_id, attempt_number)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS proactive_pulse (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_pulse_at TEXT,
      next_pulse_after TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      last_error TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS thread_maintenance (
      activity_id TEXT PRIMARY KEY REFERENCES activities(id),
      observations_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_owner TEXT,
      fencing_token INTEGER,
      lease_expires_at TEXT,
      result_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS attention_maintenance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_completed_at TEXT,
      next_run_after TEXT NOT NULL,
      cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cursor_sequence >= 0),
      window_end_sequence INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_result_json TEXT,
      last_error TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_reflection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      next_day TEXT NOT NULL,
      next_run_after TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_completed_day TEXT,
      last_result_json TEXT,
      last_error TEXT
    ) STRICT;

    PRAGMA user_version = 11;
  `);
}
