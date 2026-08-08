import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import type { CloseActivityBusyReason, InteractionViewOptions, InteractionViewPage } from "../runtime/index.js";
import type { InteractionChannelIngressStatus } from "../channels/channel.js";

export type LoomAgentName =
  | "main-agent"
  | "orientation"
  | "life-recorder"
  | "attention-maintainer"
  | "memory-reflector"
  | "thread-maintainer";

export interface LoomAgentStatus {
  name: LoomAgentName;
  state: "running" | "retrying" | "never_run" | "succeeded" | "failed";
  nextRunAt?: string;
  latest?: {
    runId: string;
    name: LoomAgentName;
    startedAt: string;
    endedAt?: string;
    result: "running" | "succeeded" | "failed" | "interrupted";
    outcome?: string;
    failureCategory?: string;
  };
  history?: Array<NonNullable<LoomAgentStatus["latest"]>>;
}

export interface LoomCognitiveOrganWorkStatus {
  workId: string;
  organ: string;
  domainRef: string;
  status: string;
  attemptCount: number;
  createdAt: string;
  totalDeadlineAt: string;
  nextAttemptAt?: string;
  requeuedFrom?: string;
  lastCancelReason?: string;
  lastFailureCategory?: string;
  softDeadlineAt?: string;
  transcriptRef?: string;
  resultRef?: string;
}

export interface LoomIntegrationStatus {
  name: string;
  state: string;
  lastFailure?: { category: string };
  ingress?: InteractionChannelIngressStatus;
}

export type LoomModelStatus =
  | { state: "active"; revisionId: string; activatedAt: string }
  | {
      state: "degraded";
      revisionId: string;
      activatedAt: string;
      failedAt: string;
      failureCategory: string;
    }
  | { state: "blocked"; failedAt: string; failureCategory: string };

export interface LiveLoomStatusReport {
  schemaVersion: 1;
  observedAt: string;
  runId: string;
  host: {
    state: "open" | "running" | "stopping";
    version: string;
    startedAt: string;
  };
  model: LoomModelStatus;
  runtime: {
    activeTurn: boolean;
    pendingInputs: number;
    pendingEffects: number;
    deliveriesNeedingAttention: number;
    oldestPendingOrganAgeMs?: number;
    activityOverdueSince?: string;
    activityOverdueReason?: CloseActivityBusyReason;
    integrityWarnings: Array<{ kind: string; count: number }>;
  };
  agents: LoomAgentStatus[];
  cognitiveOrganWork: LoomCognitiveOrganWorkStatus[];
  channels: LoomIntegrationStatus[];
  integrations: LoomIntegrationStatus[];
}

export interface UnavailableLoomStatusReport {
  schemaVersion: 1;
  observedAt: string;
  host: { state: "unavailable" };
  agents: [];
  channels: [];
  integrations: [];
}

export type LoomStatusReport = LiveLoomStatusReport | UnavailableLoomStatusReport;

type StatusRequest =
  | { type: "status"; since?: string }
  | { type: "requeue_input"; inputId: string }
  | { type: "requeue_cognitive_organ"; workId: string }
  | { type: "retry_ingress"; channelId: string; itemId?: string }
  | { type: "history"; after?: string; limit?: number };
type StatusResponse =
  | { ok: true; type: "status"; report: LiveLoomStatusReport }
  | { ok: true; type: "requeue_input"; disposition: "requeued" | "not_blocked" }
  | { ok: true; type: "requeue_cognitive_organ"; disposition: "requeued" }
  | { ok: true; type: "retry_ingress"; retried: number }
  | { ok: true; type: "history"; page: InteractionViewPage }
  | { ok: false; error: string };
const MAX_STATUS_REQUEST_BYTES = 8 * 1024;

