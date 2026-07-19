import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { initializeRuntimeSchema } from "./schema.js";
import type {
  AcceptedInput,
  AdvanceResult,
  AgentExecution,
  ContextWindowState,
  DeliveryAttemptRequest,
  DeliveryObservation,
  EffectReceipt,
  EffectRequest,
  ExecutionInput,
  ExecutionResult,
  InputKind,
  Integration,
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
  status: RuntimeTurnStatus["status"];
  fencing_token: number;
  transcript_anchor_json: string | null;
  context_plan_json: string | null;
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
  readonly #integration: Integration | undefined;
  readonly #now: () => Date;
  readonly #nextId: () => string;
  readonly #ownerId: string;
  readonly #leaseDurationMs: number;
  #active: ActiveExecution | undefined;
  #activeDeliveryId: string | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(options: RuntimeOptions) {
    mkdirSync(options.root, { recursive: true });
    this.#database = new DatabaseSync(path.join(options.root, "runtime.db"));
    this.#execution = options.execution;
    this.#integration = options.integration;
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? randomUUID;
    this.#ownerId = options.ownerId ?? randomUUID();
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
    initializeRuntimeSchema(this.#database);
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

  async advance(): Promise<AdvanceResult> {
    if (this.#active || this.#activeDeliveryId || this.#hasRunningTurn()) return { disposition: "busy" };

    if (this.#integration) {
      const delivery = this.#claimPendingDelivery();
      if (delivery) {
        this.#activeDeliveryId = delivery.request.attemptId;
        this.#startHeartbeat("delivery", delivery.request.attemptId, delivery.fencingToken);
        try {
          let observation: DeliveryObservation;
          try {
            observation = await this.#integration.deliver(delivery.request);
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

    if (!this.#execution) return { disposition: "idle" };

    const claimed = this.#claimNextInput();
    if (!claimed) return { disposition: "idle" };
    try {
      const running = this.#execution.start({
        turnId: claimed.turnId,
        leaseToken: claimed.fencingToken,
        inputs: [claimed.input],
        ...(claimed.contextWindow ? { contextWindow: claimed.contextWindow } : {}),
      }, {
        includeInput: inputId => this.#includeInput(claimed.turnId, claimed.fencingToken, inputId),
        prepareContextWindow: window => this.#prepareContextWindow(
          claimed.turnId,
          claimed.fencingToken,
          window,
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
      return { disposition: "turn_completed" };
    } catch (error) {
      this.#failTurn(claimed.turnId, claimed.fencingToken, error);
      throw error;
    } finally {
      this.#stopHeartbeat();
      if (this.#active?.turnId === claimed.turnId) this.#active = undefined;
    }
  }

  status(): RuntimeStatus {
    const rows = this.#database.prepare(`
      SELECT id, source, source_id, kind, payload_json, status
      FROM inputs
      ORDER BY accepted_at, id
    `).all() as unknown as InputRow[];
    const turnRows = this.#database.prepare(`
      SELECT id, status, fencing_token, transcript_anchor_json, context_plan_json
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
          ...(row.context_plan_json
            ? { contextPlan: JSON.parse(row.context_plan_json) as JsonValue }
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
    };
  }

  close(): void {
    this.#stopHeartbeat();
    this.#database.close();
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

  #claimNextInput(): {
    turnId: string;
    fencingToken: number;
    input: ExecutionInput;
    contextWindow?: ContextWindowState;
  } | undefined {
    return this.#transaction(() => {
      if (this.#hasRunningTurn()) return undefined;
      const input = this.#database.prepare(`
        SELECT id, kind, payload_json, occurred_at
        FROM inputs
        WHERE status = 'pending'
        ORDER BY accepted_at, id
        LIMIT 1
      `).get() as unknown as Pick<InputRow, "id" | "kind" | "payload_json" | "occurred_at"> | undefined;
      if (!input) return undefined;

      const tokenRow = this.#database.prepare(`
        UPDATE runtime_counters
        SET value = value + 1
        WHERE name = 'fencing_token'
        RETURNING value
      `).get() as unknown as { value: number };
      const now = this.#now();
      const turnId = this.#nextId();
      this.#database.prepare(`
        INSERT INTO turns (
          id, status, lease_owner, fencing_token, lease_expires_at, started_at
        ) VALUES (?, 'running', ?, ?, ?, ?)
      `).run(
        turnId,
        this.#ownerId,
        tokenRow.value,
        new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        now.toISOString(),
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
        input: {
          id: input.id,
          kind: input.kind,
          payload: JSON.parse(input.payload_json) as JsonValue,
          occurredAt: input.occurred_at,
          inclusionPosition: 1,
        },
        ...this.#readContextWindow(),
      };
    });
  }

  #completeTurn(turnId: string, fencingToken: number, result: ExecutionResult): void {
    if (!result.transcriptAnchor.sessionId || !result.transcriptAnchor.entryId) {
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
        if (!anchor?.sessionId || !anchor.entryId) {
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
        SET status = 'completed', outcome = ?, ended_at = ?, transcript_anchor_json = ?, context_plan_json = ?
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).run(
        result.outcome,
        now.toISOString(),
        JSON.stringify(result.transcriptAnchor),
        JSON.stringify(result.contextPlan),
        turnId,
        fencingToken,
        this.#ownerId,
      );
      if (changed.changes !== 1) throw new Error(`Turn ${turnId} no longer accepts writes from lease ${fencingToken}`);
      const preparedWindow = this.#readContextWindow().contextWindow;
      if (!preparedWindow) {
        throw new Error(`Turn ${turnId} did not prepare a Context Window before completion`);
      }
      this.#validateCompletedContextWindow(preparedWindow, result.contextWindow, result.transcriptAnchor);
      const existing = this.#database.prepare(`
        SELECT 1 FROM active_context_window WHERE singleton = 1
      `).get();
      this.#database.prepare(`
        INSERT INTO active_context_window (singleton, state_json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(JSON.stringify(result.contextWindow), now.toISOString());
      this.#recordTransition(
        "context_window",
        result.contextWindow.id,
        existing ? "active" : null,
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

  #readContextWindow(): { contextWindow?: ContextWindowState } {
    const row = this.#database.prepare(`
      SELECT state_json FROM active_context_window WHERE singleton = 1
    `).get() as unknown as { state_json: string } | undefined;
    if (!row) return {};
    const contextWindow = JSON.parse(row.state_json) as ContextWindowState;
    this.#validateContextWindow(contextWindow);
    return { contextWindow };
  }

  #validateContextWindow(window: ContextWindowState): void {
    if (window.version !== 1 || !window.id || !Array.isArray(window.frozenSeed) || !Array.isArray(window.committedTrace)) {
      throw new Error("Runtime received an invalid Context Window");
    }
    if (window.transcriptAnchor
      && (!window.transcriptAnchor.sessionId || !window.transcriptAnchor.entryId)) {
      throw new Error(`Context Window ${window.id} has an invalid Transcript Anchor`);
    }
  }

  #validateCompletedContextWindow(
    prepared: ContextWindowState,
    completed: ContextWindowState,
    transcriptAnchor: TranscriptAnchor,
  ): void {
    this.#validateContextWindow(completed);
    const preservesPreparedState = completed.id === prepared.id
      && isDeepStrictEqual(completed.frozenSeed, prepared.frozenSeed)
      && completed.committedTrace.length >= prepared.committedTrace.length
      && isDeepStrictEqual(
        completed.committedTrace.slice(0, prepared.committedTrace.length),
        prepared.committedTrace,
      );
    if (!preservesPreparedState) {
      throw new Error(`Completed Turn cannot replace prepared Context Window ${prepared.id}`);
    }
    if (completed.transcriptAnchor?.sessionId !== transcriptAnchor.sessionId
      || completed.transcriptAnchor.entryId !== transcriptAnchor.entryId
      || (prepared.transcriptAnchor
        && prepared.transcriptAnchor.sessionId !== transcriptAnchor.sessionId)) {
      throw new Error(`Context Window ${completed.id} requires the completed Turn Transcript Anchor`);
    }
  }

  #prepareContextWindow(
    turnId: string,
    fencingToken: number,
    window: ContextWindowState,
  ): void {
    this.#validateContextWindow(window);
    this.#transaction(() => {
      const turn = this.#database.prepare(`
        SELECT id FROM turns
        WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
      `).get(turnId, fencingToken, this.#ownerId);
      if (!turn) throw new Error(`Turn ${turnId} no longer accepts Context from lease ${fencingToken}`);

      const current = this.#readContextWindow().contextWindow;
      if (current) {
        if (!isDeepStrictEqual(current, window)) {
          throw new Error(`Turn ${turnId} cannot replace active Context Window ${current.id} before completion`);
        }
        return;
      }

      const now = this.#now();
      this.#database.prepare(`
        INSERT INTO active_context_window (singleton, state_json, updated_at)
        VALUES (1, ?, ?)
      `).run(JSON.stringify(window), now.toISOString());
      this.#recordTransition(
        "context_window",
        window.id,
        null,
        "active",
        "turn_prepared",
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
      SELECT MAX(input_position) AS position FROM effects WHERE turn_id = ?
    `).get(turnId) as unknown as { position: number | null };
    const inputs = this.#database.prepare(`
      SELECT inputs.id, turn_inputs.position
      FROM turn_inputs
      JOIN inputs ON inputs.id = turn_inputs.input_id
      WHERE turn_inputs.turn_id = ?
        AND turn_inputs.inclusion_status = 'included'
        AND inputs.status = 'active'
      ORDER BY turn_inputs.position
    `).all(turnId) as unknown as Array<{ id: string; position: number }>;

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

  #startHeartbeat(kind: "turn" | "delivery", id: string, fencingToken: number): void {
    this.#stopHeartbeat();
    const intervalMs = Math.max(25, Math.floor(this.#leaseDurationMs / 3));
    this.#heartbeat = setInterval(() => {
      const expiresAt = new Date(this.#now().getTime() + this.#leaseDurationMs).toISOString();
      const result = kind === "turn"
        ? this.#database.prepare(`
            UPDATE turns SET lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND fencing_token = ? AND lease_owner = ?
          `).run(expiresAt, id, fencingToken, this.#ownerId)
        : this.#database.prepare(`
            UPDATE delivery_attempts SET lease_expires_at = ?
            WHERE id = ? AND status = 'dispatching' AND fencing_token = ? AND lease_owner = ?
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
