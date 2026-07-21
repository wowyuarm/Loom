import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import type {
  ActivityFreezeRequest,
  FrozenActivityEvent,
  JsonValue,
  TranscriptAnchor,
} from "../runtime/index.js";

interface VerifyTranscriptEntryRequest {
  transcriptFile: string;
  sessionId: string;
  entryId: string;
}

export interface InputAnnotationReference {
  inputId: string;
  annotationEntryId: string;
}

interface VerifyTranscriptEvidenceRequest {
  transcriptFile: string;
  sessionId: string;
  inputs: InputAnnotationReference[];
  terminalToolNames?: string[];
}

export interface VerifiedTranscriptEvidence {
  inputAnchors: Array<{
    inputId: string;
    transcriptAnchor: TranscriptAnchor;
  }>;
  transcriptAnchor: TranscriptAnchor;
}

export interface TranscriptToolInteraction {
  reference: string;
  toolCallId: string;
  toolName: string;
  callArguments: JsonValue;
  toolResult: {
    isError: boolean;
    content: JsonValue[];
  };
}

export async function readCommittedActivityEvents(request: {
  transcriptFile: string;
  startAnchor?: TranscriptAnchor;
  endAnchor: TranscriptAnchor;
  inputs: ActivityFreezeRequest["inputs"];
  turns: ActivityFreezeRequest["turns"];
}): Promise<FrozenActivityEvent[]> {
  if (request.startAnchor && request.startAnchor.sessionId !== request.endAnchor.sessionId) {
    throw new Error("Activity transcript range cannot cross sessions");
  }
  const branch = await readBranchToEntry(
    request.transcriptFile,
    request.endAnchor.sessionId,
    request.endAnchor.entryId,
  );
  assertCompleteToolInteractions(branch, request.transcriptFile);
  const startIndex = request.startAnchor
    ? branch.findIndex(entry => entry.id === request.startAnchor!.entryId)
    : -1;
  if (request.startAnchor && startIndex < 0) {
    throw new Error(`Activity start ${request.startAnchor.entryId} is not an ancestor of its closing anchor`);
  }
  const inputs = new Map(request.inputs.map(input => [input.id, input]));
  const turnByInput = new Map(request.turns.flatMap(turn => turn.inputIds.map(inputId => [inputId, turn.id] as const)));
  const observedInputs = new Set<string>();
  const events: FrozenActivityEvent[] = [];
  const entries = branch.slice(startIndex + 1);
  let currentTurnId: string | undefined;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type === "custom" && entry.customType === "loom.input.v1") {
      const data = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`Transcript input annotation ${entry.id} has invalid data`);
      }
      const inputId = (data as Record<string, unknown>).inputId;
      const input = typeof inputId === "string" ? inputs.get(inputId) : undefined;
      const turnId = typeof inputId === "string" ? turnByInput.get(inputId) : undefined;
      const userEntry = entries[index + 1];
      if (!input
        || !turnId
        || observedInputs.has(input.id)
        || (data as Record<string, unknown>).turnId !== turnId
        || (data as Record<string, unknown>).kind !== input.kind
        || (data as Record<string, unknown>).occurredAt !== input.occurredAt
        || !isDeepStrictEqual((data as Record<string, unknown>).payload, input.payload)
        || userEntry?.type !== "message"
        || userEntry.parentId !== entry.id
        || !isMessageRole(userEntry, "user")) {
        throw new Error(`Transcript input annotation ${entry.id} does not match Runtime evidence`);
      }
      currentTurnId = turnId;
      observedInputs.add(input.id);
      events.push({
        eventId: `input:${input.id}`,
        turnId,
        at: input.occurredAt,
        actorRef: input.kind === "interaction" ? "human" : "system",
        kind: "input",
        content: structuredClone(input.payload),
      });
      index += 1;
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === "user") {
      throw new Error(`Transcript user entry ${entry.id} has no matching Runtime Input annotation`);
    }
    if (message.role === "assistant") {
      if (!currentTurnId) throw new Error(`Transcript assistant entry ${entry.id} has no owning Turn`);
      if (!Array.isArray(message.content)) continue;
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
        const block = message.content[blockIndex];
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        const type = (block as Record<string, unknown>).type;
        const kind = type === "thinking"
          ? "thinking"
          : type === "toolCall"
            ? "tool_call"
            : "output";
        events.push({
          eventId: `transcript:${entry.id}:${blockIndex}`,
          turnId: currentTurnId,
          at: transcriptEntryTime(entry),
          actorRef: "individual",
          kind,
          content: asJsonValue(block),
        });
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (!currentTurnId) throw new Error(`Transcript tool result ${entry.id} has no owning Turn`);
      events.push({
        eventId: `transcript:${entry.id}`,
        turnId: currentTurnId,
        at: transcriptEntryTime(entry),
        actorRef: "system",
        kind: "tool_result",
        content: asJsonValue({
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          content: message.content,
        }),
      });
    }
  }

  for (const input of request.inputs) {
    if (observedInputs.has(input.id)) continue;
    const turnId = turnByInput.get(input.id);
    if (!turnId) throw new Error(`Runtime Input ${input.id} has no owning Turn`);
    events.push({
      eventId: `input:${input.id}`,
      turnId,
      at: input.occurredAt,
      actorRef: input.kind === "interaction" ? "human" : "system",
      kind: "input",
      content: structuredClone(input.payload),
    });
  }
  return events;
}

