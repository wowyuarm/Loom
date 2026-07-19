import { isDeepStrictEqual } from "node:util";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  defineTool,
  estimateTokens,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  ToolTraceCompactionDetail,
  ToolTraceCompactionInput,
  ToolTraceCompactor,
} from "../agents/tool-trace-compactor.js";
import type { JsonValue } from "../runtime/index.js";
import type { ContextWindowState } from "./context.js";
import {
  readCommittedToolInteractions,
  readReferencedToolInteraction,
  type TranscriptToolInteraction,
} from "./transcript.js";

const BATCH_MAX_CALLS = 10;
const BATCH_MAX_TOKENS = 64_000;
const EXPANSION_PAGE_CHARACTERS = 40_000;
const COMPACTION_DETAILS = "loomToolInteractionCompaction";
const EXPANSION_DETAILS = "loomToolInteractionExpansion";

interface ToolCallLocation {
  messageIndex: number;
  blockIndex: number;
  toolCallId: string;
  toolName: string;
  callArguments: JsonValue;
}

interface RawInteraction extends ToolCallLocation {
  resultIndex: number;
  toolResult: {
    isError: boolean;
    content: JsonValue[];
  };
}

interface ExpandedInteraction extends ToolCallLocation {
  resultIndex: number;
  reference: string;
  offset: number;
  endOffset: number;
}

interface CompactionCandidate {
  interaction: RawInteraction;
  source: TranscriptToolInteraction;
  input: ToolTraceCompactionInput;
  inputTokens: number;
  truncated: boolean;
}

export function toolTraceCompactionRequired(messages: AgentMessage[], reservation: number): boolean {
  if (!Number.isFinite(reservation) || reservation < 0) {
    throw new Error("Tool trace reservation must be a finite non-negative number");
  }
  const collected = collectInteractions(messages);
  const rawTokens = [...collected.raw, ...collected.expanded].reduce((total, interaction) => {
    const callMessage = messages[interaction.messageIndex]!;
    if (callMessage.role !== "assistant" || !Array.isArray(callMessage.content)) {
      throw new Error(`Context tool call ${interaction.toolCallId} is not in an assistant message`);
    }
    const callBlock = callMessage.content[interaction.blockIndex];
    const result = messages[interaction.resultIndex]!;
    return total + estimateMessageTokens({ ...callMessage, content: callBlock ? [callBlock] : [] })
      + estimateMessageTokens(result);
  }, 0);
  return rawTokens >= reservation && rawTokens > 0;
}

export function isRawCompactableToolResult(message: AgentMessage): boolean {
  if (message.role !== "toolResult" || message.toolName === "message") return false;
  if (message.toolName === "expand_tool_result") return Boolean(expansionMetadata(message));
  return !compactionMetadata(message) && !compactedExpansionMetadata(message);
}

export async function compactCommittedToolTraces(options: {
  window: ContextWindowState;
  transcriptFile: string;
  compactor?: ToolTraceCompactor;
}): Promise<ContextWindowState> {
  const messages = restoreMessages(options.window.committedTrace);
  const collected = collectInteractions(messages);
  if (collected.raw.length === 0 && collected.expanded.length === 0) return options.window;
  if (collected.raw.length > 0 && !options.compactor) {
    throw new Error("Tool trace compaction is required but no Tool Trace Compactor is configured");
  }
  if (collected.raw.length > 0 && !options.window.transcriptAnchor) {
    throw new Error("Tool trace compaction requires a committed transcript anchor");
  }

  const sources = collected.raw.length === 0 ? [] : await readCommittedToolInteractions({
    transcriptFile: options.transcriptFile,
    transcriptAnchor: options.window.transcriptAnchor!,
    toolCallIds: collected.raw.map(interaction => interaction.toolCallId),
  });
  const sourceById = new Map(sources.map(source => [source.toolCallId, source]));
  const candidates = collected.raw.map(interaction => {
    const source = sourceById.get(interaction.toolCallId);
    if (!source
      || source.toolName !== interaction.toolName
      || !isDeepStrictEqual(source.callArguments, interaction.callArguments)
      || !isDeepStrictEqual(source.toolResult, interaction.toolResult)) {
      throw new Error(`Context tool interaction ${interaction.toolCallId} does not match transcript evidence`);
    }
    const bounded = boundCompactionInput({
      toolCallId: source.toolCallId,
      toolName: source.toolName,
      callArguments: source.callArguments,
      toolResult: source.toolResult,
    });
    return {
      interaction,
      source,
      input: bounded.input,
      inputTokens: bounded.tokens,
      truncated: bounded.truncated,
    };
  });
  const batches = batchCandidates(candidates);
  const details = (await Promise.all(batches.map(batch =>
    options.compactor!.compact(batch.map(candidate => candidate.input))))).flat();
  validateDetails(details, candidates.map(candidate => candidate.interaction.toolCallId));
  const detailsById = new Map(details.map(detail => [detail.toolCallId, detail]));
  const replacement = structuredClone(messages);

  for (const candidate of candidates) {
    const detail = detailsById.get(candidate.interaction.toolCallId)!;
    replaceRawInteraction(
      replacement,
      candidate.interaction,
      candidate.source.reference,
      candidate.truncated ? {
        ...detail,
        limitations: [
          ...detail.limitations,
          "The compactor received a bounded preview; the stable reference retains the complete original interaction.",
        ],
      } : detail,
    );
  }
  for (const expanded of collected.expanded) replaceExpandedInteraction(replacement, expanded);

  return {
    ...options.window,
    committedTrace: serializeMessages(replacement),
  };
}

