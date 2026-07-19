import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  type InlineExtension,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentExecution,
  ContextWindowState,
  ExecutionInput,
  ExecutionResult,
  JsonValue,
  RunningExecution,
  TurnControl,
  TurnRequest,
} from "../runtime/index.js";
import {
  type InputAnnotationReference,
  verifyPrimaryTranscriptEntry,
  verifyPrimaryTranscriptEvidence,
} from "./transcript.js";
import {
  type ContextBudget,
  materializeTurnContext,
} from "./context.js";

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type PiContextMessage = AgentMessage;

export interface PiAgentExecutionOptions {
  cwd: string;
  agentDir: string;
  transcriptFile: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  systemPrompt: string;
  readOnlyTools?: ToolDefinition[];
  loadContextMaterials?: (request: TurnRequest) => Promise<PiContextMaterials>;
  contextBudget?: Partial<ContextBudget>;
}

export interface PiContextMaterials {
  turnLive: PiContextMessage[];
  windowFrozen: PiContextMessage[];
}

export interface PiAgentExecution extends AgentExecution {
  start(request: TurnRequest, control: TurnControl): PiRunningExecution;
  close(): void;
}

export interface PiExecutionResult extends ExecutionResult {
  contextWindow: ContextWindowState;
  contextPlan: JsonValue;
}

export interface PiRunningExecution extends RunningExecution {
  result: Promise<PiExecutionResult>;
}

interface ActiveTurn {
  request: TurnRequest;
  control: TurnControl;
  pending: ExecutionInput[];
  annotations: InputAnnotationReference[];
}

class InputAnnotationLifecycle {
  #active: ActiveTurn | undefined;

  constructor(private readonly sessionManager: SessionManager) {}