interface TranscriptHeader extends Record<string, unknown> {
  type: "session";
  id: string;
}

interface TranscriptEntry extends Record<string, unknown> {
  id: string;
  parentId: string | null;
}

export async function verifyPrimaryTranscriptEntry(
  request: VerifyTranscriptEntryRequest,
): Promise<TranscriptAnchor> {
  const branch = await readSelectedBranch(request.transcriptFile, request.sessionId);
  if (!branch.some(entry => entry.id === request.entryId)) {
    throw new Error(`Transcript entry ${request.entryId} is not on the selected branch`);
  }
  return { sessionId: request.sessionId, entryId: request.entryId };
}

export async function verifyPrimaryTranscriptEvidence(
  request: VerifyTranscriptEvidenceRequest,
): Promise<VerifiedTranscriptEvidence> {
  const branch = await readSelectedBranch(request.transcriptFile, request.sessionId);
  assertCompleteToolInteractions(branch, request.transcriptFile);
  const inputAnchors = request.inputs.map(input => {
    const annotationIndex = branch.findIndex(entry => entry.id === input.annotationEntryId);
    const annotation = branch[annotationIndex];
    const userEntry = branch[annotationIndex + 1];
    const data = annotation?.data;
    const message = userEntry?.message;
    if (annotationIndex < 0
      || annotation?.type !== "custom"
      || annotation.customType !== "loom.input.v1"
      || !data
      || typeof data !== "object"
      || (data as Record<string, unknown>).inputId !== input.inputId
      || userEntry?.parentId !== annotation.id
      || userEntry.type !== "message"
      || !message
      || typeof message !== "object"
      || (message as Record<string, unknown>).role !== "user") {
      throw new Error(`Transcript does not contain verified evidence for Input ${input.inputId}`);
    }
    return {
      inputId: input.inputId,
      transcriptAnchor: { sessionId: request.sessionId, entryId: userEntry.id },
    };
  });
  const leaf = branch.at(-1);
  if (!leaf) throw new Error(`Transcript ${request.transcriptFile} has no selected leaf`);
  assertCompletedTurn(branch, request.transcriptFile, new Set(request.terminalToolNames ?? []));
  return {
    inputAnchors,
    transcriptAnchor: { sessionId: request.sessionId, entryId: leaf.id },
  };
}

export async function readCommittedToolInteractions(request: {
  transcriptFile: string;
  transcriptAnchor: TranscriptAnchor;
  toolCallIds: string[];
}): Promise<TranscriptToolInteraction[]> {
  if (new Set(request.toolCallIds).size !== request.toolCallIds.length) {
    throw new Error("Context contains duplicate tool call IDs");
  }
  const branch = await readBranchToEntry(
    request.transcriptFile,
    request.transcriptAnchor.sessionId,
    request.transcriptAnchor.entryId,
  );
  const expected = new Set(request.toolCallIds);
  const calls = toolCallsOnBranch(branch, request.transcriptFile);
  const interactions = new Map<string, TranscriptToolInteraction>();
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string" || !expected.has(message.toolCallId)) continue;
    const call = calls.get(message.toolCallId);
    if (!call
      || typeof message.toolName !== "string"
      || message.toolName !== call.toolName
      || !Array.isArray(message.content)
      || typeof message.isError !== "boolean"
      || interactions.has(message.toolCallId)) {
      throw new Error(`Transcript does not contain one complete interaction for tool call ${message.toolCallId}`);
    }
    interactions.set(message.toolCallId, {
      reference: createToolInteractionReference(request.transcriptAnchor.sessionId, entry.id),
      toolCallId: message.toolCallId,
      toolName: call.toolName,
      callArguments: asJsonValue(call.callArguments),
      toolResult: {
        isError: message.isError,
        content: message.content.map(asJsonValue),
      },
    });
  }
  if (interactions.size !== expected.size) {
    const missing = request.toolCallIds.filter(id => !interactions.has(id));
    throw new Error(`Transcript is missing committed tool interactions: ${missing.join(", ")}`);
  }
  return request.toolCallIds.map(id => interactions.get(id)!);
}

