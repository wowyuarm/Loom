import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  estimateTokens,
  type InlineExtension,
  type ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentExecution,
  ExecutionInput,
  ExecutionResult,
  InteractionDestination,
  JsonValue,
  RunningExecution,
  TurnControl,
  TurnRequest,
} from "../runtime/index.js";
import type {
  AgentWorkspace,
  AgentWorkspaceTurnSnapshot,
  WorkspaceTurnKind,
} from "../workspace/agent-workspace.js";
import {
  type InputAnnotationReference,
  openPrimaryTranscriptSession,
  redactTranscriptImages,
  verifyPrimaryTranscriptEntry,
  verifyPrimaryTranscriptEvidence,
} from "./transcript.js";
import {
  assertContextWindowReplacement,
  completeContextWindow,
  type ContextWindowState,
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudget,
  materializeTurnContext,
  parseContextWindowState,
  serializeContextWindowState,
} from "./context.js";
import {
  compactCommittedToolTraces,
  createExpandTool,
  toolTraceCompactionRequired,
} from "./tool-trace.js";
import type { ToolTraceCompactor } from "../agents/tool-trace-compactor.js";
import { createMessageTool, type MessageTurnDecision } from "./message.js";
import { loadDailyContext } from "./daily-context.js";
import type { AttachmentStore } from "../integrations/attachments/index.js";
import type { InteractionChannelAgentSurface } from "../channels/surface.js";
import { RESERVED_LOOM_TOOL_NAMES } from "../channels/reserved-tool-names.js";
import { createAttachmentTool } from "./attachment.js";
import type { OperationalEventObserver } from "../operational-events.js";
import { createPiSessionFactory, type PreparedPiSession } from "./pi/session.js";
import {
  createToolActivityExtension,
  type ContextLimitCircuit,
  type ToolErrorCircuit,
} from "./pi/tool-activity.js";
import type { InputPresentation } from "./pi/attachments.js";
import { presentInput } from "./pi/input.js";

const MAIN_AGENT_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type PiContextMessage = AgentMessage;

/**
 * Consecutive tool failures within one Turn that trip the error circuit
 * breaker. Beyond this the Main Agent may be stuck retrying a tool that
 * always fails (e.g. a reply-gate rejection), so the Turn fails instead of
 * burning model calls forever.
 */
export interface PiAgentExecutionOptions {
  agentWorkspace: AgentWorkspace;
  agentDir: string;
  transcriptDirectory: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  harnessSystemPrompt: string;
  channelAgentSurface?: InteractionChannelAgentSurface;
  /** Whether at least one Interaction Channel is enabled; controls the message tool and interaction behavior. */
  interactionEnabled?: boolean;
  defaultInteractionRoute?: string;
  additionalTools?: ToolDefinition[];
  skillSources?: PiSkillSources;
  loadContextMaterials?: (request: TurnRequest) => Promise<PiContextMaterials>;
  contextBudget?: Partial<ContextBudget>;
  toolTraceCompactor?: ToolTraceCompactor;
  attachmentStore?: AttachmentStore;
  observe?: OperationalEventObserver;
}

export interface PiSkillSources {
  core: string[];
  integrations: string[];
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
}

export interface PiRunningExecution extends RunningExecution {
  result: Promise<PiExecutionResult>;
}

interface ActiveTurn {
  request: TurnRequest;
  control: TurnControl;
  pending: ExecutionInput[];
  annotations: InputAnnotationReference[];
  destinations: Map<string, NonNullable<ExecutionInput["interaction"]>["destinations"][number]>;
  interactionDefaults: Map<string, NonNullable<ExecutionInput["interaction"]>["destinations"][number]>;
  includedInteraction: boolean;
  presentedInteraction: boolean;
}

class InputAnnotationLifecycle {
  #active: ActiveTurn | undefined;

  constructor(private readonly sessionManager: SessionManager) {}

