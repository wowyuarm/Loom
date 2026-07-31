import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import type {
  AcceptedInput,
  DeliveryAttemptRequest,
  DeliveryObservation,
  InteractionViewEntry,
  InteractionViewOptions,
  InteractionViewPage,
  OutboundDelivery,
  RuntimeInput,
  RuntimeInputOutcome,
} from "../../runtime/index.js";

export const LOCAL_INTERACTION_ROUTE = "local";

const DEFAULT_WAIT_INTERVAL_MS = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 64 * 1024;

export interface LocalInteractionChannelStatus {
  state: "stopped" | "starting" | "listening" | "degraded";
  socketPath: string;
  lastError?: string;
}

export interface LocalInteractionChannelHandlers {
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  interactionView(options?: InteractionViewOptions): InteractionViewPage;
  inputOutcome(inputId: string): RuntimeInputOutcome;
}

export interface LocalInteractionChannel extends OutboundDelivery {
  start(handlers: LocalInteractionChannelHandlers): Promise<void>;
  status(): LocalInteractionChannelStatus;
  stop(): Promise<void>;
}

export interface OpenLocalInteractionChannelOptions {
  socketPath: string;
  waitIntervalMs?: number;
  waitTimeoutMs?: number;
}

type LocalRequest =
  | { type: "chat"; sourceId: string; text: string }
  | { type: "history"; after?: string; limit?: number };

type LocalResponse =
  | {
      ok: true;
      type: "chat";
      inputId: string;
      outcome: Exclude<RuntimeInputOutcome, { state: "pending" }>;
      entries: InteractionViewEntry[];
    }
  | { ok: true; type: "history"; page: InteractionViewPage }
  | { ok: false; error: string };

class DefaultLocalInteractionChannel implements LocalInteractionChannel {
  readonly #socketPath: string;
  readonly #waitIntervalMs: number;
  readonly #waitTimeoutMs: number;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #handlers: LocalInteractionChannelHandlers | undefined;
  #state: LocalInteractionChannelStatus["state"] = "stopped";
  #lastError: string | undefined;

  constructor(options: OpenLocalInteractionChannelOptions) {
    this.#socketPath = path.resolve(options.socketPath);
    this.#waitIntervalMs = positiveDuration(options.waitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS, "waitIntervalMs");
    this.#waitTimeoutMs = positiveDuration(options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, "waitTimeoutMs");
  }