export async function readReferencedToolInteraction(request: {
  transcriptFile: string;
  reference: string;
}): Promise<TranscriptToolInteraction> {
  const source = decodeToolInteractionReference(request.reference);
  const branch = await readBranchToEntry(request.transcriptFile, source.sessionId, source.resultEntryId);
  const resultEntry = branch.at(-1);
  const message = resultEntry?.message;
  if (resultEntry?.id !== source.resultEntryId
    || resultEntry.type !== "message"
    || !message
    || typeof message !== "object") {
    throw new Error("Tool interaction reference does not identify a transcript result");
  }
  const result = message as Record<string, unknown>;
  if (result.role !== "toolResult"
    || typeof result.toolCallId !== "string"
    || typeof result.toolName !== "string"
    || typeof result.isError !== "boolean"
    || !Array.isArray(result.content)) {
    throw new Error("Tool interaction reference does not identify a transcript result");
  }
  const call = toolCallsOnBranch(branch.slice(0, -1), request.transcriptFile).get(result.toolCallId);
  if (!call || call.toolName !== result.toolName) {
    throw new Error("Tool interaction reference has no matching transcript call");
  }
  return {
    reference: request.reference,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    callArguments: asJsonValue(call.callArguments),
    toolResult: {
      isError: result.isError,
      content: result.content.map(asJsonValue),
    },
  };
}

function assertCompletedTurn(
  branch: TranscriptEntry[],
  transcriptFile: string,
  terminalToolNames: Set<string>,
): void {
  const leaf = branch.at(-1);
  if (!leaf) throw new Error(`Transcript ${transcriptFile} has no selected leaf`);
  const message = leaf.message;
  if (leaf.type !== "message" || !message || typeof message !== "object") {
    throw new Error(`Transcript ${transcriptFile} does not end with a completed assistant message`);
  }
  const assistant = message as Record<string, unknown>;
  if (assistant.role === "toolResult"
    && assistant.isError === false
    && typeof assistant.toolCallId === "string"
    && typeof assistant.toolName === "string"
    && terminalToolNames.has(assistant.toolName)) {
    const call = toolCallsOnBranch(branch.slice(0, -1), transcriptFile).get(assistant.toolCallId);
    if (call?.toolName === assistant.toolName) return;
  }
  if (assistant.role !== "assistant") {
    throw new Error(`Transcript ${transcriptFile} does not end with a completed assistant message`);
  }
  if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
    const detail = typeof assistant.errorMessage === "string" ? `: ${assistant.errorMessage}` : "";
    throw new Error(`Transcript ${transcriptFile} ends with ${assistant.stopReason}${detail}`);
  }
}

function assertCompleteToolInteractions(branch: TranscriptEntry[], transcriptFile: string): void {
  const pending = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const content = block as Record<string, unknown>;
        if (content.type !== "toolCall" || typeof content.id !== "string") continue;
        if (pending.has(content.id)) throw new Error(`Transcript ${transcriptFile} contains duplicate tool call ${content.id}`);
        pending.add(content.id);
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      if (!pending.delete(message.toolCallId)) {
        throw new Error(`Transcript ${transcriptFile} contains tool result without call ${message.toolCallId}`);
      }
    }
  }
  if (pending.size > 0) {
    throw new Error(`Transcript ${transcriptFile} contains incomplete tool interaction ${[...pending].join(", ")}`);
  }
}

async function readSelectedBranch(transcriptFile: string, sessionId: string): Promise<TranscriptEntry[]> {
  const { entries } = await readTranscript(transcriptFile, sessionId);
  return buildBranch(entries, entries.at(-1), transcriptFile);
}

async function readBranchToEntry(
  transcriptFile: string,
  sessionId: string,
  entryId: string,
): Promise<TranscriptEntry[]> {
  const { entries } = await readTranscript(transcriptFile, sessionId);
  const target = entries.find(entry => entry.id === entryId);
  if (!target) throw new Error(`Transcript entry ${entryId} does not exist`);
  return buildBranch(entries, target, transcriptFile);
}

