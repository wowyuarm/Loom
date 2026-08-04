import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

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

export interface LoomIntegrationStatus {
  name: string;
  state: string;
  lastFailure?: { category: string };
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
  };
  agents: LoomAgentStatus[];
  integrations: LoomIntegrationStatus[];
}

export interface UnavailableLoomStatusReport {
  schemaVersion: 1;
  observedAt: string;
  host: { state: "unavailable" };
  agents: [];
  integrations: [];
}

export type LoomStatusReport = LiveLoomStatusReport | UnavailableLoomStatusReport;

type StatusRequest = { type: "status"; since?: string };
type StatusResponse = { ok: true; report: LiveLoomStatusReport } | { ok: false; error: string };
const MAX_STATUS_REQUEST_BYTES = 8 * 1024;

export interface LoomStatusServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createLoomStatusServer(options: {
  socketPath: string;
  read(since?: string): LiveLoomStatusReport;
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
          try {
            writeResponse(socket, { ok: true, report: options.read(request.since) });
          } catch {
            writeResponse(socket, { ok: false, error: "Loom status is unavailable" });
          }
          socket.end();
        });
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

function parseStatusRequest(source: string): StatusRequest {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Loom status request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (request.type !== "status") throw new Error("Unsupported Loom status request");
  if (request.since !== undefined && typeof request.since !== "string") {
    throw new Error("Loom status since must be an ISO timestamp");
  }
  return {
    type: "status",
    ...(typeof request.since === "string" ? { since: request.since } : {}),
  };
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