export function createExpandTool(options: {
  window: ContextWindowState;
  transcriptFile: string;
}): ToolDefinition {
  const authorized = authorizedReferences(restoreMessages(options.window.committedTrace));
  return defineTool({
    name: "expand_tool_result",
    label: "Expand Tool Result",
    description: "Read one page of the original complete tool interaction identified by a reference in the current Context.",
    parameters: Type.Object({
      reference: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (_toolCallId, params) => {
      if (!authorized.has(params.reference)) {
        throw new Error("The tool interaction reference is not authorized by the current Context");
      }
      const interaction = await readReferencedToolInteraction({
        transcriptFile: options.transcriptFile,
        reference: params.reference,
      });
      const original = JSON.stringify({
        toolCall: {
          id: interaction.toolCallId,
          name: interaction.toolName,
          arguments: interaction.callArguments,
        },
        toolResult: {
          isError: interaction.toolResult.isError,
          content: interaction.toolResult.content.map(withoutImagePixels),
        },
      });
      const offset = params.offset ?? 0;
      if (offset > original.length) throw new Error("Expansion offset is outside the original interaction");
      const endOffset = Math.min(original.length, offset + EXPANSION_PAGE_CHARACTERS);
      const nextOffset = endOffset < original.length ? endOffset : null;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            type: "loom.tool-interaction.page",
            version: 1,
            reference: params.reference,
            offset,
            nextOffset,
            content: original.slice(offset, endOffset),
          }),
        }],
        details: {
          [EXPANSION_DETAILS]: {
            version: 1,
            reference: params.reference,
            offset,
            endOffset,
          },
        },
      };
    },
  });
}

function collectInteractions(messages: AgentMessage[]): {
  raw: RawInteraction[];
  expanded: ExpandedInteraction[];
} {
  const calls = new Map<string, ToolCallLocation>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (!block || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      if (calls.has(block.id)) throw new Error(`Context contains duplicate tool call ${block.id}`);
      calls.set(block.id, {
        messageIndex,
        blockIndex,
        toolCallId: block.id,
        toolName: block.name,
        callArguments: asJsonValue(block.arguments),
      });
    }
  }

  const raw: RawInteraction[] = [];
  const expanded: ExpandedInteraction[] = [];
  const results = new Set<string>();
  for (let resultIndex = 0; resultIndex < messages.length; resultIndex += 1) {
    const message = messages[resultIndex]!;
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    if (results.has(message.toolCallId)) throw new Error(`Context contains duplicate tool result ${message.toolCallId}`);
    results.add(message.toolCallId);
    const call = calls.get(message.toolCallId);
    if (!call || call.toolName !== message.toolName) {
      throw new Error(`Context contains a tool result without its matching call ${message.toolCallId}`);
    }
    if (message.toolName === "message" || compactionMetadata(message) || compactedExpansionMetadata(message)) continue;
    const expansion = expansionMetadata(message);
    if (message.toolName === "expand_tool_result") {
      if (expansion) expanded.push({ ...call, resultIndex, ...expansion });
      continue;
    }
    raw.push({
      ...call,
      resultIndex,
      toolResult: {
        isError: message.isError,
        content: message.content.map(asJsonValue),
      },
    });
  }
  return { raw, expanded };
}

