import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Shared execution module for Cognitive Organs.
//
// Persistent ledger covering one "execution budget cycle" (cognitive_work) and
// append-only attempts (cognitive_attempts), plus a fixed execution policy
// (maximum attempts, failure backoff, and cancel grace). The Pi-native 50-turn
// session bound belongs to the Agent session module, not this ledger. It does
// not take over any organ's domain state: pending, ordering, lease,
// FIFO/Receipt, the Workspace Mutation journal, and official results stay in
// each organ's own tables. The shared layer records only budget, attempts,
// cancellation, failure category, and result references.
//
// This module owns its small schema outside the Runtime schema-version chain.
// It creates the final tables directly and performs one bounded rebuild when
// reopening the historical deadline columns; no dual read/write path remains.
//
// Append-only semantics: an attempt row allows exactly one running -> terminal
// update after it starts (ended_at/status/failure category are unknown at
// start); once terminal it is immutable. Any late call (complete, fail,
// cancel) against a terminal attempt is a no-op and never rewrites history.

export const COGNITIVE_ORGAN_POLICY: CognitiveOrganPolicy = Object.freeze({
  cancelGraceMs: 10_000,
  maxAttempts: 3,
  retryBackoffMs: [60_000, 5 * 60_000],
});

export type CognitiveOrganName =
  | "orientation"
  | "life-recorder"
  | "attention-maintainer"
  | "memory-reflector"
  | "thread-maintainer"
  | "tool-trace-compactor";

export type CognitiveAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "intervention_required";

export type CognitiveWorkStatus =
  | "running"
  | "retry_wait"
  | "completed"
  | "cancelled"
  | "blocked"
  | "intervention_required";

export type CognitiveRetryReason = "backoff" | "attempts_exhausted";

export interface CognitiveOrganPolicy {
  /** Grace window after cancel; if still not released, persist as intervention_required. */
  readonly cancelGraceMs: number;
  /** Total attempts allowed for the same logical work (including first run and automatic retries). */
  readonly maxAttempts: number;
  /** Backoff duration after the Nth failure; index 0 = first failure. */
  readonly retryBackoffMs: readonly number[];
}

export interface CognitiveAttemptRecord {
  id: string;
  workId: string;
  attemptNumber: number;
  status: CognitiveAttemptStatus;
  startedAt: string;
  endedAt?: string;
  modelRevision: string;
  cancelReason?: string;
  failureCategory?: string;
  transcriptRef?: string;
  resultRef?: string;
}

export interface CognitiveWorkRecord {
  id: string;
  organ: CognitiveOrganName;
  domainRef: string;
  status: CognitiveWorkStatus;
  createdAt: string;
  attemptCount: number;
  nextAttemptAt?: string;
  requeuedFrom?: string;
  lastCancelReason?: string;
  lastFailureCategory?: string;
  lastError?: string;
}

export interface RetryDecision {
  workStatus: "retry_wait" | "blocked";
  reason: CognitiveRetryReason;
  nextAttemptAt?: string;
}

export interface CognitiveOrganExecutionOptions {
  database: DatabaseSync;
  policy?: CognitiveOrganPolicy;
  now?: () => Date;
  nextId?: () => string;
}

function optionalStringField(
  row: Record<string, unknown>,
  column: string,
  field: string,
): Record<string, string> {
  const value = row[column];
  return value === null || value === undefined ? {} : { [field]: String(value) };
}

function initializeCognitiveOrganExecutionSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS cognitive_work (
      id TEXT PRIMARY KEY,
      organ TEXT NOT NULL CHECK (organ IN (
        'orientation', 'life-recorder', 'attention-maintainer',
        'memory-reflector', 'thread-maintainer', 'tool-trace-compactor'
      )),
      domain_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'running', 'retry_wait', 'completed', 'cancelled', 'blocked', 'intervention_required'
      )),
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      requeued_from TEXT,
      last_cancel_reason TEXT,
      last_failure_category TEXT,
      last_error TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS cognitive_attempts (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES cognitive_work(id),
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      status TEXT NOT NULL CHECK (status IN (
        'running', 'completed', 'failed', 'cancelled', 'intervention_required'
      )),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      model_revision TEXT NOT NULL,
      cancel_reason TEXT,
      failure_category TEXT,
      transcript_ref TEXT,
      result_ref TEXT,
      UNIQUE (work_id, attempt_number)
    ) STRICT;
  `);
  // Older databases stored normal-execution wall-clock deadlines in these
  // tables. Rebuild once so reopening an Instance cannot retain a hidden
  // deadline path. The ledger is small and wholly owned by this module.
  const columns = (table: string) => new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name),
  );
  const workColumns = columns("cognitive_work");
  const attemptColumns = columns("cognitive_attempts");
  if (!workColumns.has("total_deadline_at") && !attemptColumns.has("soft_deadline_at")) return;
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE cognitive_attempts RENAME TO cognitive_attempts_legacy;
    ALTER TABLE cognitive_work RENAME TO cognitive_work_legacy;
    CREATE TABLE cognitive_work (
      id TEXT PRIMARY KEY,
      organ TEXT NOT NULL CHECK (organ IN ('orientation', 'life-recorder', 'attention-maintainer', 'memory-reflector', 'thread-maintainer', 'tool-trace-compactor')),
      domain_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'retry_wait', 'completed', 'cancelled', 'blocked', 'intervention_required')),
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      requeued_from TEXT,
      last_cancel_reason TEXT,
      last_failure_category TEXT,
      last_error TEXT
    ) STRICT;
    CREATE TABLE cognitive_attempts (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES cognitive_work(id),
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'intervention_required')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      model_revision TEXT NOT NULL,
      cancel_reason TEXT,
      failure_category TEXT,
      transcript_ref TEXT,
      result_ref TEXT,
      UNIQUE (work_id, attempt_number)
    ) STRICT;
    INSERT INTO cognitive_work (id, organ, domain_ref, status, created_at, attempt_count, next_attempt_at, requeued_from, last_cancel_reason, last_failure_category, last_error)
      SELECT id, organ, domain_ref, status, created_at, attempt_count, next_attempt_at, requeued_from, last_cancel_reason, last_failure_category, last_error FROM cognitive_work_legacy;
    INSERT INTO cognitive_attempts (id, work_id, attempt_number, status, started_at, ended_at, model_revision, cancel_reason, failure_category, transcript_ref, result_ref)
      SELECT id, work_id, attempt_number, status, started_at, ended_at, model_revision, cancel_reason, failure_category, transcript_ref, result_ref FROM cognitive_attempts_legacy;
    DROP TABLE cognitive_attempts_legacy;
    DROP TABLE cognitive_work_legacy;
    COMMIT;
  `);
}

export class CognitiveOrganExecution {
  readonly #database: DatabaseSync;
  readonly #policy: CognitiveOrganPolicy;
  readonly #now: () => Date;
  readonly #nextId: () => string;

