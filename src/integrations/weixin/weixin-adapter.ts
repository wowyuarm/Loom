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
import type { AttachmentStore } from "../attachments/index.js";
import { parseAttachmentReference, type AttachmentReference } from "../../attachments/index.js";
import { createWeixinHttpRemote } from "./weixin-http.js";

const RECONNECT_DELAY_MS = 2_000;
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

export interface WeixinRemoteMessage {
  messageId?: string;
  from?: string;
  createTimeMs?: number;
  messageType?: "user" | "bot";
  messageState?: "finished" | "partial";
  contextToken?: string;
  items?: Array<{
    type?: "text" | "image";
    text?: string;
    image?: WeixinRemoteImage;
  }>;
}

export interface WeixinRemoteImage {
  encryptedQueryParam?: string;
  aesKey?: string;
  aesKeyHex?: string;
  fullUrl?: string;
}

export interface WeixinRemotePollResult {
  cursor?: string;
  messages?: WeixinRemoteMessage[];
}

export interface WeixinRemote {
  start(request: { baseUrl: string; token: string; signal: AbortSignal }): Promise<void>;
  poll(request: { baseUrl: string; token: string; cursor: string; signal: AbortSignal }): Promise<WeixinRemotePollResult>;
  downloadImage(request: {
    cdnBaseUrl: string;
    image: WeixinRemoteImage;
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
  stop(request: { baseUrl: string; token: string }): Promise<void>;
}

export interface WeixinAdapterStatus {
  state: "stopped" | "connecting" | "connected" | "degraded";
  lastPollAt?: string;
  lastError?: string;
}

export interface WeixinAdapter extends OutboundDelivery {
  start(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>): void;
  status(): WeixinAdapterStatus;
  stop(): Promise<void>;
}

export interface OpenWeixinAdapterOptions {
  configurationFile: string;
  authFile: string;
  stateFile: string;
  expectedRouteRef: string;
  attachmentStore: AttachmentStore;
  remote?: WeixinRemote;
}

export interface OpenConfiguredWeixinAdapterOptions extends Omit<OpenWeixinAdapterOptions, "expectedRouteRef"> {
  expectedRouteRef?: string;
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
  readonly #database: DatabaseSync;
  #state: WeixinAdapterStatus = { state: "stopped" };
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly configuration: WeixinConfiguration,
    private readonly remote: WeixinRemote,
    private readonly attachmentStore: AttachmentStore,
    stateFile: string,
  ) {
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
    return this.#state;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#controller?.abort();
    await this.#running;
    this.#state = { ...this.#state, state: "stopped" };
    this.#database.close();
  }

  async deliver(attempt: DeliveryAttemptRequest): Promise<DeliveryObservation> {
    if (attempt.routeRef !== this.configuration.routeRef) {
      return { status: "not_sent", error: `Weixin route does not own ${attempt.routeRef}` };
    }
    if (attempt.kind !== "message") {
      return { status: "not_sent", error: "Weixin accepts only message Effects" };
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
    }
  }

  async #run(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>, signal: AbortSignal): Promise<void> {
    let remoteStarted = false;
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
            signal,
          });
          if (signal.aborted) break;
          await this.#acceptPoll(response, acceptInput, signal);
          const now = new Date().toISOString();
          this.#writeState({ lastPollAt: now, lastError: null });
          this.#state = { state: "connected", lastPollAt: now };
        } catch (error) {
          if (signal.aborted) break;
          const message = errorMessage(error);
          remoteStarted = false;
          this.#writeState({ lastError: message });
          this.#state = { ...this.#state, state: "degraded", lastError: message };
          await waitForReconnect(signal);
        }
      }
    } finally {
      await this.remote.stop({ baseUrl: this.configuration.baseUrl, token: this.configuration.token }).catch(() => {});
    }
  }

  async #acceptPoll(
    response: WeixinRemotePollResult,
    acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const message of response.messages ?? []) {
      const input = await toRuntimeInput(
        message,
        this.configuration,
        this.remote,
        this.attachmentStore,
        signal,
      );
      if (!input) continue;
      await acceptInput(input);
      if (message.contextToken) this.#writeState({ contextToken: message.contextToken });
    }
    this.#writeState({
      ...(response.cursor !== undefined ? { cursor: response.cursor } : {}),
    });
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
  if (configuration.routeRef !== options.expectedRouteRef) {
    throw new Error(
      `Weixin route ${configuration.routeRef} does not match default Interaction Route ${options.expectedRouteRef}`,
    );
  }
  await mkdir(path.dirname(options.stateFile), { recursive: true });
  return new DefaultWeixinAdapter(
    configuration,
    options.remote ?? createWeixinHttpRemote(),
    options.attachmentStore,
    options.stateFile,
  );
}

export async function openConfiguredWeixinAdapter(
  options: OpenConfiguredWeixinAdapterOptions,
): Promise<WeixinAdapter | undefined> {
  const [hasConfiguration, hasAuth] = await Promise.all([
    fileExists(options.configurationFile),
    fileExists(options.authFile),
  ]);
  if (!hasConfiguration && !hasAuth) return undefined;
  if (!hasConfiguration || !hasAuth) {
    throw new Error("Weixin Integration requires both config.json and auth.json");
  }
  if (!options.expectedRouteRef) {
    throw new Error("Weixin Integration requires an Instance default Interaction Route");
  }
  return openWeixinAdapter({
    ...options,
    expectedRouteRef: options.expectedRouteRef,
  });
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
  if (message.from !== configuration.peerId || message.messageType !== "user" || message.messageState !== "finished") return undefined;
  if (!message.messageId) return undefined;
  const text = (message.items ?? [])
    .filter(item => item.type === "text")
    .map(item => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  const imageItems = (message.items ?? []).filter(item => item.type === "image" && item.image);
  if (imageItems.length > 1) throw new Error("Weixin first attachment slice accepts one image per message");
  const downloaded = imageItems[0]?.image
    ? await remote.downloadImage({
        cdnBaseUrl: configuration.cdnBaseUrl,
        image: imageItems[0].image,
        signal,
      })
    : undefined;
  const attachment = downloaded
    ? await attachmentStore.put({
        kind: "image",
        mediaType: downloaded.mediaType,
        ...(downloaded.fileName ? { fileName: downloaded.fileName } : {}),
        content: downloaded.content,
      })
    : undefined;
  if (!text && !attachment) return undefined;
  const occurredAt = message.createTimeMs === undefined ? undefined : new Date(message.createTimeMs);
  if (occurredAt && !Number.isFinite(occurredAt.getTime())) return undefined;
  return {
    source: "weixin",
    sourceId: message.messageId,
    kind: "interaction",
    payload: {
      ...(text ? { text } : {}),
      ...(attachment
        ? { attachments: [JSON.parse(JSON.stringify(attachment))] }
        : {}),
    },
    ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
  };
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

async function waitForReconnect(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, RECONNECT_DELAY_MS);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
