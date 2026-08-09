import type { JsonValue } from "../../runtime/index.js";
import { ACTIVITY_QUEUE_LIMIT } from "./raft-activity.js";
import type { RaftRemoteMessage, RaftRemotePlace } from "./raft-channel.js";

export const SUPPORTED_RAFT_CLI_VERSION = "0.0.17";

export interface RaftProfile {
  id: string;
  kind: "human" | "agent";
  name: string;
  displayName?: string | null;
  description?: string | null;
}

export interface HistoryMessage {
  messageId: string;
  occurredAt: string;
  senderName: string;
  senderType: "human" | "agent" | "system";
  remainder: string;
}

export interface InboxSpoolEntry {
  receiptId: string;
  target: string;
  shortId: string;
  receivedAt: string;
  messageId?: string;
  /** Bounded summary of the last failed completion attempt; kept for recovery. */
  lastError?: string;
}

export function parseResolvedMessageHeader(output: string): {
  target: string;
  shortId: string;
  localTime: string;
  senderKind: "human" | "agent" | "system";
  senderHandle: string;
  remainder: string;
} {
  const header = /^\[target=(\S+) msg=([^\s]+) time=(.+?) type=(human|agent|system)\] @([A-Za-z0-9_-]+)([\s\S]*)$/.exec(output);
  if (!header) throw new Error("Raft message resolve returned an unsupported 0.0.17 format");
  const [, target, shortId, localTime, senderKind, senderHandle, remainder] = header;
  return {
    target: target!,
    shortId: shortId!,
    localTime: localTime!,
    senderKind: senderKind as "human" | "agent" | "system",
    senderHandle: senderHandle!,
    remainder: remainder!,
  };
}

export function validateBridgeWake(
  value: Record<string, unknown>,
  expected: { profile: string; agentId: string },
): void {
  const keys = [
    "schema", "attemptId", "eventId", "messageId", "agentId",
    "profile", "coreSessionId", "adapterInstance", "occurredAt",
  ];
  const unsupported = Object.keys(value).filter(key => !keys.includes(key));
  if (unsupported.length > 0) throw new Error(`Raft bridge wake has unsupported field ${unsupported.join(", ")}`);
  assertEqual(value.schema, "raft-channel-wake.v1", "Raft bridge wake schema");
  assertEqual(value.agentId, expected.agentId, "Raft bridge wake agent binding");
  assertEqual(value.profile, expected.profile, "Raft bridge wake profile binding");
  for (const field of ["attemptId", "eventId", "messageId", "coreSessionId", "adapterInstance", "occurredAt"]) {
    stringField(value, field, "Raft bridge wake");
  }
  if (Number.isNaN(Date.parse(String(value.occurredAt)))) throw new Error("Raft bridge wake occurredAt must be an ISO timestamp");
}

export function directMessageHandle(target: string): string {
  const match = /^dm:@([A-Za-z0-9_-]+)$/.exec(required(target, "Raft principal DM target"));
  if (!match) throw new Error("Raft principal DM target must be a top-level dm:@handle");
  return match[1]!;
}

export function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(cursor.trim())) throw new Error("Raft cursor is invalid");
  return Number(cursor);
}

/**
 * Bounded `max` for one activity drain: absent means the queue limit,
 * malformed or negative values drain nothing, and the value is capped at
 * the queue limit so a misbehaving bridge cannot request unbounded work.
 */
export function parseActivityDrainMax(value: string | null): number {
  if (value === null) return ACTIVITY_QUEUE_LIMIT;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value.trim())) return 0;
  return Math.min(Number(value), ACTIVITY_QUEUE_LIMIT);
}

