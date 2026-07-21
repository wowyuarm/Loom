import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FrozenActivity, FrozenActivityEvent, JsonValue, Runtime } from "../../runtime/index.js";
import {
  NmemClient,
  NmemRequestError,
  type NmemThreadCreate,
  type NmemThreadMessage,
} from "./client.js";

const MAX_PRIVATE_ITEM_CHARACTERS = 500;
const MAX_PRIVATE_ACTIVITY_CHARACTERS = 4_000;
const MAX_PRIVATE_ITEMS = 20;

export interface NmemThreadReconcileResult {
  imported: number;
  current: number;
  pending: number;
  blocked: number;
}

export interface NmemThreadReconciler {
  reconcile(): Promise<NmemThreadReconcileResult>;
  close(): void;
}

export interface NmemThreadReconcilerOptions {
  runtime: Pick<Runtime, "status" | "frozenActivity">;
  stateRoot: string;
  endpoint?: string;
  apiKey?: string;
  spaceId?: string;
  timeoutMs?: number;
  now?: () => Date;
  fetch?: typeof fetch;
}

interface ThreadExportRow {
  segment_id: string;
  activity_hash: string;
  status: "current" | "pending" | "blocked";
  attempt_count: number;
  next_attempt_at: string | null;
  connection_hash: string;
}

interface PreparedActivity {
  activity: FrozenActivity;
  contentHash: string;
}

class SqliteNmemThreadReconciler implements NmemThreadReconciler {
  readonly #runtime: Pick<Runtime, "status" | "frozenActivity">;
  readonly #database: DatabaseSync;
  readonly #client: NmemClient | undefined;
  readonly #connectionHash: string;
  readonly #now: () => Date;

  constructor(options: NmemThreadReconcilerOptions) {
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => new Date());
    const directory = path.join(options.stateRoot, "integrations");
    mkdirSync(directory, { recursive: true });
    this.#database = new DatabaseSync(path.join(directory, "nmem.db"));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS thread_exports (
        segment_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        activity_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'pending', 'blocked')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        connection_hash TEXT NOT NULL,
        last_error TEXT,
        imported_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#connectionHash = createHash("sha256")
      .update(`${options.endpoint ?? ""}\0${options.apiKey ?? ""}\0${options.spaceId ?? ""}`)
      .digest("hex");
    this.#client = options.endpoint
      ? new NmemClient({
          endpoint: options.endpoint,
          ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
          ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        })
      : undefined;
  }

  async reconcile(): Promise<NmemThreadReconcileResult> {
    const result: NmemThreadReconcileResult = { imported: 0, current: 0, pending: 0, blocked: 0 };
    const candidates: PreparedActivity[] = [];
    for (const reference of this.#runtime.status().activities) {
      const activity = this.#runtime.frozenActivity(reference.id);
      if (!activity) {
        this.#recordFailure(reference.id, "missing", new Error(`Frozen Activity ${reference.id} is unavailable`));
        result.blocked++;
        continue;
      }
      const contentHash = createHash("sha256").update(JSON.stringify(activity)).digest("hex");
      const existing = this.#read(activity.segmentId);
      const sameProjection = existing?.activity_hash === contentHash
        && existing.connection_hash === this.#connectionHash;
      if (sameProjection && existing.status === "current") {
        result.current++;
        continue;
      }
      if (sameProjection
        && existing.next_attempt_at
        && existing.next_attempt_at > this.#now().toISOString()) {
        existing.status === "pending" ? result.pending++ : result.blocked++;
        continue;
      }
      candidates.push({ activity, contentHash });
    }
    if (candidates.length === 0) return result;
    if (!this.#client) {
      result.blocked += candidates.length;
      return result;
    }

    try {
      await this.#client.requireCapabilities("threads");
    } catch (error) {
      for (const candidate of candidates) {
        this.#recordFailure(candidate.activity.segmentId, candidate.contentHash, error);
        classify(error) === "temporary" ? result.pending++ : result.blocked++;
      }
      return result;
    }

    for (const candidate of candidates) {
      try {
        const projection = projectActivity(candidate.activity);
        await this.#client.createThread(projection);
        this.#recordSuccess(candidate.activity.segmentId, projection.thread_id, candidate.contentHash);
        result.imported++;
      } catch (error) {
        this.#recordFailure(candidate.activity.segmentId, candidate.contentHash, error);
        classify(error) === "temporary" ? result.pending++ : result.blocked++;
      }
    }
    return result;
  }

  close(): void {
    this.#database.close();
  }

  #read(segmentId: string): ThreadExportRow | undefined {
    return this.#database.prepare(`
      SELECT segment_id, activity_hash, status, attempt_count, next_attempt_at, connection_hash
      FROM thread_exports WHERE segment_id = ?
    `).get(segmentId) as unknown as ThreadExportRow | undefined;
  }

  #recordSuccess(segmentId: string, threadId: string, contentHash: string): void {
    const now = this.#now().toISOString();
    this.#database.prepare(`
      INSERT INTO thread_exports (
        segment_id, thread_id, activity_hash, status, attempt_count,
        next_attempt_at, connection_hash, last_error, imported_at, updated_at
      ) VALUES (?, ?, ?, 'current', 1, NULL, ?, NULL, ?, ?)
      ON CONFLICT (segment_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        activity_hash = excluded.activity_hash,
        status = 'current',
        attempt_count = thread_exports.attempt_count + 1,
        next_attempt_at = NULL,
        connection_hash = excluded.connection_hash,
        last_error = NULL,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at
    `).run(segmentId, threadId, contentHash, this.#connectionHash, now, now);
  }

  #recordFailure(segmentId: string, contentHash: string, error: unknown): void {
    const now = this.#now();
    const kind = classify(error);
    const current = this.#read(segmentId);
    const attempts = current
      && current.activity_hash === contentHash
      && current.connection_hash === this.#connectionHash
      ? current.attempt_count
      : 0;
    const nextAttemptAt = new Date(
      now.getTime() + (kind === "temporary" ? retryDelayMs(attempts + 1) : 6 * 60 * 60_000),
    ).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.#database.prepare(`
      INSERT INTO thread_exports (
        segment_id, thread_id, activity_hash, status, attempt_count,
        next_attempt_at, connection_hash, last_error, imported_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)
      ON CONFLICT (segment_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        activity_hash = excluded.activity_hash,
        status = excluded.status,
        attempt_count = CASE
          WHEN thread_exports.activity_hash = excluded.activity_hash
            AND thread_exports.connection_hash = excluded.connection_hash
          THEN thread_exports.attempt_count + 1 ELSE 1 END,
        next_attempt_at = excluded.next_attempt_at,
        connection_hash = excluded.connection_hash,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      segmentId,
      threadId(segmentId),
      contentHash,
      kind === "temporary" ? "pending" : "blocked",
      nextAttemptAt,
      this.#connectionHash,
      message,
      now.toISOString(),
    );
  }
}