  begin(request: TurnRequest, control: TurnControl): void {
    if (this.#active) throw new Error(`Agent Execution is already running Turn ${this.#active.request.turnId}`);
    this.#active = {
      request,
      control,
      pending: [...request.inputs],
      annotations: [],
      destinations: new Map(),
      interactionDefaults: new Map(),
      includedInteraction: false,
      presentedInteraction: false,
    };
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
      ...(input.interaction ? { interaction: input.interaction } : {}),
    });
    active.annotations.push({ inputId: input.id, annotationEntryId });
    for (const destination of input.interaction?.destinations ?? []) {
      active.destinations.set(destination.destinationRef, destination);
    }
    const defaultDestinationRef = input.interaction?.defaultDestinationRef;
    const defaultDestination = defaultDestinationRef
      ? input.interaction?.destinations.find(destination => destination.destinationRef === defaultDestinationRef)
      : undefined;
    if (defaultDestination) {
      active.interactionDefaults.set(defaultDestination.destinationRef, defaultDestination);
    }
    if (input.kind === "interaction") active.includedInteraction = true;
    active.control.includeInput(input.id);
  }

  evidenceRequest(turnId: string): InputAnnotationReference[] {
    return [...this.#require(turnId).annotations];
  }

  control(turnId: string): TurnControl {
    return this.#require(turnId).control;
  }

  hasIncludedInteraction(turnId: string): boolean {
    return this.#require(turnId).includedInteraction;
  }

  presentInteraction(turnId: string): boolean {
    const active = this.#require(turnId);
    const first = !active.presentedInteraction;
    active.presentedInteraction = true;
    return first;
  }

  destinations(turnId: string) {
    return [...this.#require(turnId).destinations.values()];
  }

  interactionDefaultDestination(turnId: string): InteractionDestination | undefined {
    const destinations = [...this.#require(turnId).interactionDefaults.values()];
    return destinations.length === 1 ? destinations[0] : undefined;
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
    private readonly transcriptDirectory: string,
    private readonly agentWorkspace: AgentWorkspace,
    private readonly createSession: (
      systemPrompt: string,
      turnTools: ToolDefinition[],
      activityExtension: InlineExtension,
      annotationLifecycle: InputAnnotationLifecycle,
      sessionManager: SessionManager,
    ) => Promise<PreparedPiSession>,
    private readonly loadContextMaterials: (request: TurnRequest) => Promise<PiContextMaterials>,
    private readonly harnessSystemPrompt: string,
    private readonly channelAgentSurface: InteractionChannelAgentSurface | undefined,
    private readonly interactionEnabled: boolean,
    private readonly defaultInteractionRoute: string | undefined,
    private readonly contextBudget: Partial<ContextBudget> | undefined,
    private readonly toolTraceCompactor: ToolTraceCompactor | undefined,
    private readonly attachmentStore: AttachmentStore | undefined,
    private readonly supportsNativeImages: boolean,
    private readonly ordinaryToolNames: Set<string>,
    private readonly observe: OperationalEventObserver | undefined,
    private readonly toolErrorCircuit: ToolErrorCircuit = { consecutiveErrors: 0, opened: false },
    private readonly contextLimitCircuit: ContextLimitCircuit = { opened: false },
  ) {}

  start(request: TurnRequest, control: TurnControl): PiRunningExecution {
    if (this.#closed) throw new Error("Agent Execution is closed");
    if (this.#runningTurnId) throw new Error(`Agent Execution is already running Turn ${this.#runningTurnId}`);
    if (request.inputs.length !== 1) throw new Error("A new Pi Turn requires exactly one initial Input");
    this.toolErrorCircuit.consecutiveErrors = 0;
    this.toolErrorCircuit.opened = false;
    delete this.toolErrorCircuit.lastFailedTool;
    delete this.toolErrorCircuit.lastFailedToolCallId;
    delete this.toolErrorCircuit.openedAtConsecutiveErrors;
    this.contextLimitCircuit.opened = false;
    delete this.contextLimitCircuit.estimatedTokens;
    delete this.contextLimitCircuit.limit;
    const sessionManager = openPrimaryTranscriptSession(
      this.transcriptDirectory,
      request.recordingDay,
      this.agentWorkspace.root,
    );
    const lifecycle = new InputAnnotationLifecycle(sessionManager);
    this.#runningTurnId = request.turnId;
    this.#abortReason = undefined;
    this.#acceptsSteering = true;
    this.#sessionReady = deferred<PiSession>();
    lifecycle.begin(request, control);
    const result = this.#run(request, sessionManager, lifecycle);
    return {
      result,
      steer: async input => {
        if (this.#runningTurnId !== request.turnId || !this.#acceptsSteering) {
          throw new Error(`Turn ${request.turnId} no longer accepts steering`);
        }
        lifecycle.enqueue(request.turnId, input);
        try {
          const session = await this.#sessionReady!.promise;
          const firstInteraction = input.kind === "interaction"
            ? lifecycle.presentInteraction(request.turnId)
            : false;
          const presentation = await presentInput(input, {
            structureHumanInput: input.kind === "interaction",
            includeMessageReminder: this.interactionEnabled && firstInteraction,
            humanArrivedDuringNonInteraction:
              request.inputs[0]!.kind !== "interaction" && firstInteraction,
            channelDestinations: this.channelAgentSurface?.destinations ?? [],
          }, this.attachmentStore, this.supportsNativeImages);
          await session.steer(presentation.text, presentation.images);
        } catch (error) {
          lifecycle.removePending(request.turnId, input.id);
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

  async #run(
    request: TurnRequest,
    sessionManager: SessionManager,
    lifecycle: InputAnnotationLifecycle,
  ): Promise<PiExecutionResult> {
    let session: PiSession | undefined;
    const messageDecision: MessageTurnDecision = { sent: 0, noReply: false };
    try {
      const restoredWindow = parseContextWindowState(request.executionState);
      await this.#selectCommittedBranch(restoredWindow, request.recordingDay, sessionManager);
      const [workspaceSnapshot, materials, dailyContext] = await Promise.all([
        this.agentWorkspace.loadTurnSnapshot(behaviorForInput(request.inputs[0]!)),
        this.loadContextMaterials(request),
        restoredWindow
          ? Promise.resolve(undefined)
          : loadDailyContext(this.agentWorkspace, request.recordingDay),
      ]);
      const systemPrompt = composeSystemPrompt(
        this.harnessSystemPrompt,
        workspaceSnapshot,
        this.channelAgentSurface?.guidance,
      );
      let preparedWindow: ContextWindowState = restoredWindow ?? {
        version: 1,
        id: request.turnId,
        frozenSeed: serializeMessages([
          ...(dailyContext ? [dailyContext] : []),
          ...materials.windowFrozen,
        ]),
        recentActivityReferences: [],
        committedTrace: [],
        transcriptSources: [],
      };
      lifecycle.control(request.turnId).prepareExecutionState(serializeContextWindowState(preparedWindow));
      const reservation = this.contextBudget?.toolTraceReservation
        ?? DEFAULT_CONTEXT_BUDGET.toolTraceReservation;
      if (toolTraceCompactionRequired(restoreMessages(preparedWindow.committedTrace), reservation)) {
        const replacement = await compactCommittedToolTraces({
          window: preparedWindow,
          transcriptDirectory: this.transcriptDirectory,
          ...(this.toolTraceCompactor ? { compactor: this.toolTraceCompactor } : {}),
        });
        assertContextWindowReplacement(preparedWindow, replacement);
        lifecycle.control(request.turnId).replaceExecutionState(
          serializeContextWindowState(preparedWindow),
          serializeContextWindowState(replacement),
        );
        preparedWindow = replacement;
      }
      const turnTools = [createExpandTool({
        window: preparedWindow,
        transcriptDirectory: this.transcriptDirectory,
      })];
      if (this.attachmentStore) {
        turnTools.push(createAttachmentTool({
          store: this.attachmentStore,
          workspaceRoot: this.agentWorkspace.root,
        }));
      }
      if (this.interactionEnabled) {
        const defaultDestination = this.channelAgentSurface?.defaultDestination;
        turnTools.push(createMessageTool({
          control: lifecycle.control(request.turnId),
          ...(this.defaultInteractionRoute ? { routeRef: this.defaultInteractionRoute } : {}),
          destinations: () => lifecycle.destinations(request.turnId),
          channelDestinations: () => this.channelAgentSurface?.destinations ?? [],
          interactionDefaultDestination: () => lifecycle.interactionDefaultDestination(request.turnId),
          ...(defaultDestination ? { defaultDestination } : {}),
          hasInteraction: () => lifecycle.hasIncludedInteraction(request.turnId),
          decision: messageDecision,
          workspaceRoot: this.agentWorkspace.root,
          ...(this.attachmentStore ? { attachmentStore: this.attachmentStore } : {}),
        }));
      }
      const channelTools = this.channelAgentSurface?.tools.create({
        prepareEffect: effect => lifecycle.control(request.turnId).prepareEffect(effect),
      }) ?? [];
      assertChannelTools(this.channelAgentSurface?.tools.names ?? [], channelTools);
      turnTools.push(...channelTools);
      const toolActivityExtension = createToolActivityExtension(
        lifecycle.control(request.turnId),
        new Set([...this.ordinaryToolNames, ...channelTools.map(tool => tool.name)]),
        this.observe,
        this.toolErrorCircuit,
        this.contextLimitCircuit,
      );
      const preparedSession = await this.createSession(
        systemPrompt,
        turnTools,
        toolActivityExtension,
        lifecycle,
        sessionManager,
      );
      session = preparedSession.session;
      const budget = { ...DEFAULT_CONTEXT_BUDGET, ...this.contextBudget };
      const fixedTokens = textTokens(session.systemPrompt) + textTokens(JSON.stringify(session.agent.state.tools));
      const liveMessageLimit = budget.hardContext - budget.outputReserve - budget.safetyMargin - fixedTokens;
      if (preparedSession.skillDiagnostics.length > 0) {
        sessionManager.appendCustomEntry("loom.skill-diagnostics.v1", {
          version: 1,
          turnId: request.turnId,
          diagnostics: preparedSession.skillDiagnostics,
        });
      }
      if (preparedSession.acceptedSkillCount > 0
        && !session.getActiveToolNames().includes("read")) {
        throw new Error("Accepted skills require an active read tool");
      }
      session.setAutoCompactionEnabled(false);
      const firstInteraction = request.inputs[0]!.kind === "interaction"
        ? lifecycle.presentInteraction(request.turnId)
        : false;
      const initialInputOptions = {
        structureHumanInput: this.interactionEnabled && firstInteraction,
        includeMessageReminder: this.interactionEnabled && firstInteraction,
        channelDestinations: this.channelAgentSurface?.destinations ?? [],
      };
      const initialPresentation = await presentInput(
        request.inputs[0]!,
        initialInputOptions,
        this.attachmentStore,
        this.supportsNativeImages,
      );
      const materialized = materializeTurnContext({
        currentInput: currentInputMessage(request.inputs[0]!, initialPresentation),
        requiredTurnLive: [currentAttentionMessage(workspaceSnapshot.currentAttention)],
        turnLive: structuredClone(materials.turnLive),
        windowFrozen: restoreMessages(preparedWindow.frozenSeed),
        committedTrace: restoreMessages(preparedWindow.committedTrace),
        fixedTokens: {
          system: textTokens(session.systemPrompt),
          toolSchemas: textTokens(JSON.stringify(session.agent.state.tools)),
        },
        ...(this.contextBudget ? { budget: this.contextBudget } : {}),
      });
      if (!Number.isFinite(liveMessageLimit) || liveMessageLimit < 0) {
        throw new Error("Context budget leaves no room for live Turn messages");
      }
      this.contextLimitCircuit.limit = liveMessageLimit;
      session.agent.state.messages = materialized.messages;
      const previousMessageCount = session.messages.length;
      const prompt = session.prompt(
        initialPresentation.text,
        {
          expandPromptTemplates: false,
          ...(initialPresentation.images.length > 0 ? { images: initialPresentation.images } : {}),
        },
      );
      this.#sessionReady!.resolve(session);
      await prompt;
      this.#acceptsSteering = false;
      this.#throwIfAborted(request.turnId);
      this.#throwIfToolErrorCircuitOpened();
      this.#throwIfContextLimitOpened();
      if (this.interactionEnabled
        && (requiresMessageDecision(request.inputs[0]!) || lifecycle.hasIncludedInteraction(request.turnId))
        && !hasMessageDecision(messageDecision)) {
        sessionManager.appendCustomEntry("loom.internal-prompt.v1", {
          version: 1,
          turnId: request.turnId,
          purpose: "message-decision-correction",
        });
        await session.prompt(messageDecisionFollowupText(), { expandPromptTemplates: false });
        this.#throwIfAborted(request.turnId);
        this.#throwIfContextLimitOpened();
        if (!hasMessageDecision(messageDecision)) {
          throw new Error("Main Agent did not choose message.send or message.no_reply after one correction");
        }
      }
      const evidence = await verifyPrimaryTranscriptEvidence({
        transcriptDirectory: this.transcriptDirectory,
        sourceId: request.recordingDay,
        sessionId: sessionManager.getSessionId(),
        inputs: lifecycle.evidenceRequest(request.turnId),
        ...(this.interactionEnabled ? { terminalToolNames: ["message"] } : {}),
      });
      this.#throwIfAborted(request.turnId);
      const completedWindow = completeContextWindow(
        preparedWindow,
        serializeMessages(session.messages.slice(previousMessageCount).map(redactTranscriptImages)),
        evidence.transcriptAnchor,
      );
      return {
        outcome: messageDecision.noReply && messageDecision.sent === 0 ? "no_reply" : "completed",
        ...evidence,
        executionState: serializeContextWindowState(completedWindow),
        executionRecord: serializeValue(materialized.plan),
      };
    } catch (error) {
      this.#sessionReady?.reject(error);
      this.#throwIfToolErrorCircuitOpened();
      this.#throwIfContextLimitOpened();
      throw error;
    } finally {
      session?.dispose();
      lifecycle.end(request.turnId);
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

  #throwIfToolErrorCircuitOpened(): void {
    // The Pi loop treats an aborted stream as a normal end, so the Turn would
    // otherwise fall through to the message-decision correction prompt and
    // keep calling the model. The circuit already decided this Turn failed:
    // surface it here instead of letting a fresh run retry the same failure.
    if (this.toolErrorCircuit.opened) {
      const circuit = this.toolErrorCircuit;
      throw new Error(
        `Main Agent failed after ${circuit.openedAtConsecutiveErrors ?? circuit.consecutiveErrors} consecutive tool errors on ${circuit.lastFailedTool ?? "unknown tool"} (toolCall ${circuit.lastFailedToolCallId ?? "unknown"})`,
      );
    }
  }

  #throwIfContextLimitOpened(): void {
    if (!this.contextLimitCircuit.opened) return;
    const circuit = this.contextLimitCircuit;
    throw new Error(
      `Main Agent context exceeded the live Turn limit (${circuit.estimatedTokens ?? "unknown"} > ${circuit.limit ?? "unknown"} tokens)`,
    );
  }

  async #selectCommittedBranch(
    window: ContextWindowState | undefined,
    sourceId: string,
    sessionManager: SessionManager,
  ): Promise<void> {
    if (!window?.transcriptAnchor) {
      sessionManager.resetLeaf();
      return;
    }
    for (const transcriptAnchor of window.transcriptSources) {
      await verifyPrimaryTranscriptEntry({
        transcriptDirectory: this.transcriptDirectory,
        transcriptAnchor,
      });
    }
    const anchor = window.transcriptAnchor;
    if (anchor.sourceId !== sourceId) {
      sessionManager.resetLeaf();
      return;
    }
    if (anchor.sessionId !== sessionManager.getSessionId()) {
      throw new Error(`Context Window ${window.id} belongs to a different transcript session`);
    }
    sessionManager.branch(anchor.entryId);
  }
}

export async function createPiAgentExecution(options: PiAgentExecutionOptions): Promise<PiAgentExecution> {
  const additionalTools = options.additionalTools ?? [];
  const reservedTools = RESERVED_LOOM_TOOL_NAMES;
  const additionalToolNames = new Set<string>();
  for (const tool of additionalTools) {
    if (reservedTools.has(tool.name)) {
      throw new Error(`${tool.name} is maintained by Loom and cannot be supplied as an additional tool`);
    }
    if (additionalToolNames.has(tool.name)) {
      throw new Error(`Additional tool ${tool.name} is duplicated`);
    }
    additionalToolNames.add(tool.name);
  }
  const channelToolNames = new Set<string>();
  for (const name of options.channelAgentSurface?.tools.names ?? []) {
    if (reservedTools.has(name)) {
      throw new Error(`${name} is maintained by Loom and cannot be supplied by an Interaction Channel`);
    }
    if (additionalToolNames.has(name)) {
      throw new Error(`Interaction Channel tool ${name} duplicates an additional tool`);
    }
    if (channelToolNames.has(name)) throw new Error(`Interaction Channel tool ${name} is duplicated`);
    channelToolNames.add(name);
  }
  if (options.defaultInteractionRoute !== undefined && !options.defaultInteractionRoute.trim()) {
    throw new Error("Default Interaction Route cannot be blank");
  }
  if (options.channelAgentSurface?.defaultDestination
    && options.channelAgentSurface.defaultDestination.routeRef !== options.defaultInteractionRoute) {
    throw new Error("Interaction Channel default Destination must use the default Interaction Route");
  }
  const sessionFactory = await createPiSessionFactory({
    agentWorkspace: options.agentWorkspace,
    agentDir: options.agentDir,
    transcriptDirectory: options.transcriptDirectory,
    modelRuntime: options.modelRuntime,
    model: options.model,
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.skillSources ? { skillSources: options.skillSources } : {}),
    additionalTools,
  });
  const createSession = (
    systemPrompt: string,
    turnTools: ToolDefinition[],
    activityExtension: InlineExtension,
    annotationLifecycle: InputAnnotationLifecycle,
    sessionManager: SessionManager,
  ) => sessionFactory({
    systemPrompt,
    turnTools,
    activityExtension,
    onMessageStart: message => annotationLifecycle.onMessageStart(message),
    sessionManager,
  });
  return new PerTurnPiAgentExecution(
    options.transcriptDirectory,
    options.agentWorkspace,
    createSession,
    options.loadContextMaterials ?? (async () => ({ turnLive: [], windowFrozen: [] })),
    options.harnessSystemPrompt,
    options.channelAgentSurface,
    options.interactionEnabled ?? false,
    options.defaultInteractionRoute,
    options.contextBudget,
    options.toolTraceCompactor,
    options.attachmentStore,
    options.model.input.includes("image"),
    new Set([
      ...MAIN_AGENT_BUILTIN_TOOLS,
      ...additionalTools.map(tool => tool.name),
      ...(options.attachmentStore ? ["attachment"] : []),
    ]),
    options.observe,
  );
}

function assertChannelTools(names: readonly string[], tools: ToolDefinition[]): void {
  const actual = tools.map(tool => tool.name);
  if (new Set(actual).size !== actual.length) {
    throw new Error("Interaction Channel tools contain a duplicate name");
  }
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) {
    throw new Error("Interaction Channel tool names do not match the declared action surface");
  }
}

function requiresMessageDecision(input: Pick<ExecutionInput, "kind">): boolean {
  return input.kind === "interaction" || input.kind === "continuation";
}

function hasMessageDecision(decision: MessageTurnDecision): boolean {
  return decision.sent > 0 || decision.noReply;
}

function messageDecisionFollowupText(): string {
  return [
    "<message_decision_required>",
    "The Main Agent did not choose how this interaction ends.",
    "Ordinary assistant text is not delivered to the human.",
    "If you want to reply, call message.send. If no reply is needed, call message.no_reply.",
    "Make one of those decisions now; do not answer only with ordinary assistant text.",
    "</message_decision_required>",
  ].join("\n");
}

export function behaviorForInput(
  input: Pick<ExecutionInput, "kind" | "payload">,
): WorkspaceTurnKind {
  if (input.kind === "interaction") return "interactivity";
  if (input.kind === "opportunity") return "proactivity";
  if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    if (input.payload.sourceBehavior === "interactivity") return "interactivity";
    if (input.payload.sourceBehavior === "proactivity") return "proactivity";
  }
  throw new Error("Continuation Input requires a source Behavior");
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

function currentInputMessage(
  input: ExecutionInput,
  presentation: InputPresentation,
): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: presentation.text },
      ...presentation.images,
    ],
    timestamp: Date.parse(input.occurredAt),
  };
}

function currentAttentionMessage(content: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: section("Current Attention", content) }],
    timestamp: 0,
  };
}

function composeSystemPrompt(
  harnessSystemPrompt: string,
  snapshot: AgentWorkspaceTurnSnapshot,
  interactionChannelGuidance: string | undefined,
): string {
  return [
    section("Harness System Guidance", harnessSystemPrompt),
    section("Identity", snapshot.identity),
    section("Behavior", snapshot.behavior),
    section("Long-term Memory", snapshot.longTermMemory),
    ...(interactionChannelGuidance?.trim()
      ? [section("Interaction Channel Guidance", interactionChannelGuidance.trim())]
      : []),
  ].join("\n\n");
}

function section(label: string, content: string): string {
  return `# ${label}\n\n${content}`;
}

function textTokens(text: string): number {
  return Math.max(0, estimateTokens({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  }));
}
