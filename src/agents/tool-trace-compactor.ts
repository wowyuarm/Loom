import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { JsonValue } from "../runtime/index.js";

const SYSTEM_PROMPT = `You compress completed tool interactions into factual replay records.

Return exactly one result for every input as JSON:
{"results":[{"toolCallId":"...","callSummary":"...","resultSummary":"...","confirmedFacts":["..."],"sourceClaims":["..."],"limitations":["..."]}]}

Rules:
- Report only facts supported by the tool call arguments and tool result.
- Keep directly confirmed facts separate from claims made by a source.
- Record missing data, errors, truncation, access limits, and uncertainty as limitations.
- Do not infer the primary Agent's motivation, position, or next action. Do not give advice.
- Do not mention or reconstruct dialogue, reasoning, Identity, Memory, or Behavior.
- Return JSON only, with no Markdown or additional fields.`;

export interface ToolTraceCompactionInput {
  toolCallId: string;
  toolName: string;
  callArguments: JsonValue;
  toolResult: {
    isError: boolean;
    content: JsonValue[];
  };
}

export interface ToolTraceCompactionDetail {
  toolCallId: string;
  callSummary: string;
  resultSummary: string;
  confirmedFacts: string[];
  sourceClaims: string[];
  limitations: string[];
}

export interface PiToolTraceCompactorOptions {
  agentDir: string;
  transcriptDirectory: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
}

export interface ToolTraceCompactor {
  compact(inputs: ToolTraceCompactionInput[]): Promise<ToolTraceCompactionDetail[]>;
}

class PiToolTraceCompactor implements ToolTraceCompactor {
  constructor(private readonly options: PiToolTraceCompactorOptions) {}

  async compact(inputs: ToolTraceCompactionInput[]): Promise<ToolTraceCompactionDetail[]> {
    const transcriptFile = path.join(this.options.transcriptDirectory, `${randomUUID()}.jsonl`);
    const sessionManager = SessionManager.open(
      transcriptFile,
      this.options.transcriptDirectory,
      this.options.transcriptDirectory,
    );
    const settingsManager = SettingsManager.create(
      this.options.transcriptDirectory,
      this.options.agentDir,
      { projectTrusted: false },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.transcriptDirectory,
      agentDir: this.options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.transcriptDirectory,
      agentDir: this.options.agentDir,
      modelRuntime: this.options.modelRuntime,
      model: this.options.model,
      noTools: "all",
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    try {
      await session.bindExtensions({});
      session.setAutoCompactionEnabled(false);
      await session.prompt(JSON.stringify({ inputs }), { expandPromptTemplates: false });
      return parseCompactionResult(
        lastAssistantText(session.messages),
        inputs.map(input => input.toolCallId),
      );
    } finally {
      session.dispose();
    }
  }
}

export async function createPiToolTraceCompactor(
  options: PiToolTraceCompactorOptions,
): Promise<ToolTraceCompactor> {
  await Promise.all([
    mkdir(options.agentDir, { recursive: true }),
    mkdir(options.transcriptDirectory, { recursive: true }),
  ]);
  return new PiToolTraceCompactor(options);
}

function lastAssistantText(messages: AgentMessage[]): string {
  const message = [...messages].reverse().find(candidate => candidate.role === "assistant");
  if (!message || !Array.isArray(message.content)) {
    throw new Error("Tool Trace Compactor did not return an assistant message");
  }
  return message.content
    .flatMap(block => block.type === "text" ? [block.text] : [])
    .join("\n")
    .trim();
}

function parseCompactionResult(raw: string, expectedIds: string[]): ToolTraceCompactionDetail[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Tool Trace Compactor did not return JSON");
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).length !== 1
    || !Array.isArray(parsed.results)) {
    throw new Error("Tool Trace Compactor returned unexpected fields");
  }
  if (new Set(expectedIds).size !== expectedIds.length || parsed.results.length !== expectedIds.length) {
    throw new Error("Tool Trace Compactor returned an incomplete result set");
  }

  const expected = new Set(expectedIds);
  const details = new Map<string, ToolTraceCompactionDetail>();
  for (const candidate of parsed.results) {
    if (!isRecord(candidate)
      || Object.keys(candidate).some(key => ![
        "toolCallId",
        "callSummary",
        "resultSummary",
        "confirmedFacts",
        "sourceClaims",
        "limitations",
      ].includes(key))) {
      throw new Error("Tool Trace Compactor returned unexpected fields");
    }
    if (typeof candidate.toolCallId !== "string"
      || !expected.has(candidate.toolCallId)
      || details.has(candidate.toolCallId)
      || !isNonEmptyString(candidate.callSummary)
      || !isNonEmptyString(candidate.resultSummary)
      || !isStringArray(candidate.confirmedFacts)
      || !isStringArray(candidate.sourceClaims)
      || !isStringArray(candidate.limitations)) {
      throw new Error("Tool Trace Compactor returned a malformed result");
    }
    details.set(candidate.toolCallId, candidate as unknown as ToolTraceCompactionDetail);
  }
  if (details.size !== expectedIds.length) {
    throw new Error("Tool Trace Compactor returned an incomplete result set");
  }
  return expectedIds.map(id => details.get(id)!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}