export function createNmemThreadReconciler(
  options: NmemThreadReconcilerOptions,
): NmemThreadReconciler {
  return new SqliteNmemThreadReconciler(options);
}

function projectActivity(activity: FrozenActivity): NmemThreadCreate {
  const messages: Array<NmemThreadMessage & { order: number }> = [];
  const delivered = deliveredEffects(activity.events);
  for (let index = 0; index < activity.events.length; index += 1) {
    const event = activity.events[index]!;
    if (event.kind === "input" && event.actorRef === "human") {
      messages.push({
        role: "user",
        content: eventText(event.content),
        timestamp: event.at,
        metadata: {
          kind: "dialogue",
          actor_ref: "human",
          loom_event_id: event.eventId,
          loom_turn_id: event.turnId,
        },
        order: index,
      });
      continue;
    }
    if (event.kind !== "effect" || !isObject(event.content)) continue;
    const effectId = stringValue(event.content.effectId);
    const delivery = effectId ? delivered.get(effectId) : undefined;
    const text = messageEffectText(event.content);
    if (!delivery || !text) continue;
    messages.push({
      role: "assistant",
      content: text,
      timestamp: delivery.at,
      metadata: {
        kind: "dialogue",
        actor_ref: "individual",
        loom_event_id: event.eventId,
        loom_delivery_event_id: delivery.eventId,
        loom_turn_id: event.turnId,
      },
      order: index,
    });
  }

  for (const turn of activity.turns) {
    const privateActivity = privateActivityMessage(activity, turn.turnId);
    if (!privateActivity) continue;
    messages.push({ ...privateActivity, order: activity.events.findIndex(event => event.eventId === privateActivity.metadata.loom_event_id) });
  }
  messages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.order - right.order);
  if (messages.length === 0) throw new Error(`Frozen Activity ${activity.segmentId} has no projectable nmem Thread messages`);
  const includesHumanRelationship = messages.some(message => message.role === "user" || message.role === "assistant");

  return {
    thread_id: threadId(activity.segmentId),
    title: `Activity ${activity.recordingDay}`,
    participants: includesHumanRelationship ? ["human", "individual"] : ["individual"],
    source: "loom-runtime",
    messages: messages.map(({ order: _order, ...message }) => message),
    metadata: {
      kind: "loom_conversation_activity",
      schema_version: 1,
      loom_segment_id: activity.segmentId,
      recording_day: activity.recordingDay,
      opened_at: activity.openedAt,
      closed_at: activity.closedAt,
    },
  };
}

