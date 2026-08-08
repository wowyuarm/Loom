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
  assert.equal(version.user_version, 20);
  const row = database.prepare(
    "SELECT overdue_since FROM active_segment WHERE id = 'segment-1'",
  ).get() as { overdue_since: string | null };
  assert.equal(row.overdue_since, null);
});