  constructor(options: CognitiveOrganExecutionOptions) {
    this.#database = options.database;
    this.#policy = options.policy ?? COGNITIVE_ORGAN_POLICY;
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? randomUUID;
    initializeCognitiveOrganExecutionSchema(this.#database);
  }

  /** Create one execution budget cycle and start the first attempt. */
  begin(
    organ: CognitiveOrganName,
    domainRef: string,
    modelRevision: string,
  ): { work: CognitiveWorkRecord; attempt: CognitiveAttemptRecord } {
    const now = this.#now();
    const workId = this.#nextId();
    const attemptId = this.#nextId();
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO cognitive_work (id, organ, domain_ref, status, created_at, attempt_count)
        VALUES (?, ?, ?, 'running', ?, 1)
      `).run(workId, organ, domainRef, now.toISOString());
      this.#insertAttempt(attemptId, workId, 1, now, modelRevision);
    });
    return {
      work: this.#workRecord(workId)!,
      attempt: this.#attemptRecord(attemptId),
    };
  }

  /**
   * Complete the attempt; effective only against a running attempt. When the
   * attempt is already terminal (cancelled/failed) this is a no-op and never
   * marks the work completed.
   */
  completeAttempt(
    workId: string,
    references: { transcriptRef?: string; resultRef?: string } = {},
  ): void {
    const endedAt = this.#now().toISOString();
    this.#transaction(() => {
      const changed = this.#database.prepare(`
        UPDATE cognitive_attempts
        SET status = 'completed', ended_at = ?, transcript_ref = ?, result_ref = ?
        WHERE work_id = ? AND status = 'running'
      `).run(endedAt, references.transcriptRef ?? null, references.resultRef ?? null, workId);
      if (changed.changes === 0) return;
      this.#database.prepare(`
        UPDATE cognitive_work
        SET status = 'completed'
        WHERE id = ? AND status = 'running'
      `).run(workId);
    });
  }

  /**
   * Fail the attempt and decide per policy: backoff retry or blocked.
   * Returns undefined when the call had no effect (no running attempt — already
   * cancelled or terminal); work state is unchanged and no retry quota is
   * consumed. Such a late failure can only be closed by finishCancelled /
   * markInterventionRequired.
   */
  failAttempt(
    workId: string,
    failure: { failureCategory: string; error?: string },
  ): RetryDecision | undefined {
    const now = this.#now();
    const decision = this.#transaction<RetryDecision | undefined>(() => {
      const changed = this.#database.prepare(`
        UPDATE cognitive_attempts
        SET status = 'failed', ended_at = ?, failure_category = ?
        WHERE work_id = ? AND status = 'running'
      `).run(now.toISOString(), failure.failureCategory, workId);
      if (changed.changes === 0) return undefined;
      const work = this.#workRecord(workId)!;
      if (work.attemptCount >= this.#policy.maxAttempts) {
        this.#markBlocked(workId, failure, now);
        return { workStatus: "blocked", reason: "attempts_exhausted" } as const;
      }
      const nextAttemptAt = this.#after(now, this.#backoffMs(work.attemptCount));
      this.#database.prepare(`
        UPDATE cognitive_work
        SET status = 'retry_wait', next_attempt_at = ?,
            last_failure_category = ?, last_error = ?
        WHERE id = ?
      `).run(nextAttemptAt.toISOString(), failure.failureCategory, failure.error ?? null, workId);
      return {
        workStatus: "retry_wait",
        reason: "backoff",
        nextAttemptAt: nextAttemptAt.toISOString(),
      } as const;
    });
    return decision;
  }

  /**
   * Cancel the current attempt (human preemption, Host stop, or explicit cancel). The attempt
   * is marked cancelled while the work stays running in the grace window: once
   * the organ releases within the window, the Runtime calls finishCancelled to
   * terminate; if it does not release, markInterventionRequired persists it as
   * intervention_required.
   */
  cancel(workId: string, reason: string): void {
    const now = this.#now();
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE cognitive_attempts
        SET status = 'cancelled', ended_at = ?, cancel_reason = ?
        WHERE work_id = ? AND status = 'running'
      `).run(now.toISOString(), reason, workId);
      this.#database.prepare(`
        UPDATE cognitive_work
        SET last_cancel_reason = ?
        WHERE id = ? AND status = 'running'
      `).run(reason, workId);
    });
  }

  /** Organ released within the grace window after cancel: work becomes cancelled, no automatic retry. */
  finishCancelled(workId: string): void {
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE cognitive_work
        SET status = 'cancelled'
        WHERE id = ? AND status = 'running'
      `).run(workId);
    });
  }

  /** Cancel grace expired without release: persist as intervention_required, forbidding parallel starts. */
  markInterventionRequired(workId: string, reason: string): void {
    const now = this.#now();
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE cognitive_attempts
        SET status = 'intervention_required', ended_at = ?, cancel_reason = ?
        WHERE work_id = ? AND status IN ('running', 'cancelled')
      `).run(now.toISOString(), reason, workId);
      this.#database.prepare(`
        UPDATE cognitive_work
        SET status = 'intervention_required', last_cancel_reason = ?
        WHERE id = ? AND status = 'running'
      `).run(reason, workId);
    });
  }

  /** Automatic retry: start the next attempt when backoff has elapsed; undefined when conditions are not met. */
  beginNextAttempt(workId: string, modelRevision: string): CognitiveAttemptRecord | undefined {
    const now = this.#now();
    return this.#transaction<CognitiveAttemptRecord | undefined>(() => {
      const work = this.#workRecord(workId);
      if (!work || work.status !== "retry_wait") return undefined;
      if (work.nextAttemptAt && Date.parse(work.nextAttemptAt) > now.getTime()) return undefined;
      if (work.attemptCount >= this.#policy.maxAttempts) {
        this.#database.prepare(`
          UPDATE cognitive_work SET status = 'blocked' WHERE id = ?
        `).run(workId);
        return undefined;
      }
      const attemptNumber = work.attemptCount + 1;
      const attemptId = this.#nextId();
      this.#insertAttempt(attemptId, workId, attemptNumber, now, modelRevision);
      this.#database.prepare(`
        UPDATE cognitive_work
        SET status = 'running', attempt_count = ?, next_attempt_at = NULL
        WHERE id = ?
      `).run(attemptNumber, workId);
      return this.#attemptRecord(attemptId);
    });
  }

  /**
   * Manual requeue: create a successor budget cycle referencing the same
   * domain object without copying domain work. Accepts only explicitly
   * recoverable terminal states (blocked, intervention_required); other states
   * are rejected to avoid parallel domain work or duplicated completed results.
   */
  requeue(
    workId: string,
    modelRevision: string,
  ): { work: CognitiveWorkRecord; attempt: CognitiveAttemptRecord } {
    const previous = this.#workRecord(workId);
    if (!previous) throw new Error(`Cannot requeue unknown cognitive work ${workId}`);
    if (previous.status !== "blocked" && previous.status !== "intervention_required") {
      throw new Error(`Cannot requeue cognitive work ${workId} in state ${previous.status}`);
    }
    const now = this.#now();
    const newWorkId = this.#nextId();
    const attemptId = this.#nextId();
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO cognitive_work (id, organ, domain_ref, status, created_at, attempt_count, requeued_from)
        VALUES (?, ?, ?, 'running', ?, 1, ?)
      `).run(
        newWorkId,
        previous.organ,
        previous.domainRef,
        now.toISOString(),
        workId,
      );
      this.#insertAttempt(attemptId, newWorkId, 1, now, modelRevision);
    });
    return {
      work: this.#workRecord(newWorkId)!,
      attempt: this.#attemptRecord(attemptId),
    };
  }


  /** Latest budget cycle of the organ (running / retry_wait / held / terminal). */
  currentWork(organ: CognitiveOrganName): CognitiveWorkRecord | undefined {
    const row = this.#database.prepare(`
      SELECT id FROM cognitive_work WHERE organ = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(organ) as { id: string } | undefined;
    if (!row) return undefined;
    return this.#workRecord(row.id);
  }

  /**
   * True when any organ's current cycle is held for human intervention
   * (blocks parallel starts). A requeued cycle replaces the held one, so the
   * historical held record must not keep blocking the organ entry point.
   */
  hasInterventionRequired(): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 FROM cognitive_work held
      WHERE held.status = 'intervention_required'
        AND NOT EXISTS (
          SELECT 1 FROM cognitive_work newer
          WHERE newer.organ = held.organ
            AND (newer.created_at > held.created_at
              OR (newer.created_at = held.created_at AND newer.rowid > held.rowid))
        )
      LIMIT 1
    `).get());
  }

  /**
   * Restart recovery: mark leftover running work/attempts as interrupted
   * failures and schedule retry or blocked per policy. Does not touch any
   * organ's domain state.
   */
  reconcile(now: Date): void {
    const running = this.#database.prepare(`
      SELECT id FROM cognitive_work WHERE status = 'running'
    `).all() as Array<{ id: string }>;
    for (const row of running) {
      this.failAttempt(row.id, { failureCategory: "interrupted", error: "Runtime restarted" });
    }
  }

  work(workId: string): CognitiveWorkRecord | undefined {
    return this.#workRecord(workId);
  }

  /**
   * Opaque, stable local work id (`organ-<rowid>`) for operator-facing
   * surfaces; never exposes the raw UUID or domain content.
   */
  localIdOf(workId: string): string | undefined {
    const row = this.#database.prepare(`
      SELECT rowid, organ FROM cognitive_work WHERE id = ?
    `).get(workId) as { rowid: number; organ: string } | undefined;
    return row ? `${row.organ}-${row.rowid}` : undefined;
  }

  /** Resolve an operator-supplied local work id back to the work record. */
  resolveLocalId(localId: string): CognitiveWorkRecord | undefined {
    const match = /^(.+)-(\d+)$/.exec(localId);
    if (!match) return undefined;
    const row = this.#database.prepare(`
      SELECT id, organ FROM cognitive_work WHERE rowid = ?
    `).get(Number(match[2])) as { id: string; organ: string } | undefined;
    if (!row || row.organ !== match[1]) return undefined;
    return this.#workRecord(row.id);
  }

  attempts(workId: string): CognitiveAttemptRecord[] {
    const rows = this.#database.prepare(`
      SELECT id, work_id, attempt_number, status, started_at, ended_at,
             model_revision, cancel_reason, failure_category, transcript_ref, result_ref
      FROM cognitive_attempts WHERE work_id = ? ORDER BY attempt_number
    `).all(workId) as unknown as Array<Record<string, unknown>>;
    return rows.map(row => this.#mapAttempt(row));
  }

  #insertAttempt(id: string, workId: string, attemptNumber: number, startedAt: Date, modelRevision: string): void {
    this.#database.prepare(`
      INSERT INTO cognitive_attempts (id, work_id, attempt_number, status, started_at, model_revision)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(id, workId, attemptNumber, startedAt.toISOString(), modelRevision);
  }

  #markBlocked(workId: string, failure: { failureCategory: string; error?: string }, now: Date): void {
    this.#database.prepare(`
      UPDATE cognitive_work
      SET status = 'blocked', next_attempt_at = NULL,
          last_failure_category = ?, last_error = ?
      WHERE id = ?
    `).run(failure.failureCategory, failure.error ?? null, workId);
  }

  #backoffMs(attemptCount: number): number {
    const backoff = this.#policy.retryBackoffMs;
    const index = Math.min(Math.max(0, attemptCount - 1), backoff.length - 1);
    return backoff[index]!;
  }

  #after(from: Date, ms: number): Date {
    return new Date(from.getTime() + ms);
  }

  #workRecord(workId: string): CognitiveWorkRecord | undefined {
    const row = this.#database.prepare(`
      SELECT id, organ, domain_ref, status, created_at, attempt_count,
             next_attempt_at, requeued_from, last_cancel_reason, last_failure_category, last_error
      FROM cognitive_work WHERE id = ?
    `).get(workId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      organ: row.organ as CognitiveOrganName,
      domainRef: row.domain_ref as string,
      status: row.status as CognitiveWorkStatus,
      createdAt: row.created_at as string,
      attemptCount: row.attempt_count as number,
      ...optionalStringField(row, "next_attempt_at", "nextAttemptAt"),
      ...optionalStringField(row, "requeued_from", "requeuedFrom"),
      ...optionalStringField(row, "last_cancel_reason", "lastCancelReason"),
      ...optionalStringField(row, "last_failure_category", "lastFailureCategory"),
      ...optionalStringField(row, "last_error", "lastError"),
    };
  }

  #attemptRecord(attemptId: string): CognitiveAttemptRecord {
    const row = this.#database.prepare(`
      SELECT id, work_id, attempt_number, status, started_at, ended_at,
             model_revision, cancel_reason, failure_category, transcript_ref, result_ref
      FROM cognitive_attempts WHERE id = ?
    `).get(attemptId) as Record<string, unknown>;
    return this.#mapAttempt(row);
  }

  #mapAttempt(row: Record<string, unknown>): CognitiveAttemptRecord {
    return {
      id: row.id as string,
      workId: row.work_id as string,
      attemptNumber: row.attempt_number as number,
      status: row.status as CognitiveAttemptStatus,
      startedAt: row.started_at as string,
      modelRevision: row.model_revision as string,
      ...optionalStringField(row, "ended_at", "endedAt"),
      ...optionalStringField(row, "cancel_reason", "cancelReason"),
      ...optionalStringField(row, "failure_category", "failureCategory"),
      ...optionalStringField(row, "transcript_ref", "transcriptRef"),
      ...optionalStringField(row, "result_ref", "resultRef"),
    };
  }

  #transaction<T>(fn: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = fn();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