export interface LoomStatusServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createLoomStatusServer(options: {
  socketPath: string;
  read(since?: string): LiveLoomStatusReport;
  requeueInput(inputId: string): "requeued" | "not_blocked";
  requeueCognitiveOrganWork(workId: string): void;
  retryChannelIngress(channelId: string, itemId?: string): Promise<number>;
  interactionView(viewOptions?: InteractionViewOptions): InteractionViewPage;
}): LoomStatusServer {
  const socketPath = path.resolve(options.socketPath);
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  return {
    async start() {
      if (server) throw new Error("Loom status server has already started");
      await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await rm(socketPath, { force: true });
      const opened = createServer(socket => {
        sockets.add(socket);
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", chunk => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > MAX_STATUS_REQUEST_BYTES) {
            writeResponse(socket, { ok: false, error: "Loom status request is too large" });
            socket.end();
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          let request: StatusRequest;
          try {
            request = parseStatusRequest(buffer.slice(0, newline));
          } catch (error) {
            writeResponse(socket, { ok: false, error: errorMessage(error) });
            socket.end();
            return;
          }
          void handleRequest(request, socket);
        });
        async function handleRequest(request: StatusRequest, socket: Socket): Promise<void> {
          try {
            if (request.type === "retry_ingress") {
              writeResponse(socket, {
                ok: true,
                type: "retry_ingress",
                retried: await options.retryChannelIngress(request.channelId, request.itemId),
              });
            } else if (request.type === "requeue_input") {
              writeResponse(socket, {
                ok: true,
                type: "requeue_input",
                disposition: options.requeueInput(request.inputId),
              });
            } else if (request.type === "requeue_cognitive_organ") {
              options.requeueCognitiveOrganWork(request.workId);
              writeResponse(socket, { ok: true, type: "requeue_cognitive_organ", disposition: "requeued" });
            } else if (request.type === "history") {
              writeResponse(socket, {
                ok: true,
                type: "history",
                page: options.interactionView({
                  ...(request.after !== undefined ? { after: request.after } : {}),
                  ...(request.limit !== undefined ? { limit: request.limit } : {}),
                }),
              });
            } else {
              writeResponse(socket, { ok: true, type: "status", report: options.read(request.since) });
            }
          } catch (error) {
            // Only explicit recovery commands surface their operation error
            // (unknown work id, active attempt, ...) so rejections stay
            // distinguishable; every other request keeps the stable generic
            // failure so raw internals never leak through status output.
            const recovery = request.type === "requeue_input"
              || request.type === "requeue_cognitive_organ";
            writeResponse(socket, {
              ok: false,
              error: recovery ? errorMessage(error) : "Loom status is unavailable",
            });
          } finally {
            socket.end();
          }
        }
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => sockets.delete(socket));
      });
      server = opened;
      try {
        await new Promise<void>((resolve, reject) => {
          opened.once("error", reject);
          opened.once("listening", resolve);
          opened.listen(socketPath);
        });
        await chmod(socketPath, 0o600);
      } catch (error) {
        server = undefined;
        opened.close();
        await rm(socketPath, { force: true });
        throw error;
      }
    },
    async stop() {
      const opened = server;
      server = undefined;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (opened?.listening) {
        await new Promise<void>(resolve => opened.close(() => resolve()));
      }
      await rm(socketPath, { force: true });
    },
  };
}

