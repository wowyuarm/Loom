import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createHostTimePolicy, type TimePolicy } from "../configuration/index.js";
import { initializeRuntimeSchema } from "./schema.js";
import { RuntimeStatusReader, reflectionSlice } from "./status-reader.js";
import {
  CognitiveOrganExecution,
  COGNITIVE_ORGAN_POLICY,
  type CognitiveAttemptRecord,
  type CognitiveOrganName,
  type CognitiveOrganPolicy,
  type CognitiveWorkRecord,
} from "./cognitive-organ-execution.js";

/** Organs the Runtime executes through the shared Cognitive Organ ledger. */
const RUNTIME_COGNITIVE_ORGANS: readonly CognitiveOrganName[] = [
  "life-recorder",
  "attention-maintainer",
  "memory-reflector",
  "thread-maintainer",
];
import type {
  AcceptedInput,
  AdvanceOptions,
  AdvanceResult,
  ActivityFreezeRequest,
  ActivityLifecycle,
  ActivityRecorder,
  AttentionMaintenance,
  AttentionMaintenanceResult,
  ActorReference,
  MemoryReflection,
  MemoryReflectionResult,
  AgentExecution,
  OrientationResult,
  CloseActivityBusyReason,
  CloseActivityOptions,
  CloseActivityResult,
  DeliveryAttemptRequest,
  DeliveryObservation,
  EffectReceipt,
  EffectRequest,
  ExecutionInput,
  ExecutionResult,
  FormOpportunityResult,
  InputKind,
  InteractionDecisionReceipt,
  InteractionDecisionRequest,
  InteractionViewOptions,
  InteractionViewPage,
  FrozenActivity,
  LifeRecorderReceipt,
  Orientation,
  OutboundDelivery,
  JsonValue,
  RunningExecution,
  Runtime,
  RuntimeAfterChatContinuationStatus,
  RuntimeDeliveryStatus,
  RuntimeEffectStatus,
  RuntimeInput,
  RuntimeInputOutcome,
  RequeueInputResult,
  RequeueCognitiveOrganWorkResult,
  RuntimeInputStatus,
  RuntimeOptions,
  RuntimeStatus,
  RuntimeAgentName,
  RuntimeAgentRunSummary,
  RuntimeCognitiveOrganWorkStatus,
  RuntimeOperationalStatus,
  ThreadActivityObservation,
  ThreadMaintenance,
  ThreadMaintenanceResult,
  RuntimeTurnStatus,
  RunOpportunityPulseOptions,
  RunOpportunityPulseResult,
  RunAfterChatContinuationOptions,
  RunAfterChatContinuationResult,
  RunAttentionMaintenanceOptions,
  RunAttentionMaintenanceResult,
  RunMemoryReflectionOptions,
  RunMemoryReflectionResult,
  TranscriptAnchor,
  VerifiedToolActivity,
} from "./types.js";
import {
  emitOperationalEvent,
  type OperationalEvent,
  type OperationalEventObserver,
} from "../operational-events.js";

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
  segment_id: string;
  turn_id: string;
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

interface AgentRunRow {
  id: string;
  agent_name: RuntimeAgentName;
  status: RuntimeAgentRunSummary["result"];
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  failure_category: string | null;
}

const AFTER_CHAT_DELAY_MS = 5 * 60 * 1_000;
const AFTER_CHAT_EXPIRY_MS = 20 * 60 * 1_000;
const DELIVERY_RETRY_BASE_MS = 60 * 1_000;
const DELIVERY_RETRY_MAX_MS = 60 * 60 * 1_000;
const INTERACTION_WAVE_QUIET_MS = 1_500;
const INTERACTION_WAVE_MAX_MS = 6_000;
const OVERDUE_RECHECK_INTERVAL_MS = 15 * 60 * 1_000;

const RUNTIME_AGENT_NAMES: RuntimeAgentName[] = [
  "main-agent",
  "orientation",
  "life-recorder",
  "attention-maintainer",
  "memory-reflector",
  "thread-maintainer",
];

function deliveryRetryDelay(attempt: number): number {
  const exponent = Math.min(
    Math.max(0, attempt - 1),
    Math.ceil(Math.log2(DELIVERY_RETRY_MAX_MS / DELIVERY_RETRY_BASE_MS)),
  );
  return Math.min(DELIVERY_RETRY_BASE_MS * 2 ** exponent, DELIVERY_RETRY_MAX_MS);
}

interface ActiveExecution {
  turnId: string;
  fencingToken: number;
  execution: RunningExecution;
  finishing: boolean;
  steeringTail: Promise<void>;
  interactionWaveId: string | undefined;
  interactionScopeKey: string | undefined;
}

interface ActiveOrientation {
  supersede(): void;
}

interface ActiveCognitiveOrgan {
  workId: string;
  attempt: CognitiveAttemptRecord;
  cancel: (reason: string) => Promise<void>;
  run: Promise<unknown>;
}

interface CognitiveOrganClaim {
  workId: string;
  work: CognitiveWorkRecord;
  attempt: CognitiveAttemptRecord;
  agentRunId: string;
}

/** Outcome of one Cognitive Organ budget cycle as seen by the domain entry point. */
export type CognitiveOrganRunOutcome<Result> =
  | { disposition: "completed"; result: Result }
  | {
      disposition: "failed";
      failureCategory: string | undefined;
      error: string;
      nextAttemptAt: string | undefined;
      blocked: boolean;
    }
  | { disposition: "cancelled" }
  | { disposition: "intervention_required" };

