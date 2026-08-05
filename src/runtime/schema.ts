import type { DatabaseSync } from "node:sqlite";

export function initializeRuntimeSchema(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  const backfillAgentRuns = version.user_version < 16;
  if (version.user_version === 11) migrateVersion11(database);
  const migrated = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  if (migrated.user_version === 12) migrateVersion12(database);
  const deliveryMigrated = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  if (deliveryMigrated.user_version === 13) migrateVersion13(database);
  const interactionMigrated = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  if (interactionMigrated.user_version === 14) migrateVersion14(database);
  const statusMigrated = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  if (statusMigrated.user_version === 15) migrateVersion15(database);
  const waveMigrated = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  if (waveMigrated.user_version === 16) migrateVersion16(database);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS interaction_waves (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      last_input_at TEXT NOT NULL,
      quiet_seal_at TEXT NOT NULL,
      max_seal_at TEXT NOT NULL,
      sealed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'sealed'))
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_interaction_wave_per_scope
    ON interaction_waves (scope_key) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS inputs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('interaction', 'opportunity', 'continuation')),
      payload_json TEXT NOT NULL,
      interaction_json TEXT,
      interaction_wave_id TEXT REFERENCES interaction_waves(id),
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
      destination_ref TEXT,
      input_position INTEGER NOT NULL CHECK (input_position > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'reconciliation_required', 'abandoned')),
      created_at TEXT NOT NULL,
      ended_at TEXT,
      next_delivery_after TEXT
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

    CREATE TABLE IF NOT EXISTS after_chat_continuation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'admitted', 'cancelled', 'expired', 'completed')),
      source_delivery_id TEXT NOT NULL REFERENCES delivery_attempts(id),
      source_effect_id TEXT NOT NULL REFERENCES effects(id),
      source_turn_id TEXT NOT NULL REFERENCES turns(id),
      source_segment_id TEXT NOT NULL,
      source_behavior TEXT NOT NULL CHECK (source_behavior IN ('interaction', 'background')),
      delivered_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      input_id TEXT REFERENCES inputs(id),
      ended_at TEXT,
      reason TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL CHECK (agent_name IN (
        'main-agent', 'orientation', 'life-recorder', 'attention-maintainer',
        'memory-reflector', 'thread-maintainer'
      )),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      outcome TEXT,
      failure_category TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS agent_runs_by_agent_and_time
    ON agent_runs (agent_name, started_at DESC, id DESC);

    PRAGMA user_version = 17;
  `);
  if (backfillAgentRuns) backfillExistingAgentRuns(database);
}

function migrateVersion16(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS interaction_waves (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        last_input_at TEXT NOT NULL,
        quiet_seal_at TEXT NOT NULL,
        max_seal_at TEXT NOT NULL,
        sealed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'sealed'))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_interaction_wave_per_scope
      ON interaction_waves (scope_key) WHERE status = 'open';
    `);
    const hasWaveColumn = (database.prepare("PRAGMA table_info(inputs)").all() as unknown as Array<{
      name: string;
    }>).some(column => column.name === "interaction_wave_id");
    if (!hasWaveColumn) {
      database.exec(`
        ALTER TABLE inputs
        ADD COLUMN interaction_wave_id TEXT REFERENCES interaction_waves(id)
      `);
    }
    database.exec(`
      INSERT OR IGNORE INTO interaction_waves (
        id, scope_key, opened_at, last_input_at, quiet_seal_at, max_seal_at, sealed_at, status
      )
      SELECT
        'legacy:' || id,
        'legacy:' || id,
        accepted_at,
        accepted_at,
        accepted_at,
        accepted_at,
        accepted_at,
        'sealed'
      FROM inputs
      WHERE kind = 'interaction' AND interaction_wave_id IS NULL;
      UPDATE inputs
      SET interaction_wave_id = 'legacy:' || id
      WHERE kind = 'interaction' AND interaction_wave_id IS NULL;
      PRAGMA user_version = 17;
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateVersion15(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL CHECK (agent_name IN (
        'main-agent', 'orientation', 'life-recorder', 'attention-maintainer',
        'memory-reflector', 'thread-maintainer'
      )),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      outcome TEXT,
      failure_category TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_runs_by_agent_and_time
    ON agent_runs (agent_name, started_at DESC, id DESC);
    PRAGMA user_version = 16;
    COMMIT;
  `);
}