export function parseTarget(target: string): { base: string; thread: boolean } {
  if (/^dm:@[A-Za-z0-9_-]+$/.test(target) || /^#[A-Za-z0-9_-]+$/.test(target)) {
    return { base: target, thread: false };
  }
  const match = /^(dm:@[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+):[0-9a-f]{8}$/i.exec(target);
  if (!match) throw new Error("Raft message resolve returned an unsupported target");
  return { base: match[1]!, thread: true };
}

export function parseHistory(output: string): HistoryMessage[] {
  const rows: HistoryMessage[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("[seq=")) continue;
    const match = /^\[seq=\S+ msg=([0-9a-f-]+) time=(.+?) type=(human|agent|system)(?: [^\]]+)?\] @([A-Za-z0-9_-]+)([\s\S]*)$/.exec(line);
    if (!match) throw new Error("Raft message read returned an unsupported 0.0.17 history format");
    const [, messageId, localTime, senderType, senderName, remainder] = match;
    rows.push({
      messageId: messageId!,
      occurredAt: localTimestamp(localTime!),
      senderName: senderName!,
      senderType: senderType as HistoryMessage["senderType"],
      remainder: remainder!,
    });
  }
  return rows;
}

export function parseInboxNotices(output: string): InboxSpoolEntry[] {
  const entries: InboxSpoolEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("[target=")) continue;
    const match = /^\[target=(\S+) msg=([0-9a-f]{8}) time=(.+?) type=(?:human|agent|system)\]/i.exec(line);
    if (!match) continue;
    const [, target, shortId, localTime] = match;
    entries.push({
      receiptId: `${target}:${shortId!.toLowerCase()}`,
      target: target!,
      shortId: shortId!.toLowerCase(),
      receivedAt: localTimestamp(localTime!),
    });
  }
  return entries;
}

export function parseInboxSpoolEntry(value: unknown): InboxSpoolEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Raft inbox spool contains an invalid entry");
  }
  const entry = value as Partial<InboxSpoolEntry>;
  if (typeof entry.receiptId !== "string" || !entry.receiptId
    || typeof entry.target !== "string" || !entry.target
    || typeof entry.shortId !== "string" || !/^[0-9a-f]{8}$/i.test(entry.shortId)
    || typeof entry.receivedAt !== "string" || Number.isNaN(Date.parse(entry.receivedAt))
    || (entry.messageId !== undefined && (typeof entry.messageId !== "string" || !entry.messageId))) {
    throw new Error("Raft inbox spool contains an invalid entry");
  }
  return entry as InboxSpoolEntry;
}

export function resolvedContent(remainder: string, description: string | null | undefined): string {
  const descriptionPrefix = description ? ` — ${description}: ` : undefined;
  const prefix = descriptionPrefix && remainder.startsWith(descriptionPrefix)
    ? descriptionPrefix
    : remainder.startsWith(": ") ? ": " : undefined;
  if (!prefix) throw new Error("Raft message resolve returned an unsupported sender/content separator");
  const content = remainder.slice(prefix.length).trim();
  if (!content) throw new Error("Raft message resolve returned blank content");
  return content;
}