class SqliteRuntime implements Runtime {
  readonly #database: DatabaseSync;
  readonly #execution: AgentExecution | undefined;
  readonly #outboundDelivery: OutboundDelivery | undefined;
  readonly #activityLifecycle: ActivityLifecycle | undefined;
  readonly #activityRecorder: ActivityRecorder | undefined;
  readonly #orientation: Orientation | undefined;
  readonly #threadMaintenance: ThreadMaintenance | undefined;
  readonly #attentionMaintenance: AttentionMaintenance | undefined;
  readonly #memoryReflection: MemoryReflection | undefined;
  readonly #timePolicy: TimePolicy;
  readonly #now: () => Date;
  readonly #nextId: () => string;
  readonly #ownerId: string;
  readonly #leaseDurationMs: number;
  readonly #observe: OperationalEventObserver | undefined;
  readonly #revisions: { current(): { id: string } } | undefined;
  readonly #cognitiveOrganPolicy: CognitiveOrganPolicy;
  readonly #cognitiveOrgan: CognitiveOrganExecution;
  readonly #statusReader: RuntimeStatusReader;
  readonly #organCancelTimer: (
    delayMs: number,
    callback: () => void,
  ) => { clear(): void };
  readonly #organSoftDeadlineTimers = new Map<string, { clear(): void }>();
  #pendingOperationalEvents: OperationalEvent[] | undefined;
  #active: ActiveExecution | undefined;
  #activeDeliveryId: string | undefined;
  #closingActivityId: string | undefined;
  #activeActivityAttemptId: string | undefined;
  #activeThreadMaintenanceId: string | undefined;
  #attentionMaintenanceRunning = false;
  #memoryReflectionRunning = false;
  #opportunityRunning = false;
  #activeOrientation: ActiveOrientation | undefined;
  #activeCognitiveOrgan: ActiveCognitiveOrgan | undefined;
  /** In-flight cancel decision; the run path awaits it before deriving its outcome. */
  #cancelSettling: Promise<void> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(options: RuntimeOptions) {
    mkdirSync(options.root, { recursive: true });
    this.#database = new DatabaseSync(path.join(options.root, "runtime.db"));
    this.#execution = options.execution;
    this.#outboundDelivery = options.outboundDelivery;
    this.#activityLifecycle = options.activityLifecycle;
    this.#activityRecorder = options.activityRecorder;
    this.#orientation = options.orientation;
    this.#threadMaintenance = options.threadMaintenance;
    this.#attentionMaintenance = options.attentionMaintenance;
    this.#memoryReflection = options.memoryReflection;
    this.#timePolicy = options.timePolicy ?? createHostTimePolicy();
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? randomUUID;
    this.#ownerId = options.ownerId ?? randomUUID();
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.#observe = options.observe;
    this.#revisions = options.revisions;
    this.#cognitiveOrganPolicy = options.cognitiveOrganPolicy ?? COGNITIVE_ORGAN_POLICY;
    this.#organCancelTimer = options.organCancelTimer ?? defaultOrganCancelTimer;
    initializeRuntimeSchema(this.#database);
    this.#cognitiveOrgan = new CognitiveOrganExecution({
      database: this.#database,
      policy: this.#cognitiveOrganPolicy,
      now: this.#now,
      nextId: this.#nextId,
    });
    this.#statusReader = new RuntimeStatusReader({
      database: this.#database,
      now: this.#now,
      organs: RUNTIME_COGNITIVE_ORGANS,
      cognitiveOrganWork: organ => this.#cognitiveOrgan.currentWork(organ),
      cognitiveOrganLocalId: workId => this.#cognitiveOrgan.localIdOf(workId),
      cognitiveOrganAttempts: workId => this.#cognitiveOrgan.attempts(workId),
    });
    this.#reconcileExpiredActivityClose();
    this.#reconcileExpiredActivityRecording();
    this.#reconcileExpiredThreadMaintenance();
    this.#reconcileExpiredDeliveries();
    this.#reconcileExpiredTurns();
    this.#reconcileOrphanedAgentRuns();
    this.#cognitiveOrgan.reconcile(this.#now());
  }

  async acceptInput(input: RuntimeInput): Promise<AcceptedInput> {
    if (!input.source || !input.sourceId) throw new Error("Runtime input requires source and sourceId");
    if ((input as { kind: string }).kind === "continuation") {
      throw new Error("After-chat continuation is admitted only by Runtime lifecycle");
    }
    const id = this.#nextId();
    const accepted = this.#transaction(() => {
      const existing = this.#findInput(input.source, input.sourceId);
      if (existing) return { disposition: "duplicate", inputId: existing.id } as const;
      const now = this.#now();
      const interactionWaveId = input.kind === "interaction"
        ? this.#joinInteractionWave(input, now, id)
        : undefined;
      const interactionScopeKey = interactionWaveId
        ? (this.#database.prepare(`
            SELECT scope_key FROM interaction_waves WHERE id = ?
          `).get(interactionWaveId) as unknown as { scope_key: string } | undefined)?.scope_key
        : undefined;
      // Durable arrival context: an Interaction accepted after the same scope's
      // first message Effect was committed but before its Delivery was confirmed
      // was sent while the human likely had not seen the previous reply yet.
      // This fact is fixed at accept time; a Delivery that confirms later must
      // not erase it.
      const lateArriving = interactionScopeKey
        ? this.#deliveryUnconfirmedAfterCommit(interactionScopeKey) ? 1 : 0
        : 0;
      const result = this.#database.prepare(`
        INSERT OR IGNORE INTO inputs (
          id, source, source_id, kind, payload_json, interaction_json,
          interaction_wave_id, occurred_at, accepted_at, status, late_arriving
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        id,
        input.source,
        input.sourceId,
        input.kind,
        JSON.stringify(input.payload),
        input.interaction ? JSON.stringify(input.interaction) : null,
        interactionWaveId ?? null,
        input.occurredAt ?? now.toISOString(),
        now.toISOString(),
        lateArriving,
      );
      if (result.changes === 1) {
        if (input.kind === "interaction") {
          this.#cancelPendingAfterChat(now, "new_human_input");
          this.#discardUnclaimedOpportunities(now);
        }
        this.#recordTransition("input", id, null, "pending", "accepted", now, null);
        return {
          disposition: "accepted",
          inputId: id,
          interactionWaveId,
          interactionScopeKey,
        } as const;
      }
      const duplicate = this.#findInput(input.source, input.sourceId);
      if (!duplicate) throw new Error("Input dedupe conflict did not preserve an existing input");
      return { disposition: "duplicate", inputId: duplicate.id } as const;
    });

    if (accepted.disposition === "accepted") {
      if (input.kind === "interaction") {
        this.#activeOrientation?.supersede();
        if (input.interaction?.actor.kind !== "agent" && input.interaction?.actor.kind !== "system") {
          await this.#cancelActiveCognitiveOrgan("new_human_input");
        }
      }
      const active = this.#active;
      if (active && !active.finishing && input.kind === "interaction") {
        const sameWave = active.interactionWaveId === undefined
          || active.interactionWaveId === accepted.interactionWaveId;
        if (sameWave) {
          active.interactionWaveId ??= accepted.interactionWaveId;
        }
        // Wave mismatch is not a dead end: an Input of the same scope may still
        // steer into the running Turn while its reply gate is open. The
        // authoritative gate check happens inside the steering transaction.
        const scopeMatches = active.interactionScopeKey !== undefined
          && active.interactionScopeKey === accepted.interactionScopeKey;
        if (sameWave || scopeMatches) {
          const steering = active.steeringTail.then(async () => {
            await this.#steerInput(active, id);
          });
          active.steeringTail = steering.catch(() => {});
        }
      }
      return { disposition: "accepted", inputId: id };
    }
    return accepted;
  }

  #deliveryUnconfirmedAfterCommit(scopeKey: string): boolean {
    // Lock onto the most recently closed Turn of this scope. A no_reply Turn
    // has no message Effect and must count as a clean boundary: Inputs that
    // arrive after it are not late, even if an older reply is still
    // unconfirmed. Only the latest Turn's own reply (if any) decides.
    // Tie-break by rowid (insert order), not by id (a random UUID): the
    // one_running_turn index serializes Turns, so start order equals gate
    // close order and rowid DESC is the reliable "latest closed" ordering.
    const prior = this.#database.prepare(`
      SELECT
        EXISTS (
          SELECT 1 FROM effects e WHERE e.turn_id = t.id AND e.kind = 'message'
        ) AS has_message,
        EXISTS (
          SELECT 1 FROM effects e
          WHERE e.turn_id = t.id AND e.kind = 'message'
            AND EXISTS (
              SELECT 1 FROM delivery_attempts da
              WHERE da.effect_id = e.id AND da.status = 'delivered'
            )
        ) AS delivered
      FROM turns t
      WHERE t.interaction_scope_key = ? AND t.reply_gate_closed_at IS NOT NULL
      ORDER BY t.reply_gate_closed_at DESC, t.rowid DESC
      LIMIT 1
    `).get(scopeKey) as unknown as { has_message: number; delivered: number } | undefined;
    return prior?.has_message === 1 && prior?.delivered !== 1;
  }

  requeueInput(inputId: string): RequeueInputResult {
    if (!inputId.trim()) throw new Error("Runtime requeue requires an Input id");
    return this.#transaction(() => {
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE inputs SET status = 'pending'
        WHERE id = ? AND status = 'blocked'
      `).run(inputId);
      if (changed.changes !== 1) return { disposition: "not_blocked" } as const;
      this.#recordTransition("input", inputId, "blocked", "pending", "explicit_requeue", now, null);
      return { disposition: "requeued" } as const;
    });
  }

  #joinInteractionWave(input: RuntimeInput, now: Date, inputId: string): string {
    const scopeKey = JSON.stringify([
      input.interaction?.routeRef ?? input.source,
      input.interaction?.place.placeRef ?? input.source,
    ]);
    const open = this.#database.prepare(`
      SELECT id, quiet_seal_at, max_seal_at
      FROM interaction_waves
      WHERE scope_key = ? AND status = 'open'
    `).get(scopeKey) as unknown as {
      id: string;
      quiet_seal_at: string;
      max_seal_at: string;
    } | undefined;
    if (open) {
      const quietSealAt = Date.parse(open.quiet_seal_at);
      const maxSealAt = Date.parse(open.max_seal_at);
      if (now.getTime() < quietSealAt && now.getTime() < maxSealAt) {
        const nextQuietSealAt = new Date(Math.min(
          now.getTime() + INTERACTION_WAVE_QUIET_MS,
          maxSealAt,
        ));
        this.#database.prepare(`
          UPDATE interaction_waves
          SET last_input_at = ?, quiet_seal_at = ?
          WHERE id = ? AND status = 'open'
        `).run(now.toISOString(), nextQuietSealAt.toISOString(), open.id);
        return open.id;
      }
      this.#sealInteractionWave(open.id, now);
    }

    const waveId = `wave:${inputId}`;
    const maxSealAt = new Date(now.getTime() + INTERACTION_WAVE_MAX_MS);
    const quietSealAt = new Date(Math.min(
      now.getTime() + INTERACTION_WAVE_QUIET_MS,
      maxSealAt.getTime(),
    ));
    this.#database.prepare(`
      INSERT INTO interaction_waves (
        id, scope_key, opened_at, last_input_at, quiet_seal_at, max_seal_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'open')
    `).run(
      waveId,
      scopeKey,
      now.toISOString(),
      now.toISOString(),
      quietSealAt.toISOString(),
      maxSealAt.toISOString(),
    );
    return waveId;
  }

  #sealInteractionWave(waveId: string, now: Date): void {
    this.#database.prepare(`
      UPDATE interaction_waves
      SET status = 'sealed', sealed_at = ?
      WHERE id = ? AND status = 'open'
    `).run(now.toISOString(), waveId);
  }

  async formOpportunity(): Promise<FormOpportunityResult> {
    return this.#formOpportunityAt(this.#now());
  }

  async runAfterChatContinuation(
    options: RunAfterChatContinuationOptions,
  ): Promise<RunAfterChatContinuationResult> {
    if (!Number.isFinite(options.observedAt.getTime())) {
      throw new Error("After-chat continuation requires a valid observedAt");
    }
    return this.#transaction(() => {
      const continuation = this.#readAfterChatContinuation();
      if (continuation?.status !== "pending") return { disposition: "none" } as const;
      if (options.observedAt.getTime() >= Date.parse(continuation.expires_at)) {
        this.#finishPendingAfterChat(continuation, "expired", options.observedAt, "expired");
        return { disposition: "expired" } as const;
      }
      if (options.observedAt.getTime() < Date.parse(continuation.due_at)) {
        return { disposition: "waiting", nextRunAt: continuation.due_at } as const;
      }
      if (options.agentWork === "defer") {
        return { disposition: "agent_work_deferred", nextRunAt: continuation.expires_at } as const;
      }
      if (this.#active || this.#hasRunningTurn()) return { disposition: "busy" } as const;
      const segment = this.#readActiveSegment();
      if (!segment || segment.status !== "active" || segment.id !== continuation.source_segment_id) {
        this.#finishPendingAfterChat(
          continuation,
          "expired",
          options.observedAt,
          "source_activity_unavailable",
        );
        return { disposition: "expired" } as const;
      }

      const inputId = this.#nextId();
      const acceptedAt = this.#now();
      this.#database.prepare(`
        INSERT INTO inputs (
          id, source, source_id, kind, payload_json, occurred_at, accepted_at, status
        ) VALUES (?, 'after-chat', ?, 'continuation', ?, ?, ?, 'pending')
      `).run(
        inputId,
        continuation.id,
        JSON.stringify({
          version: 1,
          observedAt: options.observedAt.toISOString(),
          deliveredAt: continuation.delivered_at,
          sourceTurnId: continuation.source_turn_id,
          sourceEffectId: continuation.source_effect_id,
          sourceBehavior: continuation.source_behavior,
        }),
        options.observedAt.toISOString(),
        acceptedAt.toISOString(),
      );
      const changed = this.#database.prepare(`
        UPDATE after_chat_continuation
        SET status = 'admitted', input_id = ?
        WHERE singleton = 1 AND id = ? AND status = 'pending'
      `).run(inputId, continuation.id);
      if (changed.changes !== 1) throw new Error(`After-chat continuation ${continuation.id} lost admission`);
      this.#recordTransition("input", inputId, null, "pending", "after_chat_admitted", acceptedAt, null);
      this.#recordTransition(
        "after_chat_continuation",
        continuation.id,
        "pending",
        "admitted",
        "due",
        acceptedAt,
        null,
      );
      return { disposition: "admitted", inputId } as const;
    });
  }

  async runOpportunityPulse(
    options: RunOpportunityPulseOptions,
  ): Promise<RunOpportunityPulseResult> {
    if (!Number.isFinite(options.observedAt.getTime())) {
      throw new Error("Opportunity Pulse requires a valid observedAt");
    }
    assertPositiveDuration(options.initialDelayMs, "initialDelayMs");
    assertPositiveDuration(options.cadenceMs, "cadenceMs");
    assertPositiveDuration(options.retryDelayMs, "retryDelayMs");
    const schedule = this.#ensurePulseSchedule(options.observedAt, options.initialDelayMs);
    if (options.observedAt < new Date(schedule.next_pulse_after)) {
      return { disposition: "waiting", nextRunAt: schedule.next_pulse_after };
    }
    if (options.agentWork === "defer") {
      return { disposition: "agent_work_deferred", nextRunAt: schedule.next_pulse_after };
    }

    const nextRunAt = new Date(options.observedAt.getTime() + options.cadenceMs).toISOString();
    try {
      const result = await this.#formOpportunityAt(options.observedAt, nextRunAt, true);
      if (result.disposition === "accepted") return { ...result, nextRunAt };
      if (result.disposition === "none") return { ...result, nextRunAt };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = new Date(options.observedAt.getTime() + options.retryDelayMs).toISOString();
      this.#failPulse(options.observedAt, retryAt, message);
      return { disposition: "failed", nextRunAt: retryAt, error: message };
    }
  }

  async #formOpportunityAt(
    observedAt: Date,
    completedPulseNextRunAt?: string,
  ): Promise<FormOpportunityResult>;
  async #formOpportunityAt(
    observedAt: Date,
    completedPulseNextRunAt: string | undefined,
    returnOnSupersede: true,
  ): Promise<FormOpportunityResult | { disposition: "stale" }>;
  async #formOpportunityAt(
    observedAt: Date,
    completedPulseNextRunAt?: string,
    returnOnSupersede = false,
  ): Promise<FormOpportunityResult | { disposition: "stale" }> {
    if (!this.#orientation) throw new Error("Runtime has no Orientation adapter");
    if (this.#opportunityRunning) return { disposition: "busy" };
    const snapshot = this.#opportunitySnapshot(observedAt);
    if (!snapshot) return { disposition: "busy" };

    let supersededByInput = false;
    let supersede!: () => void;
    const superseded = new Promise<"superseded">(resolve => {
      supersede = () => {
        supersededByInput = true;
        resolve("superseded");
      };
    });
    const orientation: ActiveOrientation = { supersede };
    this.#opportunityRunning = true;
    this.#activeOrientation = orientation;
    const completion = Promise.resolve().then(() => this.#runOrientation(snapshot.request));
    void completion.finally(() => {
      if (this.#activeOrientation === orientation) {
        this.#activeOrientation = undefined;
        this.#opportunityRunning = false;
      }
    }).catch(() => {});
    let result: OrientationResult | "superseded";
    try {
      result = returnOnSupersede
        ? await Promise.race([completion, superseded])
        : await completion;
    } catch (error) {
      if (this.#activeOrientation === orientation) {
        this.#activeOrientation = undefined;
        this.#opportunityRunning = false;
      }
      throw error;
    }
    if (result === "superseded") return { disposition: "stale" };
    if (supersededByInput) return { disposition: "stale", runId: result.runId };
    if (result.outcome === "none") {
      if (completedPulseNextRunAt) {
        this.#completePulse(observedAt, completedPulseNextRunAt, "orientation_none");
      }
      await result.acknowledgeExternalEvidence?.();
      return { disposition: "none", runId: result.runId };
    }
    if (!result.runId.trim() || !result.narrative.trim()) {
      throw new Error("Orientation Opportunity requires a runId and narrative");
    }

    const admitted = this.#transaction(() => {
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
      if (completedPulseNextRunAt) {
        this.#completePulseInTransaction(
          observedAt,
          completedPulseNextRunAt,
          "opportunity_admitted",
        );
      }
      return { disposition: "accepted", inputId, runId: result.runId } as const;
    });
    if (admitted.disposition === "accepted") {
      await result.acknowledgeExternalEvidence?.();
    }
    return admitted;
  }

  async advance(options: AdvanceOptions = {}): Promise<AdvanceResult> {
    if (this.#active || this.#activeDeliveryId || this.#closingActivityId
      || this.#activeActivityAttemptId || this.#activeThreadMaintenanceId) {
      return { disposition: "busy" };
    }
    this.#reconcileExpiredDeliveries();
    this.#reconcileExpiredTurns();
    this.#reconcileExpiredActivityClose();
    this.#reconcileExpiredActivityRecording();
    this.#reconcileExpiredThreadMaintenance();
    this.#expireAfterChatContinuation(options.observedAt ?? this.#now());
    if (this.#hasRunningTurn()) return { disposition: "busy" };

    if (this.#outboundDelivery) {
      const delivery = this.#claimPendingDelivery(options.observedAt ?? this.#now());
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
          const nextDeliveryAt = this.#finishDelivery(
            delivery.request.attemptId,
            delivery.fencingToken,
            observation,
          );
          if (observation.status === "delivered") return { disposition: "delivery_completed" };
          if (observation.status === "not_sent") {
            if (!nextDeliveryAt) throw new Error("A not-sent Delivery requires a retry time");
            return { disposition: "delivery_not_sent", nextRunAt: nextDeliveryAt };
          }
          return { disposition: "delivery_requires_reconciliation" };
        } finally {
          this.#stopHeartbeat();
          if (this.#activeDeliveryId === delivery.request.attemptId) this.#activeDeliveryId = undefined;
        }
      }
    }

    if (this.#execution) {
      // While Cognitive Organ work is held for human intervention no parallel
      // Workspace writer may run: the foreground Input stays durable until a
      // human resolves the held work.
      if (this.#hasHeldCognitiveOrganWork()) return { disposition: "busy" };
      if (options.agentWork === "defer" && this.#hasPendingInput()) {
        return { disposition: "agent_work_deferred" };
      }
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
            commitInteractionDecision: decision => this.#commitInteractionDecision(
              claimed.turnId,
              claimed.fencingToken,
              decision,
            ),
          });
          const active = {
            turnId: claimed.turnId,
            fencingToken: claimed.fencingToken,
            execution: running,
            finishing: false,
            steeringTail: Promise.resolve(),
            interactionWaveId: claimed.interactionWaveId,
            interactionScopeKey: claimed.interactionScopeKey,
          };
          this.#active = active;
          if (claimed.interactionScopeKey) {
            for (const inputId of this.#pendingScopeInteractionInputs(
              claimed.interactionScopeKey,
              claimed.input.id,
            )) {
              const steering = active.steeringTail.then(async () => {
                await this.#steerInput(active, inputId);
              });
              active.steeringTail = steering.catch(() => {});
            }
          }
          this.#startHeartbeat("turn", claimed.turnId, claimed.fencingToken);
          const result = await running.result;
          active.finishing = true;
          await active.steeringTail;
          this.#completeTurn(claimed.turnId, claimed.fencingToken, result);
          turnCompleted = true;
          if (claimed.input.kind === "opportunity") {
            const standalone = this.#standaloneProactiveActivity(claimed.turnId);
            if (standalone) {
              await this.#freezeActivity(standalone, {});
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
                await this.#freezeActivity(standalone, {});
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

    if (options.agentWork === "defer" && (
      (this.#activityRecorder && this.#hasPendingActivityRecording())
      || (this.#threadMaintenance && this.#hasPendingThreadMaintenance())
    )) {
      return { disposition: "agent_work_deferred" };
    }
    const recording = await this.#advanceActivityRecording();
    if (recording.disposition !== "idle") return recording;
    return this.#advanceThreadMaintenance();
  }

  async runAttentionMaintenance(
    options: RunAttentionMaintenanceOptions,
  ): Promise<RunAttentionMaintenanceResult> {
    assertMaintenanceOptions(options);
    const schedule = this.#ensureAttentionSchedule(options.observedAt, options.initialDelayMs);
    if (options.observedAt < new Date(schedule.next_run_after)) {
      return { disposition: "waiting", nextRunAt: schedule.next_run_after };
    }
    if (options.agentWork === "defer") {
      return { disposition: "agent_work_deferred", nextRunAt: schedule.next_run_after };
    }
    if (!this.#attentionMaintenance || this.#attentionMaintenanceRunning || !this.#isMaintenanceIdle()) {
      return { disposition: "busy" };
    }

    const windowEnd = schedule.window_end_sequence ?? this.#latestActivitySequence();
    const activities = this.#activitiesInSequenceRange(schedule.cursor_sequence, windowEnd);
    const begun = this.#beginCognitiveOrganAttempt("attention-maintainer", `window:${windowEnd}`);
    if (!begun.claim) {
      return begun.nextAttemptAt
        ? { disposition: "waiting", nextRunAt: begun.nextAttemptAt }
        : { disposition: "busy" };
    }
    const claim = begun.claim;
    this.#attentionMaintenanceRunning = true;
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE attention_maintenance
        SET window_end_sequence = ?, attempt_count = attempt_count + 1
        WHERE singleton = 1
      `).run(windowEnd);
      this.#startAgentRun(claim.agentRunId, "attention-maintainer", this.#now());
    });
    try {
      const outcome = await this.#runCognitiveOrgan(claim, {
        cancel: reason => this.#attentionMaintenance!.cancel?.(reason) ?? Promise.resolve(),
        run: () => this.#attentionMaintenance!.maintain({
          observedAt: options.observedAt.toISOString(),
          localTime: this.#timePolicy.formatLocalTime(options.observedAt),
          recentActivities: activities,
        }),
        transcriptRef: result => organTranscriptRef("attention-maintainer", result.runId),
        resultRef: result => result.path,
      });
      switch (outcome.disposition) {
        case "completed": {
          const nextRunAt = new Date(options.observedAt.getTime() + options.cadenceMs).toISOString();
          this.#transaction(() => {
            this.#database.prepare(`
              UPDATE attention_maintenance
              SET last_completed_at = ?, next_run_after = ?, cursor_sequence = ?,
                  window_end_sequence = NULL, attempt_count = 0, last_result_json = ?, last_error = NULL
              WHERE singleton = 1
            `).run(options.observedAt.toISOString(), nextRunAt, windowEnd, JSON.stringify(outcome.result));
            this.#finishAgentRun(claim.agentRunId, "succeeded", outcome.result.outcome, this.#now());
          });
          return { disposition: "completed", result: outcome.result, nextRunAt };
        }
        case "cancelled": {
          // Human preemption dropped this run; the same window is retried on the
          // next cadence. The attempt budget is closed in the ledger.
          const nextRunAt = new Date(options.observedAt.getTime() + options.cadenceMs).toISOString();
          this.#transaction(() => {
            this.#database.prepare(`
              UPDATE attention_maintenance
              SET next_run_after = ?, last_error = NULL, window_end_sequence = NULL, attempt_count = 0
              WHERE singleton = 1
            `).run(nextRunAt);
            this.#finishAgentRun(claim.agentRunId, "interrupted", "cancelled", this.#now(), "cancelled");
          });
          return { disposition: "busy" };
        }
        case "intervention_required":
          // Domain schedule is left untouched; a human must resolve the held
          // work before any organ may start again.
          this.#finishAgentRun(
            claim.agentRunId,
            "interrupted",
            "intervention_required",
            this.#now(),
            "cancelled",
          );
          return { disposition: "busy" };
        case "failed": {
          const message = outcome.error;
          const nextRunAt = outcome.nextAttemptAt
            ?? new Date(options.observedAt.getTime() + options.retryDelayMs).toISOString();
          this.#transaction(() => {
            this.#database.prepare(`
              UPDATE attention_maintenance
              SET next_run_after = ?, last_error = ?
              WHERE singleton = 1
            `).run(nextRunAt, message.slice(0, 2_000));
            this.#finishAgentRun(
              claim.agentRunId,
              "failed",
              undefined,
              this.#now(),
              outcome.failureCategory ?? "unknown",
            );
          });
          return { disposition: "failed", nextRunAt, error: message };
        }
      }
    } finally {
      this.#attentionMaintenanceRunning = false;
    }
  }

  async runMemoryReflection(options: RunMemoryReflectionOptions): Promise<RunMemoryReflectionResult> {
    assertReflectionOptions(options);
    const schedule = this.#ensureMemoryReflectionSchedule(options.observedAt, options.delayMs);
    if (options.observedAt < new Date(schedule.next_run_after)) {
      return { disposition: "waiting", nextRunAt: schedule.next_run_after };
    }
    if (this.#memoryReflectionRunning || !this.#isCognitiveOrganIdle()) {
      return { disposition: "busy" };
    }
    if (!this.#reflectionDayComplete(schedule.next_day)) return { disposition: "busy" };

    const reflectionDay = schedule.next_day;
    const activities = this.#reflectionActivities(reflectionDay);
    if (activities.length === 0) {
      const nextDay = this.#timePolicy.nextRecordingDay(reflectionDay);
      const nextRunAt = this.#reflectionRunAt(nextDay, options.delayMs);
      this.#completeMemoryReflection(reflectionDay, nextDay, nextRunAt, undefined);
      return { disposition: "completed", reflectionDay, nextRunAt };
    }
    if (options.agentWork === "defer") {
      return { disposition: "agent_work_deferred", nextRunAt: schedule.next_run_after };
    }
    if (!this.#memoryReflection) return { disposition: "busy" };

    const begun = this.#beginCognitiveOrganAttempt("memory-reflector", `day:${reflectionDay}`);
    if (!begun.claim) {
      return begun.nextAttemptAt
        ? { disposition: "waiting", nextRunAt: begun.nextAttemptAt }
        : { disposition: "busy" };
    }
    const claim = begun.claim;
    this.#memoryReflectionRunning = true;
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE memory_reflection SET attempt_count = attempt_count + 1 WHERE singleton = 1
      `).run();
      this.#startAgentRun(claim.agentRunId, "memory-reflector", this.#now());
    });
    try {
      const outcome = await this.#runCognitiveOrgan(claim, {
        cancel: reason => this.#memoryReflection!.cancel?.(reason) ?? Promise.resolve(),
        run: () => this.#memoryReflection!.reflect({
          reflectionDay,
          observedAt: options.observedAt.toISOString(),
          localTime: this.#timePolicy.formatLocalTime(options.observedAt),
          activities,
        }),
        transcriptRef: result => organTranscriptRef("memory-reflector", result.runId),
        resultRef: result => result.changedMaterials[0],
      });
      switch (outcome.disposition) {
        case "completed": {
          const nextDay = this.#timePolicy.nextRecordingDay(reflectionDay);
          const nextRunAt = this.#reflectionRunAt(nextDay, options.delayMs);
          this.#transaction(() => {
            this.#completeMemoryReflection(reflectionDay, nextDay, nextRunAt, outcome.result);
            this.#finishAgentRun(claim.agentRunId, "succeeded", outcome.result.outcome, this.#now());
          });
          return { disposition: "completed", reflectionDay, result: outcome.result, nextRunAt };
        }
        case "cancelled": {
          const nextRunAt = new Date(options.observedAt.getTime() + options.retryDelayMs).toISOString();
          this.#transaction(() => {
            this.#database.prepare(`
              UPDATE memory_reflection SET next_run_after = ?, last_error = NULL, attempt_count = 0
              WHERE singleton = 1
            `).run(nextRunAt);
            this.#finishAgentRun(claim.agentRunId, "interrupted", "cancelled", this.#now(), "cancelled");
          });
          return { disposition: "busy" };
        }
        case "intervention_required":
          this.#finishAgentRun(
            claim.agentRunId,
            "interrupted",
            "intervention_required",
            this.#now(),
            "cancelled",
          );
          return { disposition: "busy" };
        case "failed": {
          const message = outcome.error;
          const nextRunAt = outcome.nextAttemptAt
            ?? new Date(options.observedAt.getTime() + options.retryDelayMs).toISOString();
          this.#transaction(() => {
            this.#database.prepare(`
              UPDATE memory_reflection SET next_run_after = ?, last_error = ? WHERE singleton = 1
            `).run(nextRunAt, message.slice(0, 2_000));
            this.#finishAgentRun(
              claim.agentRunId,
              "failed",
              undefined,
              this.#now(),
              outcome.failureCategory ?? "unknown",
            );
          });
          return { disposition: "failed", reflectionDay, nextRunAt, error: message };
        }
      }
    } finally {
      this.#memoryReflectionRunning = false;
    }
  }

  async closeActivity(options: CloseActivityOptions = {}): Promise<CloseActivityResult> {
    // Report the specific blocker instead of folding every condition into one
    // boolean: an operator (or the scheduler) must be able to tell "normally
    // working" from "stuck" when the Segment cannot freeze.
    const busy = this.#busyActivityReason();
    if (busy) {
      const nextOverdueCheckAt = this.#recordOverdueActivityClose(options, busy);
      return { disposition: "busy", reason: busy, ...(nextOverdueCheckAt ? { nextOverdueCheckAt } : {}) };
    }
    this.#reconcileExpiredActivityClose();
    const runningTurn = this.#readRunningTurn();
    if (runningTurn) {
      const reason: CloseActivityBusyReason = { kind: "main_agent_turn", turnId: runningTurn.id };
      const nextOverdueCheckAt = this.#recordOverdueActivityClose(options, reason);
      return { disposition: "busy", reason, ...(nextOverdueCheckAt ? { nextOverdueCheckAt } : {}) };
    }
    if (this.#hasPendingInput()) {
      const inputId = this.#readPendingInputId();
      if (!inputId) throw new Error("Pending Input exists but its id could not be read");
      const reason: CloseActivityBusyReason = { kind: "pending_input", inputId };
      const nextOverdueCheckAt = this.#recordOverdueActivityClose(options, reason);
      return { disposition: "busy", reason, ...(nextOverdueCheckAt ? { nextOverdueCheckAt } : {}) };
    }
    const segment = this.#readActiveSegment();
    if (!segment) return { disposition: "no_activity" };
    return this.#freezeActivity(segment, options);
  }

  #busyActivityReason(): CloseActivityBusyReason | undefined {
    if (this.#active) {
      return { kind: "active_execution", turnId: this.#active.turnId };
    }
    if (this.#activeDeliveryId) {
      return { kind: "delivery", attemptId: this.#activeDeliveryId };
    }
    if (this.#closingActivityId) {
      return { kind: "activity_closing", segmentId: this.#closingActivityId };
    }
    if (this.#activeActivityAttemptId) {
      return { kind: "activity_recording", activityId: this.#activeActivityAttemptId };
    }
    if (this.#activeThreadMaintenanceId) {
      return { kind: "thread_maintenance", activityId: this.#activeThreadMaintenanceId };
    }
    return undefined;
  }

  /**
   * Persist "Segment reached activityMaxMs but still cannot close" once per
   * check interval, so the operator can see the blocker and its first notice
   * time across restarts without the scheduler spinning on writes. Returns
   * the next re-check time so the scheduler can wake the driver at that
   * point instead of waiting for an external Input.
   */
  #recordOverdueActivityClose(options: CloseActivityOptions, reason: CloseActivityBusyReason): string | undefined {
    const segment = this.#readActiveSegment();
    if (!segment || segment.status !== "active") return undefined;
    const now = this.#now();
    // Same boundary as the scheduler's due check: the Segment is overdue once
    // openedAt has reached openedBefore (i.e. openedAt + activityMaxMs).
    const overdue = options.openedBefore !== undefined
      && Date.parse(segment.opened_at) <= Date.parse(options.openedBefore);
    if (!overdue) return undefined;
    const checkAt = segment.next_overdue_check_at;
    if (checkAt !== null && Date.parse(checkAt) > now.getTime()) {
      const reasonJson = JSON.stringify(reason);
      if (segment.overdue_reason_json !== reasonJson) {
        this.#database.prepare(`
          UPDATE active_segment
          SET overdue_reason_json = ?
          WHERE singleton = 1 AND status = 'active'
        `).run(reasonJson);
      }
      return checkAt;
    }
    const nextCheckAt = new Date(now.getTime() + OVERDUE_RECHECK_INTERVAL_MS).toISOString();
    this.#database.prepare(`
      UPDATE active_segment
      SET overdue_since = COALESCE(overdue_since, ?),
          overdue_reason_json = ?,
          next_overdue_check_at = ?
      WHERE singleton = 1 AND status = 'active'
    `).run(
      now.toISOString(),
      JSON.stringify(reason),
      nextCheckAt,
    );
    return nextCheckAt;
  }

  async #freezeActivity(
    segment: ActiveSegmentRow,
    closePolicy: CloseActivityOptions,
  ): Promise<CloseActivityResult> {
    const claimed = this.#claimActivityClose(segment.id, closePolicy);
    if (!claimed) {
      // Distinguish the real blocker: a running Turn, a pending Input, a
      const reason: CloseActivityBusyReason = this.#readRunningTurn()
        ? { kind: "main_agent_turn", turnId: this.#readRunningTurn()!.id }
        : this.#hasPendingInput()
          ? (() => {
              const inputId = this.#readPendingInputId();
              if (!inputId) throw new Error("Pending Input exists but its id could not be read");
              return { kind: "pending_input", inputId } as const;
            })()
          : { kind: "activity_closing", segmentId: segment.id };
      const nextOverdueCheckAt = this.#recordOverdueActivityClose(closePolicy, reason);
      return {
        disposition: "busy",
        reason,
        ...(nextOverdueCheckAt ? { nextOverdueCheckAt } : {}),
      };
    }
    if (claimed.disposition === "not_due") return claimed;
    if (!this.#activityLifecycle) {
      this.#failActivityClose(segment.id, claimed.fencingToken, new Error("Activity closure requires a Main Agent lifecycle adapter"));
      throw new Error("Activity closure requires a Main Agent lifecycle adapter");
    }
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
      if (!committed) {
        // The close yielded to a new Input: report that concrete blocker with
        // the persisted re-check time instead of a generic closing race.
        const reason: CloseActivityBusyReason = this.#hasPendingInput()
          ? (() => {
              const inputId = this.#readPendingInputId();
              if (!inputId) throw new Error("Pending Input exists but its id could not be read");
              return { kind: "pending_input", inputId } as const;
            })()
          : { kind: "activity_closing", segmentId: segment.id };
        const nextOverdueCheckAt = this.#recordOverdueActivityClose(closePolicy, reason);
        return {
          disposition: "busy",
          reason,
          ...(nextOverdueCheckAt ? { nextOverdueCheckAt } : {}),
        };
      }
      return { disposition: "activity_frozen", activityId: segment.id };
    } catch (error) {
      this.#failActivityClose(segment.id, claimed.fencingToken, error);
      throw error;
    } finally {
      this.#stopHeartbeat();
      if (this.#closingActivityId === segment.id) this.#closingActivityId = undefined;
    }
  }

  interactionView(options: InteractionViewOptions = {}): InteractionViewPage {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Interaction View limit must be an integer from 1 to 500");
    }
    const after = options.after === undefined ? 0 : parseInteractionCursor(options.after);
    const rows = this.#database.prepare(`
      WITH interaction_entries AS (
        SELECT transitions.sequence,
               COALESCE(json_extract(inputs.interaction_json, '$.actor.actorRef'), 'human') AS actor_ref,
               'input:' || inputs.id AS entry_id,
               inputs.occurred_at AS entry_at,
               inputs.source AS entry_source,
               inputs.id AS input_id,
               NULL AS turn_id,
               inputs.payload_json AS content_json
        FROM transitions
        JOIN inputs ON inputs.id = transitions.entity_id
        WHERE transitions.entity_type = 'input'
          AND transitions.from_state IS NULL
          AND transitions.to_state = 'pending'
          AND inputs.kind = 'interaction'

        UNION ALL

        SELECT transitions.sequence,
               'individual' AS actor_ref,
               'effect:' || effects.id AS entry_id,
               delivery_attempts.ended_at AS entry_at,
               COALESCE(effects.route_ref, 'unknown') AS entry_source,
               NULL AS input_id,
               effects.turn_id AS turn_id,
               effects.payload_json AS content_json
        FROM transitions
        JOIN delivery_attempts ON delivery_attempts.id = transitions.entity_id
        JOIN effects ON effects.id = delivery_attempts.effect_id
        WHERE transitions.entity_type = 'delivery'
          AND transitions.to_state = 'delivered'
          AND delivery_attempts.status = 'delivered'
          AND effects.kind = 'message'
      )
      SELECT sequence, actor_ref, entry_id, entry_at, entry_source, input_id, turn_id, content_json
      FROM interaction_entries
      WHERE sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(after, limit + 1) as unknown as Array<{
      sequence: number;
      actor_ref: ActorReference;
      entry_id: string;
      entry_at: string;
      entry_source: string;
      input_id: string | null;
      turn_id: string | null;
      content_json: string;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const inputIdsByTurn = this.#database.prepare(`
      SELECT input_id
      FROM turn_inputs
      WHERE turn_id = ? AND inclusion_status = 'included'
      ORDER BY position
    `);
    const entries = selected.map(row => ({
      id: row.entry_id,
      at: row.entry_at,
      actorRef: row.actor_ref,
      source: row.entry_source,
      inputIds: row.input_id
        ? [row.input_id]
        : (inputIdsByTurn.all(row.turn_id) as unknown as Array<{ input_id: string }>)
          .map(input => input.input_id),
      content: JSON.parse(row.content_json) as JsonValue,
    }));
    const cursor = selected.at(-1)?.sequence;
    return {
      entries,
      ...(cursor !== undefined
        ? { cursor: formatInteractionCursor(cursor) }
        : options.after !== undefined ? { cursor: options.after } : {}),
      hasMore,
    };
  }

  inputOutcome(inputId: string): RuntimeInputOutcome {
    const input = this.#database.prepare(`
      SELECT status FROM inputs WHERE id = ?
    `).get(inputId) as unknown as { status: RuntimeInputStatus["status"] } | undefined;
    if (!input) throw new Error(`Runtime Input ${inputId} does not exist`);
    if (input.status === "pending" || input.status === "active") return { state: "pending" };
    if (input.status === "blocked") return { state: "blocked", reason: "input_blocked" };

    const turn = this.#database.prepare(`
      SELECT turns.id, turns.status, turns.outcome, turns.error, turn_inputs.position
      FROM turn_inputs
      JOIN turns ON turns.id = turn_inputs.turn_id
      WHERE turn_inputs.input_id = ? AND turn_inputs.inclusion_status = 'included'
      ORDER BY turns.started_at DESC, turns.id DESC
      LIMIT 1
    `).get(inputId) as unknown as {
      id: string;
      status: RuntimeTurnStatus["status"];
      outcome: "completed" | "no_reply" | null;
      error: string | null;
      position: number;
    } | undefined;
    if (!turn || turn.status === "running") return { state: "pending" };
    if (turn.status !== "completed" || !turn.outcome) {
      return { state: "failed", reason: turn.error ?? `turn_${turn.status}` };
    }
    const effects = this.#database.prepare(`
      SELECT status FROM effects
      WHERE turn_id = ? AND input_position >= ?
    `).all(turn.id, turn.position) as unknown as Array<{ status: RuntimeEffectStatus["status"] }>;
    if (effects.some(effect => effect.status === "pending")) return { state: "pending" };
    if (effects.some(effect => effect.status === "reconciliation_required")) {
      return { state: "blocked", reason: "delivery_reconciliation_required" };
    }
    if (effects.some(effect => effect.status === "abandoned")) {
      return { state: "failed", reason: "effect_abandoned" };
    }
    return { state: "completed", outcome: turn.outcome };
  }

  status(): RuntimeStatus {
    return this.#statusReader.readStatus();
  }

  operationalStatus(options: { since?: string } = {}): RuntimeOperationalStatus {
    const since = options.since;
    if (since !== undefined && !isIsoTimestamp(since)) {
      throw new Error("Runtime operational status since must be a valid ISO timestamp");
    }
    const latestRows = this.#database.prepare(`
      SELECT id, agent_name, status, started_at, ended_at, outcome, failure_category
      FROM (
        SELECT agent_runs.*, rowid AS run_sequence,
               ROW_NUMBER() OVER (PARTITION BY agent_name ORDER BY started_at DESC, rowid DESC) AS rank
        FROM agent_runs
      )
      WHERE rank = 1
      ORDER BY agent_name
    `).all() as unknown as AgentRunRow[];
    const latestByAgent = new Map(latestRows.map(row => [row.agent_name, row]));
    const historyRows = since === undefined ? [] : this.#database.prepare(`
      SELECT id, agent_name, status, started_at, ended_at, outcome, failure_category
      FROM agent_runs
      WHERE ended_at IS NULL OR ended_at >= ?
      ORDER BY started_at, rowid
    `).all(since) as unknown as AgentRunRow[];
    return {
      agents: RUNTIME_AGENT_NAMES.map(name => {
        const latest = latestByAgent.get(name);
        const summary = latest ? agentRunSummary(latest) : undefined;
        const history = historyRows.filter(row => row.agent_name === name).map(agentRunSummary);
        const nextRunAt = summary && (summary.result === "failed" || summary.result === "interrupted")
          ? this.#agentRetryAt(name)
          : undefined;
        return {
          name,
          state: summary ? (nextRunAt ? "retrying" : agentState(summary)) : "never_run",
          ...(summary ? { latest: summary } : {}),
          ...(nextRunAt ? { nextRunAt } : {}),
          ...(since !== undefined ? { history } : {}),
        };
      }),
    };
  }

  frozenActivity(activityId: string): FrozenActivity | undefined {
    const row = this.#database.prepare(`
      SELECT frozen_activity_json FROM activities WHERE id = ?
    `).get(activityId) as unknown as { frozen_activity_json: string } | undefined;
    return row ? JSON.parse(row.frozen_activity_json) as FrozenActivity : undefined;
  }

  async #runOrientation(request: Parameters<Orientation["form"]>[0]): Promise<OrientationResult> {
    const agentRunId = this.#nextId();
    this.#startAgentRun(agentRunId, "orientation", this.#now());
    try {
      const result = await this.#orientation!.form(request);
      this.#finishAgentRun(agentRunId, "succeeded", result.outcome, this.#now());
      return result;
    } catch (error) {
      this.#finishAgentRun(
        agentRunId,
        "failed",
        undefined,
        this.#now(),
        agentFailureCategory(error),
      );
      throw error;
    }
  }

  /**
   * Claim one Cognitive Organ budget cycle for a domain entry point.
   * Returns the running attempt, or the retry_wait deadline when the previous
   * attempt is still backing off, or nothing when the organ is held (grace
   * window / intervention_required / blocked) — the entry point must not start.
   */
  #beginCognitiveOrganAttempt(
    organ: CognitiveOrganName,
    domainRef: string,
  ): { claim?: CognitiveOrganClaim; nextAttemptAt?: string } {
    const now = this.#now();
    const revisionId = this.#revisions?.current().id ?? "unpinned";
    const previous = this.#cognitiveOrgan.currentWork(organ);
    if (previous) {
      if (previous.status === "retry_wait") {
        // Retries continue the same immutable domain input only: a newer
        // domainRef must start a fresh budget cycle instead of consuming the
        // old work's retry quota and total deadline with different input.
        if (previous.domainRef === domainRef) {
          if (previous.nextAttemptAt && Date.parse(previous.nextAttemptAt) > now.getTime()) {
            return { nextAttemptAt: previous.nextAttemptAt };
          }
          const attempt = this.#cognitiveOrgan.beginNextAttempt(previous.id, revisionId);
          if (!attempt) return {};
          return { claim: { workId: previous.id, work: previous, attempt, agentRunId: attempt.id } };
        }
        // Different domain input: leave the old work in retry_wait and fall
        // through to start a fresh work cycle for the new input.
      } else if (previous.status === "running" || previous.status === "intervention_required"
        || previous.status === "blocked") {
        // A work requeued by an operator is created running but has no active
        // attempt: the organ entry point claims it through the normal path
        // (domain preconditions were checked before this call) and runs its
        // first attempt. Like retry_wait, the immutable domain input must
        // still be the current one: a requeued successor whose domainRef no
        // longer matches must not be executed against different input.
        if (previous.status === "running" && previous.requeuedFrom && !this.#activeCognitiveOrgan
          && previous.domainRef === domainRef) {
          const attempt = this.#cognitiveOrgan.attempts(previous.id)[0];
          if (attempt) {
            return { claim: { workId: previous.id, work: previous, attempt, agentRunId: attempt.id } };
          }
        }
        return {};
      }
    }
    const begun = this.#cognitiveOrgan.begin(organ, domainRef, revisionId);
    return {
      claim: {
        workId: begun.work.id,
        work: begun.work,
        attempt: begun.attempt,
        agentRunId: begun.attempt.id,
      },
    };
  }

  /**
   * Run one Cognitive Organ attempt inside a shared budget cycle. Fencing is
   * the ledger's: a late completion/failure against a cancelled or terminal
   * attempt is a no-op. The outcome is derived from the ledger work state, so
   * the domain entry point reacts to what actually happened.
   */
  async #runCognitiveOrgan<Result>(
    claim: CognitiveOrganClaim,
    options: {
      cancel: (reason: string) => Promise<void>;
      run: () => Promise<Result>;
      transcriptRef?: (result: Result) => string | undefined;
      resultRef?: (result: Result) => string | undefined;
    },
  ): Promise<CognitiveOrganRunOutcome<Result>> {
    let result: Result | undefined;
    const runPromise = (async () => {
      try {
        result = await options.run();
        const transcriptRef = options.transcriptRef?.(result);
        const resultRef = options.resultRef?.(result);
        this.#cognitiveOrgan.completeAttempt(claim.workId, {
          ...(transcriptRef ? { transcriptRef } : {}),
          ...(resultRef ? { resultRef } : {}),
        });
      } catch (error) {
        this.#cognitiveOrgan.failAttempt(claim.workId, {
          failureCategory: agentFailureCategory(error),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })();
    const active: ActiveCognitiveOrgan = {
      workId: claim.workId,
      attempt: claim.attempt,
      cancel: options.cancel,
      run: runPromise,
    };
    this.#activeCognitiveOrgan = active;
    const softDeadlineAt = Date.parse(claim.attempt.softDeadlineAt);
    const remaining = softDeadlineAt - this.#now().getTime();
    if (remaining > 0) {
      const timer = this.#organCancelTimer(remaining, () => this.#softDeadlineExpired(claim.workId));
      this.#organSoftDeadlineTimers.set(claim.workId, timer);
    }
    try {
      await runPromise;
    } catch {
      // The attempt is already failed in the ledger; outcome reflects its state.
    } finally {
      this.#organSoftDeadlineTimers.get(claim.workId)?.clear();
      this.#organSoftDeadlineTimers.delete(claim.workId);
      if (this.#activeCognitiveOrgan === active) this.#activeCognitiveOrgan = undefined;
    }
    // A cancel may be settling in parallel (same event loop tick): its
    // decision (cancelled vs intervention_required) must land before the
    // outcome is derived, or a released organ would read the work as still
    // running and report a spurious failure.
    if (this.#cancelSettling) await this.#cancelSettling;
    return this.#cognitiveOrganOutcome<Result>(claim.workId, result);
  }

  #cognitiveOrganOutcome<Result>(
    workId: string,
    result: Result | undefined,
  ): CognitiveOrganRunOutcome<Result> {
    const work = this.#cognitiveOrgan.work(workId);
    if (!work) {
      return {
        disposition: "failed",
        failureCategory: undefined,
        error: "Cognitive work record disappeared",
        nextAttemptAt: undefined,
        blocked: true,
      };
    }
    switch (work.status) {
      case "completed":
        return { disposition: "completed", result: result! };
      case "cancelled":
        return { disposition: "cancelled" };
      case "intervention_required":
        return { disposition: "intervention_required" };
      case "retry_wait":
        return {
          disposition: "failed",
          failureCategory: work.lastFailureCategory,
          error: work.lastError ?? "Attempt failed",
          nextAttemptAt: work.nextAttemptAt,
          blocked: false,
        };
      case "blocked":
        return {
          disposition: "failed",
          failureCategory: work.lastFailureCategory,
          error: work.lastError ?? "Attempts exhausted",
          nextAttemptAt: undefined,
          blocked: true,
        };
      case "running":
        return {
          disposition: "failed",
          failureCategory: undefined,
          error: "Attempt did not settle",
          nextAttemptAt: undefined,
          blocked: true,
        };
    }
  }

  /**
   * Cancel the active Cognitive Organ attempt and close the grace window:
   * released within the grace period -> cancelled terminal state; otherwise
   * persisted as intervention_required (blocks parallel starts until a human
   * handles it). The incoming foreground Input stays durable in the inputs
   * table either way.
   */
  async #cancelActiveCognitiveOrgan(reason: string): Promise<void> {
    const active = this.#activeCognitiveOrgan;
    if (!active) return;
    this.#cognitiveOrgan.cancel(active.workId, reason);
    // Deliver the cancel to the organ so it can release its work; the grace
    // race below still decides released vs intervention_required. A failing
    // domain cancel must not crash the input path — the grace window is the
    // backstop.
    void active.cancel(reason).catch(() => {});
    const settling = (async () => {
      const released = await new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (didRelease: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(didRelease);
        };
        const timeout = setTimeout(() => finish(false), this.#cognitiveOrganPolicy.cancelGraceMs);
        timeout.unref();
        void active.run.then(() => finish(true), () => finish(true));
      });
      if (released) {
        this.#cognitiveOrgan.finishCancelled(active.workId);
      } else {
        this.#cognitiveOrgan.markInterventionRequired(active.workId, `${reason}: cancel grace expired`);
      }
    })();
    this.#cancelSettling = settling;
    try {
      await settling;
    } finally {
      if (this.#cancelSettling === settling) this.#cancelSettling = undefined;
    }
  }

  /** Soft deadline expired: signal cancel only; the grace window decides the rest. */
  #softDeadlineExpired(workId: string): void {
    const active = this.#activeCognitiveOrgan;
    if (!active || active.workId !== workId) return;
    const work = this.#cognitiveOrgan.work(workId);
    if (!work || work.status !== "running") return;
    if (Date.parse(active.attempt.softDeadlineAt) > this.#now().getTime()) return;
    void this.#cancelActiveCognitiveOrgan("soft_deadline");
  }

  #hasHeldCognitiveOrganWork(): boolean {
    return this.#cognitiveOrgan.hasInterventionRequired();
  }

  /**
   * Manual recovery: create a successor budget cycle for a blocked or
   * intervention_required work. Only the ledger is touched; the successor is
   * executed by the organ's normal claim path on its next entry, so domain
   * preconditions (pending/FIFO/lease) still decide the work. Rejected when
   * the work is unknown, not recoverable, still has an active attempt, or its
   * domain input has already moved on (stale/superseded).
   */
  requeueCognitiveOrganWork(localId: string): RequeueCognitiveOrganWorkResult {
    if (!localId.trim()) throw new Error("Loom requeue-organ requires a work id");
    const work = this.#cognitiveOrgan.resolveLocalId(localId);
    if (!work) throw new Error(`Unknown cognitive organ work ${localId}`);
    if (this.#activeCognitiveOrgan) {
      throw new Error(
        `Cognitive organ work ${localId} has an active attempt; resolve the intervention before requeue`,
      );
    }
    this.#assertOrganRequeueEligible(work, localId);
    this.#cognitiveOrgan.requeue(work.id, this.#revisions?.current().id ?? "unpinned");
    return { disposition: "requeued" } as const;
  }

  /**
   * Requeue eligibility per organ: the work's immutable domain input must
   * still be what the organ's entry point will next act on. Requeuing against
   * moved-on input would create a successor that can never run — rejected
   * explicitly instead of creating work and waiting for the entry point to
   * discover it.
   */
  #assertOrganRequeueEligible(work: CognitiveWorkRecord, localId: string): void {
    switch (work.organ) {
      case "life-recorder": {
        // The recording domain is a single FIFO queue of unrecorded
        // activities; the successor will claim the first one.
        const pending = this.#database.prepare(`
          SELECT 1 FROM activities WHERE status <> 'recorded' LIMIT 1
        `).get();
        if (!pending) {
          throw new Error(
            `Cognitive organ work ${localId} is stale: no Activity awaits recording`,
          );
        }
        return;
      }
      case "attention-maintainer": {
        const schedule = this.#readAttentionSchedule();
        const windowEnd = schedule?.window_end_sequence ?? this.#latestActivitySequence();
        if (work.domainRef !== `window:${windowEnd}`) {
          throw new Error(
            `Cognitive organ work ${localId} is superseded by a newer attention window`,
          );
        }
        return;
      }
      case "memory-reflector": {
        const schedule = this.#readMemoryReflectionSchedule();
        if (!schedule || work.domainRef !== `day:${schedule.next_day}`) {
          throw new Error(
            `Cognitive organ work ${localId} is superseded by a newer reflection day`,
          );
        }
        return;
      }
      case "thread-maintainer": {
        const activitySegmentId = work.domainRef.startsWith("activity:")
          ? work.domainRef.slice("activity:".length)
          : "";
        if (!activitySegmentId) {
          throw new Error(`Cognitive organ work ${localId} has an invalid thread domain ref`);
        }
        const pending = this.#database.prepare(`
          SELECT 1
          FROM thread_maintenance
          JOIN activities ON activities.id = thread_maintenance.activity_id
          WHERE thread_maintenance.status <> 'completed'
            AND json_extract(activities.frozen_activity_json, '$.segmentId') = ?
          LIMIT 1
        `).get(activitySegmentId);
        if (!pending) {
          throw new Error(
            `Cognitive organ work ${localId} is superseded: thread maintenance is already completed`,
          );
        }
        return;
      }
    }
  }

  #agentRetryAt(name: RuntimeAgentName): string | undefined {
    if (name === "orientation") {
      const pulse = this.#readPulseSchedule();
      return pulse?.last_error ? pulse.next_pulse_after : undefined;
    }
    if (name === "attention-maintainer") {
      const attention = this.#readAttentionSchedule();
      return attention?.last_error ? attention.next_run_after : undefined;
    }
    if (name === "memory-reflector") {
      const reflection = this.#readMemoryReflectionSchedule();
      return reflection?.last_error ? reflection.next_run_after : undefined;
    }
    return undefined;
  }

  #startAgentRun(id: string, name: RuntimeAgentName, startedAt: Date): void {
    this.#database.prepare(`
      INSERT INTO agent_runs (id, agent_name, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(id, name, startedAt.toISOString());
  }

  #finishAgentRun(
    id: string,
    result: Exclude<RuntimeAgentRunSummary["result"], "running">,
    outcome: string | undefined,
    endedAt: Date,
    failureCategory?: string,
  ): void {
    this.#database.prepare(`
      UPDATE agent_runs
      SET status = ?, ended_at = ?, outcome = ?, failure_category = ?
      WHERE id = ? AND status = 'running'
    `).run(result, endedAt.toISOString(), outcome ?? null, failureCategory ?? null, id);
  }

  close(): void {
    this.#stopHeartbeat();
    this.#database.close();
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

  #cancelPendingAfterChat(cancelledAt: Date, reason: string): void {
    const continuation = this.#readAfterChatContinuation();
    if (continuation?.status !== "pending" && continuation?.status !== "admitted") return;
    let admittedInputId: string | undefined;
    let hasTurnEvidence = false;
    if (continuation.status === "admitted") {
      const running = continuation.input_id && this.#database.prepare(`
        SELECT 1 FROM inputs WHERE id = ? AND status = 'active'
      `).get(continuation.input_id);
      if (running) return;
      admittedInputId = continuation.input_id ?? undefined;
      hasTurnEvidence = Boolean(admittedInputId && this.#database.prepare(`
        SELECT 1 FROM turn_inputs WHERE input_id = ? LIMIT 1
      `).get(admittedInputId));
    }
    const changed = this.#database.prepare(`
      UPDATE after_chat_continuation
      SET status = 'cancelled', input_id = ?, ended_at = ?, reason = ?
      WHERE singleton = 1 AND id = ? AND status = ?
    `).run(
      hasTurnEvidence ? admittedInputId! : null,
      cancelledAt.toISOString(),
      reason,
      continuation.id,
      continuation.status,
    );
    if (changed.changes !== 1) return;
    if (admittedInputId) {
      if (hasTurnEvidence) {
        const blocked = this.#database.prepare(`
          UPDATE inputs SET status = 'blocked'
          WHERE id = ? AND status = 'pending'
        `).run(admittedInputId);
        if (blocked.changes !== 1) {
          throw new Error(`After-chat continuation ${continuation.id} lost admitted Input at cancellation`);
        }
        this.#recordTransition(
          "input",
          admittedInputId,
          "pending",
          "blocked",
          reason,
          cancelledAt,
          null,
        );
      } else {
        const removed = this.#database.prepare(`
          DELETE FROM inputs WHERE id = ? AND status = 'pending'
        `).run(admittedInputId);
        if (removed.changes !== 1) {
          throw new Error(`After-chat continuation ${continuation.id} lost unclaimed Input at cancellation`);
        }
      }
    }
    this.#recordTransition(
      "after_chat_continuation",
      continuation.id,
      continuation.status,
      "cancelled",
      reason,
      cancelledAt,
      null,
    );
  }

  #finishPendingAfterChat(
    continuation: AfterChatContinuationRow,
    status: "expired" | "cancelled",
    endedAt: Date,
    reason: string,
  ): void {
    const changed = this.#database.prepare(`
      UPDATE after_chat_continuation
      SET status = ?, ended_at = ?, reason = ?
      WHERE singleton = 1 AND id = ? AND status = 'pending'
    `).run(status, endedAt.toISOString(), reason, continuation.id);
    if (changed.changes !== 1) return;
    this.#recordTransition(
      "after_chat_continuation",
      continuation.id,
      "pending",
      status,
      reason,
      endedAt,
      null,
    );
  }

  #expireAfterChatContinuation(observedAt: Date): void {
    this.#transaction(() => {
      const continuation = this.#readAfterChatContinuation();
      if (!continuation
        || (continuation.status !== "pending" && continuation.status !== "admitted")
        || observedAt.getTime() < Date.parse(continuation.expires_at)) return;
      if (continuation.status === "admitted" && continuation.input_id) {
        const pendingInput = this.#database.prepare(`
          SELECT 1 FROM inputs WHERE id = ? AND status = 'pending'
        `).get(continuation.input_id);
        if (!pendingInput) return;
        const changed = this.#database.prepare(`
          UPDATE after_chat_continuation
          SET status = 'expired', ended_at = ?, reason = 'expired'
          WHERE singleton = 1 AND id = ? AND status = 'admitted'
        `).run(observedAt.toISOString(), continuation.id);
        if (changed.changes !== 1) return;
        const blocked = this.#database.prepare(`
          UPDATE inputs SET status = 'blocked' WHERE id = ? AND status = 'pending'
        `).run(continuation.input_id);
        if (blocked.changes !== 1) {
          throw new Error(`After-chat continuation ${continuation.id} lost admitted Input at expiry`);
        }
        this.#recordTransition(
          "input",
          continuation.input_id,
          "pending",
          "blocked",
          "expired",
          observedAt,
          null,
        );
        this.#recordTransition(
          "after_chat_continuation",
          continuation.id,
          "admitted",
          "expired",
          "expired",
          observedAt,
          null,
        );
        return;
      }
      if (continuation.status === "pending") {
        this.#finishPendingAfterChat(continuation, "expired", observedAt, "expired");
      }
    });
  }

  #readAttentionSchedule(): AttentionMaintenanceRow | undefined {
    return this.#database.prepare(`
      SELECT last_completed_at, next_run_after, cursor_sequence, window_end_sequence,
             attempt_count, last_result_json, last_error
      FROM attention_maintenance WHERE singleton = 1
    `).get() as unknown as AttentionMaintenanceRow | undefined;
  }

  #ensureAttentionSchedule(observedAt: Date, initialDelayMs: number): AttentionMaintenanceRow {
    const existing = this.#readAttentionSchedule();
    if (existing) return existing;
    const nextRunAfter = new Date(observedAt.getTime() + initialDelayMs).toISOString();
    this.#database.prepare(`
      INSERT INTO attention_maintenance (
        singleton, last_completed_at, next_run_after, cursor_sequence, window_end_sequence,
        attempt_count, last_result_json, last_error
      ) VALUES (1, NULL, ?, 0, NULL, 0, NULL, NULL)
    `).run(nextRunAfter);
    return this.#readAttentionSchedule()!;
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

  #isMaintenanceIdle(): boolean {
    return !this.#active
      && !this.#activeDeliveryId
      && !this.#closingActivityId
      && !this.#activeActivityAttemptId
      && !this.#activeThreadMaintenanceId
      && !this.#hasRunningTurn()
      && !this.#readActiveSegment()
      && !this.#hasPendingInput()
      && !this.#hasPendingDeliveryWork()
      && !this.#hasPendingActivityRecording()
      && !this.#hasPendingThreadMaintenance()
      && !this.#hasHeldCognitiveOrganWork();
  }

  #isCognitiveOrganIdle(): boolean {
    return !this.#active
      && !this.#activeDeliveryId
      && !this.#closingActivityId
      && !this.#activeActivityAttemptId
      && !this.#activeThreadMaintenanceId
      && !this.#attentionMaintenanceRunning
      && !this.#memoryReflectionRunning
      && !this.#hasRunningTurn()
      && !this.#hasPendingInput()
      && !this.#hasHeldCognitiveOrganWork();
  }

  #readMemoryReflectionSchedule(): MemoryReflectionRow | undefined {
    return this.#database.prepare(`
      SELECT next_day, next_run_after, attempt_count, last_completed_day,
             last_result_json, last_error
      FROM memory_reflection WHERE singleton = 1
    `).get() as unknown as MemoryReflectionRow | undefined;
  }

  #ensureMemoryReflectionSchedule(observedAt: Date, delayMs: number): MemoryReflectionRow {
    const existing = this.#readMemoryReflectionSchedule();
    if (existing) return existing;
    const nextDay = this.#timePolicy.recordingDay(observedAt);
    const nextRunAfter = this.#reflectionRunAt(nextDay, delayMs);
    this.#database.prepare(`
      INSERT INTO memory_reflection (
        singleton, next_day, next_run_after, attempt_count,
        last_completed_day, last_result_json, last_error
      ) VALUES (1, ?, ?, 0, NULL, NULL, NULL)
    `).run(nextDay, nextRunAfter);
    return this.#readMemoryReflectionSchedule()!;
  }

  #reflectionRunAt(reflectionDay: string, delayMs: number): string {
    return new Date(this.#timePolicy.logicalDayEnd(reflectionDay).getTime() + delayMs).toISOString();
  }

  #reflectionDayComplete(reflectionDay: string): boolean {
    const unsettledActivity = this.#database.prepare(`
      SELECT 1 FROM activities
      WHERE id IN (SELECT DISTINCT segment_id FROM turns WHERE recording_day = ?)
        AND status <> 'recorded'
      LIMIT 1
    `).get(reflectionDay);
    if (unsettledActivity) return false;
    const unsettledThread = this.#database.prepare(`
      SELECT 1 FROM thread_maintenance
      WHERE activity_id IN (SELECT DISTINCT segment_id FROM turns WHERE recording_day = ?)
        AND status <> 'completed'
      LIMIT 1
    `).get(reflectionDay);
    return !unsettledThread;
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

  #completeMemoryReflection(
    reflectionDay: string,
    nextDay: string,
    nextRunAt: string,
    result: MemoryReflectionResult | undefined,
  ): void {
    this.#database.prepare(`
      UPDATE memory_reflection
      SET next_day = ?, next_run_after = ?, attempt_count = 0,
          last_completed_day = ?, last_result_json = ?, last_error = NULL
      WHERE singleton = 1
    `).run(nextDay, nextRunAt, reflectionDay, result ? JSON.stringify(result) : null);
  }

  #ensurePulseSchedule(observedAt: Date, initialDelayMs: number): PulseRow {
    return this.#transaction(() => {
      const existing = this.#readPulseSchedule();
      if (existing) return existing;
      const nextPulseAfter = new Date(observedAt.getTime() + initialDelayMs).toISOString();
      this.#database.prepare(`
        INSERT INTO proactive_pulse (
          singleton, last_pulse_at, next_pulse_after, consecutive_failures, last_error
        ) VALUES (1, NULL, ?, 0, NULL)
      `).run(nextPulseAfter);
      this.#recordTransition(
        "proactive_pulse",
        "singleton",
        null,
        "scheduled",
        "initialized",
        observedAt,
        null,
      );
      return {
        last_pulse_at: null,
        next_pulse_after: nextPulseAfter,
        consecutive_failures: 0,
        last_error: null,
      };
    });
  }

  #completePulse(observedAt: Date, nextRunAt: string, reason: string): void {
    this.#transaction(() => this.#completePulseInTransaction(observedAt, nextRunAt, reason));
  }

  #completePulseInTransaction(observedAt: Date, nextRunAt: string, reason: string): void {
    const changed = this.#database.prepare(`
      UPDATE proactive_pulse
      SET last_pulse_at = ?, next_pulse_after = ?, consecutive_failures = 0, last_error = NULL
      WHERE singleton = 1
    `).run(observedAt.toISOString(), nextRunAt);
    if (changed.changes !== 1) throw new Error("Opportunity Pulse schedule is missing");
    this.#recordTransition(
      "proactive_pulse",
      "singleton",
      "due",
      "scheduled",
      reason,
      observedAt,
      null,
    );
  }

  #failPulse(observedAt: Date, nextRunAt: string, error: string): void {
    this.#transaction(() => {
      const changed = this.#database.prepare(`
        UPDATE proactive_pulse
        SET next_pulse_after = ?, consecutive_failures = consecutive_failures + 1,
            last_error = ?
        WHERE singleton = 1
      `).run(nextRunAt, error.slice(0, 2_000));
      if (changed.changes !== 1) throw new Error("Opportunity Pulse schedule is missing");
      this.#recordTransition(
        "proactive_pulse",
        "singleton",
        "due",
        "scheduled",
        "orientation_failed",
        observedAt,
        null,
      );
    });
  }

  #hasPendingInput(): boolean {
    return Boolean(this.#database.prepare("SELECT 1 FROM inputs WHERE status = 'pending' LIMIT 1").get());
  }

  #discardUnclaimedOpportunities(discardedAt: Date): void {
    const opportunities = this.#database.prepare(`
      SELECT id FROM inputs
      WHERE kind = 'opportunity' AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM turn_inputs WHERE turn_inputs.input_id = inputs.id)
    `).all() as unknown as Array<{ id: string }>;
    for (const opportunity of opportunities) {
      const removed = this.#database.prepare(`
        DELETE FROM inputs WHERE id = ? AND kind = 'opportunity' AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM turn_inputs WHERE turn_inputs.input_id = inputs.id)
      `).run(opportunity.id);
      if (removed.changes !== 1) continue;
      this.#recordTransition(
        "input",
        opportunity.id,
        "pending",
        "discarded",
        "human_input_precedes_opportunity",
        discardedAt,
        null,
      );
    }
  }

  #hasPendingActivityRecording(): boolean {
    return Boolean(this.#database.prepare(
      "SELECT 1 FROM activities WHERE status <> 'recorded' LIMIT 1",
    ).get());
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
          AND (
            interaction_json IS NULL
            OR json_extract(interaction_json, '$.actor.actorRef') = 'human'
          )
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

  #claimActivityClose(segmentId: string, closePolicy: CloseActivityOptions):
    | { request: ActivityFreezeRequest; fencingToken: number; disposition?: never }
    | { disposition: "not_due"; openedAt: string; lastActivityAt: string }
    | undefined {
    return this.#transaction(() => {
      if (this.#hasRunningTurn() || this.#hasPendingInput()
        || this.#readAfterChatContinuation()?.status === "pending") return undefined;
      const segment = this.#readActiveSegment();
      if (!segment || segment.id !== segmentId || segment.status !== "active") return undefined;
      const idleDue = closePolicy.inactiveBefore !== undefined
        && segment.last_activity_at <= closePolicy.inactiveBefore;
      const ageDue = closePolicy.openedBefore !== undefined
        && segment.opened_at <= closePolicy.openedBefore;
      if ((closePolicy.inactiveBefore !== undefined || closePolicy.openedBefore !== undefined)
        && !idleDue && !ageDue) {
        return {
          disposition: "not_due",
          openedAt: segment.opened_at,
          lastActivityAt: segment.last_activity_at,
        };
      }
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
      SELECT DISTINCT inputs.id, inputs.kind, inputs.payload_json, inputs.interaction_json,
             inputs.occurred_at
      FROM inputs
      JOIN turn_inputs ON turn_inputs.input_id = inputs.id
      JOIN turns ON turns.id = turn_inputs.turn_id
      WHERE turns.segment_id = ? AND turn_inputs.inclusion_status = 'included'
      ORDER BY inputs.occurred_at, inputs.id
    `).all(segment.id) as unknown as Array<{
      id: string;
      kind: InputKind;
      payload_json: string;
      interaction_json: string | null;
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
             effects.destination_ref,
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
      SELECT delivery_attempts.id, delivery_attempts.effect_id, effects.turn_id,
             delivery_attempts.attempt_number,
             delivery_attempts.status, delivery_attempts.started_at, delivery_attempts.ended_at,
             delivery_attempts.remote_id, delivery_attempts.error
      FROM delivery_attempts
      JOIN effects ON effects.id = delivery_attempts.effect_id
      WHERE delivery_attempts.segment_id = ?
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
        ...(row.interaction_json
          ? { interaction: JSON.parse(row.interaction_json) as NonNullable<ActivityFreezeRequest["inputs"][number]["interaction"]> }
          : {}),
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
        ...(row.destination_ref ? { destinationRef: row.destination_ref } : {}),
        createdAt: row.created_at,
        ...(row.ended_at ? { endedAt: row.ended_at } : {}),
        status: row.status,
      })),
      deliveries: deliveryRows.map(row => ({
        id: row.id,
        effectId: row.effect_id,
        turnId: row.turn_id,
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
      const observations = this.#threadMaintenance?.observationsFor(activity) ?? [];
      if (observations.some(observation => observation.relation === "changed")) {
        this.#database.prepare(`
          INSERT INTO thread_maintenance (
            activity_id, observations_json, status, created_at
          ) VALUES (?, ?, 'pending', ?)
        `).run(activity.segmentId, JSON.stringify(observations), now.toISOString());
        this.#recordTransition(
          "thread_maintenance",
          activity.segmentId,
          null,
          "pending",
          "thread_change_observed",
          now,
          fencingToken,
        );
      }
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

  #readRunningTurn(): { id: string } | undefined {
    return this.#database.prepare(`
      SELECT id FROM turns WHERE status = 'running' LIMIT 1
    `).get() as unknown as { id: string } | undefined;
  }

  #readPendingInputId(): string | undefined {
    const row = this.#database.prepare(`
      SELECT id FROM inputs WHERE status = 'pending' ORDER BY accepted_at, id LIMIT 1
    `).get() as unknown as { id: string } | undefined;
    return row?.id;
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
        this.#finishAgentRun(turn.id, "interrupted", "lease_expired", now, "runtime_interrupted");
        this.#recordTransition("turn", turn.id, "running", "interrupted", "lease_expired", now, turn.fencing_token);
        this.#settleInputsAfterStoppedTurn(turn.id, "interrupted", now, turn.fencing_token);
        this.#settleAfterChatContinuationFromStoppedTurn(turn.id, now, turn.fencing_token);
      }
    });
  }

  #reconcileOrphanedAgentRuns(): void {
    this.#transaction(() => {
      const now = this.#now();
      this.#database.prepare(`
        UPDATE agent_runs
        SET status = 'interrupted', ended_at = ?, outcome = 'process_restarted',
            failure_category = 'runtime_interrupted'
        WHERE status = 'running'
          AND (
            agent_name IN ('orientation', 'attention-maintainer', 'memory-reflector')
            OR (agent_name = 'main-agent' AND id NOT IN (
              SELECT id FROM turns WHERE status = 'running'
            ))
            OR (agent_name = 'life-recorder' AND id NOT IN (
              SELECT id FROM activity_attempts WHERE status = 'recording'
            ))
            OR (agent_name = 'thread-maintainer' AND NOT EXISTS (
              SELECT 1 FROM thread_maintenance WHERE status = 'running'
            ))
          )
      `).run(now.toISOString());
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
        SELECT activities.id, activities.attempt_count, activities.fencing_token,
               activity_attempts.id AS attempt_id
        FROM activities
        JOIN activity_attempts
          ON activity_attempts.activity_id = activities.id
         AND activity_attempts.attempt_number = activities.attempt_count
        WHERE activities.status = 'recording' AND activities.lease_expires_at <= ?
        ORDER BY activities.sequence
      `).all(now.toISOString()) as unknown as Array<{
        id: string;
        attempt_id: string;
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
        this.#finishAgentRun(
          activity.attempt_id,
          "interrupted",
          "lease_expired",
          now,
          "runtime_interrupted",
        );
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

  #reconcileExpiredThreadMaintenance(): void {
    if (!this.#threadMaintenance) return;
    this.#transaction(() => {
      const now = this.#now();
      const expired = this.#database.prepare(`
        SELECT activity_id, fencing_token,
               (SELECT id FROM agent_runs
                WHERE agent_name = 'thread-maintainer' AND status = 'running'
                ORDER BY started_at DESC, id DESC LIMIT 1) AS agent_run_id
        FROM thread_maintenance
        WHERE status = 'running' AND lease_expires_at <= ?
        ORDER BY created_at, activity_id
      `).all(now.toISOString()) as unknown as Array<{
        activity_id: string;
        agent_run_id: string;
        fencing_token: number;
      }>;
      for (const maintenance of expired) {
        this.#database.prepare(`
          UPDATE thread_maintenance
          SET status = 'pending', lease_owner = NULL, fencing_token = NULL,
              lease_expires_at = NULL, last_error = 'maintenance lease expired'
          WHERE activity_id = ? AND status = 'running' AND fencing_token = ?
        `).run(maintenance.activity_id, maintenance.fencing_token);
        this.#finishAgentRun(
          maintenance.agent_run_id,
          "interrupted",
          "lease_expired",
          now,
          "runtime_interrupted",
        );
        this.#recordTransition(
          "thread_maintenance",
          maintenance.activity_id,
          "running",
          "pending",
          "maintenance_lease_expired",
          now,
          maintenance.fencing_token,
        );
      }
    });
  }

  async #advanceThreadMaintenance(): Promise<AdvanceResult> {
    if (!this.#threadMaintenance) return { disposition: "idle" };
    const pending = this.#queryPendingThreadMaintenance();
    if (!pending) {
      const unfinished = this.#database.prepare(`
        SELECT 1 FROM thread_maintenance WHERE status <> 'completed' LIMIT 1
      `).get();
      return unfinished ? { disposition: "busy" } : { disposition: "idle" };
    }
    const begun = this.#beginCognitiveOrganAttempt(
      "thread-maintainer",
      `activity:${pending.activity.segmentId}`,
    );
    if (!begun.claim) return { disposition: "busy" };
    const claim = begun.claim;
    const claimed = this.#claimPendingThreadMaintenance(claim.agentRunId);
    if (!claimed) {
      // Domain claim lost to a concurrent path (should not happen under the
      // single-writer gate): close the budget cycle as interrupted.
      this.#cognitiveOrgan.failAttempt(claim.workId, {
        failureCategory: "interrupted",
        error: "Thread maintenance domain claim lost",
      });
      return { disposition: "busy" };
    }
    this.#activeThreadMaintenanceId = claimed.activity.segmentId;
    this.#startHeartbeat("thread_maintenance", claimed.activity.segmentId, claimed.fencingToken);
    try {
      const observedAt = this.#now();
      const outcome = await this.#runCognitiveOrgan(claim, {
        cancel: reason => this.#threadMaintenance!.cancel?.(reason) ?? Promise.resolve(),
        run: () => this.#threadMaintenance!.maintain({
          observedAt: observedAt.toISOString(),
          localTime: this.#timePolicy.formatLocalTime(observedAt),
          activity: claimed.activity,
          observations: claimed.observations,
        }),
        transcriptRef: result => organTranscriptRef("thread-maintainer", result.runId),
        resultRef: result => result.changedPaths[0],
      });
      switch (outcome.disposition) {
        case "completed":
          this.#finishThreadMaintenance(claimed, outcome.result);
          return { disposition: "thread_maintenance_completed" };
        case "cancelled":
          this.#releaseThreadMaintenance(claimed, "cancelled");
          return { disposition: "busy" };
        case "intervention_required":
          // Domain lease is left running; a human must resolve the held work.
          this.#finishAgentRun(claimed.agentRunId, "interrupted", "intervention_required", this.#now(), "cancelled");
          return { disposition: "busy" };
        case "failed":
          this.#failThreadMaintenance(claimed, new Error(outcome.error));
          return { disposition: "thread_maintenance_failed" };
        default:
          throw new Error("Unexpected Cognitive Organ outcome");
      }
    } finally {
      this.#stopHeartbeat();
      if (this.#activeThreadMaintenanceId === claimed.activity.segmentId) {
        this.#activeThreadMaintenanceId = undefined;
      }
    }
  }

  #queryPendingThreadMaintenance(): {
    activity: FrozenActivity;
  } | undefined {
    const next = this.#database.prepare(`
      SELECT thread_maintenance.activity_id, activities.frozen_activity_json
      FROM thread_maintenance
      JOIN activities ON activities.id = thread_maintenance.activity_id
      WHERE thread_maintenance.status = 'pending' AND activities.status = 'recorded'
      ORDER BY thread_maintenance.created_at, thread_maintenance.activity_id
      LIMIT 1
    `).get() as unknown as {
      activity_id: string;
      frozen_activity_json: string;
    } | undefined;
    if (!next) return undefined;
    return { activity: JSON.parse(next.frozen_activity_json) as FrozenActivity };
  }

  /** Release a cancelled maintenance back to pending without recording a failure. */
  #releaseThreadMaintenance(
    claimed: { activity: FrozenActivity; agentRunId: string; attemptNumber: number; fencingToken: number },
    reason: string,
  ): void {
    this.#transaction(() => {
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE thread_maintenance
        SET status = 'pending', lease_owner = NULL, fencing_token = NULL,
            lease_expires_at = NULL, last_error = NULL
        WHERE activity_id = ? AND status = 'running' AND attempt_count = ?
          AND fencing_token = ? AND lease_owner = ?
      `).run(
        claimed.activity.segmentId,
        claimed.attemptNumber,
        claimed.fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) return;
      this.#finishAgentRun(claimed.agentRunId, "interrupted", reason, now, "cancelled");
      this.#recordTransition(
        "thread_maintenance",
        claimed.activity.segmentId,
        "running",
        "pending",
        `maintenance_${reason}`,
        now,
        claimed.fencingToken,
      );
    });
  }

  #claimPendingThreadMaintenance(agentRunId: string): {
    activity: FrozenActivity;
    observations: ThreadActivityObservation[];
    agentRunId: string;
    attemptNumber: number;
    fencingToken: number;
  } | undefined {
    return this.#transaction(() => {
      const next = this.#database.prepare(`
        SELECT thread_maintenance.activity_id, thread_maintenance.observations_json,
               thread_maintenance.attempt_count, activities.frozen_activity_json
        FROM thread_maintenance
        JOIN activities ON activities.id = thread_maintenance.activity_id
        WHERE thread_maintenance.status = 'pending' AND activities.status = 'recorded'
        ORDER BY thread_maintenance.created_at, thread_maintenance.activity_id
        LIMIT 1
      `).get() as unknown as {
        activity_id: string;
        observations_json: string;
        attempt_count: number;
        frozen_activity_json: string;
      } | undefined;
      if (!next) return undefined;
      const token = this.#database.prepare(`
        UPDATE runtime_counters SET value = value + 1
        WHERE name = 'fencing_token'
        RETURNING value
      `).get() as unknown as { value: number };
      const now = this.#now();
      const attemptNumber = next.attempt_count + 1;
      const changed = this.#database.prepare(`
        UPDATE thread_maintenance
        SET status = 'running', attempt_count = ?, lease_owner = ?, fencing_token = ?,
            lease_expires_at = ?
        WHERE activity_id = ? AND status = 'pending' AND attempt_count = ?
      `).run(
        attemptNumber,
        this.#ownerId,
        token.value,
        new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        next.activity_id,
        next.attempt_count,
      );
      if (changed.changes !== 1) return undefined;
      this.#startAgentRun(agentRunId, "thread-maintainer", now);
      this.#recordTransition(
        "thread_maintenance",
        next.activity_id,
        "pending",
        "running",
        "maintenance_claimed",
        now,
        token.value,
      );
      return {
        activity: JSON.parse(next.frozen_activity_json) as FrozenActivity,
        observations: JSON.parse(next.observations_json) as ThreadActivityObservation[],
        agentRunId,
        attemptNumber,
        fencingToken: token.value,
      };
    });
  }

  #finishThreadMaintenance(
    claimed: { activity: FrozenActivity; agentRunId: string; attemptNumber: number; fencingToken: number },
    result: ThreadMaintenanceResult,
  ): void {
    this.#transaction(() => {
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE thread_maintenance
        SET status = 'completed', lease_owner = NULL, fencing_token = NULL,
            lease_expires_at = NULL, result_json = ?, last_error = NULL, completed_at = ?
        WHERE activity_id = ? AND status = 'running' AND attempt_count = ?
          AND fencing_token = ? AND lease_owner = ?
      `).run(
        JSON.stringify(result),
        now.toISOString(),
        claimed.activity.segmentId,
        claimed.attemptNumber,
        claimed.fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) {
        throw new Error(`Thread maintenance ${claimed.activity.segmentId} no longer accepts completion`);
      }
      this.#finishAgentRun(claimed.agentRunId, "succeeded", result.outcome, now);
      this.#recordTransition(
        "thread_maintenance",
        claimed.activity.segmentId,
        "running",
        "completed",
        result.outcome,
        now,
        claimed.fencingToken,
      );
    });
  }

  #failThreadMaintenance(
    claimed: { activity: FrozenActivity; agentRunId: string; attemptNumber: number; fencingToken: number },
    error: unknown,
  ): void {
    this.#transaction(() => {
      const now = this.#now();
      const detail = error instanceof Error ? error.message : String(error);
      const changed = this.#database.prepare(`
        UPDATE thread_maintenance
        SET status = 'pending', lease_owner = NULL, fencing_token = NULL,
            lease_expires_at = NULL, last_error = ?
        WHERE activity_id = ? AND status = 'running' AND attempt_count = ?
          AND fencing_token = ? AND lease_owner = ?
      `).run(
        detail,
        claimed.activity.segmentId,
        claimed.attemptNumber,
        claimed.fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) return;
      this.#finishAgentRun(
        claimed.agentRunId,
        "failed",
        undefined,
        now,
        agentFailureCategory(error),
      );
      this.#recordTransition(
        "thread_maintenance",
        claimed.activity.segmentId,
        "running",
        "pending",
        `maintenance_failed:${detail}`,
        now,
        claimed.fencingToken,
      );
    });
  }

  #hasPendingThreadMaintenance(): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 FROM thread_maintenance
      WHERE status <> 'completed'
      LIMIT 1
    `).get());
  }

  async #advanceActivityRecording(): Promise<AdvanceResult> {
    if (!this.#activityRecorder) return { disposition: "idle" };
    const pending = this.#database.prepare(`
      SELECT 1 FROM activities WHERE status = 'pending' LIMIT 1
    `).get();
    if (!pending) {
      const unfinished = this.#database.prepare(`
        SELECT 1 FROM activities WHERE status <> 'recorded' LIMIT 1
      `).get();
      return unfinished ? { disposition: "busy" } : { disposition: "idle" };
    }
    const begun = this.#beginCognitiveOrganAttempt("life-recorder", "recording");
    if (!begun.claim) return { disposition: "busy" };
    const claim = begun.claim;
    const claimed = this.#claimPendingActivity(claim.agentRunId);
    if (!claimed) {
      // Domain claim lost to a concurrent path (should not happen under the
      // single-writer gate): close the budget cycle as interrupted.
      this.#cognitiveOrgan.failAttempt(claim.workId, {
        failureCategory: "interrupted",
        error: "Activity recording domain claim lost",
      });
      return { disposition: "busy" };
    }
    this.#activeActivityAttemptId = claimed.attemptId;
    this.#startHeartbeat("activity_recording", claimed.activity.segmentId, claimed.fencingToken);
    try {
      const outcome = await this.#runCognitiveOrgan(claim, {
        cancel: reason => this.#activityRecorder!.cancel?.(reason) ?? Promise.resolve(),
        run: async () => {
          const receipt = await this.#activityRecorder!.record(claimed.activity);
          if (receipt.segmentId !== claimed.activity.segmentId) {
            throw new Error(`Recorder receipt belongs to ${receipt.segmentId}, not ${claimed.activity.segmentId}`);
          }
          return receipt;
        },
        transcriptRef: receipt => organTranscriptRef("life-recorder", receipt.runId),
        resultRef: receipt => receipt.daily.path,
      });
      switch (outcome.disposition) {
        case "completed":
          this.#finishActivityRecording(claimed, outcome.result);
          return { disposition: "activity_recorded" };
        case "cancelled":
          this.#releaseActivityRecording(claimed, "cancelled");
          return { disposition: "busy" };
        case "intervention_required":
          // Domain lease is left running; a human must resolve the held work.
          this.#finishAgentRun(claimed.attemptId, "interrupted", "intervention_required", this.#now(), "cancelled");
          return { disposition: "busy" };
        case "failed":
          this.#failActivityRecording(claimed, new Error(outcome.error));
          return { disposition: "activity_recording_failed" };
        default:
          throw new Error("Unexpected Cognitive Organ outcome");
      }
    } finally {
      this.#stopHeartbeat();
      if (this.#activeActivityAttemptId === claimed.attemptId) this.#activeActivityAttemptId = undefined;
    }
  }

  /** Release a cancelled recording back to pending without recording a failure. */
  #releaseActivityRecording(
    claimed: { activity: FrozenActivity; attemptId: string; attemptNumber: number; fencingToken: number },
    reason: string,
  ): void {
    this.#transaction(() => {
      const now = this.#now();
      const changed = this.#database.prepare(`
        UPDATE activities
        SET status = 'pending', lease_owner = NULL, fencing_token = NULL,
            lease_expires_at = NULL, last_error = NULL
        WHERE id = ? AND status = 'recording' AND attempt_count = ?
          AND fencing_token = ? AND lease_owner = ?
      `).run(
        claimed.activity.segmentId,
        claimed.attemptNumber,
        claimed.fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) return;
      // The domain attempt terminal state is 'interrupted'; the cancelled
      // outcome itself lives in the shared Cognitive Organ ledger.
      this.#database.prepare(`
        UPDATE activity_attempts
        SET status = 'interrupted', ended_at = ?
        WHERE id = ? AND status = 'recording' AND fencing_token = ?
      `).run(now.toISOString(), claimed.attemptId, claimed.fencingToken);
      this.#finishAgentRun(claimed.attemptId, "interrupted", reason, now, "cancelled");
      this.#recordTransition(
        "activity",
        claimed.activity.segmentId,
        "recording",
        "pending",
        `recording_${reason}`,
        now,
        claimed.fencingToken,
      );
    });
  }

  #claimPendingActivity(agentRunId: string): {
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
      const attemptId = agentRunId;
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
      this.#startAgentRun(attemptId, "life-recorder", now);
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
      this.#finishAgentRun(claimed.attemptId, "succeeded", "recorded", now);
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
      this.#finishAgentRun(
        claimed.attemptId,
        "failed",
        undefined,
        now,
        agentFailureCategory(error),
      );
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
    interactionWaveId?: string;
    interactionScopeKey?: string;
    executionState?: JsonValue;
  } | undefined {
    return this.#transaction(() => {
      if (this.#hasRunningTurn()) return undefined;
      const existingSegment = this.#readActiveSegment();
      if (existingSegment?.status === "closing") return undefined;
      const input = this.#database.prepare(`
        SELECT id, kind, payload_json, interaction_json, interaction_wave_id, occurred_at, late_arriving
        FROM inputs
        WHERE status = 'pending'
        ORDER BY accepted_at, id
        LIMIT 1
      `).get() as unknown as Pick<InputRow,
        "id" | "kind" | "payload_json" | "interaction_json" | "interaction_wave_id" | "occurred_at" | "late_arriving"
      > | undefined;
      if (!input) return undefined;

      const now = this.#now();
      const recordingDay = this.#timePolicy.recordingDay(now);
      const segmentId = existingSegment?.id ?? this.#nextId();
      if (!existingSegment) {
        const startingState = this.#readExecutionState().executionState;
        this.#database.prepare(`
          INSERT INTO active_segment (
            singleton, id, opened_at, last_activity_at, starting_state_json, status
          ) VALUES (1, ?, ?, ?, ?, 'active')
        `).run(
          segmentId,
          now.toISOString(),
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
      const interactionScopeKey = input.interaction_wave_id
        ? (this.#database.prepare(`
            SELECT scope_key FROM interaction_waves WHERE id = ?
          `).get(input.interaction_wave_id) as unknown as { scope_key: string } | undefined)?.scope_key
        : undefined;
      const turnId = this.#nextId();
      this.#database.prepare(`
        INSERT INTO turns (
          id, segment_id, status, lease_owner, fencing_token, lease_expires_at, started_at,
          recording_day, interaction_scope_key
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)
      `).run(
        turnId,
        segmentId,
        this.#ownerId,
        tokenRow.value,
        new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        now.toISOString(),
        recordingDay,
        interactionScopeKey ?? null,
      );
      this.#startAgentRun(turnId, "main-agent", now);
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
          ...(input.interaction_json
            ? { interaction: JSON.parse(input.interaction_json) as NonNullable<ExecutionInput["interaction"]> }
            : {}),
          occurredAt: input.occurred_at,
          inclusionPosition: 1,
          ...(input.late_arriving === 1 ? { lateArriving: true } : {}),
        },
        ...(input.interaction_wave_id ? { interactionWaveId: input.interaction_wave_id } : {}),
        ...(interactionScopeKey ? { interactionScopeKey } : {}),
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
      const quietContinuation = this.#turnBeginsWithContinuation(turnId);
      if (!quietContinuation) this.#touchSegmentForTurn(turnId, now);
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
      this.#finishAgentRun(turnId, "succeeded", result.outcome, now);
      for (const input of activeInputs) {
        this.#recordTransition("input", input.id, "active", "consumed", "turn_completed", now, fencingToken);
      }
      if (quietContinuation) this.#completeAfterChatContinuation(turnId, now, fencingToken);
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
      this.#finishAgentRun(turnId, "failed", undefined, now, agentFailureCategory(error));
      if (!this.#turnBeginsWithContinuation(turnId)) this.#touchSegmentForTurn(turnId, now);
      this.#recordTransition("turn", turnId, "running", "failed", "execution_failed", now, fencingToken);
      this.#settleInputsAfterStoppedTurn(turnId, "failed", now, fencingToken);
      this.#settleAfterChatContinuationFromStoppedTurn(turnId, now, fencingToken);
    });
  }

  async #commitInteractionDecision(
    turnId: string,
    fencingToken: number,
    decision: InteractionDecisionRequest,
  ): Promise<InteractionDecisionReceipt> {
    let observedAt = this.#now().getTime();
    while (true) {
      observedAt = Math.max(observedAt, this.#now().getTime());
      const waitUntil = this.#transaction(() => {
        // Wait for every Interaction wave already folded into this Turn to
        // seal, not just the first one: a later same-scope wave steered in
        // while the reply gate is open must still get its short batching
        // window before the first send/no_reply commit.
        const openWaves = this.#database.prepare(`
          SELECT DISTINCT interaction_waves.id, interaction_waves.quiet_seal_at,
                 interaction_waves.max_seal_at
          FROM turn_inputs
          JOIN inputs ON inputs.id = turn_inputs.input_id
          JOIN interaction_waves ON interaction_waves.id = inputs.interaction_wave_id
          WHERE turn_inputs.turn_id = ? AND interaction_waves.status = 'open'
        `).all(turnId) as unknown as Array<{
          id: string;
          quiet_seal_at: string;
          max_seal_at: string;
        }>;
        if (openWaves.length === 0) return undefined;
        const dueAt = Math.min(...openWaves.map(wave =>
          Math.min(Date.parse(wave.quiet_seal_at), Date.parse(wave.max_seal_at))));
        if (observedAt < dueAt) return dueAt;
        // Seal every wave whose own deadline has arrived, then keep looping
        // until no open wave of this Turn remains: a later wave with a later
        // deadline must still be waited for before the commit proceeds.
        let nextDueAt: number | undefined;
        for (const wave of openWaves) {
          const waveDueAt = Math.min(Date.parse(wave.quiet_seal_at), Date.parse(wave.max_seal_at));
          if (observedAt >= waveDueAt) {
            this.#sealInteractionWave(wave.id, new Date(observedAt));
          } else {
            nextDueAt = nextDueAt === undefined ? waveDueAt : Math.min(nextDueAt, waveDueAt);
          }
        }
        return nextDueAt;
      });
      if (waitUntil === undefined) break;
      await delay(Math.max(0, waitUntil - observedAt));
      observedAt = waitUntil;
    }

    const active = this.#active;
    if (active?.turnId === turnId) await active.steeringTail;

    return this.#transaction(() => {
      const turn = this.#database.prepare(`
        SELECT id, interaction_scope_key, reply_gate_closed_at FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(turnId, fencingToken, this.#ownerId) as unknown as {
        id: string;
        interaction_scope_key: string | null;
        reply_gate_closed_at: string | null;
      } | undefined;
      if (!turn) {
        throw new Error(`Turn ${turnId} no longer accepts an interaction decision from lease ${fencingToken}`);
      }
      // Every wave folded into this Turn must be sealed and fully included
      // before the first reply may be committed; a later same-scope wave is
      // not exempt just because an earlier wave already sealed.
      const waves = this.#database.prepare(`
        SELECT DISTINCT interaction_waves.id, interaction_waves.status
        FROM turn_inputs
        JOIN inputs ON inputs.id = turn_inputs.input_id
        JOIN interaction_waves ON interaction_waves.id = inputs.interaction_wave_id
        WHERE turn_inputs.turn_id = ?
      `).all(turnId) as unknown as Array<{ id: string; status: "open" | "sealed" }>;
      for (const wave of waves) {
        if (wave.status !== "sealed") throw new Error("Interaction wave is not sealed");
        const coverage = this.#database.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE
              WHEN inputs.status = 'consumed' OR EXISTS (
                SELECT 1
                FROM turn_inputs
                WHERE turn_inputs.input_id = inputs.id
                  AND turn_inputs.turn_id = ?
                  AND turn_inputs.inclusion_status = 'included'
              ) THEN 1
              ELSE 0
            END) AS included
          FROM inputs
          WHERE inputs.interaction_wave_id = ?
        `).get(turnId, wave.id) as unknown as { total: number; included: number };
        if (coverage.included !== coverage.total) {
          throw new Error("Interaction wave has newer Inputs; review them before replying");
        }
      }
      // Reply gate coverage: every Interaction of this scope accepted while
      // the gate was open must be included in the Turn before the first
      // reply may be committed. A later commit (after_send=continue) re-checks
      // the same window with the closed boundary, so post-commit arrivals are
      // never demanded from a running Turn.
      if (turn.interaction_scope_key !== null) {
        const boundary = turn.reply_gate_closed_at ?? this.#now().toISOString();
        // Coverage is judged by this Turn's own rows only. An Input whose rows
        // live in an earlier failed or interrupted Turn is requeued and gets a
        // fresh row here when re-claimed, so rows in other Turns must not
        // exclude it from the count (they belong to the requeue path, not to
        // another live Turn: claims are serialized).
        const scopeCoverage = this.#database.prepare(`
          SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE
              WHEN i.status = 'consumed' OR EXISTS (
                SELECT 1
                FROM turn_inputs
                WHERE turn_inputs.input_id = i.id
                  AND turn_inputs.turn_id = ?
                  AND turn_inputs.inclusion_status = 'included'
              ) THEN 1
              ELSE 0
            END), 0) AS included
          FROM inputs i
          JOIN interaction_waves w ON w.id = i.interaction_wave_id
          WHERE i.kind = 'interaction' AND i.status IN ('pending', 'active')
            AND w.scope_key = ?
            AND i.accepted_at <= ?
        `).get(turnId, turn.interaction_scope_key, boundary) as unknown as {
          total: number;
          included: number;
        };
        if (scopeCoverage.included !== scopeCoverage.total) {
          throw new Error("Interaction scope has newer Inputs; review them before replying");
        }
      }
      // Atomically close the reply gate: the first committed reply (send or
      // no_reply) fixes the boundary. Anything arriving after this point
      // belongs to the next Turn.
      if (turn.interaction_scope_key !== null && turn.reply_gate_closed_at === null) {
        this.#database.prepare(`
          UPDATE turns SET reply_gate_closed_at = ?
          WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
            AND reply_gate_closed_at IS NULL
        `).run(this.#now().toISOString(), turnId, fencingToken, this.#ownerId);
      }
      if (decision.outcome === "no_reply") return { outcome: "no_reply" };
      return {
        outcome: "send",
        effect: this.#prepareEffectInTransaction(turnId, fencingToken, decision.effect),
      };
    });
  }

  #prepareEffect(turnId: string, fencingToken: number, effect: EffectRequest): EffectReceipt {
    if (!effect.kind) throw new Error("Effect requires a kind");
    return this.#transaction(() => this.#prepareEffectInTransaction(turnId, fencingToken, effect));
  }

  #prepareEffectInTransaction(
    turnId: string,
    fencingToken: number,
    effect: EffectRequest,
  ): EffectReceipt {
    if (!effect.kind) throw new Error("Effect requires a kind");
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
        id, turn_id, kind, payload_json, route_ref, destination_ref,
        input_position, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      effectId,
      turnId,
      effect.kind,
      JSON.stringify(effect.payload),
      effect.routeRef ?? null,
      effect.destinationRef ?? null,
      position.position,
      now.toISOString(),
    );
    this.#touchSegmentForTurn(turnId, now);
    this.#recordTransition("effect", effectId, null, "pending", "accepted", now, fencingToken);
    return { effectId };
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
      this.#touchSegmentForTurn(turnId, now);
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

      const inputKind = this.#database.prepare(`
        SELECT kind FROM inputs WHERE id = ? AND status = 'pending'
      `).get(inputId) as unknown as { kind: InputKind } | undefined;
      const input = this.#database.prepare(`
        UPDATE inputs SET status = 'active', active_turn_id = ?
        WHERE id = ? AND status = 'pending'
      `).run(turnId, inputId);
      if (input.changes !== 1) throw new Error(`Input ${inputId} could not join Turn ${turnId}`);
      if (inputKind?.kind !== "continuation") this.#touchSegmentForTurn(turnId, now);
      this.#recordTransition("input", inputId, "pending", "active", "execution_included", now, fencingToken);
    });
  }

  #claimPendingDelivery(observedAt: Date): { request: DeliveryAttemptRequest; fencingToken: number } | undefined {
    return this.#transaction(() => {
      const effect = this.#database.prepare(`
        SELECT effects.id, effects.kind, effects.payload_json, effects.route_ref,
               effects.destination_ref, turns.segment_id
        FROM effects
        JOIN turns ON turns.id = effects.turn_id
        WHERE effects.status = 'pending' AND effects.route_ref IS NOT NULL
          AND (effects.next_delivery_after IS NULL OR effects.next_delivery_after <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM delivery_attempts
            WHERE delivery_attempts.effect_id = effects.id
              AND delivery_attempts.status = 'dispatching'
          )
        ORDER BY effects.created_at, effects.id
        LIMIT 1
      `).get(observedAt.toISOString()) as unknown as Pick<
        EffectRow,
        "id" | "kind" | "payload_json" | "route_ref" | "destination_ref"
      > & { segment_id: string } | undefined;
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
      const segmentId = this.#ensureDeliverySegment(effect.segment_id, now);
      this.#database.prepare(`
        INSERT INTO delivery_attempts (
          id, effect_id, segment_id, attempt_number, status, idempotency_key,
          lease_owner, fencing_token, lease_expires_at, started_at
        ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)
      `).run(
        attemptId,
        effect.id,
        segmentId,
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
      this.#touchSegment(segmentId, now);

      return {
        request: {
          attemptId,
          effectId: effect.id,
          kind: effect.kind,
          payload: JSON.parse(effect.payload_json) as JsonValue,
          routeRef: effect.route_ref,
          ...(effect.destination_ref ? { destinationRef: effect.destination_ref } : {}),
          idempotencyKey,
        },
        fencingToken: tokenRow.value,
      };
    });
  }

  #finishDelivery(
    attemptId: string,
    fencingToken: number,
    observation: DeliveryObservation,
  ): string | undefined {
    return this.#transaction(() => {
      const now = this.#now();
      const attempt = this.#database.prepare(`
        SELECT effect_id, segment_id, attempt_number FROM delivery_attempts
        WHERE id = ? AND status = 'dispatching' AND fencing_token = ? AND lease_owner = ?
      `).get(attemptId, fencingToken, this.#ownerId) as unknown as {
        effect_id: string;
        segment_id: string;
        attempt_number: number;
      } | undefined;
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
      const nextDeliveryAt = observation.status === "not_sent"
        ? new Date(now.getTime() + deliveryRetryDelay(attempt.attempt_number)).toISOString()
        : undefined;
      if (effectState === "pending") {
        this.#database.prepare(`
          UPDATE effects SET next_delivery_after = ? WHERE id = ? AND status = 'pending'
        `).run(nextDeliveryAt ?? null, attempt.effect_id);
      } else {
        this.#database.prepare(`
          UPDATE effects
          SET status = ?, ended_at = ?, next_delivery_after = NULL
          WHERE id = ? AND status = 'pending'
        `).run(effectState, now.toISOString(), attempt.effect_id);
      }
      this.#touchSegment(attempt.segment_id, now);
      this.#recordTransition("delivery", attemptId, "dispatching", observation.status, "integration_result", now, fencingToken);
      if (effectState !== "pending") {
        this.#recordTransition("effect", attempt.effect_id, "pending", effectState, `delivery_${observation.status}`, now, fencingToken);
      }
      if (observation.status === "delivered") {
        this.#scheduleAfterChatContinuation(attempt.effect_id, attemptId, now);
      }
      return nextDeliveryAt;
    });
  }

  #scheduleAfterChatContinuation(effectId: string, deliveryId: string, deliveredAt: Date): void {
    const source = this.#database.prepare(`
      SELECT turns.id AS turn_id, turns.segment_id, inputs.kind AS input_kind
      FROM effects
      JOIN turns ON turns.id = effects.turn_id
      JOIN turn_inputs ON turn_inputs.turn_id = turns.id AND turn_inputs.position = 1
      JOIN inputs ON inputs.id = turn_inputs.input_id
      WHERE effects.id = ? AND turn_inputs.inclusion_status = 'included'
    `).get(effectId) as unknown as {
      turn_id: string;
      segment_id: string;
      input_kind: InputKind;
    } | undefined;
    if (!source || source.input_kind === "continuation") return;

    const previous = this.#readAfterChatContinuation();
    if (previous?.status === "pending") {
      this.#recordTransition(
        "after_chat_continuation",
        previous.id,
        "pending",
        "cancelled",
        "superseded_by_delivery",
        deliveredAt,
        null,
      );
    }
    const id = this.#nextId();
    const dueAt = new Date(deliveredAt.getTime() + AFTER_CHAT_DELAY_MS).toISOString();
    const expiresAt = new Date(deliveredAt.getTime() + AFTER_CHAT_EXPIRY_MS).toISOString();
    this.#database.prepare(`
      INSERT INTO after_chat_continuation (
        singleton, id, status, source_delivery_id, source_effect_id, source_turn_id,
        source_segment_id, source_behavior, delivered_at, due_at, expires_at,
        input_id, ended_at, reason
      ) VALUES (1, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(singleton) DO UPDATE SET
        id = excluded.id,
        status = excluded.status,
        source_delivery_id = excluded.source_delivery_id,
        source_effect_id = excluded.source_effect_id,
        source_turn_id = excluded.source_turn_id,
        source_segment_id = excluded.source_segment_id,
        source_behavior = excluded.source_behavior,
        delivered_at = excluded.delivered_at,
        due_at = excluded.due_at,
        expires_at = excluded.expires_at,
        input_id = NULL,
        ended_at = NULL,
        reason = NULL
    `).run(
      id,
      deliveryId,
      effectId,
      source.turn_id,
      source.segment_id,
      // After-chat runs in the interaction context: sending a message is
      // itself an interaction, regardless of the source Turn's behavior.
      "interactivity",
      deliveredAt.toISOString(),
      dueAt,
      expiresAt,
    );
    this.#recordTransition(
      "after_chat_continuation",
      id,
      null,
      "pending",
      "delivery_confirmed",
      deliveredAt,
      null,
    );
  }

  async #steerInput(
    active: ActiveExecution,
    inputId: string,
  ): Promise<void> {
    const prepared = this.#transaction(() => {
      const input = this.#database.prepare(`
        SELECT id, kind, payload_json, interaction_json, occurred_at, interaction_wave_id, late_arriving
        FROM inputs WHERE id = ? AND status = 'pending'
      `).get(inputId) as unknown as Pick<InputRow,
        "id" | "kind" | "payload_json" | "interaction_json" | "occurred_at" | "interaction_wave_id" | "late_arriving"
      > | undefined;
      if (!input) return undefined;
      const turn = this.#database.prepare(`
        SELECT id, interaction_scope_key, reply_gate_closed_at FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(active.turnId, active.fencingToken, this.#ownerId) as unknown as {
        id: string;
        interaction_scope_key: string | null;
        reply_gate_closed_at: string | null;
      } | undefined;
      if (!turn) return undefined;
      // Authoritative reply gate: an Interaction may join this Turn only when
      // its scope matches the Turn and the gate is still open. A closed gate
      // means the first reply was already committed; the Input stays pending
      // for the next Turn.
      let lateSteered = false;
      if (input.kind === "interaction") {
        const inputScope = input.interaction_wave_id
          ? (this.#database.prepare(`
              SELECT scope_key FROM interaction_waves WHERE id = ?
            `).get(input.interaction_wave_id) as unknown as { scope_key: string } | undefined)?.scope_key
          : undefined;
        if (!inputScope) return undefined;
        if (turn.interaction_scope_key === null) {
          // A proactive (non-interaction) Turn hosting its first Interaction
          // becomes an Interaction Turn for that route+place: fix the scope
          // atomically and mirror it in memory so later Interactions are held
          // to the same scope and the first reply closes the gate.
          this.#database.prepare(`
            UPDATE turns SET interaction_scope_key = ?
            WHERE id = ? AND status = 'running' AND interaction_scope_key IS NULL
          `).run(inputScope, active.turnId);
          turn.interaction_scope_key = inputScope;
          active.interactionScopeKey = inputScope;
        }
        if (inputScope !== turn.interaction_scope_key) {
          return undefined;
        }
        if (turn.reply_gate_closed_at !== null) return undefined;
        // The baseline for "late" is the first user Interaction of this Turn:
        // for a proactive Turn that is not the position-1 (opportunity) input.
        const firstInputWave = this.#database.prepare(`
          SELECT inputs.interaction_wave_id
          FROM turn_inputs
          JOIN inputs ON inputs.id = turn_inputs.input_id
          WHERE turn_inputs.turn_id = ? AND inputs.kind = 'interaction'
          ORDER BY turn_inputs.position
          LIMIT 1
        `).get(active.turnId) as unknown as { interaction_wave_id: string | null } | undefined;
        lateSteered = firstInputWave !== undefined
          && firstInputWave.interaction_wave_id !== null
          && firstInputWave.interaction_wave_id !== input.interaction_wave_id;
      }
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
          ...(input.interaction_json
            ? { interaction: JSON.parse(input.interaction_json) as NonNullable<ExecutionInput["interaction"]> }
            : {}),
          occurredAt: input.occurred_at,
          inclusionPosition: next.position,
          ...(lateSteered ? { lateSteered: true } : {}),
          ...(input.late_arriving === 1 ? { lateArriving: true } : {}),
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

  #pendingScopeInteractionInputs(scopeKey: string, firstInputId: string): string[] {
    return (this.#database.prepare(`
      SELECT inputs.id
      FROM inputs
      JOIN interaction_waves ON interaction_waves.id = inputs.interaction_wave_id
      WHERE interaction_waves.scope_key = ? AND inputs.status = 'pending' AND inputs.id <> ?
      ORDER BY inputs.accepted_at, inputs.id
    `).all(scopeKey, firstInputId) as unknown as Array<{ id: string }>).map(input => input.id);
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
      const next = covered
        ? "consumed"
        : reason === "failed" && input.kind !== "continuation"
          ? "blocked"
          : "pending";
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

  #touchSegmentForTurn(turnId: string, now: Date): void {
    this.#database.prepare(`
      UPDATE active_segment
      SET last_activity_at = MAX(last_activity_at, ?)
      WHERE singleton = 1 AND status = 'active'
        AND id = (SELECT segment_id FROM turns WHERE id = ?)
    `).run(now.toISOString(), turnId);
  }

  #turnBeginsWithContinuation(turnId: string): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1
      FROM turn_inputs
      JOIN inputs ON inputs.id = turn_inputs.input_id
      WHERE turn_inputs.turn_id = ? AND turn_inputs.position = 1
        AND turn_inputs.inclusion_status = 'included'
        AND inputs.kind = 'continuation'
    `).get(turnId));
  }

  #completeAfterChatContinuation(turnId: string, completedAt: Date, fencingToken: number): void {
    const continuation = this.#database.prepare(`
      SELECT after_chat_continuation.id
      FROM after_chat_continuation
      JOIN turn_inputs ON turn_inputs.input_id = after_chat_continuation.input_id
      WHERE after_chat_continuation.singleton = 1
        AND after_chat_continuation.status = 'admitted'
        AND turn_inputs.turn_id = ?
        AND turn_inputs.inclusion_status = 'included'
    `).get(turnId) as unknown as { id: string } | undefined;
    if (!continuation) return;
    const changed = this.#database.prepare(`
      UPDATE after_chat_continuation
      SET status = 'completed', ended_at = ?, reason = NULL
      WHERE singleton = 1 AND id = ? AND status = 'admitted'
    `).run(completedAt.toISOString(), continuation.id);
    if (changed.changes !== 1) return;
    this.#recordTransition(
      "after_chat_continuation",
      continuation.id,
      "admitted",
      "completed",
      "turn_completed",
      completedAt,
      fencingToken,
    );
  }

  #settleAfterChatContinuationFromStoppedTurn(
    turnId: string,
    stoppedAt: Date,
    fencingToken: number,
  ): void {
    const continuation = this.#database.prepare(`
      SELECT after_chat_continuation.id, after_chat_continuation.input_id
      FROM after_chat_continuation
      JOIN turn_inputs ON turn_inputs.input_id = after_chat_continuation.input_id
      JOIN inputs ON inputs.id = turn_inputs.input_id
      WHERE after_chat_continuation.singleton = 1
        AND after_chat_continuation.status = 'admitted'
        AND turn_inputs.turn_id = ?
        AND turn_inputs.inclusion_status = 'included'
        AND inputs.status = 'consumed'
    `).get(turnId) as unknown as { id: string; input_id: string } | undefined;
    if (!continuation) return;
    const changed = this.#database.prepare(`
      UPDATE after_chat_continuation
      SET status = 'completed', ended_at = ?, reason = 'turn_stopped_after_activity'
      WHERE singleton = 1 AND id = ? AND status = 'admitted'
    `).run(stoppedAt.toISOString(), continuation.id);
    if (changed.changes !== 1) return;
    this.#recordTransition(
      "after_chat_continuation",
      continuation.id,
      "admitted",
      "completed",
      "turn_stopped_after_activity",
      stoppedAt,
      fencingToken,
    );
  }

  #ensureDeliverySegment(originalSegmentId: string, now: Date): string {
    const active = this.#readActiveSegment();
    if (active) return active.id;
    const originalFrozen = this.#database.prepare(
      "SELECT 1 FROM activities WHERE id = ? LIMIT 1",
    ).get(originalSegmentId);
    const segmentId = originalFrozen ? this.#nextId() : originalSegmentId;
    const startingState = this.#readExecutionState().executionState;
    this.#database.prepare(`
      INSERT INTO active_segment (
        singleton, id, opened_at, last_activity_at, starting_state_json, status
      ) VALUES (1, ?, ?, ?, ?, 'active')
    `).run(
      segmentId,
      now.toISOString(),
      now.toISOString(),
      startingState === undefined ? null : JSON.stringify(startingState),
    );
    this.#recordTransition(
      "segment",
      segmentId,
      null,
      "active",
      originalFrozen ? "late_delivery_attempt" : "delivery_attempt",
      now,
      null,
    );
    return segmentId;
  }

  #touchSegment(segmentId: string, now: Date): void {
    this.#database.prepare(`
      UPDATE active_segment
      SET last_activity_at = MAX(last_activity_at, ?)
      WHERE singleton = 1 AND status = 'active'
        AND id = ?
    `).run(now.toISOString(), segmentId);
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
    const event: OperationalEvent = {
      event: "runtime.transition",
      at: occurredAt.toISOString(),
      entityType,
      entityId,
      fromState,
      toState,
      reason,
    };
    if (this.#pendingOperationalEvents) {
      this.#pendingOperationalEvents.push(event);
    } else {
      emitOperationalEvent(this.#observe, event);
    }
  }

  #startHeartbeat(
    kind: "turn" | "delivery" | "activity_close" | "activity_recording" | "thread_maintenance",
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
            : kind === "activity_recording"
              ? this.#database.prepare(`
                  UPDATE activities SET lease_expires_at = ?
                  WHERE id = ? AND status = 'recording' AND fencing_token = ? AND lease_owner = ?
                `).run(expiresAt, id, fencingToken, this.#ownerId)
              : this.#database.prepare(`
                  UPDATE thread_maintenance SET lease_expires_at = ?
                  WHERE activity_id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
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
    if (this.#pendingOperationalEvents) throw new Error("Runtime transactions cannot be nested");
    this.#database.exec("BEGIN IMMEDIATE");
    this.#pendingOperationalEvents = [];
    try {
      const result = work();
      this.#database.exec("COMMIT");
      const events = this.#pendingOperationalEvents;
      this.#pendingOperationalEvents = undefined;
      for (const event of events) emitOperationalEvent(this.#observe, event);
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      this.#pendingOperationalEvents = undefined;
      throw error;
    }
  }
}

