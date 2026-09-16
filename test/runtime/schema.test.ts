import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../../src/runtime/schema.js";

test("upgrades version 17 Delivery attempts with a required owning Segment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-schema-v17-"));
  const database = new DatabaseSync(path.join(root, "runtime.db"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      segment_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE effects (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id)
    ) STRICT;
    CREATE TABLE delivery_attempts (
      id TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL REFERENCES effects(id),
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
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
    CREATE TABLE after_chat_continuation (
      singleton INTEGER PRIMARY KEY,
      source_delivery_id TEXT NOT NULL REFERENCES delivery_attempts(id)
    ) STRICT;
    INSERT INTO turns (id, segment_id, status) VALUES ('turn-1', 'segment-1', 'completed');
    INSERT INTO effects (id, turn_id) VALUES ('effect-1', 'turn-1');
    INSERT INTO delivery_attempts (
      id, effect_id, attempt_number, status, idempotency_key,
      lease_owner, fencing_token, lease_expires_at, started_at
    ) VALUES (
      'delivery-1', 'effect-1', 1, 'not_sent', 'effect-1:1',
      'owner-1', 1, '2026-08-05T10:01:00.000Z', '2026-08-05T10:00:00.000Z'
    );
    INSERT INTO after_chat_continuation (singleton, source_delivery_id)
    VALUES (1, 'delivery-1');
    PRAGMA user_version = 17;
  `);

  initializeRuntimeSchema(database);

  const segmentColumn = (database.prepare("PRAGMA table_info(delivery_attempts)").all() as unknown as Array<{
    name: string;
    notnull: number;
  }>).find(column => column.name === "segment_id");
  assert.equal(segmentColumn?.name, "segment_id");
  assert.equal(segmentColumn?.notnull, 1);
  const migrated = database.prepare(
    "SELECT segment_id FROM delivery_attempts WHERE id = 'delivery-1'",
  ).get() as { segment_id: string };
  assert.equal(migrated.segment_id, "segment-1");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const continuation = database.prepare(
    "SELECT source_delivery_id FROM after_chat_continuation",
  ).get() as { source_delivery_id: string };
  assert.equal(continuation.source_delivery_id, "delivery-1");
  assert.equal(
    (database.prepare("PRAGMA foreign_keys").get() as unknown as { foreign_keys: number }).foreign_keys,
    1,
  );
  database.close();
});

test("upgrades version 19 active_segment with overdue columns (issue #4)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-schema-v19-"));
  const database = new DatabaseSync(path.join(root, "runtime.db"));
  database.exec(`
    CREATE TABLE active_segment (
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
    INSERT INTO active_segment (singleton, id, opened_at, last_activity_at, status)
    VALUES (1, 'segment-1', '2026-08-08T08:00:00.000Z', '2026-08-08T08:00:00.000Z', 'active');
    PRAGMA user_version = 19;
  `);

  initializeRuntimeSchema(database);

  const columns = (database.prepare("PRAGMA table_info(active_segment)").all() as unknown as Array<{
    name: string;
  }>).map(column => column.name);
  assert.ok(columns.includes("overdue_since"));
  assert.ok(columns.includes("overdue_reason_json"));
  assert.ok(columns.includes("next_overdue_check_at"));
  const version = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  assert.equal(version.user_version, 23);
  const row = database.prepare(
    "SELECT overdue_since FROM active_segment WHERE id = 'segment-1'",
  ).get() as { overdue_since: string | null };
  assert.equal(row.overdue_since, null);
});

test("upgrades version 20 organ domain rows with budget columns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-schema-v20-"));
  const database = new DatabaseSync(path.join(root, "runtime.db"));
  database.exec(`
    CREATE TABLE activities (
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
    CREATE TABLE thread_maintenance (
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
    CREATE TABLE attention_maintenance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_completed_at TEXT,
      next_run_after TEXT NOT NULL,
      cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cursor_sequence >= 0),
      window_end_sequence INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_result_json TEXT,
      last_error TEXT
    ) STRICT;
    CREATE TABLE memory_reflection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      next_day TEXT NOT NULL,
      next_run_after TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_completed_day TEXT,
      last_result_json TEXT,
      last_error TEXT
    ) STRICT;
    CREATE TABLE proactive_pulse (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_pulse_at TEXT,
      next_pulse_after TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      last_error TEXT
    ) STRICT;
    INSERT INTO activities (id, opened_at, closed_at, recording_day, frozen_activity_json, status, created_at)
    VALUES ('activity-1', '2026-08-20T08:00:00.000Z', '2026-08-20T08:10:00.000Z', '2026-08-20', '{}', 'pending', '2026-08-20T08:10:00.000Z');
    PRAGMA user_version = 20;
  `);

  initializeRuntimeSchema(database);

  const columnsOf = (table: string) =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
      .map(column => column.name);
  assert.ok(columnsOf("activities").includes("next_eligible_at"));
  assert.ok(columnsOf("activities").includes("needs_human"));
  assert.ok(columnsOf("thread_maintenance").includes("next_eligible_at"));
  assert.ok(columnsOf("thread_maintenance").includes("needs_human"));
  assert.ok(columnsOf("attention_maintenance").includes("needs_human"));
  assert.ok(columnsOf("memory_reflection").includes("needs_human"));
  assert.ok(columnsOf("proactive_pulse").includes("needs_human"));
  for (const table of [
    "activities",
    "thread_maintenance",
    "attention_maintenance",
    "memory_reflection",
    "proactive_pulse",
  ]) {
    assert.ok(columnsOf(table).includes("transient_since"));
  }
  const version = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  assert.equal(version.user_version, 23);
  const row = database.prepare(
    "SELECT next_eligible_at, needs_human FROM activities WHERE id = 'activity-1'",
  ).get() as { next_eligible_at: string | null; needs_human: number };
  assert.equal(row.next_eligible_at, null);
  assert.equal(row.needs_human, 0);
});

test("upgrades version 21 by mapping blocked ledger work to needs_human rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-schema-v21-"));
  const database = new DatabaseSync(path.join(root, "runtime.db"));
  database.exec(`
    CREATE TABLE activities (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      recording_day TEXT NOT NULL,
      frozen_activity_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'recording', 'recorded')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_eligible_at TEXT,
      needs_human INTEGER NOT NULL DEFAULT 0 CHECK (needs_human IN (0, 1)),
      lease_owner TEXT,
      fencing_token INTEGER,
      lease_expires_at TEXT,
      receipt_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      recorded_at TEXT
    ) STRICT;
    CREATE TABLE cognitive_work (
      id TEXT PRIMARY KEY,
      organ TEXT NOT NULL,
      domain_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE cognitive_attempts (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES cognitive_work(id),
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO activities (id, opened_at, closed_at, recording_day, frozen_activity_json, status, created_at)
    VALUES ('activity-1', '2026-08-20T08:00:00.000Z', '2026-08-20T08:10:00.000Z', '2026-08-20', '{}', 'recording', '2026-08-20T08:10:00.000Z');
    INSERT INTO cognitive_work (id, organ, domain_ref, status, created_at, attempt_count)
    VALUES ('work-1', 'life-recorder', 'recording', 'blocked', '2026-08-20T08:10:00.000Z', 3);
    INSERT INTO cognitive_attempts (id, work_id, attempt_number, status, started_at)
    VALUES ('attempt-1', 'work-1', 1, 'failed', '2026-08-20T08:10:00.000Z');
    PRAGMA user_version = 21;
  `);

  initializeRuntimeSchema(database);

  const version = database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
  assert.equal(version.user_version, 23);
  // The stale recording claim is released and the blocked work lands as
  // needs_human on the domain row; the ledger tables are gone.
  const row = database.prepare(
    "SELECT status, needs_human FROM activities WHERE id = 'activity-1'",
  ).get() as Record<string, unknown>;
  assert.equal(row.status, "pending");
  assert.equal(row.needs_human, 1);
  for (const table of ["cognitive_work", "cognitive_attempts", "activity_attempts"]) {
    const exists = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    assert.equal(exists, undefined);
  }
});
