import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type {
  AcceptedInput,
  DeliveryAttemptRequest,
  DeliveryObservation,
  OutboundDelivery,
  RuntimeInput,
} from "../../runtime/index.js";
import type { AttachmentStore } from "../../attachments/index.js";
import type { InteractionChannel, InteractionChannelFailureCategory, InteractionChannelIngressStatus } from "../channel.js";
import type { InteractionChannelAgentSurface } from "../surface.js";
import { parseAttachmentReference, type AttachmentReference } from "../../attachments/index.js";
import { createWeixinHttpRemote } from "./weixin-http.js";
import { isWeixinSessionExpired, WeixinFailure } from "./weixin-failures.js";

/**
 * Deterministic, channel-namespaced opaque ref for one Weixin peer. The raw
 * peer id never reaches the model prompt; Delivery resolves attempts against
 * the same derivation so only this Channel's peer is a valid Destination.
 */
export function weixinOpaqueRef(kind: "place" | "destination", routeRef: string, peerId: string): string {
  const digest = createHash("sha256")
    .update(`${routeRef}\0${kind}\0${peerId}`)
    .digest("hex")
    .slice(0, 24);
  return `weixin:${kind}:${digest}`;
}

const RECONNECT_DELAY_MS = 2_000;
const FAILURE_BACKOFF_AFTER = 3;
const FAILURE_BACKOFF_DELAY_MS = 30_000;
/** An expired bot session is re-established outside the Channel. */
const SESSION_EXPIRED_DELAY_MS = 10 * 60_000;
const DEFAULT_POLL_TIMEOUT_MS = 40_000;
const MIN_POLL_TIMEOUT_MS = 5_000;
const MAX_POLL_TIMEOUT_MS = 60_000;
/**
 * Attempts one transiently failing inbound message gets before it is recorded
 * as failed. Bounded on purpose: a download that can never succeed must not
 * hold the cursor forever.
 */
const INBOUND_TRANSIENT_ATTEMPTS = 5;
const FAILED_INGRESS_LIMIT = 10;
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** Typing keepalive and the longest a single session may stay visible. */
const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_MAX_DURATION_MS = 2 * 60_000;
const TYPING_TICKET_TTL_MS = 24 * 60 * 60_000;
const TYPING_TICKET_RETRY_INITIAL_MS = 2_000;
const TYPING_TICKET_RETRY_MAX_MS = 60 * 60_000;

export interface WeixinTypingTimings {
  keepaliveMs: number;
  maxDurationMs: number;
}

export interface WeixinRetryTimings {
  /** Delay before re-polling after a single failure. */
  reconnectMs: number;
  /** Delay once failures repeat, instead of reconnecting in a tight loop. */
  failureBackoffMs: number;
  /** Delay after an expired bot session, which only re-authentication fixes. */
  sessionExpiredMs: number;
}

export interface WeixinRemoteMessage {
  messageId?: string;
  from?: string;
  createTimeMs?: number;
  messageType?: "user" | "bot";
  messageState?: "finished" | "partial";
  contextToken?: string;
  items?: Array<{
    type?: "text" | "image" | "voice" | "file" | "video";
    text?: string;
    image?: WeixinRemoteMedia;
    voice?: WeixinRemoteVoice;
    file?: WeixinRemoteMedia;
    video?: WeixinRemoteMedia;
  }>;
}

/**
 * One downloadable Weixin media item. `kind` names the wire item the media
 * came from, so a download failure and a stored Attachment say what actually
 * arrived instead of guessing from the bytes. `mediaType` and `fileName` are
 * that item's declared storage identity: an image's real type is still
 * verified from its bytes, while audio and video keep the type the wire
 * declared because the Channel cannot inspect those containers.
 */
export interface WeixinRemoteMedia {
  kind: "image" | "voice" | "file" | "video";
  mediaType?: string;
  fileName?: string;
  /** Video clip length as the wire item declared it. */
  playLengthMs?: number;
  encryptedQueryParam?: string;
  aesKey?: string;
  aesKeyHex?: string;
  fullUrl?: string;
}