  async start(handlers: LocalInteractionChannelHandlers): Promise<void> {
    if (this.#server) throw new Error("Local Interaction Channel has already started");
    this.#handlers = handlers;
    this.#state = "starting";
    await mkdir(path.dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    await rm(this.#socketPath, { force: true });
    const server = createServer(socket => this.#handleSocket(socket));
    this.#server = server;
    server.on("error", error => {
      this.#lastError = error.message;
      this.#state = "degraded";
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#socketPath);
      });
      await chmod(this.#socketPath, 0o600);
      this.#state = "listening";
      this.#lastError = undefined;
    } catch (error) {
      this.#state = "degraded";
      this.#lastError = errorMessage(error);
      await this.stop();
      throw error;
    }
  }

  status(): LocalInteractionChannelStatus {
    return {
      state: this.#state,
      socketPath: this.#socketPath,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  async deliver(attempt: DeliveryAttemptRequest): Promise<DeliveryObservation> {
    if (attempt.routeRef !== LOCAL_INTERACTION_ROUTE) {
      return { status: "not_sent", error: `Local route does not own ${attempt.routeRef}` };
    }
    if (attempt.kind !== "message") {
      return { status: "not_sent", error: "Local route accepts only message Effects" };
    }
    return { status: "delivered", remoteId: `local:${attempt.effectId}` };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (server?.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(this.#socketPath, { force: true });
    this.#handlers = undefined;
    this.#state = "stopped";
  }

  #handleSocket(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let tail = Promise.resolve();
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        writeResponse(socket, { ok: false, error: "Local request is too large" });
        socket.end();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        tail = tail.then(() => this.#handleLine(socket, line));
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => this.#sockets.delete(socket));
  }

  async #handleLine(socket: Socket, line: string): Promise<void> {
    try {
      const request = parseRequest(line);
      const handlers = this.#handlers;
      if (!handlers) throw new Error("Local Interaction Channel is not running");
      if (request.type === "history") {
        writeResponse(socket, {
          ok: true,
          type: "history",
          page: handlers.interactionView({
            ...(request.after !== undefined ? { after: request.after } : {}),
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
          }),
        });
        return;
      }
      const cursor = latestCursor(handlers.interactionView);
      const accepted = await handlers.acceptInput({
        source: "local",
        sourceId: request.sourceId,
        kind: "interaction",
        payload: { text: request.text },
      });
      const outcome = await this.#waitForOutcome(handlers, accepted.inputId);
      const entries = readAfter(handlers.interactionView, cursor)
        .filter(entry => entry.actor === "individual" && entry.inputIds.includes(accepted.inputId));
      writeResponse(socket, { ok: true, type: "chat", inputId: accepted.inputId, outcome, entries });
    } catch (error) {
      writeResponse(socket, { ok: false, error: errorMessage(error) });
    }
  }

  async #waitForOutcome(
    handlers: LocalInteractionChannelHandlers,
    inputId: string,
  ): Promise<Exclude<RuntimeInputOutcome, { state: "pending" }>> {
    const deadline = Date.now() + this.#waitTimeoutMs;
    while (true) {
      const outcome = handlers.inputOutcome(inputId);
      if (outcome.state !== "pending") return outcome;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the local Input to finish");
      await new Promise<void>(resolve => setTimeout(resolve, this.#waitIntervalMs));
    }
  }
}

export function openLocalInteractionChannel(
  options: OpenLocalInteractionChannelOptions,
): LocalInteractionChannel {
  return new DefaultLocalInteractionChannel(options);
}

export async function sendLocalChat(options: {
  socketPath: string;
  text: string;
  sourceId?: string;
}): Promise<{ inputId: string; outcome: Exclude<RuntimeInputOutcome, { state: "pending" }>; entries: InteractionViewEntry[] }> {
  const text = options.text.trim();
  if (!text) throw new Error("Local chat text cannot be blank");
  const response = await localRequest(options.socketPath, {
    type: "chat",
    sourceId: options.sourceId ?? randomUUID(),
    text,
  });
  if (response.type !== "chat") throw new Error("Local channel returned the wrong response type");
  return { inputId: response.inputId, outcome: response.outcome, entries: response.entries };
}

export async function readLocalInteractionHistory(options: {
  socketPath: string;
  after?: string;
  limit?: number;
}): Promise<InteractionViewPage> {
  const response = await localRequest(options.socketPath, {
    type: "history",
    ...(options.after !== undefined ? { after: options.after } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  if (response.type !== "history") throw new Error("Local channel returned the wrong response type");
  return response.page;
}

async function localRequest(socketPath: string, request: LocalRequest): Promise<Extract<LocalResponse, { ok: true }>> {
  const socket = createConnection(path.resolve(socketPath));
  socket.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error("Local channel closed without a response"));
    });
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as LocalResponse;
        if (!response.ok) throw new Error(response.error);
        settled = true;
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

function latestCursor(read: LocalInteractionChannelHandlers["interactionView"]): string | undefined {
  let after: string | undefined;
  while (true) {
    const page = read({ ...(after ? { after } : {}), limit: 500 });
    after = page.cursor ?? after;
    if (!page.hasMore) return after;
  }
}

function readAfter(
  read: LocalInteractionChannelHandlers["interactionView"],
  after: string | undefined,
): InteractionViewEntry[] {
  const entries: InteractionViewEntry[] = [];
  let cursor = after;
  while (true) {
    const page = read({ ...(cursor ? { after: cursor } : {}), limit: 500 });
    entries.push(...page.entries);
    cursor = page.cursor ?? cursor;
    if (!page.hasMore) return entries;
  }
}

function parseRequest(line: string): LocalRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Local request must be one JSON object per line");
  }
  if (!isObject(value) || typeof value.type !== "string") throw new Error("Local request type is required");
  if (value.type === "chat") {
    if (typeof value.sourceId !== "string" || !value.sourceId.trim()) {
      throw new Error("Local chat sourceId is required");
    }
    if (typeof value.text !== "string" || !value.text.trim()) throw new Error("Local chat text cannot be blank");
    return { type: "chat", sourceId: value.sourceId.trim(), text: value.text.trim() };
  }
  if (value.type === "history") {
    if (value.after !== undefined && typeof value.after !== "string") {
      throw new Error("Local history cursor must be a string");
    }
    if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1)) {
      throw new Error("Local history limit must be a positive integer");
    }
    return {
      type: "history",
      ...(value.after !== undefined ? { after: value.after as string } : {}),
      ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
    };
  }
  throw new Error(`Unsupported local request type: ${value.type}`);
}

function writeResponse(socket: Socket, response: LocalResponse): void {
  if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Local ${label} must be positive`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