function replaceRawInteraction(
  messages: AgentMessage[],
  interaction: RawInteraction,
  reference: string,
  detail: ToolTraceCompactionDetail,
): void {
  const callMessage = messages[interaction.messageIndex]!;
  if (callMessage.role !== "assistant" || !Array.isArray(callMessage.content)) {
    throw new Error(`Context tool call ${interaction.toolCallId} changed during compaction`);
  }
  const block = callMessage.content[interaction.blockIndex];
  if (!block || block.type !== "toolCall") {
    throw new Error(`Context tool call ${interaction.toolCallId} changed during compaction`);
  }
  callMessage.content[interaction.blockIndex] = {
    ...block,
    arguments: {
      type: "loom.tool-interaction.compacted-call",
      version: 1,
      reference,
      summary: detail.callSummary,
    },
  };
  const result = messages[interaction.resultIndex]!;
  if (result.role !== "toolResult") {
    throw new Error(`Context tool result ${interaction.toolCallId} changed during compaction`);
  }
  result.content = [{
    type: "text",
    text: JSON.stringify({
      type: "loom.tool-interaction.compacted",
      version: 1,
      reference,
      callSummary: detail.callSummary,
      resultSummary: detail.resultSummary,
      confirmedFacts: detail.confirmedFacts,
      sourceClaims: detail.sourceClaims,
      limitations: detail.limitations,
    }),
  }];
  result.details = { [COMPACTION_DETAILS]: { version: 1, reference } };
}

function replaceExpandedInteraction(messages: AgentMessage[], interaction: ExpandedInteraction): void {
  const callMessage = messages[interaction.messageIndex]!;
  if (callMessage.role !== "assistant" || !Array.isArray(callMessage.content)) return;
  const block = callMessage.content[interaction.blockIndex];
  if (!block || block.type !== "toolCall") return;
  callMessage.content[interaction.blockIndex] = {
    ...block,
    arguments: {
      type: "loom.tool-interaction.expansion-compacted",
      version: 1,
      reference: interaction.reference,
      offset: interaction.offset,
      endOffset: interaction.endOffset,
    },
  };
  const result = messages[interaction.resultIndex]!;
  if (result.role !== "toolResult") return;
  result.content = [{
    type: "text",
    text: JSON.stringify({
      type: "loom.tool-interaction.expansion-compacted",
      version: 1,
      reference: interaction.reference,
      offset: interaction.offset,
      endOffset: interaction.endOffset,
    }),
  }];
  result.details = {
    [COMPACTION_DETAILS]: {
      version: 1,
      reference: interaction.reference,
      expansion: true,
    },
  };
}