  begin(request: TurnRequest, control: TurnControl): void {
    if (this.#active) throw new Error(`Agent Execution is already running Turn ${this.#active.request.turnId}`);
    this.#active = { request, control, pending: [...request.inputs], annotations: [] };
  }

  enqueue(turnId: string, input: ExecutionInput): void {
    const active = this.#require(turnId);
    active.pending.push(input);
  }

  removePending(turnId: string, inputId: string): void {
    const active = this.#active;
    if (!active || active.request.turnId !== turnId) return;
    const index = active.pending.findIndex(input => input.id === inputId);
    if (index >= 0) active.pending.splice(index, 1);
  }

  onMessageStart(message: unknown): void {
    const active = this.#active;
    if (!active || !isUserMessage(message)) return;
    const input = active.pending.shift();
    if (!input) return;
    const annotationEntryId = this.sessionManager.appendCustomEntry("loom.input.v1", {
      version: 1,
      turnId: active.request.turnId,
      inputId: input.id,
      inclusionPosition: input.inclusionPosition,
      kind: input.kind,
      occurredAt: input.occurredAt,
      payload: input.payload,
    });
    active.annotations.push({ inputId: input.id, annotationEntryId });
    active.control.includeInput(input.id);
  }

  evidenceRequest(turnId: string): InputAnnotationReference[] {
    return [...this.#require(turnId).annotations];
  }

  control(turnId: string): TurnControl {
    return this.#require(turnId).control;
  }

  end(turnId: string): void {
    this.#require(turnId);
    this.#active = undefined;
  }

  #require(turnId: string): ActiveTurn {
    if (!this.#active || this.#active.request.turnId !== turnId) {
      throw new Error(`Agent Execution is not running Turn ${turnId}`);
    }
    return this.#active;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

class PerTurnPiAgentExecution implements PiAgentExecution {
  #runningTurnId: string | undefined;
  #abortReason: string | undefined;
  #acceptsSteering = false;
  #sessionReady: Deferred<PiSession> | undefined;
  #closed = false;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly transcriptFile: string,
    private readonly lifecycle: InputAnnotationLifecycle,
    private readonly createSession: () => Promise<PiSession>,
    private readonly loadContextMaterials: (request: TurnRequest) => Promise<PiContextMaterials>,
    private readonly systemPrompt: string,
    private readonly contextBudget: Partial<ContextBudget> | undefined,
  ) {}

  start(request: TurnRequest, control: TurnControl): PiRunningExecution {
    if (this.#closed) throw new Error("Agent Execution is closed");
    if (this.#runningTurnId) throw new Error(`Agent Execution is already running Turn ${this.#runningTurnId}`);
    if (request.inputs.length !== 1) throw new Error("A new Pi Turn requires exactly one initial Input");
    this.#runningTurnId = request.turnId;
    this.#abortReason = undefined;
    this.#acceptsSteering = true;
    this.#sessionReady = deferred<PiSession>();
    this.lifecycle.begin(request, control);
    const result = this.#run(request);
    return {
      result,
      steer: async input => {
        if (this.#runningTurnId !== request.turnId || !this.#acceptsSteering) {
          throw new Error(`Turn ${request.turnId} no longer accepts steering`);
        }
        this.lifecycle.enqueue(request.turnId, input);
        try {
          const session = await this.#sessionReady!.promise;
          await session.steer(inputText(input));
        } catch (error) {
          this.lifecycle.removePending(request.turnId, input.id);
          throw error;
        }
      },
      abort: async reason => this.#abort(request.turnId, reason),
    };
  }

  close(): void {
    if (this.#runningTurnId) {
      throw new Error(`Cannot close Agent Execution while Turn ${this.#runningTurnId} is running`);
    }
    this.#closed = true;
  }

  async #run(request: TurnRequest): Promise<PiExecutionResult> {
    let session: PiSession | undefined;
    try {
      await this.#selectCommittedBranch(request.contextWindow);
      const materials = await this.loadContextMaterials(request);
      const preparedWindow: ContextWindowState = request.contextWindow ?? {
        version: 1,
        id: request.turnId,
        frozenSeed: serializeMessages(materials.windowFrozen),
        committedTrace: [],
      };
      this.lifecycle.control(request.turnId).prepareContextWindow(preparedWindow);
      session = await this.createSession();
      session.setAutoCompactionEnabled(false);
      const materialized = materializeTurnContext({
        currentInput: currentInputMessage(request.inputs[0]!),
        turnLive: structuredClone(materials.turnLive),
        windowFrozen: restoreMessages(preparedWindow.frozenSeed),
        committedTrace: restoreMessages(preparedWindow.committedTrace),
        fixedTokens: {
          system: textTokens(this.systemPrompt),
          toolSchemas: textTokens(JSON.stringify(session.getAllTools().map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            promptGuidelines: tool.promptGuidelines,
          })))),
        },
        ...(this.contextBudget ? { budget: this.contextBudget } : {}),
      });
      session.agent.state.messages = materialized.messages;
      const previousMessageCount = session.messages.length;
      const prompt = session.prompt(inputText(request.inputs[0]!), { expandPromptTemplates: false });
      this.#sessionReady!.resolve(session);
      await prompt;
      this.#acceptsSteering = false;
      this.#throwIfAborted(request.turnId);
      const evidence = await verifyPrimaryTranscriptEvidence({
        transcriptFile: this.transcriptFile,
        sessionId: this.sessionManager.getSessionId(),
        inputs: this.lifecycle.evidenceRequest(request.turnId),
      });
      this.#throwIfAborted(request.turnId);
      const committedTrace = [
        ...preparedWindow.committedTrace,
        ...serializeMessages(session.messages.slice(previousMessageCount)),
      ];
      return {
        outcome: "completed",
        ...evidence,
        contextWindow: {
          version: 1,
          id: preparedWindow.id,
          frozenSeed: preparedWindow.frozenSeed,
          committedTrace,
          transcriptAnchor: evidence.transcriptAnchor,
        },
        contextPlan: serializeValue(materialized.plan),
      };
    } catch (error) {
      this.#sessionReady?.reject(error);
      throw error;
    } finally {
      session?.dispose();
      this.lifecycle.end(request.turnId);
      this.#runningTurnId = undefined;
      this.#abortReason = undefined;
      this.#acceptsSteering = false;
      this.#sessionReady = undefined;
    }
  }

