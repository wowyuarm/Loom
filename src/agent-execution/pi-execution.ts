import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentExecution,
  ExecutionInput,
  ExecutionResult,
  RunningExecution,
  TurnControl,
  TurnRequest,
} from "../runtime/index.js";
import {
  type InputAnnotationReference,
  verifyPrimaryTranscriptEvidence,
} from "./transcript.js";

export interface PiAgentExecutionOptions {
  cwd: string;
  agentDir: string;
  transcriptFile: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  systemPrompt: string;
  readOnlyTools?: ToolDefinition[];
}

export interface PiAgentExecution extends AgentExecution {
  close(): void;
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
    const active = this.#require(turnId);
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

class PersistentPiAgentExecution implements PiAgentExecution {
  #runningTurnId: string | undefined;
  #abortReason: string | undefined;
  #acceptsSteering = false;

  constructor(
    private readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"],
    private readonly sessionManager: SessionManager,
    private readonly transcriptFile: string,
    private readonly lifecycle: InputAnnotationLifecycle,
  ) {}

  start(request: TurnRequest, control: TurnControl): RunningExecution {
    if (this.#runningTurnId) throw new Error(`Agent Execution is already running Turn ${this.#runningTurnId}`);
    if (request.inputs.length !== 1) throw new Error("A new Pi Turn requires exactly one initial Input");
    this.#runningTurnId = request.turnId;
    this.#abortReason = undefined;
    this.#acceptsSteering = true;
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
          await this.session.steer(inputText(input));
        } catch (error) {
          this.lifecycle.removePending(request.turnId, input.id);
          throw error;
        }
      },
      abort: async reason => this.#abort(request.turnId, reason),
    };
  }

  close(): void {
    this.session.dispose();
  }

  async #run(request: TurnRequest): Promise<ExecutionResult> {
    try {
      await this.session.prompt(inputText(request.inputs[0]!), { expandPromptTemplates: false });
      this.#acceptsSteering = false;
      this.#throwIfAborted(request.turnId);
      const evidence = await verifyPrimaryTranscriptEvidence({
        transcriptFile: this.transcriptFile,
        sessionId: this.sessionManager.getSessionId(),
        inputs: this.lifecycle.evidenceRequest(request.turnId),
      });
      this.#throwIfAborted(request.turnId);
      return { outcome: "completed", ...evidence };
    } finally {
      this.lifecycle.end(request.turnId);
      this.#runningTurnId = undefined;
      this.#abortReason = undefined;
      this.#acceptsSteering = false;
    }
  }

  async #abort(turnId: string, reason: string): Promise<void> {
    if (this.#runningTurnId !== turnId) throw new Error(`Turn ${turnId} is no longer running`);
    this.#abortReason = reason;
    this.#acceptsSteering = false;
    this.session.clearQueue();
    await this.session.abort();
  }

  #throwIfAborted(turnId: string): void {
    if (this.#runningTurnId === turnId && this.#abortReason !== undefined) {
      throw new Error(`Turn ${turnId} aborted: ${this.#abortReason}`);
    }
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
  return new PersistentPiAgentExecution(session, sessionManager, options.transcriptFile, lifecycle);
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
