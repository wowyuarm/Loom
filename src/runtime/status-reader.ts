import type { DatabaseSync } from "node:sqlite";

import type {
  AttentionMaintenanceResult,
  CognitiveOrganName,
  CloseActivityBusyReason,
  FrozenActivity,
  InputKind,
  JsonValue,
  LifeRecorderReceipt,
  MemoryReflectionResult,
  RuntimeAfterChatContinuationStatus,
  RuntimeOrganLaneStatus,
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
  needs_human: number;
  next_eligible_at: string | null;
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
  needs_human: number;
  last_error: string | null;
}

interface ThreadMaintenanceRow {
  activity_id: string;
  observations_json: string;
  status: "pending" | "running" | "completed";
  attempt_count: number;
  needs_human: number;
  next_eligible_at: string | null;
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
  needs_human: number;
  last_result_json: string | null;
  last_error: string | null;
}

interface MemoryReflectionRow {
  next_day: string;
  next_run_after: string;
  attempt_count: number;
  needs_human: number;
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
  /** Organs driven through domain-row lanes, in display order. */
  organs: readonly CognitiveOrganName[];
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

  constructor(options: RuntimeStatusReaderOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#organs = options.organs;
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
             needs_human, next_eligible_at, fencing_token, receipt_json, last_error
      FROM activities
      ORDER BY sequence
    `).all() as unknown as ActivityRow[];
    const pulse = this.#readPulseSchedule();
    const threadMaintenanceRows = this.#database.prepare(`
      SELECT activity_id, observations_json, status, attempt_count, needs_human,
             next_eligible_at, fencing_token, result_json, last_error
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
        UNION ALL
        SELECT next_pulse_after AS pending_at FROM proactive_pulse WHERE next_pulse_after <= ?
      )
    `).get(
      statusObservedAt.toISOString(),
      statusObservedAt.toISOString(),
      statusObservedAt.toISOString(),
    ) as unknown as {
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
      organLanes: this.#organLanes(),
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
      SELECT last_pulse_at, next_pulse_after, consecutive_failures, needs_human, last_error
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
             attempt_count, needs_human, last_result_json, last_error
      FROM attention_maintenance WHERE singleton = 1
    `).get() as unknown as AttentionMaintenanceRow | undefined;
  }

  #readMemoryReflectionSchedule(): MemoryReflectionRow | undefined {
    return this.#database.prepare(`
      SELECT next_day, next_run_after, attempt_count, needs_human, last_completed_day,
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
   * Four-state projection per organ lane, derived from the domain rows and
   * the running agent runs. A lane with no pending domain work is absent.
   * Deliberately bounded: the reason is the row's stored error message
   * (already content-free at write time) and `since` is a provable failure
   * time from the agent run history.
   */
  #organLanes(): RuntimeOrganLaneStatus[] {
    const now = this.#now().getTime();
    const lastFailureByOrgan = new Map<string, { ended_at: string; failure_category: string | null }>();
    const failureRows = this.#database.prepare(`
      SELECT agent_name, ended_at, failure_category
      FROM agent_runs
      WHERE status = 'failed' AND ended_at IS NOT NULL
      ORDER BY started_at, id
    `).all() as unknown as Array<{ agent_name: string; ended_at: string; failure_category: string | null }>;
    for (const row of failureRows) {
      lastFailureByOrgan.set(row.agent_name, { ended_at: row.ended_at, failure_category: row.failure_category });
    }
    const runningOrgans = new Set(
      (this.#database.prepare(`
        SELECT DISTINCT agent_name FROM agent_runs WHERE status = 'running'
      `).all() as unknown as Array<{ agent_name: string }>).map(row => row.agent_name),
    );

    const lanes: RuntimeOrganLaneStatus[] = [];
    const push = (
      organ: RuntimeOrganLaneStatus["organ"],
      row: {
        attempts: number;
        needsHuman: boolean;
        nextEligibleAt: string | null;
        lastError: string | null;
      } | undefined,
    ): void => {
      if (!row) return;
      if (row.needsHuman) {
        const lastFailure = lastFailureByOrgan.get(organ);
        lanes.push({
          organ,
          state: "needs_human",
          ...(row.nextEligibleAt ? { nextRunAt: row.nextEligibleAt } : {}),
          ...(row.lastError ? { reason: row.lastError } : {}),
          ...(lastFailure?.failure_category ? { cause: lastFailure.failure_category } : {}),
          ...(lastFailure ? { since: lastFailure.ended_at } : {}),
          attempts: row.attempts,
        });
        return;
      }
      if (runningOrgans.has(organ)) {
        lanes.push({ organ, state: "running" });
        return;
      }
      if (row.nextEligibleAt && Date.parse(row.nextEligibleAt) > now) {
        lanes.push({ organ, state: "waiting", nextRunAt: row.nextEligibleAt, attempts: row.attempts });
        return;
      }
      lanes.push({ organ, state: "due" });
    };

    const attention = this.#readAttentionSchedule();
    if (attention) {
      push("attention-maintainer", {
        attempts: attention.attempt_count,
        needsHuman: attention.needs_human === 1,
        nextEligibleAt: attention.next_run_after,
        lastError: attention.last_error,
      });
    }
    const reflection = this.#readMemoryReflectionSchedule();
    if (reflection) {
      push("memory-reflector", {
        attempts: reflection.attempt_count,
        needsHuman: reflection.needs_human === 1,
        nextEligibleAt: reflection.next_run_after,
        lastError: reflection.last_error,
      });
    }
    const pulse = this.#readPulseSchedule();
    if (pulse) {
      push("orientation", {
        attempts: pulse.consecutive_failures,
        needsHuman: pulse.needs_human === 1,
        nextEligibleAt: pulse.next_pulse_after,
        lastError: pulse.last_error,
      });
    }
    const recorderHead = this.#database.prepare(`
      SELECT attempt_count, needs_human, next_eligible_at, last_error
      FROM activities WHERE status <> 'recorded'
      ORDER BY sequence LIMIT 1
    `).get() as unknown as {
      attempt_count: number;
      needs_human: number;
      next_eligible_at: string | null;
      last_error: string | null;
    } | undefined;
    if (recorderHead) {
      push("life-recorder", {
        attempts: recorderHead.attempt_count,
        needsHuman: recorderHead.needs_human === 1,
        nextEligibleAt: recorderHead.next_eligible_at,
        lastError: recorderHead.last_error,
      });
    }
    const threadHead = this.#database.prepare(`
      SELECT tm.attempt_count, tm.needs_human, tm.next_eligible_at, tm.last_error
      FROM thread_maintenance tm
      JOIN activities ON activities.id = tm.activity_id
      WHERE tm.status <> 'completed' AND activities.status = 'recorded'
      ORDER BY activities.sequence LIMIT 1
    `).get() as unknown as {
      attempt_count: number;
      needs_human: number;
      next_eligible_at: string | null;
      last_error: string | null;
    } | undefined;
    if (threadHead) {
      push("thread-maintainer", {
        attempts: threadHead.attempt_count,
        needsHuman: threadHead.needs_human === 1,
        nextEligibleAt: threadHead.next_eligible_at,
        lastError: threadHead.last_error,
      });
    }
    return lanes;
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