  async #abort(turnId: string, reason: string): Promise<void> {
    if (this.#runningTurnId !== turnId) throw new Error(`Turn ${turnId} is no longer running`);
    this.#abortReason = reason;
    this.#acceptsSteering = false;
    const session = await this.#sessionReady!.promise;
    session.clearQueue();
    await session.abort();
  }

  #throwIfAborted(turnId: string): void {
    if (this.#runningTurnId === turnId && this.#abortReason !== undefined) {
      throw new Error(`Turn ${turnId} aborted: ${this.#abortReason}`);
    }
  }

  async #selectCommittedBranch(window: ContextWindowState | undefined): Promise<void> {
    if (!window?.transcriptAnchor) {
      this.sessionManager.resetLeaf();
      return;
    }
    const anchor = await verifyPrimaryTranscriptEntry({
      transcriptFile: this.transcriptFile,
      sessionId: window.transcriptAnchor.sessionId,
      entryId: window.transcriptAnchor.entryId,
    });
    if (anchor.sessionId !== this.sessionManager.getSessionId()) {
      throw new Error(`Context Window ${window.id} belongs to a different transcript session`);
    }
    this.sessionManager.branch(anchor.entryId);
  }
}

export async function createPiAgentExecution(options: PiAgentExecutionOptions): Promise<PiAgentExecution> {
  await Promise.all([
    mkdir(options.cwd, { recursive: true }),
    mkdir(options.agentDir, { recursive: true }),
    mkdir(path.dirname(options.transcriptFile), { recursive: true }),
  ]);
  const sessionManager = SessionManager.open(
    options.transcriptFile,
    path.dirname(options.transcriptFile),
    options.cwd,
  );
  const lifecycle = new InputAnnotationLifecycle(sessionManager);
  const annotationExtension: InlineExtension = {
    name: "loom-input-annotation",
    factory: pi => {
      pi.on("message_start", event => lifecycle.onMessageStart(event.message));
    },
  };
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories: [annotationExtension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
  });
  const createSession = async () => {
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRuntime: options.modelRuntime,
      model: options.model,
      noTools: options.readOnlyTools?.length ? "builtin" : "all",
      ...(options.readOnlyTools ? { customTools: options.readOnlyTools } : {}),
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    await session.bindExtensions({});
    return session;
  };
  return new PerTurnPiAgentExecution(
    sessionManager,
    options.transcriptFile,
    lifecycle,
    createSession,
    options.loadContextMaterials ?? (async () => ({ turnLive: [], windowFrozen: [] })),
    options.systemPrompt,
    options.contextBudget,
  );
}

function inputText(input: ExecutionInput): string {
  if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    const text = input.payload.text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(input.payload);
}

function isUserMessage(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).role === "user");
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function serializeMessages(messages: unknown[]): JsonValue[] {
  return JSON.parse(JSON.stringify(messages)) as JsonValue[];
}

function restoreMessages(messages: JsonValue[]): PiSession["messages"] {
  const restored = structuredClone(messages) as unknown[];
  for (const message of restored) {
    if (!message || typeof message !== "object" || typeof (message as Record<string, unknown>).role !== "string") {
      throw new Error("Context Window contains an invalid Agent message");
    }
  }
  return restored as PiSession["messages"];
}

function serializeValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function currentInputMessage(input: ExecutionInput): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: inputText(input) }],
    timestamp: Date.parse(input.occurredAt),
  };
}

function textTokens(text: string): number {
  return Math.max(0, estimateTokens({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  }));
}