function backfillExistingAgentRuns(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    INSERT OR IGNORE INTO agent_runs (
      id, agent_name, status, started_at, ended_at, outcome, failure_category
    )
    SELECT
      id,
      'main-agent',
      CASE
        WHEN status = 'completed' THEN 'succeeded'
        WHEN status = 'running' THEN 'running'
        WHEN status = 'interrupted' THEN 'interrupted'
        ELSE 'failed'
      END,
      started_at,
      ended_at,
      outcome,
      CASE WHEN error IS NULL THEN NULL ELSE 'unknown' END
    FROM turns
    ORDER BY started_at, id;
    INSERT OR IGNORE INTO agent_runs (
      id, agent_name, status, started_at, ended_at, outcome, failure_category
    )
    SELECT
      id,
      'life-recorder',
      CASE
        WHEN status = 'recorded' THEN 'succeeded'
        WHEN status = 'recording' THEN 'running'
        WHEN status = 'interrupted' THEN 'interrupted'
        ELSE 'failed'
      END,
      started_at,
      ended_at,
      CASE WHEN status = 'recorded' THEN 'recorded' ELSE NULL END,
      CASE WHEN error IS NULL THEN NULL ELSE 'unknown' END
    FROM activity_attempts
    ORDER BY started_at, id;
    INSERT OR IGNORE INTO agent_runs (
      id, agent_name, status, started_at, ended_at, outcome, failure_category
    )
    SELECT
      'legacy:thread-maintainer:' || activity_id,
      'thread-maintainer',
      'succeeded',
      completed_at,
      completed_at,
      json_extract(result_json, '$.outcome'),
      NULL
    FROM thread_maintenance
    WHERE status = 'completed' AND completed_at IS NOT NULL;
    COMMIT;
  `);
}

function migrateVersion14(database: DatabaseSync): void {
  migrateOptionalColumn(database, "effects", "destination_ref", "TEXT", 15);
}

function migrateVersion13(database: DatabaseSync): void {
  migrateOptionalColumn(database, "inputs", "interaction_json", "TEXT", 14);
}

function migrateVersion12(database: DatabaseSync): void {
  migrateOptionalColumn(database, "effects", "next_delivery_after", "TEXT", 13);
}

function migrateOptionalColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  type: string,
  nextVersion: number,
): void {
  const tableExists = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table);
  const columnExists = tableExists && (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>).some(candidate => candidate.name === column);
  database.exec("BEGIN IMMEDIATE");
  try {
    if (tableExists && !columnExists) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    database.exec(`PRAGMA user_version = ${nextVersion}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateVersion11(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE turn_inputs RENAME TO turn_inputs_v11;
      ALTER TABLE inputs RENAME TO inputs_v11;

      CREATE TABLE inputs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('interaction', 'opportunity', 'continuation')),
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'consumed', 'blocked')),
        active_turn_id TEXT,
        UNIQUE (source, source_id)
      ) STRICT;

      INSERT INTO inputs (
        id, source, source_id, kind, payload_json, occurred_at, accepted_at, status, active_turn_id
      )
      SELECT id, source, source_id, kind, payload_json, occurred_at, accepted_at, status, active_turn_id
      FROM inputs_v11;

      CREATE TABLE turn_inputs (
        turn_id TEXT NOT NULL REFERENCES turns(id),
        input_id TEXT NOT NULL REFERENCES inputs(id),
        position INTEGER NOT NULL CHECK (position > 0),
        inclusion_status TEXT NOT NULL CHECK (inclusion_status IN ('prepared', 'included', 'rejected')),
        included_at TEXT,
        inclusion_anchor_json TEXT,
        PRIMARY KEY (turn_id, input_id),
        UNIQUE (turn_id, position)
      ) STRICT;

      INSERT INTO turn_inputs (
        turn_id, input_id, position, inclusion_status, included_at, inclusion_anchor_json
      )
      SELECT turn_id, input_id, position, inclusion_status, included_at, inclusion_anchor_json
      FROM turn_inputs_v11;

      DROP TABLE turn_inputs_v11;
      DROP TABLE inputs_v11;
      PRAGMA user_version = 12;
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The failing statement may already have ended the transaction.
    }
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
