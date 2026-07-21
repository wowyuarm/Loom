import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { createHostTimePolicy, type TimePolicy } from "../configuration/index.js";
import { initializeRuntimeSchema } from "./schema.js";
import type {
  AcceptedInput,
  AdvanceResult,
  ActivityFreezeRequest,
  ActivityLifecycle,
  ActivityRecorder,
  AgentExecution,
  CloseActivityResult,
  DeliveryAttemptRequest,
  DeliveryObservation,
  EffectReceipt,
  EffectRequest,
  ExecutionInput,
  ExecutionResult,
  FormOpportunityResult,
  InputKind,
  FrozenActivity,
  LifeRecorderReceipt,
  Orientation,
  OutboundDelivery,
  JsonValue,
  RunningExecution,
  Runtime,
  RuntimeDeliveryStatus,
  RuntimeEffectStatus,
  RuntimeInput,
  RuntimeInputStatus,
  RuntimeOptions,
  RuntimeStatus,
  RuntimeTurnStatus,
  TranscriptAnchor,
  VerifiedToolActivity,
} from "./types.js";

interface InputRow {
  id: string;
  source: string;
  source_id: string;
  kind: InputKind;
  payload_json: string;
  occurred_at: string;
  status: RuntimeInputStatus["status"];
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
  starting_state_json: string | null;
  status: "active" | "closing";
  close_fencing_token: number | null;
  closed_at: string | null;
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
  input_position: number;
  status: RuntimeEffectStatus["status"];
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

interface ActiveExecution {
  turnId: string;
  fencingToken: number;
  execution: RunningExecution;
  finishing: boolean;
  steeringTail: Promise<void>;
}

class SqliteRuntime implements Runtime {
  readonly #database: DatabaseSync;
  readonly #execution: AgentExecution | undefined;
  readonly #outboundDelivery: OutboundDelivery | undefined;
  readonly #activityLifecycle: ActivityLifecycle | undefined;
  readonly #activityRecorder: ActivityRecorder | undefined;
  readonly #orientation: Orientation | undefined;
  readonly #timePolicy: TimePolicy;
  readonly #now: () => Date;
  readonly #nextId: () => string;
  readonly #ownerId: string;
  readonly #leaseDurationMs: number;
  #active: ActiveExecution | undefined;
  #activeDeliveryId: string | undefined;
  #closingActivityId: string | undefined;
  #activeActivityAttemptId: string | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(options: RuntimeOptions) {
    mkdirSync(options.root, { recursive: true });
    this.#database = new DatabaseSync(path.join(options.root, "runtime.db"));
    this.#execution = options.execution;
    this.#outboundDelivery = options.outboundDelivery;
    this.#activityLifecycle = options.activityLifecycle;
    this.#activityRecorder = options.activityRecorder;
    this.#orientation = options.orientation;
    this.#timePolicy = options.timePolicy ?? createHostTimePolicy();
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? randomUUID;
    this.#ownerId = options.ownerId ?? randomUUID();
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
    initializeRuntimeSchema(this.#database);
    this.#reconcileExpiredActivityClose();
    this.#reconcileExpiredActivityRecording();
    this.#reconcileExpiredDeliveries();
    this.#reconcileExpiredTurns();
  }

  async acceptInput(input: RuntimeInput): Promise<AcceptedInput> {
    if (!input.source || !input.sourceId) throw new Error("Runtime input requires source and sourceId");
    const id = this.#nextId();
    const accepted = this.#transaction(() => {
      const existing = this.#findInput(input.source, input.sourceId);
      if (existing) return { disposition: "duplicate", inputId: existing.id } as const;
      const now = this.#now();
      const result = this.#database.prepare(`
        INSERT OR IGNORE INTO inputs (
          id, source, source_id, kind, payload_json, occurred_at, accepted_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        id,
        input.source,
        input.sourceId,
        input.kind,
        JSON.stringify(input.payload),
        input.occurredAt ?? now.toISOString(),
        now.toISOString(),
      );
      if (result.changes === 1) {
        this.#recordTransition("input", id, null, "pending", "accepted", now, null);
        return { disposition: "accepted", inputId: id } as const;
      }
      const duplicate = this.#findInput(input.source, input.sourceId);
      if (!duplicate) throw new Error("Input dedupe conflict did not preserve an existing input");
      return { disposition: "duplicate", inputId: duplicate.id } as const;
    });