function batchCandidates(candidates: CompactionCandidate[]): CompactionCandidate[][] {
  const batches: CompactionCandidate[][] = [];
  let current: CompactionCandidate[] = [];
  let tokens = 0;
  for (const candidate of candidates) {
    if (current.length >= BATCH_MAX_CALLS
      || (current.length > 0 && tokens + candidate.inputTokens > BATCH_MAX_TOKENS)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(candidate);
    tokens += candidate.inputTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function boundCompactionInput(input: ToolTraceCompactionInput): {
  input: ToolTraceCompactionInput;
  tokens: number;
  truncated: boolean;
} {
  const originalTokens = estimateInputTokens(input);
  if (originalTokens <= BATCH_MAX_TOKENS) {
    return { input, tokens: originalTokens, truncated: false };
  }
  const argumentsText = JSON.stringify(input.callArguments);
  const resultText = JSON.stringify(input.toolResult.content);
  let previewCharacters = Math.max(1_000, Math.floor((argumentsText.length + resultText.length) / 2));
  while (true) {
    const bounded: ToolTraceCompactionInput = {
      ...input,
      callArguments: boundedPreview(argumentsText, previewCharacters),
      toolResult: {
        ...input.toolResult,
        content: [boundedPreview(resultText, previewCharacters)],
      },
    };
    const tokens = estimateInputTokens(bounded);
    if (tokens <= BATCH_MAX_TOKENS) {
      return { input: bounded, tokens, truncated: true };
    }
    if (previewCharacters <= 1_000) {
      throw new Error("A tool interaction cannot fit inside the compactor batch limit");
    }
    previewCharacters = Math.max(1_000, Math.floor(previewCharacters * 0.7));
  }
}

function boundedPreview(content: string, characters: number): JsonValue {
  const head = Math.ceil(characters / 2);
  const tail = Math.floor(characters / 2);
  return {
    type: "loom.bounded-json-preview",
    originalCharacters: content.length,
    content: content.length <= characters
      ? content
      : `${content.slice(0, head)}\n[...bounded by Harness...]\n${content.slice(-tail)}`,
  };
}

function validateDetails(details: ToolTraceCompactionDetail[], expectedIds: string[]): void {
  const fields = [
    "toolCallId",
    "callSummary",
    "resultSummary",
    "confirmedFacts",
    "sourceClaims",
    "limitations",
  ];
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  if (details.length !== expectedIds.length) {
    throw new Error("Tool Trace Compactor returned an incomplete replacement set");
  }
  for (const detail of details) {
    if (!detail
      || typeof detail !== "object"
      || Object.keys(detail).length !== fields.length
      || Object.keys(detail).some(key => !fields.includes(key))
      || typeof detail.toolCallId !== "string"
      || !expected.has(detail.toolCallId)
      || seen.has(detail.toolCallId)
      || typeof detail.callSummary !== "string"
      || !detail.callSummary.trim()
      || typeof detail.resultSummary !== "string"
      || !detail.resultSummary.trim()
      || !stringArray(detail.confirmedFacts)
      || !stringArray(detail.sourceClaims)
      || !stringArray(detail.limitations)) {
      throw new Error("Tool Trace Compactor returned a malformed replacement set");
    }
    seen.add(detail.toolCallId);
  }
}

function authorizedReferences(messages: AgentMessage[]): Set<string> {
  return new Set(messages.flatMap(message => {
    const metadata = compactionMetadata(message);
    return metadata ? [metadata.reference] : [];
  }));
}

function compactionMetadata(message: AgentMessage): { reference: string } | undefined {
  if (message.role !== "toolResult" || !message.details || typeof message.details !== "object") return undefined;
  const metadata = (message.details as Record<string, unknown>)[COMPACTION_DETAILS];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  return record.version === 1 && typeof record.reference === "string"
    ? { reference: record.reference }
    : undefined;
}

function expansionMetadata(message: AgentMessage): {
  reference: string;
  offset: number;
  endOffset: number;
} | undefined {
  if (message.role !== "toolResult" || !message.details || typeof message.details !== "object") return undefined;
  const metadata = (message.details as Record<string, unknown>)[EXPANSION_DETAILS];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  return record.version === 1
    && typeof record.reference === "string"
    && Number.isInteger(record.offset)
    && Number.isInteger(record.endOffset)
    ? {
        reference: record.reference,
        offset: record.offset as number,
        endOffset: record.endOffset as number,
      }
    : undefined;
}

function compactedExpansionMetadata(message: AgentMessage): boolean {
  const metadata = compactionMetadata(message);
  if (!metadata || message.role !== "toolResult" || !message.details || typeof message.details !== "object") return false;
  const record = (message.details as Record<string, unknown>)[COMPACTION_DETAILS];
  return Boolean(record && typeof record === "object" && (record as Record<string, unknown>).expansion === true);
}

function withoutImagePixels(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.type !== "image") return value;
  return {
    type: "image",
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    pixelContentOmitted: true,
  };
}

function estimateInputTokens(input: ToolTraceCompactionInput): number {
  return estimateMessageTokens({
    role: "user",
    content: [{ type: "text", text: JSON.stringify(input) }],
    timestamp: 0,
  });
}

function estimateMessageTokens(message: AgentMessage): number {
  return Math.max(0, estimateTokens(message));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function asJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Tool interaction contains a non-JSON value");
  return JSON.parse(serialized) as JsonValue;
}

function restoreMessages(messages: JsonValue[]): AgentMessage[] {
  return structuredClone(messages) as unknown as AgentMessage[];
}

function serializeMessages(messages: AgentMessage[]): JsonValue[] {
  return JSON.parse(JSON.stringify(messages)) as JsonValue[];
}
