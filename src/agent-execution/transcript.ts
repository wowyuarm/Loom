import { readFile } from "node:fs/promises";

import type { TranscriptAnchor } from "../runtime/index.js";

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
}

export interface VerifiedTranscriptEvidence {
  inputAnchors: Array<{
    inputId: string;
    transcriptAnchor: TranscriptAnchor;
  }>;
  transcriptAnchor: TranscriptAnchor;
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
  assertCompletedTurn(leaf, request.transcriptFile);
  return {
    inputAnchors,
    transcriptAnchor: { sessionId: request.sessionId, entryId: leaf.id },
  };
}

function assertCompletedTurn(leaf: TranscriptEntry, transcriptFile: string): void {
  const message = leaf.message;
  if (leaf.type !== "message" || !message || typeof message !== "object") {
    throw new Error(`Transcript ${transcriptFile} does not end with a completed assistant message`);
  }
  const assistant = message as Record<string, unknown>;
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
  const records = (await readFile(transcriptFile, "utf8"))
    .split("\n")
    .filter(line => line.length > 0)
    .map((line, index) => parseRecord(line, index + 1));
  const [header, ...entries] = records;
  if (!isHeader(header) || header.id !== sessionId) {
    throw new Error(`Transcript ${transcriptFile} does not belong to session ${sessionId}`);
  }

  const byId = new Map<string, TranscriptEntry>();
  for (const record of entries) {
    if (!isEntry(record)) throw new Error(`Transcript ${transcriptFile} contains an invalid entry`);
    if (byId.has(record.id)) throw new Error(`Transcript ${transcriptFile} contains duplicate entry ${record.id}`);
    byId.set(record.id, record);
  }

  const branch: TranscriptEntry[] = [];
  const selected = new Set<string>();
  let current = entries.at(-1);
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