async function readTranscript(
  transcriptFile: string,
  sessionId: string,
): Promise<{ entries: TranscriptEntry[] }> {
  const records = (await readFile(transcriptFile, "utf8"))
    .split("\n")
    .filter(line => line.length > 0)
    .map((line, index) => parseRecord(line, index + 1));
  const [header, ...rawEntries] = records;
  if (!isHeader(header) || header.id !== sessionId) {
    throw new Error(`Transcript ${transcriptFile} does not belong to session ${sessionId}`);
  }

  const entries: TranscriptEntry[] = [];
  const byId = new Map<string, TranscriptEntry>();
  for (const record of rawEntries) {
    if (!isEntry(record)) throw new Error(`Transcript ${transcriptFile} contains an invalid entry`);
    if (byId.has(record.id)) throw new Error(`Transcript ${transcriptFile} contains duplicate entry ${record.id}`);
    byId.set(record.id, record);
    entries.push(record);
  }

  return { entries };
}

function buildBranch(
  entries: TranscriptEntry[],
  leaf: TranscriptEntry | undefined,
  transcriptFile: string,
): TranscriptEntry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: TranscriptEntry[] = [];
  const selected = new Set<string>();
  let current = leaf;
  while (isEntry(current)) {
    if (selected.has(current.id)) throw new Error(`Transcript ${transcriptFile} selected branch contains a cycle`);
    selected.add(current.id);
    branch.unshift(current);
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
    if (!current) throw new Error(`Transcript ${transcriptFile} selected branch is not continuous`);
  }
  if (branch.length === 0 || !isEntry(current) || current.parentId !== null) {
    throw new Error(`Transcript ${transcriptFile} has no continuous selected branch`);
  }
  return branch;
}

function toolCallsOnBranch(
  branch: TranscriptEntry[],
  transcriptFile: string,
): Map<string, { toolName: string; callArguments: unknown }> {
  const calls = new Map<string, { toolName: string; callArguments: unknown }>();
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const content = block as Record<string, unknown>;
      if (content.type !== "toolCall") continue;
      if (typeof content.id !== "string"
        || typeof content.name !== "string"
        || !("arguments" in content)
        || calls.has(content.id)) {
        throw new Error(`Transcript ${transcriptFile} contains an invalid or duplicate tool call`);
      }
      calls.set(content.id, { toolName: content.name, callArguments: content.arguments });
    }
  }
  return calls;
}

export function createToolInteractionReference(sessionId: string, resultEntryId: string): string {
  const payload = Buffer.from(JSON.stringify({ sessionId, resultEntryId }), "utf8").toString("base64url");
  return `loom-tool-interaction:v1:${payload}`;
}

function decodeToolInteractionReference(reference: string): {
  sessionId: string;
  resultEntryId: string;
} {
  const prefix = "loom-tool-interaction:v1:";
  if (!reference.startsWith(prefix)) throw new Error("Invalid tool interaction reference");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(reference.slice(prefix.length), "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid tool interaction reference");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid tool interaction reference");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || typeof record.sessionId !== "string"
    || !record.sessionId
    || typeof record.resultEntryId !== "string"
    || !record.resultEntryId) {
    throw new Error("Invalid tool interaction reference");
  }
  return { sessionId: record.sessionId, resultEntryId: record.resultEntryId };
}

function asJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Transcript tool interaction contains a non-JSON value");
  const parsed = JSON.parse(serialized) as JsonValue;
  if (!isDeepStrictEqual(parsed, value)) {
    throw new Error("Transcript tool interaction contains a non-JSON value");
  }
  return parsed;
}

function transcriptEntryTime(entry: TranscriptEntry): string {
  if (typeof entry.timestamp !== "string" || Number.isNaN(Date.parse(entry.timestamp))) {
    throw new Error(`Transcript entry ${entry.id} has no valid timestamp`);
  }
  return new Date(entry.timestamp).toISOString();
}

function isMessageRole(entry: TranscriptEntry, role: string): boolean {
  return Boolean(entry.message
    && typeof entry.message === "object"
    && (entry.message as Record<string, unknown>).role === role);
}

function parseRecord(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Transcript contains invalid JSON at line ${lineNumber}`);
  }
}

function isHeader(value: unknown): value is TranscriptHeader {
  return Boolean(value && typeof value === "object"
    && (value as Record<string, unknown>).type === "session"
    && typeof (value as Record<string, unknown>).id === "string");
}

function isEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && (typeof record.parentId === "string" || record.parentId === null);
}