export interface WeixinRemoteVoice {
  /**
   * Weixin's own transcription of the voice message. The Channel never runs
   * its own ASR: this is either what the platform already produced or absent.
   */
  text?: string;
  media: WeixinRemoteMedia;
}

export interface WeixinRemotePollResult {
  cursor?: string;
  /** Server-suggested duration for the next long poll. */
  longpollTimeoutMs?: number;
  messages?: WeixinRemoteMessage[];
}

export interface WeixinRemote {
  start(request: { baseUrl: string; token: string; signal: AbortSignal }): Promise<void>;
  poll(request: {
    baseUrl: string;
    token: string;
    cursor: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<WeixinRemotePollResult>;
  downloadMedia(request: {
    cdnBaseUrl: string;
    media: WeixinRemoteMedia;
    signal: AbortSignal;
  }): Promise<{ content: Uint8Array; mediaType: string; fileName?: string }>;
  sendText(request: {
    baseUrl: string;
    token: string;
    peerId: string;
    text: string;
    clientId: string;
    contextToken?: string;
  }): Promise<
    | { disposition: "sent"; remoteId: string }
    | { disposition: "rejected"; error: string; code?: number }
  >;
  sendAttachment(request: {
    baseUrl: string;
    cdnBaseUrl: string;
    token: string;
    peerId: string;
    text: string;
    attachment: AttachmentReference;
    content: Uint8Array;
    clientId: string;
    contextToken?: string;
  }): Promise<
    | { disposition: "sent"; remoteId: string }
    | { disposition: "rejected"; error: string; code?: number }
  >;
  /** Resolves the peer's typing ticket, or undefined when the peer offers no typing. */
  typingTicket(request: {
    baseUrl: string;
    token: string;
    peerId: string;
    contextToken?: string;
  }): Promise<string | undefined>;
  /** Publishes or cancels the peer's typing state. Failures are not authoritative. */
  sendTyping(request: {
    baseUrl: string;
    token: string;
    peerId: string;
    typingTicket: string;
    status: "typing" | "cancel";
  }): Promise<void>;
  stop(request: { baseUrl: string; token: string }): Promise<void>;
}

export interface WeixinAdapterStatus {
  state: "stopped" | "connecting" | "connected" | "degraded";
  lastPollAt?: string;
  lastError?: string;
  /** Channel-neutral ingress health: messages held for retry or given up on. */
  ingress?: InteractionChannelIngressStatus;
}

export interface WeixinAdapter extends InteractionChannel, OutboundDelivery {
  readonly id: "weixin";
  readonly label: "Weixin";
  start(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>): void;
  status(): WeixinAdapterStatus;
  stop(): Promise<void>;
}

export interface OpenWeixinAdapterOptions {
  configurationFile: string;
  authFile: string;
  stateFile: string;
  attachmentStore: AttachmentStore;
  remote?: WeixinRemote;
  /** Typing timings, resolved here so the adapter only executes parsed values. */
  typing?: WeixinTypingTimings;
  /** Retry timings, resolved here so the adapter only executes parsed values. */
  retry?: WeixinRetryTimings;
}


interface WeixinConfiguration {
  routeRef: string;
  peerId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
}

interface StateRow {
  cursor: string;
  context_token: string | null;
  last_poll_at: string | null;
  last_error: string | null;
}

class DefaultWeixinAdapter implements WeixinAdapter {
  readonly id = "weixin" as const;
  readonly label = "Weixin" as const;
  readonly #database: DatabaseSync;
  #state: WeixinAdapterStatus = { state: "stopped" };
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  /**
   * One best-effort typing session for the configured peer. A second accepted
   * message extends the same session instead of restarting it, so overlapping
   * inbound messages do not flicker the peer's typing state.
   */
  #typing: { keepalive: NodeJS.Timeout; deadline: NodeJS.Timeout } | undefined;
  #typingTicket: { value: string; expiresAt: number } | undefined;
  #typingTicketRetry: { retryAt: number; delayMs: number } | undefined;
  /** Ingress messages currently held for retry by message id. */
  #heldInbound = 0;
  #ingressAttempts = new Map<string, number>();
  #ingressFailures = new Map<string, { category: InteractionChannelFailureCategory; at: string }>();

  readonly routeRef: string;

  constructor(
    private readonly configuration: WeixinConfiguration,
    private readonly remote: WeixinRemote,
    private readonly attachmentStore: AttachmentStore,
    private readonly typingTimings: WeixinTypingTimings,
    private readonly retryTimings: WeixinRetryTimings,
    stateFile: string,
  ) {
    this.routeRef = configuration.routeRef;
    this.#database = new DatabaseSync(stateFile);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor TEXT NOT NULL DEFAULT '',
        context_token TEXT,
        last_poll_at TEXT,
        last_error TEXT
      ) STRICT;
      INSERT OR IGNORE INTO state (singleton) VALUES (1);
    `);
    const state = this.#readState();
    this.#state = {
      state: "stopped",
      ...(state.last_poll_at ? { lastPollAt: state.last_poll_at } : {}),
      ...(state.last_error ? { lastError: state.last_error } : {}),
    };
  }

  start(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>): void {
    if (this.#stopped) throw new Error("Weixin Adapter cannot start after stop");
    if (this.#running) return;
    this.#controller = new AbortController();
    this.#state = { ...this.#state, state: "connecting" };
    this.#running = this.#run(acceptInput, this.#controller.signal);
  }

  status(): WeixinAdapterStatus {
    const ingress = this.#ingressStatus();
    return { ...this.#state, ...(ingress ? { ingress } : {}) };
  }

  channelGuidance(): string {
    return [
      "Weixin is a private, ongoing direct conversation with the configured human.",
      "Write as ordinary social messaging rather than a formal report.",
      "One thought may be split into a few natural message bubbles.",
      "Do not turn separate bubbles into a burst of questions, and usually ask at most one question in one conversational turn.",
      "Let the exchange end naturally when no reply is needed.",
    ].join(" ");
  }

  agentSurface(): InteractionChannelAgentSurface {
    return {
      guidance: this.channelGuidance(),
      tools: { names: [], create: () => [] },
      defaultDestination: {
        destinationRef: weixinOpaqueRef("destination", this.configuration.routeRef, this.configuration.peerId),
        routeRef: this.configuration.routeRef,
        kind: "top_level",
        label: "Weixin peer",
      },
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#controller?.abort();
    // Cancelling typing is part of stopping, not of ingress or Delivery: a
    // failed cancel is bounded by the request timeout and cannot keep the
    // Channel from converging to stopped.
    await this.#endTyping();
    try {
      await this.#running;
    } finally {
      // Channel state converges even when remote shutdown failed; the failure
      // still propagates to the caller instead of being discarded.
      this.#state = { ...this.#state, state: "stopped" };
      this.#database.close();
    }
  }

  async deliver(attempt: DeliveryAttemptRequest): Promise<DeliveryObservation> {
    if (attempt.routeRef !== this.configuration.routeRef) {
      return { status: "not_sent", error: `Weixin route does not own ${attempt.routeRef}` };
    }
    if (attempt.kind !== "message") {
      return { status: "not_sent", error: "Weixin accepts only message Effects" };
    }
    const destinationRef = weixinOpaqueRef("destination", this.configuration.routeRef, this.configuration.peerId);
    if (!attempt.destinationRef || attempt.destinationRef !== destinationRef) {
      return { status: "not_sent", error: "Weixin Destination is unavailable to this Channel" };
    }
    let payload: ReturnType<typeof parseMessagePayload>;
    try {
      payload = parseMessagePayload(attempt.payload);
    } catch (error) {
      return { status: "not_sent", error: errorMessage(error) };
    }
    let attachmentContent: Buffer | undefined;
    if (payload.attachment) {
      try {
        attachmentContent = await this.attachmentStore.read(payload.attachment);
      } catch (error) {
        return { status: "not_sent", error: errorMessage(error) };
      }
    }
    try {
      const contextToken = this.#readState().context_token;
      const request = {
        baseUrl: this.configuration.baseUrl,
        token: this.configuration.token,
        peerId: this.configuration.peerId,
        text: payload.text,
        clientId: attempt.idempotencyKey,
        ...(contextToken ? { contextToken } : {}),
      };
      const send = (candidate: typeof request | Omit<typeof request, "contextToken">) => payload.attachment
        ? this.remote.sendAttachment({
            ...candidate,
            cdnBaseUrl: this.configuration.cdnBaseUrl,
            attachment: payload.attachment,
            content: attachmentContent!,
          })
        : this.remote.sendText(candidate);
      let result = await send(request);
      if (result.disposition === "rejected" && result.code === -14 && contextToken) {
        this.#database.prepare(`
          UPDATE state SET context_token = NULL
          WHERE singleton = 1 AND context_token = ?
        `).run(contextToken);
        const { contextToken: _expired, ...withoutContext } = request;
        result = await send(withoutContext);
      }
      if (result.disposition === "rejected") return { status: "not_sent", error: result.error };
      return { status: "delivered", remoteId: result.remoteId };
    } catch (error) {
      return { status: "unknown", error: errorMessage(error) };
    } finally {
      // The individual's answer exists once the attempt ran, whatever its
      // outcome, so the peer stops seeing typing instead of waiting for a
      // message the Channel already tried to send.
      await this.#endTyping();
    }
  }

  /**
   * Starts or extends the peer's typing state. Typing is lossy feedback: every
   * failure below is swallowed and can never change ingress, Delivery, or the
   * Channel's reported state.
   */
  #beginTyping(): void {
    if (this.#stopped) return;
    if (this.#typing) {
      clearTimeout(this.#typing.deadline);
      this.#typing.deadline = this.#typingDeadline();
      return;
    }
    const typing = {
      keepalive: setInterval(() => void this.#pingTyping("typing"), this.typingTimings.keepaliveMs),
      deadline: this.#typingDeadline(),
    };
    typing.keepalive.unref();
    this.#typing = typing;
    void this.#pingTyping("typing");
  }

  #typingDeadline(): NodeJS.Timeout {
    const deadline = setTimeout(() => void this.#endTyping(), this.typingTimings.maxDurationMs);
    deadline.unref();
    return deadline;
  }

  async #endTyping(): Promise<void> {
    const typing = this.#typing;
    if (!typing) return;
    this.#typing = undefined;
    clearInterval(typing.keepalive);
    clearTimeout(typing.deadline);
    await this.#pingTyping("cancel");
  }

  async #pingTyping(status: "typing" | "cancel"): Promise<void> {
    try {
      const typingTicket = await this.#resolveTypingTicket();
      if (!typingTicket) return;
      await this.remote.sendTyping({
        baseUrl: this.configuration.baseUrl,
        token: this.configuration.token,
        peerId: this.configuration.peerId,
        typingTicket,
        status,
      });
    } catch {
      // A rejected typing ticket, expired session, or transport failure only
      // costs the peer this indicator; it is not evidence about the message,
      // the Delivery, or the Channel's health.
    }
  }

  async #resolveTypingTicket(): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.#typingTicket;
    if (cached && now < cached.expiresAt) return cached.value;
    const retry = this.#typingTicketRetry;
    if (retry && now < retry.retryAt) return cached?.value;
    try {
      const contextToken = this.#readState().context_token;
      const typingTicket = await this.remote.typingTicket({
        baseUrl: this.configuration.baseUrl,
        token: this.configuration.token,
        peerId: this.configuration.peerId,
        ...(contextToken ? { contextToken } : {}),
      });
      if (!typingTicket) {
        this.#deferTypingTicket(now);
        return cached?.value;
      }
      this.#typingTicket = { value: typingTicket, expiresAt: now + TYPING_TICKET_TTL_MS };
      this.#typingTicketRetry = undefined;
      return typingTicket;
    } catch {
      // Refresh failure keeps a previously resolved ticket usable and backs
      // off so a broken ticket path cannot turn every message into a retry.
      this.#deferTypingTicket(now);
      return cached?.value;
    }
  }

  #deferTypingTicket(now: number): void {
    const delayMs = Math.min(
      (this.#typingTicketRetry?.delayMs ?? TYPING_TICKET_RETRY_INITIAL_MS / 2) * 2,
      TYPING_TICKET_RETRY_MAX_MS,
    );
    this.#typingTicketRetry = { retryAt: now + delayMs, delayMs };
  }

  async #run(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>, signal: AbortSignal): Promise<void> {
    let remoteStarted = false;
    let failures = 0;
    let pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS;
    try {
      while (!signal.aborted) {
        try {
          if (!remoteStarted) {
            await this.remote.start({
              baseUrl: this.configuration.baseUrl,
              token: this.configuration.token,
              signal,
            });
            remoteStarted = true;
          }
          const response = await this.remote.poll({
            baseUrl: this.configuration.baseUrl,
            token: this.configuration.token,
            cursor: this.#readState().cursor,
            timeoutMs: pollTimeoutMs,
            signal,
          });
          if (signal.aborted) break;
          if (response.longpollTimeoutMs !== undefined) {
            pollTimeoutMs = clampPollTimeout(response.longpollTimeoutMs);
          }
          await this.#acceptPoll(response, acceptInput, signal);
          const now = new Date().toISOString();
          this.#writeState({ lastPollAt: now, lastError: null });
          this.#state = { state: "connected", lastPollAt: now };
          failures = 0;
        } catch (error) {
          if (signal.aborted) break;
          const message = errorMessage(error);
          remoteStarted = false;
          this.#writeState({ lastError: message });
          this.#state = { ...this.#state, state: "degraded", lastError: message };
          // An expired bot session is re-established outside the Channel;
          // polling again after a long wait keeps the adapter from hammering
          // the API while the operator re-authenticates.
          if (isWeixinSessionExpired(error)) {
            await waitForReconnect(signal, this.retryTimings.sessionExpiredMs);
            continue;
          }
          failures += 1;
          await waitForReconnect(
            signal,
            failures >= FAILURE_BACKOFF_AFTER ? this.retryTimings.failureBackoffMs : this.retryTimings.reconnectMs,
          );
        }
      }
    } finally {
      // Await remote shutdown: stop() must not return while the remote may
      // still be delivering. A failed notify-stop is recorded instead of being
      // discarded or propagated: poll/abort failures already won precedence
      // inside the loop (degraded state / abort break), and propagating here
      // would block the Host's channel-state convergence.
      try {
        await this.remote.stop({ baseUrl: this.configuration.baseUrl, token: this.configuration.token });
      } catch (error) {
        // Preserve original poll/abort error precedence: only record the
        // failed notify-stop when no ingress failure already owns lastError.
        if (!this.#readState().last_error) {
          const message = errorMessage(error);
          this.#writeState({ lastError: message });
          this.#state = { ...this.#state, state: "degraded", lastError: message };
        }
      }
    }
  }

  async #acceptPoll(
    response: WeixinRemotePollResult,
    acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>,
    signal: AbortSignal,
  ): Promise<void> {
    const held: WeixinFailure[] = [];
    this.#heldInbound = 0;
    for (const message of response.messages ?? []) {
      const messageId = message.messageId ?? "";
      try {
        const input = await toRuntimeInput(
          message,
          this.configuration,
          this.remote,
          this.attachmentStore,
          signal,
        );
        // A message with nothing Loom can represent carries no Input; it is
        // not a failure and must not hold the cursor.
        if (!input) continue;
        await acceptInput(input);
        if (message.contextToken) this.#writeState({ contextToken: message.contextToken });
        // Typing starts only once the Runtime durably accepted the Input: the
        // peer should see the individual working on a message it will actually
        // answer, not on one ingress dropped.
        this.#beginTyping();
        this.#ingressAttempts.delete(messageId);
        this.#ingressFailures.delete(messageId);
      } catch (error) {
        const failure = toIngressFailure(error);
        if (failure.category === "invalid_message") {
          this.#recordFailedIngress(messageId, failure);
          continue;
        }
        const attempts = (this.#ingressAttempts.get(messageId) ?? 0) + 1;
        this.#ingressAttempts.set(messageId, attempts);
        if (attempts >= INBOUND_TRANSIENT_ATTEMPTS) {
          this.#recordFailedIngress(messageId, failure);
          continue;
        }
        held.push(failure);
        this.#heldInbound += 1;
      }
    }
    if (held.length > 0) {
      // Holding the cursor makes the remote replay this batch; already accepted
      // siblings come back as duplicates the Runtime already deduplicates, so
      // one unreadable message never hides the others or wedges the Channel.
      throw held[0];
    }
    this.#writeState({
      ...(response.cursor !== undefined ? { cursor: response.cursor } : {}),
    });
  }

  #recordFailedIngress(messageId: string, failure: WeixinFailure): void {
    this.#ingressAttempts.delete(messageId);
    this.#ingressFailures.delete(messageId);
    this.#ingressFailures.set(messageId, { category: failure.category, at: new Date().toISOString() });
    while (this.#ingressFailures.size > FAILED_INGRESS_LIMIT) {
      const oldest = this.#ingressFailures.keys().next();
      if (oldest.done) break;
      this.#ingressFailures.delete(oldest.value);
    }
  }

  #ingressStatus(): InteractionChannelIngressStatus | undefined {
    const failed = [...this.#ingressFailures.entries()];
    if (failed.length === 0 && this.#heldInbound === 0) return undefined;
    const times = failed.map(([, failure]) => failure.at).sort();
    const firstFailureAt = times[0];
    const lastFailureAt = times.at(-1);
    const latest = failed.at(-1);
    return {
      pending: 0,
      retrying: this.#heldInbound,
      failed: failed.length,
      // The Adapter holds no recovery spool: a message it cannot read is
      // either retried from the remote's own replay window or recorded above.
      spooled: 0,
      ...(firstFailureAt !== undefined && lastFailureAt !== undefined
        ? { firstFailureAt, lastFailureAt }
        : {}),
      ...(latest ? { lastFailureCategory: latest[1].category } : {}),
      failedItemIds: failed.map(([messageId]) => messageId),
    };
  }

  #readState(): StateRow {
    return this.#database.prepare(`
      SELECT cursor, context_token, last_poll_at, last_error FROM state WHERE singleton = 1
    `).get() as unknown as StateRow;
  }

  #writeState(update: {
    cursor?: string;
    contextToken?: string;
    lastPollAt?: string;
    lastError?: string | null;
  }): void {
    this.#database.prepare(`
      UPDATE state
      SET cursor = COALESCE(?, cursor),
          context_token = COALESCE(?, context_token),
          last_poll_at = COALESCE(?, last_poll_at),
          last_error = ?
      WHERE singleton = 1
    `).run(
      update.cursor ?? null,
      update.contextToken ?? null,
      update.lastPollAt ?? null,
      update.lastError ?? null,
    );
  }
}

export async function openWeixinAdapter(options: OpenWeixinAdapterOptions): Promise<WeixinAdapter> {
  const configuration = await loadConfiguration(options.configurationFile, options.authFile);
  await mkdir(path.dirname(options.stateFile), { recursive: true });
  return new DefaultWeixinAdapter(
    configuration,
    options.remote ?? createWeixinHttpRemote(),
    options.attachmentStore,
    options.typing ?? { keepaliveMs: TYPING_KEEPALIVE_MS, maxDurationMs: TYPING_MAX_DURATION_MS },
    options.retry ?? {
      reconnectMs: RECONNECT_DELAY_MS,
      failureBackoffMs: FAILURE_BACKOFF_DELAY_MS,
      sessionExpiredMs: SESSION_EXPIRED_DELAY_MS,
    },
    options.stateFile,
  );
}

export async function openConfiguredWeixinAdapter(
  options: OpenWeixinAdapterOptions,
): Promise<WeixinAdapter | undefined> {
  const [hasConfiguration, hasAuth] = await Promise.all([
    fileExists(options.configurationFile),
    fileExists(options.authFile),
  ]);
  if (!hasConfiguration && !hasAuth) return undefined;
  if (!hasConfiguration || !hasAuth) {
    throw new Error("Weixin Integration requires both config.json and auth.json");
  }
  return openWeixinAdapter(options);
}

async function loadConfiguration(configurationFile: string, authFile: string): Promise<WeixinConfiguration> {
  const [configurationDocument, authDocument] = await Promise.all([
    readJson(configurationFile, "Weixin configuration"),
    readJson(authFile, "Weixin auth"),
  ]);
  assertObject(configurationDocument, "Weixin configuration");
  assertExactKeys(configurationDocument, ["version", "routeRef", "peerId", "baseUrl", "cdnBaseUrl"], "Weixin configuration");
  assertObject(authDocument, "Weixin auth");
  assertExactKeys(authDocument, ["version", "token"], "Weixin auth");
  if (configurationDocument.version !== 1) throw new Error("Weixin configuration requires version: 1");
  if (authDocument.version !== 1) throw new Error("Weixin auth requires version: 1");
  return {
    routeRef: nonEmptyString(configurationDocument.routeRef, "Weixin configuration routeRef"),
    peerId: nonEmptyString(configurationDocument.peerId, "Weixin configuration peerId"),
    baseUrl: parseBaseUrl(configurationDocument.baseUrl),
    cdnBaseUrl: parseBaseUrl(configurationDocument.cdnBaseUrl, "Weixin configuration cdnBaseUrl", "https://novac2c.cdn.weixin.qq.com/c2c"),
    token: nonEmptyString(authDocument.token, "Weixin auth token"),
  };
}

async function toRuntimeInput(
  message: WeixinRemoteMessage,
  configuration: WeixinConfiguration,
  remote: WeixinRemote,
  attachmentStore: AttachmentStore,
  signal: AbortSignal,
): Promise<RuntimeInput | undefined> {
  // Wire-boundary filtering, not a defect: incoming messages that are not
  // from the configured peer, not a user message, or not finished are not
  // Inputs by contract and are silently dropped here.
  if (message.from !== configuration.peerId || message.messageType !== "user" || message.messageState !== "finished") return undefined;
  if (!message.messageId) return undefined;
  const items = message.items ?? [];
  const text = items
    .filter(item => item.type === "text")
    .map(item => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  const voiceItems = items.filter(item => item.type === "voice" && item.voice);
  const voice = voiceItems[0]?.voice;
  // Weixin transcribes voice messages on its own side. That transcript is the
  // peer's words and is preferred over the audio; only a voice message without
  // a transcript is worth persisting as audio.
  const transcription = voice?.text?.trim() ?? "";
  // One Input carries at most one attachment. Extra media in the same message
  // is dropped here rather than failing the whole message: the peer's text and
  // the first representable item still arrive.
  const selected = firstMediaItem(items, Boolean(transcription));
  const attachment = selected.media
    ? await attachmentStore.put({
        kind: "file",
        mediaType: selected.media.mediaType ?? "application/octet-stream",
        ...(selected.media.fileName ? { fileName: selected.media.fileName } : {}),
        content: (await remote.downloadMedia({
          cdnBaseUrl: configuration.cdnBaseUrl,
          media: selected.media,
          signal,
        })).content,
      })
    : undefined;
  // The peer's own words come first; what only the Channel can know — that a
  // voice message arrived untranscribed, or that a media item arrived — is
  // appended as a note. Inbound text is never rewritten.
  const composedText = [text, transcription, selected.note]
    .filter(value => Boolean(value))
    .join("\n");
  // A message that carries neither words nor anything downloadable produces no
  // Input; the wire contract keeps it out of the Runtime rather than surfacing
  // an empty interaction.
  if (!composedText && !attachment) return undefined;
  const occurredAt = message.createTimeMs === undefined ? undefined : new Date(message.createTimeMs);
  if (occurredAt && !Number.isFinite(occurredAt.getTime())) return undefined;
  const destinationRef = weixinOpaqueRef("destination", configuration.routeRef, configuration.peerId);
  return {
    source: "weixin",
    sourceId: message.messageId,
    kind: "interaction",
    payload: {
      ...(composedText ? { text: composedText } : {}),
      ...(attachment
        ? { attachments: [JSON.parse(JSON.stringify(attachment))] }
        : {}),
    },
    ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
    interaction: {
      routeRef: configuration.routeRef,
      signal: "direct_message",
      actor: { actorRef: "human", kind: "human" },
      place: {
        placeRef: weixinOpaqueRef("place", configuration.routeRef, configuration.peerId),
        kind: "direct",
        visibility: "private",
      },
      audience: {
        visibility: "private",
        description: "private conversation with the Weixin peer",
      },
      references: [],
      destinations: [{
        destinationRef,
        routeRef: configuration.routeRef,
        kind: "top_level",
        label: "Weixin peer",
      }],
      defaultDestinationRef: destinationRef,
    },
  };
}

/**
 * Picks the one media item an Input can carry and says in words what arrived,
 * so the model never has to infer a file or a video from an Attachment
 * reference alone. A voice transcript already carries the meaning of its
 * audio, so transcribed voice does not consume the single attachment slot.
 */
function firstMediaItem(
  items: NonNullable<WeixinRemoteMessage["items"]>,
  transcribed: boolean,
): { media?: WeixinRemoteMedia; note?: string } {
  const candidates: Array<{ media?: WeixinRemoteMedia; note?: string }> = items.map(item => {
    if (item.type === "image" && item.image) return { media: item.image };
    if (item.type === "voice" && item.voice) {
      if (transcribed) return {};
      return item.voice.media.fullUrl || item.voice.media.encryptedQueryParam
        ? { media: item.voice.media, note: "[语音]" }
        : { note: "[语音] 这条语音没有可用的转写，也没有可下载的音频" };
    }
    if (item.type === "file" && item.file) {
      const name = item.file.fileName;
      return name
        ? { media: item.file, note: `[文件: ${name}]` }
        : { media: item.file, note: "[文件]" };
    }
    if (item.type === "video" && item.video) return { media: item.video, note: "[视频]" };
    return {};
  });
  return candidates.find(candidate => candidate.media) ?? candidates.find(candidate => candidate.note) ?? {};
}

function parseMessagePayload(value: unknown): { text: string; attachment?: AttachmentReference } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Weixin message Effect requires a structured payload");
  }
  const payload = value as Record<string, unknown>;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const attachments = payload.attachments;
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length !== 1)) {
    throw new Error("Weixin message Effect accepts one attachment");
  }
  const attachment = Array.isArray(attachments)
    ? parseAttachmentReference(attachments[0], "Weixin outbound Attachment")
    : undefined;
  if (!text && !attachment) throw new Error("Weixin message Effect requires text or one attachment");
  return { text, ...(attachment ? { attachment } : {}) };
}

async function readJson(file: string, label: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${errorMessage(error)}`);
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has unsupported key ${key}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function parseBaseUrl(
  value: unknown,
  label = "Weixin configuration baseUrl",
  defaultValue = DEFAULT_BASE_URL,
): string {
  const source = value === undefined
    ? defaultValue
    : nonEmptyString(value, label);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${label} must be an absolute HTTP URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an absolute HTTP URL`);
  }
  return url.toString().replace(/\/$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Unknown failures stay transient on purpose: retrying a message Loom cannot
 * classify is recoverable, while dropping it would lose the peer's words.
 */
function toIngressFailure(error: unknown): WeixinFailure {
  return error instanceof WeixinFailure
    ? error
    : new WeixinFailure(errorMessage(error), "remote_unavailable");
}

function clampPollTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_POLL_TIMEOUT_MS;
  return Math.min(Math.max(timeoutMs, MIN_POLL_TIMEOUT_MS), MAX_POLL_TIMEOUT_MS);
}

async function waitForReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