    if (accepted.disposition === "accepted") {
      const accepted = { disposition: "accepted", inputId: id } as const;
      const active = this.#active;
      if (active && !active.finishing) {
        const steering = active.steeringTail.then(async () => {
          await this.#steerInput(active, id);
        });
        active.steeringTail = steering.catch(() => {});
      }
      return accepted;
    }
    return accepted;
  }

  async formOpportunity(): Promise<FormOpportunityResult> {
    if (!this.#orientation) throw new Error("Runtime has no Orientation adapter");
    const observedAt = this.#now();
    const snapshot = this.#opportunitySnapshot(observedAt);
    if (!snapshot) return { disposition: "busy" };

    const result = await this.#orientation.form(snapshot.request);
    if (result.outcome === "none") return { disposition: "none", runId: result.runId };
    if (!result.runId.trim() || !result.narrative.trim()) {
      throw new Error("Orientation Opportunity requires a runId and narrative");
    }

    return this.#transaction(() => {
      if (!this.#isOpportunityIdle()
        || this.#latestOpportunityTransitionSequence() !== snapshot.transitionSequence) {
        return { disposition: "stale", runId: result.runId } as const;
      }
      const inputId = this.#nextId();
      const acceptedAt = this.#now();
      this.#database.prepare(`
        INSERT INTO inputs (
          id, source, source_id, kind, payload_json, occurred_at, accepted_at, status
        ) VALUES (?, 'orientation', ?, 'opportunity', ?, ?, ?, 'pending')
      `).run(
        inputId,
        result.runId,
        JSON.stringify({
          version: 1,
          narrative: result.narrative.trim(),
          observedAt: snapshot.request.observedAt,
          localTime: snapshot.request.localTime,
          ...(snapshot.request.lastHumanInputAt
            ? { lastHumanInputAt: snapshot.request.lastHumanInputAt }
            : {}),
        }),
        snapshot.request.observedAt,
        acceptedAt.toISOString(),
      );
      this.#recordTransition("input", inputId, null, "pending", "opportunity_admitted", acceptedAt, null);
      return { disposition: "accepted", inputId, runId: result.runId } as const;
    });
  }

  async advance(): Promise<AdvanceResult> {
    if (this.#active || this.#activeDeliveryId || this.#closingActivityId || this.#activeActivityAttemptId) {
      return { disposition: "busy" };
    }
    this.#reconcileExpiredDeliveries();
    this.#reconcileExpiredTurns();
    this.#reconcileExpiredActivityClose();
    this.#reconcileExpiredActivityRecording();
    if (this.#hasRunningTurn()) return { disposition: "busy" };

    if (this.#outboundDelivery) {
      const delivery = this.#claimPendingDelivery();
      if (delivery) {
        this.#activeDeliveryId = delivery.request.attemptId;
        this.#startHeartbeat("delivery", delivery.request.attemptId, delivery.fencingToken);
        try {
          let observation: DeliveryObservation;
          try {
            observation = await this.#outboundDelivery.deliver(delivery.request);
          } catch (error) {
            observation = { status: "unknown", error: error instanceof Error ? error.message : String(error) };
          }
          this.#finishDelivery(delivery.request.attemptId, delivery.fencingToken, observation);
          if (observation.status === "delivered") return { disposition: "delivery_completed" };
          if (observation.status === "not_sent") return { disposition: "delivery_not_sent" };
          return { disposition: "delivery_requires_reconciliation" };
        } finally {
          this.#stopHeartbeat();
          if (this.#activeDeliveryId === delivery.request.attemptId) this.#activeDeliveryId = undefined;
        }
      }
    }

    if (this.#execution) {
      const claimed = this.#claimNextInput();
      if (claimed) {
        let turnCompleted = false;
        try {
          const running = this.#execution.start({
            turnId: claimed.turnId,
            leaseToken: claimed.fencingToken,
            recordingDay: claimed.recordingDay,
            inputs: [claimed.input],
            ...(claimed.executionState !== undefined ? { executionState: claimed.executionState } : {}),
          }, {
            includeInput: inputId => this.#includeInput(claimed.turnId, claimed.fencingToken, inputId),
            prepareExecutionState: state => this.#prepareExecutionState(
              claimed.turnId,
              claimed.fencingToken,
              state,
            ),
            replaceExecutionState: (expected, replacement) => this.#replaceExecutionState(
              claimed.turnId,
              claimed.fencingToken,
              expected,
              replacement,
            ),
            recordToolActivity: activity => this.#recordToolActivity(
              claimed.turnId,
              claimed.fencingToken,
              activity,
            ),
            prepareEffect: effect => this.#prepareEffect(claimed.turnId, claimed.fencingToken, effect),
          });
          const active = {
            turnId: claimed.turnId,
            fencingToken: claimed.fencingToken,
            execution: running,
            finishing: false,
            steeringTail: Promise.resolve(),
          };
          this.#active = active;
          this.#startHeartbeat("turn", claimed.turnId, claimed.fencingToken);
          const result = await running.result;
          active.finishing = true;
          await active.steeringTail;
          this.#completeTurn(claimed.turnId, claimed.fencingToken, result);
          turnCompleted = true;
          if (claimed.input.kind === "opportunity") {
            const standalone = this.#standaloneProactiveActivity(claimed.turnId);
            if (standalone) {
              await this.#freezeActivity(standalone);
            } else {
              this.#discardSilentOpportunitySegment(claimed.turnId);
            }
          }
          return { disposition: "turn_completed" };
        } catch (error) {
          if (turnCompleted) throw error;
          const active = this.#active;
          if (active?.turnId === claimed.turnId) {
            active.finishing = true;
            await active.steeringTail;
          }
          this.#failTurn(claimed.turnId, claimed.fencingToken, error);
          if (claimed.input.kind === "opportunity") {
            const standalone = this.#standaloneProactiveActivity(claimed.turnId);
            if (standalone) {
              try {
                await this.#freezeActivity(standalone);
              } catch (freezeError) {
                throw new AggregateError(
                  [error, freezeError],
                  `Proactive Turn failed and its verified activity could not be frozen: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }
          throw error;
        } finally {
          this.#stopHeartbeat();
          if (this.#active?.turnId === claimed.turnId) this.#active = undefined;
        }
      }
    }

    return this.#advanceActivityRecording();
  }

  async closeActivity(): Promise<CloseActivityResult> {
    if (this.#active || this.#activeDeliveryId || this.#closingActivityId || this.#activeActivityAttemptId) {
      return { disposition: "busy" };
    }
    this.#reconcileExpiredActivityClose();
    if (this.#hasRunningTurn() || this.#hasPendingInput()) return { disposition: "busy" };
    const segment = this.#readActiveSegment();
    if (!segment) return { disposition: "no_activity" };
    return this.#freezeActivity(segment);
  }

  async #freezeActivity(segment: ActiveSegmentRow): Promise<CloseActivityResult> {
    if (!this.#activityLifecycle) throw new Error("Activity closure requires a Main Agent lifecycle adapter");

    const claimed = this.#claimActivityClose(segment.id);
    if (!claimed) return { disposition: "busy" };
    this.#closingActivityId = segment.id;
    this.#startHeartbeat("activity_close", segment.id, claimed.fencingToken);
    try {
      const frozen = await this.#activityLifecycle.freeze(claimed.request);
      const committed = this.#finishActivityClose(
        claimed.request,
        claimed.fencingToken,
        frozen.activity,
        frozen.successorExecutionState,
      );
      if (!committed) return { disposition: "busy" };
      return { disposition: "activity_frozen", activityId: segment.id };
    } catch (error) {
      this.#failActivityClose(segment.id, claimed.fencingToken, error);
      throw error;
    } finally {
      this.#stopHeartbeat();
      if (this.#closingActivityId === segment.id) this.#closingActivityId = undefined;
    }
  }

  status(): RuntimeStatus {
    const rows = this.#database.prepare(`
      SELECT id, source, source_id, kind, payload_json, status
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
      SELECT id, turn_id, kind, payload_json, route_ref, input_position, status
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
    return {
      inputs: rows.map(row => ({
        id: row.id,
        source: row.source,
        sourceId: row.source_id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as JsonValue,
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
        coveredInputPosition: row.input_position,
        status: row.status,
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
    };
  }

  frozenActivity(activityId: string): FrozenActivity | undefined {
    const row = this.#database.prepare(`
      SELECT frozen_activity_json FROM activities WHERE id = ?
    `).get(activityId) as unknown as { frozen_activity_json: string } | undefined;
    return row ? JSON.parse(row.frozen_activity_json) as FrozenActivity : undefined;
  }

  close(): void {
    this.#stopHeartbeat();
    this.#database.close();
  }

  #readActiveSegment(): ActiveSegmentRow | undefined {
    return this.#database.prepare(`
      SELECT id, opened_at, starting_state_json, status, close_fencing_token, closed_at
      FROM active_segment WHERE singleton = 1
    `).get() as unknown as ActiveSegmentRow | undefined;
  }

  #hasPendingInput(): boolean {
    return Boolean(this.#database.prepare("SELECT 1 FROM inputs WHERE status = 'pending' LIMIT 1").get());
  }

  #hasPendingDeliveryWork(): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 FROM effects
      WHERE status = 'pending' AND route_ref IS NOT NULL
      LIMIT 1
    `).get());
  }

  #isOpportunityIdle(): boolean {
    return !this.#active
      && !this.#activeDeliveryId
      && !this.#closingActivityId
      && !this.#activeActivityAttemptId
      && !this.#hasRunningTurn()
      && !this.#readActiveSegment()
      && !this.#hasPendingInput()
      && !this.#hasPendingDeliveryWork();
  }

  #opportunitySnapshot(observedAt: Date): {
    request: {
      observedAt: string;
      localTime: string;
      lastHumanInputAt?: string;
      recentActivities: FrozenActivity[];
    };
    transitionSequence: number;
  } | undefined {
    return this.#transaction(() => {
      if (!this.#isOpportunityIdle()) return undefined;
      const latestHuman = this.#database.prepare(`
        SELECT occurred_at FROM inputs
        WHERE kind = 'interaction'
        ORDER BY accepted_at DESC, id DESC
        LIMIT 1
      `).get() as unknown as { occurred_at: string } | undefined;
      const activities = this.#database.prepare(`
        SELECT frozen_activity_json FROM activities
        ORDER BY sequence DESC
        LIMIT 4
      `).all() as unknown as Array<{ frozen_activity_json: string }>;
      return {
        request: {
          observedAt: observedAt.toISOString(),
          localTime: this.#timePolicy.formatLocalTime(observedAt),
          ...(latestHuman ? { lastHumanInputAt: latestHuman.occurred_at } : {}),
          recentActivities: activities
            .reverse()
            .map(row => JSON.parse(row.frozen_activity_json) as FrozenActivity),
        },
        transitionSequence: this.#latestOpportunityTransitionSequence(),
      };
    });
  }

  #latestOpportunityTransitionSequence(): number {
    const row = this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM transitions
    `).get() as unknown as { sequence: number };
    return row.sequence;
  }

  #claimActivityClose(segmentId: string): {
    request: ActivityFreezeRequest;
    fencingToken: number;
  } | undefined {
    return this.#transaction(() => {
      if (this.#hasRunningTurn() || this.#hasPendingInput() || this.#hasPendingDeliveryWork()) return undefined;
      const segment = this.#readActiveSegment();
      if (!segment || segment.id !== segmentId || segment.status !== "active") return undefined;
      const executionState = this.#readExecutionState().executionState;
      if (executionState === undefined) throw new Error(`Active segment ${segmentId} has no committed execution state`);
      const tokenRow = this.#database.prepare(`
        UPDATE runtime_counters SET value = value + 1
        WHERE name = 'fencing_token'
        RETURNING value
      `).get() as unknown as { value: number };
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE active_segment
        SET status = 'closing', close_owner = ?, close_fencing_token = ?,
            close_lease_expires_at = ?, closed_at = ?
        WHERE singleton = 1 AND id = ? AND status = 'active'
      `).run(
        this.#ownerId,
        tokenRow.value,
        new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        now.toISOString(),
        segmentId,
      );
      if (changed.changes !== 1) return undefined;
      this.#recordTransition("segment", segmentId, "active", "closing", "close_claimed", now, tokenRow.value);
      return {
        request: this.#buildActivityFreezeRequest({
          ...segment,
          status: "closing",
          close_fencing_token: tokenRow.value,
          closed_at: now.toISOString(),
        }, executionState),
        fencingToken: tokenRow.value,
      };
    });
  }

  #buildActivityFreezeRequest(
    segment: ActiveSegmentRow,
    executionState: JsonValue,
  ): ActivityFreezeRequest {
    if (!segment.closed_at) throw new Error(`Closing segment ${segment.id} has no close time`);
    const inputRows = this.#database.prepare(`
      SELECT DISTINCT inputs.id, inputs.kind, inputs.payload_json, inputs.occurred_at
      FROM inputs
      JOIN turn_inputs ON turn_inputs.input_id = inputs.id
      JOIN turns ON turns.id = turn_inputs.turn_id
      WHERE turns.segment_id = ? AND turn_inputs.inclusion_status = 'included'
      ORDER BY inputs.occurred_at, inputs.id
    `).all(segment.id) as unknown as Array<{
      id: string;
      kind: InputKind;
      payload_json: string;
      occurred_at: string;
    }>;
    const turnRows = this.#database.prepare(`
      SELECT id, status, started_at, ended_at, transcript_anchor_json, execution_record_json, error
      FROM turns
      WHERE segment_id = ? AND status <> 'running'
      ORDER BY started_at, id
    `).all(segment.id) as unknown as Array<{
      id: string;
      status: "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";
      started_at: string;
      ended_at: string;
      transcript_anchor_json: string | null;
      execution_record_json: string | null;
      error: string | null;
    }>;
    const turnInputs = this.#database.prepare(`
      SELECT input_id FROM turn_inputs
      WHERE turn_id = ? AND inclusion_status = 'included'
      ORDER BY position
    `);
    const effectRows = this.#database.prepare(`
      SELECT effects.id, effects.turn_id, effects.kind, effects.payload_json, effects.route_ref,
             effects.status, effects.created_at, effects.ended_at
      FROM effects
      JOIN turns ON turns.id = effects.turn_id
      WHERE turns.segment_id = ?
      ORDER BY effects.created_at, effects.id
    `).all(segment.id) as unknown as Array<EffectRow & { created_at: string; ended_at: string | null }>;
    const toolActivityRows = this.#database.prepare(`
      SELECT turn_tool_activity.turn_id, turn_tool_activity.tool_call_id,
             turn_tool_activity.tool_name, turn_tool_activity.call_arguments_json,
             turn_tool_activity.result_json, turn_tool_activity.completed_at
      FROM turn_tool_activity
      JOIN turns ON turns.id = turn_tool_activity.turn_id
      WHERE turns.segment_id = ?
      ORDER BY turn_tool_activity.completed_at, turn_tool_activity.tool_call_id
    `).all(segment.id) as unknown as Array<{
      turn_id: string;
      tool_call_id: string;
      tool_name: string;
      call_arguments_json: string;
      result_json: string;
      completed_at: string;
    }>;
    const deliveryRows = this.#database.prepare(`
      SELECT delivery_attempts.id, delivery_attempts.effect_id, delivery_attempts.attempt_number,
             delivery_attempts.status, delivery_attempts.started_at, delivery_attempts.ended_at,
             delivery_attempts.remote_id, delivery_attempts.error
      FROM delivery_attempts
      JOIN effects ON effects.id = delivery_attempts.effect_id
      JOIN turns ON turns.id = effects.turn_id
      WHERE turns.segment_id = ?
      ORDER BY delivery_attempts.started_at, delivery_attempts.id
    `).all(segment.id) as unknown as Array<DeliveryRow & { started_at: string; ended_at: string | null }>;
    const recentActivities = this.#database.prepare(`
      SELECT frozen_activity_json
      FROM activities
      ORDER BY sequence DESC
      LIMIT 4
    `).all() as unknown as Array<{ frozen_activity_json: string }>;

    return {
      segment: {
        id: segment.id,
        openedAt: segment.opened_at,
        closedAt: segment.closed_at,
        recordingDay: this.#timePolicy.recordingDay(new Date(segment.closed_at)),
      },
      recentActivities: recentActivities
        .reverse()
        .map(row => JSON.parse(row.frozen_activity_json) as FrozenActivity),
      ...(segment.starting_state_json
        ? { startingExecutionState: JSON.parse(segment.starting_state_json) as JsonValue }
        : {}),
      executionState,
      inputs: inputRows.map(row => ({
        id: row.id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as JsonValue,
        occurredAt: row.occurred_at,
      })),
      turns: turnRows.map(row => ({
        id: row.id,
        inputIds: (turnInputs.all(row.id) as unknown as Array<{ input_id: string }>).map(input => input.input_id),
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        ...(row.transcript_anchor_json
          ? { transcriptAnchor: JSON.parse(row.transcript_anchor_json) as TranscriptAnchor }
          : {}),
        ...(row.execution_record_json
          ? { executionRecord: JSON.parse(row.execution_record_json) as JsonValue }
          : {}),
        ...(row.error ? { error: row.error } : {}),
      })),
      toolActivities: toolActivityRows.map(row => ({
        turnId: row.turn_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        callArguments: JSON.parse(row.call_arguments_json) as JsonValue,
        result: JSON.parse(row.result_json) as JsonValue,
        completedAt: row.completed_at,
      })),
      effects: effectRows.map(row => ({
        id: row.id,
        turnId: row.turn_id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as JsonValue,
        ...(row.route_ref ? { routeRef: row.route_ref } : {}),
        createdAt: row.created_at,
        ...(row.ended_at ? { endedAt: row.ended_at } : {}),
        status: row.status,
      })),
      deliveries: deliveryRows.map(row => ({
        id: row.id,
        effectId: row.effect_id,
        attempt: row.attempt_number,
        status: row.status,
        startedAt: row.started_at,
        ...(row.ended_at ? { endedAt: row.ended_at } : {}),
        ...(row.remote_id ? { remoteId: row.remote_id } : {}),
        ...(row.error ? { error: row.error } : {}),
      })),
    };
  }

  #finishActivityClose(
    request: ActivityFreezeRequest,
    fencingToken: number,
    activity: FrozenActivity,
    successorExecutionState: JsonValue,
  ): boolean {
    if (activity.segmentId !== request.segment.id
      || activity.openedAt !== request.segment.openedAt
      || activity.closedAt !== request.segment.closedAt
      || activity.recordingDay !== request.segment.recordingDay) {
      throw new Error(`Frozen Activity does not match closing segment ${request.segment.id}`);
    }
    return this.#transaction(() => {
      const segment = this.#readActiveSegment();
      if (!segment
        || segment.id !== request.segment.id
        || segment.status !== "closing"
        || segment.close_fencing_token !== fencingToken) {
        throw new Error(`Activity close for ${request.segment.id} no longer owns its lease`);
      }
      if (this.#hasPendingInput()) {
        const now = this.#now();
        const changed = this.#database.prepare(`
          UPDATE active_segment
          SET status = 'active', close_owner = NULL, close_fencing_token = NULL,
              close_lease_expires_at = NULL, closed_at = NULL
          WHERE singleton = 1 AND id = ? AND status = 'closing'
            AND close_fencing_token = ? AND close_owner = ?
        `).run(request.segment.id, fencingToken, this.#ownerId);
        if (changed.changes !== 1) throw new Error(`Activity close for ${request.segment.id} could not yield`);
        this.#recordTransition("segment", request.segment.id, "closing", "active", "close_yielded_to_input", now, fencingToken);
        return false;
      }
      const current = this.#readExecutionState().executionState;
      if (current === undefined || !isDeepStrictEqual(current, request.executionState)) {
        throw new Error(`Activity close for ${request.segment.id} has stale execution state`);
      }
      const now = this.#now();
      this.#database.prepare(`
        INSERT INTO activities (
          id, opened_at, closed_at, recording_day, frozen_activity_json,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        request.segment.id,
        request.segment.openedAt,
        request.segment.closedAt,
        request.segment.recordingDay,
        JSON.stringify(activity),
        now.toISOString(),
      );
      const state = this.#database.prepare(`
        UPDATE active_execution_state SET state_json = ?, updated_at = ? WHERE singleton = 1
      `).run(JSON.stringify(successorExecutionState), now.toISOString());
      if (state.changes !== 1) throw new Error("Activity close could not install successor execution state");
      const removed = this.#database.prepare(`
        DELETE FROM active_segment
        WHERE singleton = 1 AND id = ? AND status = 'closing' AND close_fencing_token = ?
      `).run(request.segment.id, fencingToken);
      if (removed.changes !== 1) throw new Error(`Activity close could not release segment ${request.segment.id}`);
      this.#recordTransition("activity", request.segment.id, null, "pending", "evidence_frozen", now, fencingToken);
      this.#recordTransition("segment", request.segment.id, "closing", "closed", "evidence_frozen", now, fencingToken);
      this.#recordTransition("execution_state", "primary", "active", "active", "activity_succeeded", now, fencingToken);
      return true;
    });
  }

  #failActivityClose(segmentId: string, fencingToken: number, error: unknown): void {
    this.#transaction(() => {
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE active_segment
        SET status = 'active', close_owner = NULL, close_fencing_token = NULL,
            close_lease_expires_at = NULL, closed_at = NULL
        WHERE singleton = 1 AND id = ? AND status = 'closing'
          AND close_fencing_token = ? AND close_owner = ?
      `).run(segmentId, fencingToken, this.#ownerId);
      if (changed.changes === 1) {
        this.#recordTransition(
          "segment",
          segmentId,
          "closing",
          "active",
          `close_failed:${error instanceof Error ? error.message : String(error)}`,
          now,
          fencingToken,
        );
      }
    });
  }

  #findInput(source: string, sourceId: string): InputRow | undefined {
    return this.#database.prepare(`
      SELECT id, source, source_id, kind, payload_json, status
      FROM inputs
      WHERE source = ? AND source_id = ?
    `).get(source, sourceId) as unknown as InputRow | undefined;
  }

  #hasRunningTurn(): boolean {
    return Boolean(this.#database.prepare("SELECT 1 FROM turns WHERE status = 'running' LIMIT 1").get());
  }

  #reconcileExpiredTurns(): void {
    this.#transaction(() => {
      const now = this.#now();
      const expired = this.#database.prepare(`
        SELECT id, fencing_token
        FROM turns
        WHERE status = 'running' AND lease_expires_at <= ?
        ORDER BY started_at, id
      `).all(now.toISOString()) as unknown as Array<{ id: string; fencing_token: number }>;

      for (const turn of expired) {
        this.#database.prepare(`
          UPDATE turns
          SET status = 'interrupted', ended_at = ?, error = 'runtime lease expired'
          WHERE id = ? AND status = 'running' AND fencing_token = ?
        `).run(now.toISOString(), turn.id, turn.fencing_token);
        this.#recordTransition("turn", turn.id, "running", "interrupted", "lease_expired", now, turn.fencing_token);
        this.#settleInputsAfterStoppedTurn(turn.id, "interrupted", now, turn.fencing_token);
      }
    });
  }

  #reconcileExpiredDeliveries(): void {
    this.#transaction(() => {
      const now = this.#now();
      const expired = this.#database.prepare(`
        SELECT id, effect_id, fencing_token
        FROM delivery_attempts
        WHERE status = 'dispatching' AND lease_expires_at <= ?
        ORDER BY started_at, id
      `).all(now.toISOString()) as unknown as Array<{ id: string; effect_id: string; fencing_token: number }>;
      for (const attempt of expired) {
        this.#database.prepare(`
          UPDATE delivery_attempts
          SET status = 'unknown', ended_at = ?, error = 'delivery lease expired after dispatch began'
          WHERE id = ? AND status = 'dispatching' AND fencing_token = ?
        `).run(now.toISOString(), attempt.id, attempt.fencing_token);
        this.#database.prepare(`
          UPDATE effects SET status = 'reconciliation_required'
          WHERE id = ? AND status = 'pending'
        `).run(attempt.effect_id);
        this.#recordTransition("delivery", attempt.id, "dispatching", "unknown", "lease_expired", now, attempt.fencing_token);
        this.#recordTransition("effect", attempt.effect_id, "pending", "reconciliation_required", "delivery_unknown", now, attempt.fencing_token);
      }
    });
  }

  #reconcileExpiredActivityClose(): void {
    this.#transaction(() => {
      const now = this.#now();
      const expired = this.#database.prepare(`
        SELECT id, close_fencing_token
        FROM active_segment
        WHERE status = 'closing' AND close_lease_expires_at <= ?
      `).get(now.toISOString()) as unknown as {
        id: string;
        close_fencing_token: number;
      } | undefined;
      if (!expired) return;
      this.#database.prepare(`
        UPDATE active_segment
        SET status = 'active', close_owner = NULL, close_fencing_token = NULL,
            close_lease_expires_at = NULL, closed_at = NULL
        WHERE id = ? AND status = 'closing' AND close_fencing_token = ?
      `).run(expired.id, expired.close_fencing_token);
      this.#recordTransition(
        "segment",
        expired.id,
        "closing",
        "active",
        "close_lease_expired",
        now,
        expired.close_fencing_token,
      );
    });
  }

  #reconcileExpiredActivityRecording(): void {
    this.#transaction(() => {
      const now = this.#now();
      const expired = this.#database.prepare(`
        SELECT id, attempt_count, fencing_token
        FROM activities
        WHERE status = 'recording' AND lease_expires_at <= ?
        ORDER BY sequence
      `).all(now.toISOString()) as unknown as Array<{
        id: string;
        attempt_count: number;
        fencing_token: number;
      }>;
      for (const activity of expired) {
        this.#database.prepare(`
          UPDATE activities
          SET status = 'pending', lease_owner = NULL, fencing_token = NULL,
              lease_expires_at = NULL, last_error = 'recording lease expired'
          WHERE id = ? AND status = 'recording' AND fencing_token = ?
        `).run(activity.id, activity.fencing_token);
        this.#database.prepare(`
          UPDATE activity_attempts
          SET status = 'interrupted', ended_at = ?, error = 'recording lease expired'
          WHERE activity_id = ? AND attempt_number = ? AND status = 'recording'
            AND fencing_token = ?
        `).run(now.toISOString(), activity.id, activity.attempt_count, activity.fencing_token);
        this.#recordTransition(
          "activity",
          activity.id,
          "recording",
          "pending",
          "recording_lease_expired",
          now,
          activity.fencing_token,
        );
      }
    });
  }

  async #advanceActivityRecording(): Promise<AdvanceResult> {
    if (!this.#activityRecorder) return { disposition: "idle" };
    const claimed = this.#claimPendingActivity();
    if (!claimed) {
      const unfinished = this.#database.prepare(`
        SELECT 1 FROM activities WHERE status <> 'recorded' LIMIT 1
      `).get();
      return unfinished ? { disposition: "busy" } : { disposition: "idle" };
    }
    this.#activeActivityAttemptId = claimed.attemptId;
    this.#startHeartbeat("activity_recording", claimed.activity.segmentId, claimed.fencingToken);
    try {
      const receipt = await this.#activityRecorder.record(claimed.activity);
      if (receipt.segmentId !== claimed.activity.segmentId) {
        throw new Error(`Recorder receipt belongs to ${receipt.segmentId}, not ${claimed.activity.segmentId}`);
      }
      this.#finishActivityRecording(claimed, receipt);
      return { disposition: "activity_recorded" };
    } catch (error) {
      this.#failActivityRecording(claimed, error);
      return { disposition: "activity_recording_failed" };
    } finally {
      this.#stopHeartbeat();
      if (this.#activeActivityAttemptId === claimed.attemptId) this.#activeActivityAttemptId = undefined;
    }
  }

  #claimPendingActivity(): {
    activity: FrozenActivity;
    attemptId: string;
    attemptNumber: number;
    fencingToken: number;
  } | undefined {
    return this.#transaction(() => {
      const next = this.#database.prepare(`
        SELECT id, frozen_activity_json, status, attempt_count
        FROM activities
        WHERE status <> 'recorded'
        ORDER BY sequence
        LIMIT 1
      `).get() as unknown as Pick<ActivityRow, "id" | "frozen_activity_json" | "status" | "attempt_count"> | undefined;
      if (!next || next.status !== "pending") return undefined;
      const tokenRow = this.#database.prepare(`
        UPDATE runtime_counters SET value = value + 1
        WHERE name = 'fencing_token'
        RETURNING value
      `).get() as unknown as { value: number };
      const attemptNumber = next.attempt_count + 1;
      const attemptId = this.#nextId();
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE activities
        SET status = 'recording', attempt_count = ?, lease_owner = ?, fencing_token = ?,
            lease_expires_at = ?
        WHERE id = ? AND status = 'pending' AND attempt_count = ?
      `).run(
        attemptNumber,
        this.#ownerId,
        tokenRow.value,
        new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        next.id,
        next.attempt_count,
      );
      if (changed.changes !== 1) return undefined;
      this.#database.prepare(`
        INSERT INTO activity_attempts (
          id, activity_id, attempt_number, status, lease_owner,
          fencing_token, started_at
        ) VALUES (?, ?, ?, 'recording', ?, ?, ?)
      `).run(attemptId, next.id, attemptNumber, this.#ownerId, tokenRow.value, now.toISOString());
      this.#recordTransition("activity", next.id, "pending", "recording", "recording_claimed", now, tokenRow.value);
      return {
        activity: JSON.parse(next.frozen_activity_json) as FrozenActivity,
        attemptId,
        attemptNumber,
        fencingToken: tokenRow.value,
      };
    });
  }

  #finishActivityRecording(
    claimed: { activity: FrozenActivity; attemptId: string; attemptNumber: number; fencingToken: number },
    receipt: LifeRecorderReceipt,
  ): void {
    this.#transaction(() => {
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE activities
        SET status = 'recorded', lease_owner = NULL, fencing_token = NULL,
            lease_expires_at = NULL, receipt_json = ?, last_error = NULL, recorded_at = ?
        WHERE id = ? AND status = 'recording' AND attempt_count = ?
          AND fencing_token = ? AND lease_owner = ?
      `).run(
        JSON.stringify(receipt),
        now.toISOString(),
        claimed.activity.segmentId,
        claimed.attemptNumber,
        claimed.fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) {
        throw new Error(`Activity ${claimed.activity.segmentId} no longer accepts recorder receipt`);
      }
      this.#database.prepare(`
        UPDATE activity_attempts
        SET status = 'recorded', ended_at = ?, receipt_json = ?
        WHERE id = ? AND status = 'recording' AND fencing_token = ?
      `).run(now.toISOString(), JSON.stringify(receipt), claimed.attemptId, claimed.fencingToken);
      this.#recordTransition(
        "activity",
        claimed.activity.segmentId,
        "recording",
        "recorded",
        "receipt_committed",
        now,
        claimed.fencingToken,
      );
    });
  }

  #failActivityRecording(
    claimed: { activity: FrozenActivity; attemptId: string; attemptNumber: number; fencingToken: number },
    error: unknown,
  ): void {
    this.#transaction(() => {
      const now = this.#now();
      const detail = error instanceof Error ? error.message : String(error);
      const changed = this.#database.prepare(`
        UPDATE activities
        SET status = 'pending', lease_owner = NULL, fencing_token = NULL,
            lease_expires_at = NULL, last_error = ?
        WHERE id = ? AND status = 'recording' AND attempt_count = ?
          AND fencing_token = ? AND lease_owner = ?
      `).run(
        detail,
        claimed.activity.segmentId,
        claimed.attemptNumber,
        claimed.fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) return;
      this.#database.prepare(`
        UPDATE activity_attempts
        SET status = 'failed', ended_at = ?, error = ?
        WHERE id = ? AND status = 'recording' AND fencing_token = ?
      `).run(now.toISOString(), detail, claimed.attemptId, claimed.fencingToken);
      this.#recordTransition(
        "activity",
        claimed.activity.segmentId,
        "recording",
        "pending",
        `recording_failed:${detail}`,
        now,
        claimed.fencingToken,
      );
    });
  }

  #claimNextInput(): {
    turnId: string;
    fencingToken: number;
    recordingDay: string;
    input: ExecutionInput;
    executionState?: JsonValue;
  } | undefined {
    return this.#transaction(() => {
      if (this.#hasRunningTurn()) return undefined;
      const existingSegment = this.#readActiveSegment();
      if (existingSegment?.status === "closing") return undefined;
      const input = this.#database.prepare(`
        SELECT id, kind, payload_json, occurred_at
        FROM inputs
        WHERE status = 'pending'
        ORDER BY accepted_at, id
        LIMIT 1
      `).get() as unknown as Pick<InputRow, "id" | "kind" | "payload_json" | "occurred_at"> | undefined;
      if (!input) return undefined;

      const now = this.#now();
      const recordingDay = this.#timePolicy.recordingDay(now);
      const segmentId = existingSegment?.id ?? this.#nextId();
      if (!existingSegment) {
        const startingState = this.#readExecutionState().executionState;
        this.#database.prepare(`
          INSERT INTO active_segment (
            singleton, id, opened_at, starting_state_json, status
          ) VALUES (1, ?, ?, ?, 'active')
        `).run(
          segmentId,
          now.toISOString(),
          startingState === undefined ? null : JSON.stringify(startingState),
        );
        this.#recordTransition("segment", segmentId, null, "active", "turn_claimed", now, null);
      }
      const tokenRow = this.#database.prepare(`
        UPDATE runtime_counters
        SET value = value + 1
        WHERE name = 'fencing_token'
        RETURNING value
      `).get() as unknown as { value: number };
      const turnId = this.#nextId();
      this.#database.prepare(`
        INSERT INTO turns (
          id, segment_id, status, lease_owner, fencing_token, lease_expires_at, started_at,
          recording_day
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)
      `).run(
        turnId,
        segmentId,
        this.#ownerId,
        tokenRow.value,
        new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        now.toISOString(),
        recordingDay,
      );
      this.#database.prepare(`
        INSERT INTO turn_inputs (
          turn_id, input_id, position, inclusion_status
        ) VALUES (?, ?, 1, 'prepared')
      `).run(turnId, input.id);
      this.#recordTransition("turn", turnId, null, "running", "input_claimed", now, tokenRow.value);

      return {
        turnId,
        fencingToken: tokenRow.value,
        recordingDay,
        input: {
          id: input.id,
          kind: input.kind,
          payload: JSON.parse(input.payload_json) as JsonValue,
          occurredAt: input.occurred_at,
          inclusionPosition: 1,
        },
        ...this.#readExecutionState(),
      };
    });
  }

  #completeTurn(turnId: string, fencingToken: number, result: ExecutionResult): void {
    if (!result.transcriptAnchor.sourceId
      || !result.transcriptAnchor.sessionId
      || !result.transcriptAnchor.entryId) {
      throw new Error("Completed Turn requires a verified Transcript Anchor");
    }
    this.#transaction(() => {
      const now = this.#now();
      const includedInputs = this.#database.prepare(`
        SELECT input_id FROM turn_inputs
        WHERE turn_id = ? AND inclusion_status = 'included'
        ORDER BY position
      `).all(turnId) as unknown as Array<{ input_id: string }>;
      const anchors = new Map(result.inputAnchors.map(item => [item.inputId, item.transcriptAnchor]));
      if (anchors.size !== result.inputAnchors.length) throw new Error(`Turn ${turnId} returned duplicate Input anchors`);
      const includedIds = new Set(includedInputs.map(input => input.input_id));
      for (const input of includedInputs) {
        const anchor = anchors.get(input.input_id);
        if (!anchor?.sourceId || !anchor.sessionId || !anchor.entryId) {
          throw new Error(`Turn ${turnId} requires a verified Transcript Anchor for Input ${input.input_id}`);
        }
        this.#database.prepare(`
          UPDATE turn_inputs SET inclusion_anchor_json = ?
          WHERE turn_id = ? AND input_id = ? AND inclusion_status = 'included'
        `).run(JSON.stringify(anchor), turnId, input.input_id);
      }
      for (const inputId of anchors.keys()) {
        if (!includedIds.has(inputId)) throw new Error(`Turn ${turnId} returned evidence for non-included Input ${inputId}`);
      }
      this.#database.prepare(`
        UPDATE turn_inputs SET inclusion_status = 'rejected'
        WHERE turn_id = ? AND inclusion_status = 'prepared'
      `).run(turnId);
      const changed = this.#database.prepare(`
        UPDATE turns
        SET status = 'completed', outcome = ?, ended_at = ?, transcript_anchor_json = ?, execution_record_json = ?
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).run(
        result.outcome,
        now.toISOString(),
        JSON.stringify(result.transcriptAnchor),
        JSON.stringify(result.executionRecord),
        turnId,
        fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) throw new Error(`Turn ${turnId} no longer accepts writes from lease ${fencingToken}`);
      const preparedState = this.#readExecutionState().executionState;
      if (preparedState === undefined) {
        throw new Error(`Turn ${turnId} did not prepare execution state before completion`);
      }
      this.#database.prepare(`
        UPDATE active_execution_state
        SET state_json = ?, updated_at = ?
        WHERE singleton = 1
      `).run(JSON.stringify(result.executionState), now.toISOString());
      this.#recordTransition(
        "execution_state",
        "primary",
        "active",
        "active",
        "turn_completed",
        now,
        fencingToken,
      );
      const activeInputs = this.#database.prepare(`
        SELECT id FROM inputs WHERE active_turn_id = ? AND status = 'active'
      `).all(turnId) as unknown as Array<{ id: string }>;
      this.#database.prepare(`
        UPDATE inputs SET status = 'consumed', active_turn_id = NULL
        WHERE active_turn_id = ? AND status = 'active'
      `).run(turnId);
      this.#recordTransition("turn", turnId, "running", "completed", result.outcome, now, fencingToken);
      for (const input of activeInputs) {
        this.#recordTransition("input", input.id, "active", "consumed", "turn_completed", now, fencingToken);
      }
    });
  }

  #discardSilentOpportunitySegment(turnId: string): void {
    this.#transaction(() => {
      const turn = this.#database.prepare(`
        SELECT segment_id FROM turns WHERE id = ? AND status = 'completed'
      `).get(turnId) as unknown as { segment_id: string } | undefined;
      if (!turn) return;
      const segment = this.#readActiveSegment();
      if (!segment || segment.id !== turn.segment_id || segment.status !== "active") return;
      const lived = this.#database.prepare(`
        SELECT 1
        FROM turns
        LEFT JOIN turn_inputs ON turn_inputs.turn_id = turns.id
        LEFT JOIN inputs ON inputs.id = turn_inputs.input_id
        LEFT JOIN effects ON effects.turn_id = turns.id
        LEFT JOIN turn_tool_activity ON turn_tool_activity.turn_id = turns.id
        WHERE turns.segment_id = ?
          AND (inputs.kind = 'interaction' OR effects.id IS NOT NULL OR turn_tool_activity.tool_call_id IS NOT NULL)
        LIMIT 1
      `).get(segment.id);
      if (lived) return;

      const now = this.#now();
      if (segment.starting_state_json === null) {
        this.#database.prepare("DELETE FROM active_execution_state WHERE singleton = 1").run();
      } else {
        this.#database.prepare(`
          INSERT INTO active_execution_state (singleton, state_json, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
        `).run(segment.starting_state_json, now.toISOString());
      }
      const removed = this.#database.prepare(`
        DELETE FROM active_segment WHERE singleton = 1 AND id = ? AND status = 'active'
      `).run(segment.id);
      if (removed.changes !== 1) throw new Error(`Silent Opportunity could not release Segment ${segment.id}`);
      this.#recordTransition("segment", segment.id, "active", "discarded", "silent_opportunity", now, null);
      this.#recordTransition("execution_state", "primary", "active", "active", "silent_opportunity_restored", now, null);
    });
  }

  #standaloneProactiveActivity(turnId: string): ActiveSegmentRow | undefined {
    const turn = this.#database.prepare(`
      SELECT segment_id FROM turns WHERE id = ? AND status IN ('completed', 'failed')
    `).get(turnId) as unknown as { segment_id: string } | undefined;
    if (!turn) return undefined;
    const segment = this.#readActiveSegment();
    if (!segment || segment.id !== turn.segment_id || segment.status !== "active") return undefined;
    const state = this.#database.prepare(`
      SELECT
        EXISTS(
          SELECT 1 FROM turn_tool_activity
          JOIN turns ON turns.id = turn_tool_activity.turn_id
          WHERE turns.segment_id = ?
        ) AS has_tool_activity,
        EXISTS(
          SELECT 1 FROM effects
          JOIN turns ON turns.id = effects.turn_id
          WHERE turns.segment_id = ?
        ) AS has_effect,
        EXISTS(
          SELECT 1 FROM turn_inputs
          JOIN turns ON turns.id = turn_inputs.turn_id
          JOIN inputs ON inputs.id = turn_inputs.input_id
          WHERE turns.segment_id = ?
            AND turn_inputs.inclusion_status = 'included'
            AND inputs.kind = 'interaction'
        ) AS has_human_input
    `).get(segment.id, segment.id, segment.id) as unknown as {
      has_tool_activity: 0 | 1;
      has_effect: 0 | 1;
      has_human_input: 0 | 1;
    };
    return state.has_tool_activity && !state.has_effect && !state.has_human_input
      ? segment
      : undefined;
  }

  #readExecutionState(): { executionState?: JsonValue } {
    const row = this.#database.prepare(`
      SELECT state_json FROM active_execution_state WHERE singleton = 1
    `).get() as unknown as { state_json: string } | undefined;
    if (!row) return {};
    return { executionState: JSON.parse(row.state_json) as JsonValue };
  }

  #prepareExecutionState(
    turnId: string,
    fencingToken: number,
    state: JsonValue,
  ): void {
    this.#transaction(() => {
      const turn = this.#database.prepare(`
        SELECT id FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(turnId, fencingToken, this.#ownerId);
      if (!turn) throw new Error(`Turn ${turnId} no longer accepts execution state from lease ${fencingToken}`);

      const current = this.#readExecutionState().executionState;
      if (current !== undefined) {
        if (!isDeepStrictEqual(current, state)) {
          throw new Error(`Turn ${turnId} cannot replace active execution state before completion`);
        }
        return;
      }

      const now = this.#now();
      this.#database.prepare(`
        INSERT INTO active_execution_state (singleton, state_json, updated_at)
        VALUES (1, ?, ?)
      `).run(JSON.stringify(state), now.toISOString());
      this.#recordTransition(
        "execution_state",
        "primary",
        null,
        "active",
        "turn_prepared",
        now,
        fencingToken,
      );
    });
  }

  #replaceExecutionState(
    turnId: string,
    fencingToken: number,
    expected: JsonValue,
    replacement: JsonValue,
  ): void {
    this.#transaction(() => {
      const turn = this.#database.prepare(`
        SELECT id FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(turnId, fencingToken, this.#ownerId);
      if (!turn) throw new Error(`Turn ${turnId} no longer accepts execution state from lease ${fencingToken}`);

      const current = this.#readExecutionState().executionState;
      if (current === undefined || !isDeepStrictEqual(current, expected)) {
        throw new Error(`Execution state replacement for Turn ${turnId} is stale`);
      }
      const now = this.#now();
      this.#database.prepare(`
        UPDATE active_execution_state
        SET state_json = ?, updated_at = ?
        WHERE singleton = 1
      `).run(JSON.stringify(replacement), now.toISOString());
      this.#recordTransition(
        "execution_state",
        "primary",
        "active",
        "active",
        "execution_replaced",
        now,
        fencingToken,
      );
    });
  }

  #failTurn(turnId: string, fencingToken: number, error: unknown): void {
    this.#transaction(() => {
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE turns
        SET status = 'failed', ended_at = ?, error = ?
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).run(now.toISOString(), error instanceof Error ? error.message : String(error), turnId, fencingToken, this.#ownerId);
      if (changed.changes !== 1) return;
      this.#recordTransition("turn", turnId, "running", "failed", "execution_failed", now, fencingToken);
      this.#settleInputsAfterStoppedTurn(turnId, "failed", now, fencingToken);
    });
  }

  #prepareEffect(turnId: string, fencingToken: number, effect: EffectRequest): EffectReceipt {
    if (!effect.kind) throw new Error("Effect requires a kind");
    return this.#transaction(() => {
      const turn = this.#database.prepare(`
        SELECT id FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(turnId, fencingToken, this.#ownerId);
      if (!turn) throw new Error(`Turn ${turnId} no longer accepts Effects from lease ${fencingToken}`);
      const position = this.#database.prepare(`
        SELECT MAX(position) AS position
        FROM turn_inputs
        WHERE turn_id = ? AND inclusion_status = 'included'
      `).get(turnId) as unknown as { position: number | null };
      if (position.position === null) throw new Error(`Turn ${turnId} has no included Input`);
      const now = this.#now();
      const effectId = this.#nextId();
      this.#database.prepare(`
        INSERT INTO effects (
          id, turn_id, kind, payload_json, route_ref, input_position, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        effectId,
        turnId,
        effect.kind,
        JSON.stringify(effect.payload),
        effect.routeRef ?? null,
        position.position,
        now.toISOString(),
      );
      this.#recordTransition("effect", effectId, null, "pending", "accepted", now, fencingToken);
      return { effectId };
    });
  }

  #recordToolActivity(
    turnId: string,
    fencingToken: number,
    activity: VerifiedToolActivity,
  ): void {
    if (!activity.toolCallId.trim() || !activity.toolName.trim()) {
      throw new Error("Verified tool activity requires toolCallId and toolName");
    }
    this.#transaction(() => {
      const turn = this.#database.prepare(`
        SELECT id FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(turnId, fencingToken, this.#ownerId);
      if (!turn) throw new Error(`Turn ${turnId} no longer accepts tool activity from lease ${fencingToken}`);
      const position = this.#database.prepare(`
        SELECT MAX(position) AS position FROM turn_inputs
        WHERE turn_id = ? AND inclusion_status = 'included'
      `).get(turnId) as unknown as { position: number | null };
      if (position.position === null) throw new Error(`Turn ${turnId} has no included Input`);
      const now = this.#now();
      this.#database.prepare(`
        INSERT INTO turn_tool_activity (
          turn_id, tool_call_id, tool_name, call_arguments_json, result_json, input_position, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        turnId,
        activity.toolCallId,
        activity.toolName,
        JSON.stringify(activity.callArguments),
        JSON.stringify(activity.result),
        position.position,
        now.toISOString(),
      );
      this.#recordTransition(
        "tool_activity",
        `${turnId}:${activity.toolCallId}`,
        null,
        "completed",
        "tool_succeeded",
        now,
        fencingToken,
      );
    });
  }

  #includeInput(turnId: string, fencingToken: number, inputId: string): void {
    this.#transaction(() => {
      const now = this.#now();
      const turn = this.#database.prepare(`
        SELECT id FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(turnId, fencingToken, this.#ownerId);
      if (!turn) throw new Error(`Turn ${turnId} no longer accepts Input from lease ${fencingToken}`);

      const relation = this.#database.prepare(`
        UPDATE turn_inputs
        SET inclusion_status = 'included', included_at = ?
        WHERE turn_id = ? AND input_id = ? AND inclusion_status = 'prepared'
      `).run(now.toISOString(), turnId, inputId);
      if (relation.changes === 0) {
        const included = this.#database.prepare(`
          SELECT 1 FROM turn_inputs
          WHERE turn_id = ? AND input_id = ? AND inclusion_status = 'included'
        `).get(turnId, inputId);
        if (included) return;
        throw new Error(`Input ${inputId} was not prepared for Turn ${turnId}`);
      }

      const input = this.#database.prepare(`
        UPDATE inputs SET status = 'active', active_turn_id = ?
        WHERE id = ? AND status = 'pending'
      `).run(turnId, inputId);
      if (input.changes !== 1) throw new Error(`Input ${inputId} could not join Turn ${turnId}`);
      this.#recordTransition("input", inputId, "pending", "active", "execution_included", now, fencingToken);
    });
  }

  #claimPendingDelivery(): { request: DeliveryAttemptRequest; fencingToken: number } | undefined {
    return this.#transaction(() => {
      const effect = this.#database.prepare(`
        SELECT id, kind, payload_json, route_ref
        FROM effects
        WHERE status = 'pending' AND route_ref IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM delivery_attempts
            WHERE delivery_attempts.effect_id = effects.id
              AND delivery_attempts.status = 'dispatching'
          )
        ORDER BY created_at, id
        LIMIT 1
      `).get() as unknown as Pick<EffectRow, "id" | "kind" | "payload_json" | "route_ref"> | undefined;
      if (!effect?.route_ref) return undefined;

      const tokenRow = this.#database.prepare(`
        UPDATE runtime_counters
        SET value = value + 1
        WHERE name = 'fencing_token'
        RETURNING value
      `).get() as unknown as { value: number };
      const numberRow = this.#database.prepare(`
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
        FROM delivery_attempts WHERE effect_id = ?
      `).get(effect.id) as unknown as { attempt_number: number };
      const attemptId = this.#nextId();
      const idempotencyKey = `${effect.id}:${numberRow.attempt_number}`;
      const now = this.#now();
      this.#database.prepare(`
        INSERT INTO delivery_attempts (
          id, effect_id, attempt_number, status, idempotency_key,
          lease_owner, fencing_token, lease_expires_at, started_at
        ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?)
      `).run(
        attemptId,
        effect.id,
        numberRow.attempt_number,
        idempotencyKey,
        this.#ownerId,
        tokenRow.value,
        new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        now.toISOString(),
      );
      this.#recordTransition("delivery", attemptId, null, "prepared", "attempt_created", now, tokenRow.value);
      this.#database.prepare(`
        UPDATE delivery_attempts SET status = 'dispatching'
        WHERE id = ? AND status = 'prepared'
      `).run(attemptId);
      this.#recordTransition("delivery", attemptId, "prepared", "dispatching", "external_io_started", now, tokenRow.value);

      return {
        request: {
          attemptId,
          effectId: effect.id,
          kind: effect.kind,
          payload: JSON.parse(effect.payload_json) as JsonValue,
          routeRef: effect.route_ref,
          idempotencyKey,
        },
        fencingToken: tokenRow.value,
      };
    });
  }

  #finishDelivery(attemptId: string, fencingToken: number, observation: DeliveryObservation): void {
    this.#transaction(() => {
      const now = this.#now();
      const attempt = this.#database.prepare(`
        SELECT effect_id FROM delivery_attempts
        WHERE id = ? AND status = 'dispatching' AND fencing_token = ? AND lease_owner = ?
      `).get(attemptId, fencingToken, this.#ownerId) as unknown as { effect_id: string } | undefined;
      if (!attempt) throw new Error(`Delivery ${attemptId} no longer accepts writes from lease ${fencingToken}`);
      this.#database.prepare(`
        UPDATE delivery_attempts
        SET status = ?, ended_at = ?, remote_id = ?, error = ?
        WHERE id = ? AND status = 'dispatching' AND fencing_token = ? AND lease_owner = ?
      `).run(
        observation.status,
        now.toISOString(),
        observation.status === "delivered" ? observation.remoteId : null,
        observation.status === "delivered" ? null : observation.error ?? null,
        attemptId,
        fencingToken,
        this.#ownerId,
      );
      const effectState = observation.status === "delivered"
        ? "completed"
        : observation.status === "unknown"
          ? "reconciliation_required"
          : "pending";
      if (effectState !== "pending") {
        this.#database.prepare(`
          UPDATE effects SET status = ?, ended_at = ? WHERE id = ? AND status = 'pending'
        `).run(effectState, now.toISOString(), attempt.effect_id);
      }
      this.#recordTransition("delivery", attemptId, "dispatching", observation.status, "integration_result", now, fencingToken);
      if (effectState !== "pending") {
        this.#recordTransition("effect", attempt.effect_id, "pending", effectState, `delivery_${observation.status}`, now, fencingToken);
      }
    });
  }

  async #steerInput(
    active: ActiveExecution,
    inputId: string,
  ): Promise<void> {
    const prepared = this.#transaction(() => {
      const input = this.#database.prepare(`
        SELECT id, kind, payload_json, occurred_at FROM inputs WHERE id = ? AND status = 'pending'
      `).get(inputId) as unknown as Pick<InputRow, "id" | "kind" | "payload_json" | "occurred_at"> | undefined;
      if (!input) return undefined;
      const turn = this.#database.prepare(`
        SELECT id FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(active.turnId, active.fencingToken, this.#ownerId);
      if (!turn) return undefined;
      const next = this.#database.prepare(`
        SELECT COALESCE(MAX(position), 0) + 1 AS position FROM turn_inputs WHERE turn_id = ?
      `).get(active.turnId) as unknown as { position: number };
      this.#database.prepare(`
        INSERT INTO turn_inputs (turn_id, input_id, position, inclusion_status)
        VALUES (?, ?, ?, 'prepared')
      `).run(active.turnId, input.id, next.position);
      return {
        input: {
          id: input.id,
          kind: input.kind,
          payload: JSON.parse(input.payload_json) as JsonValue,
          occurredAt: input.occurred_at,
          inclusionPosition: next.position,
        } satisfies ExecutionInput,
      };
    });
    if (!prepared) return;

    try {
      await active.execution.steer(prepared.input);
    } catch {
      this.#rejectPreparedSteer(active.turnId, inputId);
    }
  }

  #rejectPreparedSteer(turnId: string, inputId: string): void {
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE turn_inputs SET inclusion_status = 'rejected'
        WHERE turn_id = ? AND input_id = ? AND inclusion_status = 'prepared'
      `).run(turnId, inputId);
    });
  }

  #settleInputsAfterStoppedTurn(
    turnId: string,
    reason: "failed" | "interrupted",
    now: Date,
    fencingToken: number,
  ): void {
    const coverage = this.#database.prepare(`
      SELECT MAX(position) AS position FROM (
        SELECT input_position AS position FROM effects WHERE turn_id = ?
        UNION ALL
        SELECT input_position AS position FROM turn_tool_activity WHERE turn_id = ?
      )
    `).get(turnId, turnId) as unknown as { position: number | null };
    const inputs = this.#database.prepare(`
      SELECT inputs.id, inputs.kind, turn_inputs.position
      FROM turn_inputs
      JOIN inputs ON inputs.id = turn_inputs.input_id
      WHERE turn_inputs.turn_id = ?
        AND turn_inputs.inclusion_status = 'included'
        AND inputs.status = 'active'
      ORDER BY turn_inputs.position
    `).all(turnId) as unknown as Array<{ id: string; kind: InputKind; position: number }>;

    for (const input of inputs) {
      const covered = coverage.position !== null && input.position <= coverage.position;
      const next = covered ? "consumed" : "pending";
      this.#database.prepare(`
        UPDATE inputs SET status = ?, active_turn_id = NULL
        WHERE id = ? AND status = 'active' AND active_turn_id = ?
      `).run(next, input.id, turnId);
      this.#recordTransition(
        "input",
        input.id,
        "active",
        next,
        covered ? `${reason}_after_effect` : `${reason}_without_effect`,
        now,
        fencingToken,
      );
    }
  }

  #recordTransition(
    entityType: string,
    entityId: string,
    fromState: string | null,
    toState: string,
    reason: string,
    occurredAt: Date,
    fencingToken: number | null,
  ): void {
    this.#database.prepare(`
      INSERT INTO transitions (
        entity_type, entity_id, from_state, to_state, reason, occurred_at, fencing_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entityType, entityId, fromState, toState, reason, occurredAt.toISOString(), fencingToken);
  }

  #startHeartbeat(
    kind: "turn" | "delivery" | "activity_close" | "activity_recording",
    id: string,
    fencingToken: number,
  ): void {
    this.#stopHeartbeat();
    const intervalMs = Math.max(25, Math.floor(this.#leaseDurationMs / 3));
    this.#heartbeat = setInterval(() => {
      const expiresAt = new Date(this.#now().getTime() + this.#leaseDurationMs).toISOString();
      const result = kind === "turn"
        ? this.#database.prepare(`
            UPDATE turns SET lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
          `).run(expiresAt, id, fencingToken, this.#ownerId)
        : kind === "delivery"
          ? this.#database.prepare(`
            UPDATE delivery_attempts SET lease_expires_at = ?
            WHERE id = ? AND status = 'dispatching' AND fencing_token = ? AND lease_owner = ?
          `).run(expiresAt, id, fencingToken, this.#ownerId)
          : kind === "activity_close"
            ? this.#database.prepare(`
                UPDATE active_segment SET close_lease_expires_at = ?
                WHERE id = ? AND status = 'closing' AND close_fencing_token = ? AND close_owner = ?
              `).run(expiresAt, id, fencingToken, this.#ownerId)
            : this.#database.prepare(`
                UPDATE activities SET lease_expires_at = ?
                WHERE id = ? AND status = 'recording' AND fencing_token = ? AND lease_owner = ?
              `).run(expiresAt, id, fencingToken, this.#ownerId);
      if (result.changes !== 1) this.#stopHeartbeat();
    }, intervalMs);
    this.#heartbeat.unref();
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #transaction<T>(work: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openRuntime(options: RuntimeOptions): Runtime {
  return new SqliteRuntime(options);
}