function privateActivityMessage(activity: FrozenActivity, turnIdValue: string): NmemThreadMessage | undefined {
  const events = activity.events.filter(event => event.turnId === turnIdValue);
  const lines: string[] = [];
  const sourceEventIds: string[] = [];
  for (const event of events) {
    const line = privateActivityLine(event);
    if (!line) continue;
    lines.push(line);
    sourceEventIds.push(event.eventId);
    if (lines.length >= MAX_PRIVATE_ITEMS) break;
  }
  if (lines.length === 0) return undefined;
  const first = events.find(event => sourceEventIds.includes(event.eventId))!;
  return {
    role: "system",
    content: bound(`Private activity in Turn ${turnIdValue}:\n${lines.map(line => `- ${line}`).join("\n")}`, MAX_PRIVATE_ACTIVITY_CHARACTERS),
    timestamp: first.at,
    metadata: {
      kind: "private_activity",
      actor_ref: "individual",
      loom_event_id: first.eventId,
      loom_event_ids: sourceEventIds,
      loom_turn_id: turnIdValue,
    },
  };
}

function privateActivityLine(event: FrozenActivityEvent): string | undefined {
  if (event.kind === "thinking") return undefined;
  if (event.kind === "input" && event.actorRef === "system") {
    return `Context: ${bound(eventText(event.content), MAX_PRIVATE_ITEM_CHARACTERS)}`;
  }
  if (event.kind === "output" && event.actorRef === "individual") {
    const text = contentText(event.content);
    return text ? `Private note: ${bound(text, MAX_PRIVATE_ITEM_CHARACTERS)}` : undefined;
  }
  if (event.kind === "tool_call" && isObject(event.content)) {
    const name = stringValue(event.content.name) || stringValue(event.content.toolName) || "tool";
    if (name === "message") return undefined;
    const argumentsValue = event.content.arguments ?? event.content.callArguments;
    const argument = toolArgumentSummary(argumentsValue);
    return `Tool action: ${name}${argument ? ` ${argument}` : ""}`;
  }
  if (event.kind === "tool_result" && isObject(event.content) && event.content.isError === true) {
    const name = stringValue(event.content.toolName) || "tool";
    return `Tool failed: ${name}`;
  }
  if (event.kind === "effect" && isObject(event.content) && event.content.kind !== "message") {
    return `Effect: ${bound(render({ kind: event.content.kind, payload: event.content.payload }), MAX_PRIVATE_ITEM_CHARACTERS)}`;
  }
  if (event.kind === "delivery" && isObject(event.content) && event.content.status !== "delivered") {
    return `Delivery outcome: ${stringValue(event.content.status) || "unknown"}`;
  }
  if (event.kind === "system" && isObject(event.content) && event.content.type === "turn_stopped") {
    return `Turn stopped: ${stringValue(event.content.status) || "unknown"}`;
  }
  return undefined;
}

function deliveredEffects(events: FrozenActivityEvent[]): Map<string, FrozenActivityEvent> {
  const delivered = new Map<string, FrozenActivityEvent>();
  for (const event of events) {
    if (event.kind !== "delivery" || !isObject(event.content) || event.content.status !== "delivered") continue;
    const effectId = stringValue(event.content.effectId);
    if (effectId) delivered.set(effectId, event);
  }
  return delivered;
}

function messageEffectText(content: Record<string, unknown>): string {
  if (content.kind !== "message" || !isObject(content.payload)) return "";
  return stringValue(content.payload.text).trim();
}

function eventText(content: JsonValue): string {
  if (typeof content === "string") return content;
  if (isObject(content) && typeof content.text === "string" && content.text.trim()) return content.text;
  return render(content);
}

function toolArgumentSummary(value: unknown): string {
  if (!isObject(value)) return "";
  for (const key of ["path", "pattern", "query", "command", "url"]) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return bound(item.trim(), MAX_PRIVATE_ITEM_CHARACTERS);
  }
  return "";
}

function contentText(content: JsonValue): string {
  return isObject(content) && typeof content.text === "string" ? content.text.trim() : "";
}

function threadId(segmentId: string): string {
  return `loom-activity-${segmentId}`;
}

function classify(error: unknown): NmemRequestError["kind"] {
  return error instanceof NmemRequestError ? error.kind : "incompatible";
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function bound(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 1)}…`;
}
