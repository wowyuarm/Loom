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

/** Evidence text is what the Main Agent actually reads; `details` never reaches the model. */
const MAX_VISIBLE_EVIDENCE_CHARS = 12_000;

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
            text: visibleEvidence(results),
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

function visibleEvidence(results: NmemMemoryEvidence[]): string {
  if (results.length === 0) return "nmem found no matching external historical evidence.";
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const [index, item] of results.entries()) {
    const block = evidenceBlock(index, item);
    if (used + block.length > MAX_VISIBLE_EVIDENCE_CHARS) {
      omitted = results.length - index;
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return [
    `nmem returned ${results.length} external historical evidence item(s). Treat them as fallible leads and verify important conclusions in the Agent Workspace.`,
    "",
    blocks.join("\n\n"),
    ...(omitted > 0
      ? ["", `(${omitted} further item(s) omitted to keep this recall bounded; narrow the query or lower the limit for the rest.)`]
      : []),
  ].join("\n");
}

function evidenceBlock(index: number, item: NmemMemoryEvidence): string {
  const facts = [
    `reference: ${item.reference}`,
    ...(item.eventDate ? [`eventDate: ${item.eventDate}`] : []),
    ...(item.recordedAt ? [`recordedAt: ${item.recordedAt}`] : []),
    ...(item.source ? [`source: ${item.source}`] : []),
    ...(item.unitType ? [`unitType: ${item.unitType}`] : []),
    `relevance: ${item.relevance}`,
  ].join(" | ");
  return [
    `${index + 1}. ${item.title ?? "Untitled"}`,
    facts,
    ...(item.relevanceReason ? [`reason: ${item.relevanceReason}`] : []),
    item.content,
    ...(item.contentTruncated ? ["(content truncated)"] : []),
  ].join("\n");
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
