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
  items?: Array<{ type?: "text"; text?: string }>;
}

export interface WeixinRemotePollResult {
  cursor?: string;
  messages?: WeixinRemoteMessage[];
}

export interface WeixinRemote {
  start(request: { baseUrl: string; token: string; signal: AbortSignal }): Promise<void>;
  poll(request: { baseUrl: string; token: string; cursor: string; signal: AbortSignal }): Promise<WeixinRemotePollResult>;
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
  remote?: WeixinRemote;
}

export interface OpenConfiguredWeixinAdapterOptions extends Omit<OpenWeixinAdapterOptions, "expectedRouteRef"> {
  expectedRouteRef?: string;
}

interface WeixinConfiguration {
  routeRef: string;
  peerId: string;
  baseUrl: string;
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
    if (attempt.kind !== "message" || !isTextPayload(attempt.payload)) {
      return { status: "not_sent", error: "Weixin accepts only text message Effects" };
    }
    try {
      const contextToken = this.#readState().context_token;
      const request = {
        baseUrl: this.configuration.baseUrl,
        token: this.configuration.token,
        peerId: this.configuration.peerId,
        text: attempt.payload.text,
        clientId: attempt.idempotencyKey,
        ...(contextToken ? { contextToken } : {}),
      };
      let result = await this.remote.sendText(request);
      if (result.disposition === "rejected" && result.code === -14 && contextToken) {
        this.#database.prepare(`
          UPDATE state SET context_token = NULL
          WHERE singleton = 1 AND context_token = ?
        `).run(contextToken);
        const { contextToken: _expired, ...withoutContext } = request;
        result = await this.remote.sendText(withoutContext);
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
          await this.#acceptPoll(response, acceptInput);
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
  ): Promise<void> {
    for (const message of response.messages ?? []) {
      const input = toRuntimeInput(message, this.configuration.peerId);
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
  assertExactKeys(configurationDocument, ["version", "routeRef", "peerId", "baseUrl"], "Weixin configuration");
  assertObject(authDocument, "Weixin auth");
  assertExactKeys(authDocument, ["version", "token"], "Weixin auth");
  if (configurationDocument.version !== 1) throw new Error("Weixin configuration requires version: 1");
  if (authDocument.version !== 1) throw new Error("Weixin auth requires version: 1");
  return {
    routeRef: nonEmptyString(configurationDocument.routeRef, "Weixin configuration routeRef"),
    peerId: nonEmptyString(configurationDocument.peerId, "Weixin configuration peerId"),
    baseUrl: parseBaseUrl(configurationDocument.baseUrl),
    token: nonEmptyString(authDocument.token, "Weixin auth token"),
  };
}

function toRuntimeInput(message: WeixinRemoteMessage, peerId: string): RuntimeInput | undefined {
  if (message.from !== peerId || message.messageType !== "user" || message.messageState !== "finished") return undefined;
  if (!message.messageId) return undefined;
  const text = (message.items ?? [])
    .filter(item => item.type === "text")
    .map(item => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  if (!text) return undefined;
  const occurredAt = message.createTimeMs === undefined ? undefined : new Date(message.createTimeMs);
  if (occurredAt && !Number.isFinite(occurredAt.getTime())) return undefined;
  return {
    source: "weixin",
    sourceId: message.messageId,
    kind: "interaction",
    payload: { text },
    ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
  };
}

function isTextPayload(value: unknown): value is { text: string } {
  return typeof value === "object" && value !== null
    && "text" in value && typeof value.text === "string" && value.text.length > 0;
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

function parseBaseUrl(value: unknown): string {
  const source = value === undefined
    ? DEFAULT_BASE_URL
    : nonEmptyString(value, "Weixin configuration baseUrl");
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Weixin configuration baseUrl must be an absolute HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Weixin configuration baseUrl must be an absolute HTTP URL");
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