export function taskAssignment(content: string): RaftRemoteMessage["task"] {
  const match = /\[task #([0-9]+) status=(todo|in_progress|in_review|done|closed)(?: assignee=([^\]\s]+))?\]/i.exec(content);
  if (!match) return undefined;
  const assignee = match[3];
  const typed = assignee ? /^([^:]+):(.+)$/.exec(assignee) : undefined;
  return {
    number: Number(match[1]),
    status: match[2]!.toLowerCase() as NonNullable<RaftRemoteMessage["task"]>["status"],
    ...(typed ? { assigneeType: typed[1], assigneeId: typed[2] } : {}),
    ...(assignee?.startsWith("@") ? { assigneeHandle: assignee } : {}),
  };
}

export function taskContent(content: string): string {
  return content.replace(/\s*\[task #[0-9]+ status=[^\]\s]+(?: assignee=[^\]\s]+)?\]\s*$/i, "").trim();
}

export function parseTaskReference(value: string): { target: string; number: number; messageId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Raft task ref is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Raft task ref is malformed");
  const fields = parsed as Record<string, unknown>;
  const target = typeof fields.target === "string" ? required(fields.target, "Raft task target") : "";
  const number = fields.number;
  const messageId = typeof fields.messageId === "string" ? required(fields.messageId, "Raft task message id") : "";
  if (!target || !Number.isInteger(number) || Number(number) < 1 || !messageId) {
    throw new Error("Raft task ref is malformed");
  }
  return { target, number: Number(number), messageId };
}

export function safePlaceLabel(target: string, provided?: string): string {
  const candidate = provided?.trim();
  if (candidate && candidate !== target && !candidate.includes(target)) return candidate;
  const parsed = parseTarget(target);
  if (parsed.base.startsWith("dm:@")) {
    const handle = parsed.base.slice("dm:".length);
    return parsed.thread ? `DM with ${handle} reply thread` : `DM with ${handle}`;
  }
  const channel = parsed.base.slice(1);
  return parsed.thread ? `${channel} reply thread` : channel;
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function localTimestamp(value: string): string {
  const parsed = new Date(`${value.trim().replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Raft message resolve returned an invalid timestamp");
  return parsed.toISOString();
}

export function jsonObject(result: { stdout: string }, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function objectField(value: Record<string, unknown>, field: string, label: string): Record<string, unknown> {
  const result = value[field];
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`${label} ${field} must be an object`);
  return result as Record<string, unknown>;
}

export function stringField(value: Record<string, unknown>, field: string, label: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result.trim()) throw new Error(`${label} ${field} must be a non-empty string`);
  return result.trim();
}

export function assertEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match the configured value`);
}

export function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} cannot be blank`);
  return value.trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cliFailure(stderr: string, stdout: string, code: number | null): string {
  const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
  return `Raft CLI command failed: ${detail.slice(0, 2_000)}`;
}

/**
 * Raft codes known to be permanent: retrying cannot succeed without human
 * action (fixing credentials, data or arguments). The CLI collapses every
 * non-5xx response into its own `<OP>_FAILED` family, so a `*_FAILED` code
 * alone is not a signal: it covers deterministic conflicts ("Task is already
 * assigned") as well as rate limits. `*_FAILED` is therefore permanent by
 * default, and only HTTP 429 / rate-limit summaries opt out.
 */
const PERMANENT_RAFT_CODES = new Set([
  "AMBIGUOUS_ID",
  "INVALID_ACTION",
  "INVALID_AGENT_ID",
  "INVALID_ARG",
  "INVALID_JSON",
  "INVALID_JSON_RESPONSE",
  "INVALID_REACTION",
  "INVALID_TARGET",
  "INTEGRATION_MANIFEST_INVALID",
  "INTEGRATION_MANIFEST_MISSING",
  "INTEGRATION_NOT_FOUND",
  "NOT_FOUND",
  "PROFILE_ENV_CONFLICT",
  "PROFILE_FILE_INVALID",
  "PROFILE_FILE_NOT_FOUND",
  "SCOPE_DENIED",
  "SEND_DRAFT_NOT_FOUND",
]);

/**
 * The CLI reports HTTP 429 through a `*_FAILED` code with the server's error
 * summary. A summary that clearly names the rate limit is the only `*_FAILED`
 * case that can succeed on retry.
 */
function isRateLimitSummary(summary: string | undefined): boolean {
  if (summary === undefined) return false;
  const lowered = summary.toLowerCase();
  return lowered.includes("http 429") || lowered.includes("rate limit")
    || lowered.includes("too many requests");
}

export class RaftCliCommandError extends Error {
  readonly raftCode: string | undefined;
  readonly summary: string | undefined;
  readonly permanent: boolean;

  constructor(stderr: string, stdout: string, exitCode: number | null) {
    super(cliFailure(stderr, stdout, exitCode));
    const detail = stderr.trim() || stdout.trim();
    this.raftCode = /^Code:\s*(\S+)$/m.exec(detail)?.[1];
    this.summary = /^Error:\s*(.+)$/m.exec(detail)?.[1]?.trim();
    this.permanent = this.raftCode !== undefined
      && (this.raftCode.startsWith("MISSING_") || this.raftCode.startsWith("TOKEN_")
        || PERMANENT_RAFT_CODES.has(this.raftCode)
        || (this.raftCode.endsWith("_FAILED") && !isRateLimitSummary(this.summary)));
  }
}

export function rejectedMutation(error: unknown): string | undefined {
  if (!(error instanceof RaftCliCommandError) || !error.permanent) return undefined;
  return error.summary ?? error.message;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Evidence payload for one resolved message, resolved against a sender profile when known. */
export function historyEvidence(
  message: HistoryMessage,
  place: RaftRemoteMessage["place"],
  sender?: RaftProfile,
): JsonValue {
  return {
    occurredAt: message.occurredAt,
    content: resolvedContent(message.remainder, sender?.description),
    sender: {
      kind: message.senderType,
      handle: `@${sender?.name ?? message.senderName}`,
      ...(sender?.displayName?.trim() ? { displayName: sender.displayName.trim() } : {}),
    },
    place: {
      kind: place.kind,
      visibility: place.visibility,
      label: safePlaceLabel(place.target, place.label),
    },
    audience: place.audience,
    visibility: place.visibility,
    ...(parseTarget(place.target).thread ? { replyDestination: place.target } : {}),
  };
}

/** Parse `raft channel info` output into a place; deterministic from its inputs. */
export function parseChannelInfo(output: string, target: string): RaftRemotePlace {
  const visibility = /^Visibility: (public|private)$/m.exec(output)?.[1];
  if (visibility !== "public" && visibility !== "private") throw new Error("Raft channel info did not report visibility");
  return {
    target,
    kind: "channel",
    visibility,
    label: target.replace(/^#/, ""),
    joined: /^Joined: yes$/m.test(output),
    ...(/^Muted: (yes|no)$/m.exec(output)?.[1]
      ? { muted: /^Muted: yes$/m.test(output) }
      : {}),
  };
}

/** Place evidence for a DM target (top-level or reply thread); no process side effect. */
export function dmPlaceEvidence(target: string): JsonValue {
  const parsed = parseTarget(target);
  return {
    kind: parsed.thread ? "reply_thread" : "dm",
    visibility: "private",
    label: safePlaceLabel(target),
  };
}

/** Place descriptor for a DM target (top-level or reply thread); no process side effect. */
export function dmPlaceFor(target: string): RaftRemoteMessage["place"] {
  const parsed = parseTarget(target);
  return {
    target,
    kind: parsed.thread ? "reply_thread" : "direct",
    visibility: "private",
    label: parsed.thread ? `${parsed.base} reply thread` : parsed.base,
    audience: parsed.thread
      ? `Members of ${parsed.base} can read this reply thread.`
      : `Only members of ${parsed.base} can read this DM.`,
  };
}

/**
 * Fast inbound signal classification that never depends on thread
 * membership. Returns undefined only when the signal needs the thread
 * membership check (a reply-thread target that is not a task/mention/dm).
 */
export function signalForFast(
  content: string,
  target: string,
  selfMember: { id: string; name: string },
): RaftRemoteMessage["signal"] | undefined {
  const task = taskAssignment(content);
  const taskAssignedToSelf = task?.assigneeType === "agent" && task.assigneeId === selfMember.id
    || task?.assigneeHandle?.replace(/^@/, "").toLowerCase() === selfMember.name.toLowerCase();
  if (taskAssignedToSelf) return "task";

  const mentionsSelf = new RegExp(
    `(^|\\W)@${escapeRegExp(selfMember.name)}(?:\\W|$)`,
    "i",
  ).test(content);
  if (mentionsSelf) return "mention";

  if (target.startsWith("dm:@")) return "direct_message";
  if (task) return "channel_activity";
  if (!parseTarget(target).thread) return "channel_activity";
  return undefined;
}

/**
 * Inbound signal classification for a received message. Deterministic from
 * its inputs; the caller resolves `inThread` (whether the self member
 * participates in the reply thread) through the CLI only when
 * `signalForFast` returned undefined.
 */
export function signalFor(
  content: string,
  target: string,
  selfMember: { id: string; name: string },
  inThread: boolean,
): RaftRemoteMessage["signal"] {
  const fast = signalForFast(content, target, selfMember);
  if (fast !== undefined) return fast;
  return inThread ? "thread_reply" : "channel_activity";
}