export async function readLoomStatus(
  socketPath: string,
  options: { since?: string } = {},
): Promise<LoomStatusReport> {
  const socket = createConnection(path.resolve(socketPath));
  socket.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error instanceof Error && isUnavailable(error)) {
        resolve(unavailableReport());
        return;
      }
      reject(error);
    };
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error("Loom Host status endpoint closed without a response"));
    });
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as StatusResponse;
        if (!response.ok) throw new Error(response.error);
        if (response.type !== "status") throw new Error("Loom status endpoint returned the wrong response type");
        settled = true;
        socket.destroy();
        resolve(response.report);
      } catch (error) {
        fail(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      type: "status",
      ...(options.since ? { since: options.since } : {}),
    } satisfies StatusRequest)}\n`));
  });
}

export async function readLoomInteractionHistory(
  socketPath: string,
  options: { after?: string; limit?: number } = {},
): Promise<InteractionViewPage> {
  let response: Extract<StatusResponse, { ok: true }>;
  try {
    response = await sendStatusRequest(socketPath, {
      type: "history",
      ...(options.after !== undefined ? { after: options.after } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  } catch (error) {
    if (error instanceof Error && isUnavailable(error)) {
      throw new Error("Loom Host is not running; start it with `loom run` before reading history");
    }
    throw error;
  }
  if (response.type !== "history") {
    throw new Error("Loom status endpoint returned the wrong response type");
  }
  return response.page;
}

export async function retryLoomChannelIngress(
  socketPath: string,
  channelId: string,
  itemId?: string,
): Promise<number> {
  if (!channelId.trim()) throw new Error("Loom retry-ingress requires a Channel id");
  let response: Extract<StatusResponse, { ok: true }>;
  try {
    response = await sendStatusRequest(socketPath, {
      type: "retry_ingress",
      channelId: channelId.trim(),
      ...(itemId?.trim() ? { itemId: itemId.trim() } : {}),
    });
  } catch (error) {
    if (error instanceof Error && isUnavailable(error)) {
      throw new Error("Loom Host is not running; start it with `loom run` before retrying ingress");
    }
    throw error;
  }
  if (response.type !== "retry_ingress") {
    throw new Error("Loom status endpoint returned the wrong response type");
  }
  return response.retried;
}

export async function requeueLoomInput(
  socketPath: string,
  inputId: string,
): Promise<"requeued" | "not_blocked"> {
  if (!inputId.trim()) throw new Error("Loom requeue requires an Input id");
  let response: Extract<StatusResponse, { ok: true }>;
  try {
    response = await sendStatusRequest(socketPath, {
      type: "requeue_input",
      inputId: inputId.trim(),
    });
  } catch (error) {
    if (error instanceof Error && isUnavailable(error)) {
      throw new Error("Loom Host is not running; start it with `loom run` before requeueing Input");
    }
    throw error;
  }
  if (response.type !== "requeue_input") {
    throw new Error("Loom status endpoint returned the wrong response type");
  }
  return response.disposition;
}

export async function requeueLoomCognitiveOrganWork(
  socketPath: string,
  workId: string,
): Promise<"requeued"> {
  if (!workId.trim()) throw new Error("Loom requeue-organ requires a Cognitive Organ work id");
  let response: Extract<StatusResponse, { ok: true }>;
  try {
    response = await sendStatusRequest(socketPath, {
      type: "requeue_cognitive_organ",
      workId: workId.trim(),
    });
  } catch (error) {
    if (error instanceof Error && isUnavailable(error)) {
      throw new Error("Loom Host is not running; start it with `loom run` before requeueing Cognitive Organ work");
    }
    throw error;
  }
  if (response.type !== "requeue_cognitive_organ") {
    throw new Error("Loom status endpoint returned the wrong response type");
  }
  return response.disposition;
}

function parseStatusRequest(source: string): StatusRequest {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Loom status request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (request.type === "requeue_input") {
    if (typeof request.inputId !== "string" || !request.inputId.trim()) {
      throw new Error("Loom requeue requires an Input id");
    }
    return { type: "requeue_input", inputId: request.inputId.trim() };
  }
  if (request.type === "requeue_cognitive_organ") {
    if (typeof request.workId !== "string" || !request.workId.trim()) {
      throw new Error("Loom requeue-organ requires a Cognitive Organ work id");
    }
    return { type: "requeue_cognitive_organ", workId: request.workId.trim() };
  }
  if (request.type === "retry_ingress") {
    if (typeof request.channelId !== "string" || !request.channelId.trim()) {
      throw new Error("Loom retry-ingress requires a Channel id");
    }
    if (request.itemId !== undefined
      && (typeof request.itemId !== "string" || !request.itemId.trim())) {
      throw new Error("Loom retry-ingress item id must be a string");
    }
    return {
      type: "retry_ingress",
      channelId: request.channelId.trim(),
      ...(typeof request.itemId === "string" ? { itemId: request.itemId.trim() } : {}),
    };
  }
  if (request.type === "history") {
    if (request.after !== undefined && typeof request.after !== "string") {
      throw new Error("Loom history cursor must be a string");
    }
    if (request.limit !== undefined
      && (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1)) {
      throw new Error("Loom history limit must be a positive integer");
    }
    return {
      type: "history",
      ...(typeof request.after === "string" ? { after: request.after } : {}),
      ...(Number.isSafeInteger(request.limit) ? { limit: request.limit as number } : {}),
    };
  }
  if (request.type !== "status") throw new Error("Unsupported Loom status request");
  if (request.since !== undefined && typeof request.since !== "string") {
    throw new Error("Loom status since must be an ISO timestamp");
  }
  return {
    type: "status",
    ...(typeof request.since === "string" ? { since: request.since } : {}),
  };
}

async function sendStatusRequest(
  socketPath: string,
  request: StatusRequest,
): Promise<Extract<StatusResponse, { ok: true }>> {
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
      if (!settled) fail(new Error("Loom Host status endpoint closed without a response"));
    });
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as StatusResponse;
        if (!response.ok) throw new Error(response.error);
        settled = true;
        socket.destroy();
        resolve(response);
      } catch (error) {
        fail(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

function writeResponse(socket: Socket, response: StatusResponse): void {
  if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
}

function unavailableReport(): UnavailableLoomStatusReport {
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    host: { state: "unavailable" },
    agents: [],
    channels: [],
    integrations: [],
  };
}

function isUnavailable(error: Error): boolean {
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ECONNREFUSED" || code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
