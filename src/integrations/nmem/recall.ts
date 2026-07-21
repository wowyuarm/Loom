import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  NmemClient,
  NmemRequestError,
  type NmemClientOptions,
  type NmemMemoryEvidence,
} from "./client.js";

export interface NmemRecallToolOptions extends Omit<NmemClientOptions, "endpoint"> {
  endpoint?: string;
}

export interface NmemRecallDetails {
  type: "loom.nmem-recall";
  version: 1;
  status: "available" | "unavailable";
  query: string;
  results: NmemMemoryEvidence[];
  reason?: "not_configured" | "temporary" | "authentication" | "incompatible";
}

export function createNmemRecallTool(options: NmemRecallToolOptions): ToolDefinition {
  const client = options.endpoint
    ? new NmemClient({
        endpoint: options.endpoint,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      })
    : undefined;
  return defineTool({
    name: "nmem_recall",
    label: "Recall",
    description: [
      "Search external historical memory evidence only when older experience would materially help the current judgment.",
      "Results may be stale, incomplete, or wrong; verify important conclusions against evidence in the Agent Workspace.",
      "This searches nmem Memories, not conversation Threads.",
      "If nmem is unavailable, continue the current Turn without it.",
    ].join(" "),
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "A focused semantic query for the older experience that is actually needed.",
      }),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 10,
        default: 5,
        description: "Maximum number of Memory evidence items to return.",
      })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params): Promise<AgentToolResult<NmemRecallDetails>> => {
      const query = params.query.trim();
      if (!query) throw new Error("nmem_recall requires a non-blank query");
      if (!client) return unavailable(query, "not_configured");
      try {
        await client.requireCapabilities("memories", "search");
        const results = await client.searchMemories(query, params.limit ?? 5);
        return {
          content: [{
            type: "text" as const,
            text: results.length === 0
              ? "nmem found no matching external historical evidence."
              : `nmem returned ${results.length} external historical evidence item(s). Treat them as fallible leads and verify important conclusions in the Agent Workspace.`,
          }],
          details: {
            type: "loom.nmem-recall",
            version: 1,
            status: "available",
            query,
            results,
          },
        };
      } catch (error) {
        const reason = error instanceof NmemRequestError ? error.kind : "incompatible";
        return unavailable(query, reason);
      }
    },
  });
}

function unavailable(
  query: string,
  reason: NonNullable<NmemRecallDetails["reason"]>,
): AgentToolResult<NmemRecallDetails> {
  return {
    content: [{
      type: "text" as const,
      text: `nmem recall is unavailable (${reason}). Continue the current Turn without it.`,
    }],
    details: {
      type: "loom.nmem-recall",
      version: 1,
      status: "unavailable",
      query,
      results: [],
      reason,
    },
  };
}