function agentRunSummary(row: AgentRunRow): RuntimeAgentRunSummary {
  return {
    runId: row.id,
    name: row.agent_name,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    result: row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.failure_category ? { failureCategory: row.failure_category } : {}),
  };
}

function agentState(summary: RuntimeAgentRunSummary): "running" | "succeeded" | "failed" {
  if (summary.result === "running") return "running";
  if (summary.result === "succeeded") return "succeeded";
  return "failed";
}

function agentFailureCategory(error: unknown): string {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/consecutive tool errors/i.test(message)) return "tool_error";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/abort|interrupt/i.test(message)) return "interrupted";
  if (/auth|credential|token|401|403/i.test(message)) return "authentication";
  if (/transcript|anchor|invalid|requires/i.test(message)) return "invalid_result";
  if (/workspace|mutation|file|directory/i.test(message)) return "workspace";
  if (/provider|model|network|connect|429|5\d\d/i.test(message)) return "provider";
  return "unknown";
}

function organTranscriptRef(organ: CognitiveOrganName, runId: string): string {
  return `organs/${organ}/${runId}.jsonl`;
}

function defaultOrganCancelTimer(
  delayMs: number,
  callback: () => void,
): { clear(): void } {
  const timeout = setTimeout(callback, delayMs);
  timeout.unref();
  return { clear: () => clearTimeout(timeout) };
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Opportunity Pulse ${label} must be a positive finite number`);
  }
}

function assertMaintenanceOptions(options: RunAttentionMaintenanceOptions): void {
  if (!Number.isFinite(options.observedAt.getTime())) {
    throw new Error("Attention maintenance requires a valid observedAt");
  }
  for (const [label, value] of [
    ["initialDelayMs", options.initialDelayMs],
    ["cadenceMs", options.cadenceMs],
    ["retryDelayMs", options.retryDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Attention maintenance ${label} must be a positive finite number`);
    }
  }
}

function assertReflectionOptions(options: RunMemoryReflectionOptions): void {
  if (!Number.isFinite(options.observedAt.getTime())) {
    throw new Error("Memory reflection requires a valid observedAt");
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error("Memory reflection delayMs must be a non-negative finite number");
  }
  if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs <= 0) {
    throw new Error("Memory reflection retryDelayMs must be a positive finite number");
  }
}

function formatInteractionCursor(sequence: number): string {
  return `v1:${sequence}`;
}

function parseInteractionCursor(cursor: string): number {
  const match = /^v1:(\d+)$/.exec(cursor);
  const sequence = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Interaction View cursor is invalid");
  }
  return sequence;
}

export function openRuntime(options: RuntimeOptions): Runtime {
  return new SqliteRuntime(options);
}
