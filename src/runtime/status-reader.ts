import type { DatabaseSync } from "node:sqlite";

import type {
  CognitiveAttemptRecord,
  CognitiveOrganName,
  CognitiveWorkRecord,
} from "./cognitive-organ-execution.js";
import type {
  AttentionMaintenanceResult,
  CloseActivityBusyReason,
  FrozenActivity,
  InputKind,
  JsonValue,
  LifeRecorderReceipt,
  MemoryReflectionResult,
  RuntimeAfterChatContinuationStatus,
  RuntimeCognitiveOrganWorkStatus,
  RuntimeDeliveryStatus,
  RuntimeEffectStatus,
  RuntimeInputStatus,
  RuntimeStatus,
  RuntimeTurnStatus,
  ThreadMaintenanceResult,
  TranscriptAnchor,
} from "./types.js";

interface InputRow {
  id: string;
  source: string;
  source_id: string;
  kind: InputKind;
  payload_json: string;
  interaction_json: string | null;
  interaction_wave_id: string | null;
  occurred_at: string;
  status: RuntimeInputStatus["status"];
  late_arriving: 0 | 1 | null;
}

interface TurnRow {
  id: string;
  segment_id: string;
  status: RuntimeTurnStatus["status"];
  fencing_token: number;
  transcript_anchor_json: string | null;
  execution_record_json: string | null;
}

interface ActiveSegmentRow {
  id: string;
  opened_at: string;
  last_activity_at: string;
  starting_state_json: string | null;
  status: "active" | "closing";
  close_fencing_token: number | null;
  closed_at: string | null;
  overdue_since: string | null;
  overdue_reason_json: string | null;
  next_overdue_check_at: string | null;
}

interface ActivityRow {
  id: string;
  opened_at: string;
  closed_at: string;
  frozen_activity_json: string;
  status: "pending" | "recording" | "recorded";
  attempt_count: number;
  fencing_token: number | null;
  receipt_json: string | null;
  last_error: string | null;
}

interface EffectRow {
  id: string;
  turn_id: string;
  kind: string;
  payload_json: string;
  route_ref: string | null;
  destination_ref: string | null;
  input_position: number;
  status: RuntimeEffectStatus["status"];
  next_delivery_after: string | null;
}

interface DeliveryRow {
  id: string;
  effect_id: string;
  attempt_number: number;
  status: RuntimeDeliveryStatus["status"];
  idempotency_key: string;
  remote_id: string | null;
  error: string | null;
}

interface PulseRow {
  last_pulse_at: string | null;
  next_pulse_after: string;
  consecutive_failures: number;
  last_error: string | null;
}

interface ThreadMaintenanceRow {
  activity_id: string;
  observations_json: string;
  status: "pending" | "running" | "completed";
  attempt_count: number;
  fencing_token: number | null;
  result_json: string | null;
  last_error: string | null;
}

interface AttentionMaintenanceRow {
  last_completed_at: string | null;
  next_run_after: string;
  cursor_sequence: number;
  window_end_sequence: number | null;
  attempt_count: number;
  last_result_json: string | null;
  last_error: string | null;
}

interface MemoryReflectionRow {
  next_day: string;
  next_run_after: string;
  attempt_count: number;
  last_completed_day: string | null;
  last_result_json: string | null;
  last_error: string | null;
}

interface AfterChatContinuationRow {
  id: string;
  status: RuntimeAfterChatContinuationStatus["status"];
  source_delivery_id: string;
  source_effect_id: string;
  source_turn_id: string;
  source_segment_id: string;
  source_behavior: RuntimeAfterChatContinuationStatus["sourceBehavior"];
  delivered_at: string;
  due_at: string;
  expires_at: string;
  input_id: string | null;
  ended_at: string | null;
  reason: string | null;
}

export interface RuntimeStatusReaderOptions {
  database: DatabaseSync;
  now: () => Date;
  /** Organs executed through the shared Cognitive Organ ledger, in display order. */
  organs: readonly CognitiveOrganName[];
  /** Latest work record for an organ, or undefined when it has no work. */
  cognitiveOrganWork: (organ: CognitiveOrganName) => CognitiveWorkRecord | undefined;
  /** Local (bounded) work id for a raw work UUID; undefined when unresolvable. */
  cognitiveOrganLocalId: (workId: string) => string | undefined;
  /** Attempt records of a work, newest last. */
  cognitiveOrganAttempts: (workId: string) => readonly CognitiveAttemptRecord[];
}

