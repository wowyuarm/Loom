import { createHash } from "node:crypto";

import {
  NmemClient,
  NmemRequestError,
  type NmemClientOptions,
} from "./client.js";

export interface NmemConnectionOptions extends Omit<NmemClientOptions, "endpoint"> {
  endpoint?: string;
}

export function createNmemConnection(options: NmemConnectionOptions): {
  client: NmemClient | undefined;
  connectionHash: string;
} {
  return {
    client: options.endpoint
      ? new NmemClient({
          endpoint: options.endpoint,
          ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
          ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        })
      : undefined,
    connectionHash: createHash("sha256")
      .update(`${options.endpoint ?? ""}\0${options.apiKey ?? ""}\0${options.spaceId ?? ""}`)
      .digest("hex"),
  };
}

export function classifyNmemError(error: unknown): NmemRequestError["kind"] {
  return error instanceof NmemRequestError ? error.kind : "incompatible";
}