/**
 * Read-only projection of Runtime status. It only ever SELECTs; it never
 * writes and never opens a transaction. The Runtime keeps ownership of the
 * SQLite database, clock, ids, leases and recovery.
 */
export class RuntimeStatusReader {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  readonly #organs: readonly CognitiveOrganName[];
  readonly #cognitiveOrganWork: (organ: CognitiveOrganName) => CognitiveWorkRecord | undefined;
  readonly #cognitiveOrganLocalId: (workId: string) => string | undefined;
  readonly #cognitiveOrganAttempts: (workId: string) => readonly CognitiveAttemptRecord[];

  constructor(options: RuntimeStatusReaderOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#organs = options.organs;
    this.#cognitiveOrganWork = options.cognitiveOrganWork;
    this.#cognitiveOrganLocalId = options.cognitiveOrganLocalId;
    this.#cognitiveOrganAttempts = options.cognitiveOrganAttempts;
  }

  readStatus(): RuntimeStatus {
    const rows = this.#database.prepare(`
      SELECT id, source, source_id, kind, payload_json, interaction_json, interaction_wave_id, status
      FROM inputs
      ORDER BY accepted_at, id
    `).all() as unknown as InputRow[];
    const turnRows = this.#database.prepare(`
      SELECT id, segment_id, status, fencing_token, transcript_anchor_json, execution_record_json
      FROM turns
      ORDER BY started_at, id
    `).all() as unknown as TurnRow[];
    const inputIdsByTurn = this.#database.prepare(`
      SELECT input_id
      FROM turn_inputs
      WHERE turn_id = ? AND inclusion_status = 'included'
      ORDER BY position
    `);
    const effectRows = this.#database.prepare(`
      SELECT id, turn_id, kind, payload_json, route_ref, destination_ref, input_position, status,
             next_delivery_after
      FROM effects
      ORDER BY created_at, id
    `).all() as unknown as EffectRow[];
    const deliveryRows = this.#database.prepare(`
      SELECT id, effect_id, attempt_number, status, idempotency_key, remote_id, error
      FROM delivery_attempts
      ORDER BY started_at, id
    `).all() as unknown as DeliveryRow[];
    const activeSegment = this.#readActiveSegment();
    const activityRows = this.#database.prepare(`
      SELECT id, opened_at, closed_at, frozen_activity_json, status, attempt_count,
             fencing_token, receipt_json, last_error
      FROM activities
      ORDER BY sequence
    `).all() as unknown as ActivityRow[];
    const pulse = this.#readPulseSchedule();
    const threadMaintenanceRows = this.#database.prepare(`
      SELECT activity_id, observations_json, status, attempt_count, fencing_token,
             result_json, last_error
      FROM thread_maintenance
      ORDER BY created_at, activity_id
    `).all() as unknown as ThreadMaintenanceRow[];
    const attentionMaintenance = this.#readAttentionSchedule();
    const memoryReflection = this.#readMemoryReflectionSchedule();
    const afterChatContinuation = this.#readAfterChatContinuation();
    const statusObservedAt = this.#now();
    const oldestPendingOrgan = this.#database.prepare(`
      SELECT MIN(pending_at) AS pending_at
      FROM (
        SELECT created_at AS pending_at FROM activities WHERE status <> 'recorded'
        UNION ALL
        SELECT created_at AS pending_at FROM thread_maintenance WHERE status <> 'completed'
        UNION ALL
        SELECT next_run_after AS pending_at FROM attention_maintenance WHERE next_run_after <= ?
        UNION ALL
        SELECT next_run_after AS pending_at FROM memory_reflection WHERE next_run_after <= ?
      )
    `).get(statusObservedAt.toISOString(), statusObservedAt.toISOString()) as unknown as {
      pending_at: string | null;
    };
    const integrityWarnings = this.#database.prepare(`
      SELECT turns.segment_id, GROUP_CONCAT(turns.id) AS turn_ids
      FROM turns
      LEFT JOIN activities ON activities.id = turns.segment_id
      LEFT JOIN active_segment ON active_segment.id = turns.segment_id
      WHERE turns.status <> 'running'
        AND activities.id IS NULL
        AND active_segment.id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transitions
          WHERE transitions.entity_type = 'segment'
            AND transitions.entity_id = turns.segment_id
            AND transitions.to_state = 'discarded'
        )
      GROUP BY turns.segment_id
      ORDER BY MIN(turns.started_at), turns.segment_id
    `).all() as unknown as Array<{ segment_id: string; turn_ids: string }>;
    return {
      inputs: rows.map(row => ({
        id: row.id,
        source: row.source,
        sourceId: row.source_id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as JsonValue,
        ...(row.interaction_json
          ? { interaction: JSON.parse(row.interaction_json) as NonNullable<RuntimeInputStatus["interaction"]> }
          : {}),
        ...(row.interaction_wave_id ? { interactionWaveId: row.interaction_wave_id } : {}),
        status: row.status,
      })),
      turns: turnRows.map(row => {
        const inputRows = inputIdsByTurn.all(row.id) as unknown as Array<{ input_id: string }>;
        return {
          id: row.id,
          status: row.status,
          inputIds: inputRows.map(input => input.input_id),
          ...(row.transcript_anchor_json
            ? { transcriptAnchor: JSON.parse(row.transcript_anchor_json) as TranscriptAnchor }
            : {}),
          ...(row.execution_record_json
            ? { executionRecord: JSON.parse(row.execution_record_json) as JsonValue }
            : {}),
        };
      }),
      effects: effectRows.map(row => ({
        id: row.id,
        turnId: row.turn_id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as JsonValue,
        ...(row.route_ref ? { routeRef: row.route_ref } : {}),
        ...(row.destination_ref ? { destinationRef: row.destination_ref } : {}),
        coveredInputPosition: row.input_position,
        status: row.status,
        ...(row.next_delivery_after ? { nextDeliveryAt: row.next_delivery_after } : {}),
      })),
      deliveries: deliveryRows.map(row => ({
        id: row.id,
        effectId: row.effect_id,
        attempt: row.attempt_number,
        status: row.status,
        idempotencyKey: row.idempotency_key,
        ...(row.remote_id ? { remoteId: row.remote_id } : {}),
        ...(row.error ? { error: row.error } : {}),
      })),
      ...(activeSegment ? {
        activeSegment: {
          id: activeSegment.id,
          openedAt: activeSegment.opened_at,
          lastActivityAt: activeSegment.last_activity_at,
          ...(activeSegment.overdue_since !== null && activeSegment.overdue_reason_json !== null ? {
            overdueSince: activeSegment.overdue_since,
            overdueReason: JSON.parse(activeSegment.overdue_reason_json) as CloseActivityBusyReason,
            ...(activeSegment.next_overdue_check_at !== null
              ? { nextOverdueCheckAt: activeSegment.next_overdue_check_at }
              : {}),
          } : {}),
        },
      } : {}),
      activities: activityRows.map(row => ({
        id: row.id,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        status: row.status,
        attempts: row.attempt_count,
        ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) as LifeRecorderReceipt } : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
      })),
      threadMaintenance: threadMaintenanceRows.map(row => ({
        activityId: row.activity_id,
        status: row.status,
        attempts: row.attempt_count,
        ...(row.result_json
          ? { result: JSON.parse(row.result_json) as ThreadMaintenanceResult }
          : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
      })),
      cognitiveOrganWork: this.#organs
        .map(organ => this.#cognitiveOrganWork(organ))
        .filter((work): work is NonNullable<typeof work> => work !== undefined)
        .map(work => this.#cognitiveOrganWorkStatus(work)),
      ...(attentionMaintenance ? {
        attentionMaintenance: {
          ...(attentionMaintenance.last_completed_at
            ? { lastCompletedAt: attentionMaintenance.last_completed_at }
            : {}),
          nextRunAfter: attentionMaintenance.next_run_after,
          attempts: attentionMaintenance.attempt_count,
          pendingActivityIds: this.#activitiesInSequenceRange(
            attentionMaintenance.cursor_sequence,
            attentionMaintenance.window_end_sequence ?? this.#latestActivitySequence(),
          ).map(activity => activity.segmentId),
          ...(attentionMaintenance.last_result_json
            ? { lastResult: JSON.parse(attentionMaintenance.last_result_json) as AttentionMaintenanceResult }
            : {}),
          ...(attentionMaintenance.last_error ? { lastError: attentionMaintenance.last_error } : {}),
        },
      } : {}),
      ...(memoryReflection ? {
        memoryReflection: {
          nextDay: memoryReflection.next_day,
          nextRunAfter: memoryReflection.next_run_after,
          attempts: memoryReflection.attempt_count,
          pendingActivityIds: this.#reflectionActivities(memoryReflection.next_day)
            .map(activity => activity.segmentId),
          ...(memoryReflection.last_completed_day
            ? { lastCompletedDay: memoryReflection.last_completed_day }
            : {}),
          ...(memoryReflection.last_result_json
            ? { lastResult: JSON.parse(memoryReflection.last_result_json) as MemoryReflectionResult }
            : {}),
          ...(memoryReflection.last_error ? { lastError: memoryReflection.last_error } : {}),
        },
      } : {}),
      ...(pulse ? {
        proactivePulse: {
          ...(pulse.last_pulse_at ? { lastPulseAt: pulse.last_pulse_at } : {}),
          nextPulseAfter: pulse.next_pulse_after,
          consecutiveFailures: pulse.consecutive_failures,
          ...(pulse.last_error ? { lastError: pulse.last_error } : {}),
        },
      } : {}),
      ...(afterChatContinuation ? {
        afterChatContinuation: {
          id: afterChatContinuation.id,
          status: afterChatContinuation.status,
          sourceDeliveryId: afterChatContinuation.source_delivery_id,
          sourceEffectId: afterChatContinuation.source_effect_id,
          sourceTurnId: afterChatContinuation.source_turn_id,
          sourceSegmentId: afterChatContinuation.source_segment_id,
          sourceBehavior: afterChatContinuation.source_behavior,
          deliveredAt: afterChatContinuation.delivered_at,
          dueAt: afterChatContinuation.due_at,
          expiresAt: afterChatContinuation.expires_at,
          ...(afterChatContinuation.input_id ? { inputId: afterChatContinuation.input_id } : {}),
          ...(afterChatContinuation.ended_at ? { endedAt: afterChatContinuation.ended_at } : {}),
          ...(afterChatContinuation.reason ? { reason: afterChatContinuation.reason } : {}),
        },
      } : {}),
      ...(oldestPendingOrgan.pending_at ? {
        oldestPendingOrganAt: oldestPendingOrgan.pending_at,
        oldestPendingOrganAgeMs: Math.max(
          0,
          statusObservedAt.getTime() - Date.parse(oldestPendingOrgan.pending_at),
        ),
      } : {}),
      integrityWarnings: integrityWarnings.map(warning => ({
        kind: "unexplained_terminal_turn_segment",
        segmentId: warning.segment_id,
        turnIds: warning.turn_ids.split(","),
      })),
    };
  }

  #readActiveSegment(): ActiveSegmentRow | undefined {
    return this.#database.prepare(`
      SELECT id, opened_at, last_activity_at, starting_state_json, status, close_fencing_token, closed_at,
             overdue_since, overdue_reason_json, next_overdue_check_at
      FROM active_segment WHERE singleton = 1
    `).get() as unknown as ActiveSegmentRow | undefined;
  }

  #readPulseSchedule(): PulseRow | undefined {
    return this.#database.prepare(`
      SELECT last_pulse_at, next_pulse_after, consecutive_failures, last_error
      FROM proactive_pulse WHERE singleton = 1
    `).get() as unknown as PulseRow | undefined;
  }

  #readAfterChatContinuation(): AfterChatContinuationRow | undefined {
    return this.#database.prepare(`
      SELECT id, status, source_delivery_id, source_effect_id, source_turn_id,
             source_segment_id, source_behavior, delivered_at, due_at, expires_at,
             input_id, ended_at, reason
      FROM after_chat_continuation WHERE singleton = 1
    `).get() as unknown as AfterChatContinuationRow | undefined;
  }

  #readAttentionSchedule(): AttentionMaintenanceRow | undefined {
    return this.#database.prepare(`
      SELECT last_completed_at, next_run_after, cursor_sequence, window_end_sequence,
             attempt_count, last_result_json, last_error
      FROM attention_maintenance WHERE singleton = 1
    `).get() as unknown as AttentionMaintenanceRow | undefined;
  }

  #readMemoryReflectionSchedule(): MemoryReflectionRow | undefined {
    return this.#database.prepare(`
      SELECT next_day, next_run_after, attempt_count, last_completed_day,
             last_result_json, last_error
      FROM memory_reflection WHERE singleton = 1
    `).get() as unknown as MemoryReflectionRow | undefined;
  }

  #latestActivitySequence(): number {
    const row = this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM activities
    `).get() as unknown as { sequence: number };
    return row.sequence;
  }

  #activitiesInSequenceRange(afterSequence: number, throughSequence: number): FrozenActivity[] {
    const rows = this.#database.prepare(`
      SELECT frozen_activity_json FROM activities
      WHERE sequence > ? AND sequence <= ?
      ORDER BY sequence
    `).all(afterSequence, throughSequence) as unknown as Array<{ frozen_activity_json: string }>;
    return rows.map(row => JSON.parse(row.frozen_activity_json) as FrozenActivity);
  }

  #reflectionActivities(reflectionDay: string): FrozenActivity[] {
    const rows = this.#database.prepare(`
      SELECT activities.id, activities.frozen_activity_json
      FROM activities
      WHERE activities.id IN (
        SELECT DISTINCT segment_id FROM turns WHERE recording_day = ?
      )
      ORDER BY activities.sequence
    `).all(reflectionDay) as unknown as Array<{ id: string; frozen_activity_json: string }>;
    const turnRows = this.#database.prepare(`
      SELECT id FROM turns WHERE segment_id = ? AND recording_day = ? ORDER BY started_at, id
    `);
    return rows.map(row => reflectionSlice(
      JSON.parse(row.frozen_activity_json) as FrozenActivity,
      reflectionDay,
      new Set((turnRows.all(row.id, reflectionDay) as unknown as Array<{ id: string }>).map(turn => turn.id)),
    ));
  }

  /**
   * Operator-facing work summary. Deliberately omits the raw error text and
   * exposes only bounded identifiers (local work id, domain ref, failure
   * category) so status output cannot leak model/Workspace/credential content.
   */
  #cognitiveOrganWorkStatus(work: CognitiveWorkRecord): RuntimeCognitiveOrganWorkStatus {
    // Local ids are the only exposed work identifiers; an unresolvable one is
    // corrupt state and fails closed instead of leaking a raw work UUID.
    const workId = this.#cognitiveOrganLocalId(work.id);
    if (!workId) {
      throw new Error(`Cognitive organ work ${work.id} is not addressable by a local work id`);
    }
    const requeuedFrom = work.requeuedFrom
      ? this.#cognitiveOrganLocalId(work.requeuedFrom)
      : undefined;
    if (work.requeuedFrom && !requeuedFrom) {
      throw new Error(`Cognitive organ work ${work.id} references an unresolvable predecessor`);
    }
    // The current attempt is the most recently started one (highest attempt
    // number): for a retried or completed work its transcript and result
    // references live on that record, not the first attempt.
    const attempt = this.#cognitiveOrganAttempts(work.id).at(-1);
    return {
      workId,
      organ: work.organ,
      domainRef: work.domainRef,
      status: work.status,
      attemptCount: work.attemptCount,
      createdAt: work.createdAt,
      ...(work.nextAttemptAt ? { nextAttemptAt: work.nextAttemptAt } : {}),
      ...(requeuedFrom ? { requeuedFrom } : {}),
      ...(work.lastCancelReason ? { lastCancelReason: work.lastCancelReason } : {}),
      ...(work.lastFailureCategory ? { lastFailureCategory: work.lastFailureCategory } : {}),
      // When the last attempt failed (blocked/retry_wait), its ended_at is the
      // provable time the degradation entered: the attempt failed at that
      // moment. Never the work creation time.
      ...(attempt?.status === "failed" && attempt.endedAt
        ? { lastFailureAt: attempt.endedAt }
        : {}),
      ...(attempt?.transcriptRef ? { transcriptRef: attempt.transcriptRef } : {}),
      ...(attempt?.resultRef ? { resultRef: attempt.resultRef } : {}),
    };
  }
}

export function reflectionSlice(
  activity: FrozenActivity,
  reflectionDay: string,
  turnIds: ReadonlySet<string>,
): FrozenActivity {
  return {
    ...activity,
    recordingDay: reflectionDay,
    events: activity.events.filter(event => turnIds.has(event.turnId)),
    turns: activity.turns.filter(turn => turnIds.has(turn.turnId)),
  };
}
