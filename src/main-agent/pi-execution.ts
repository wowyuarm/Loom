import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  type InlineExtension,
  type ModelRuntime,
  type ResourceDiagnostic,
  type Skill,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentExecution,
  ExecutionInput,
  ExecutionResult,
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

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type PiContextMessage = AgentMessage;

const MAIN_AGENT_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

interface PreparedPiSession {
  session: PiSession;
  acceptedSkillCount: number;
  skillDiagnostics: ResourceDiagnostic[];
}

export interface PiAgentExecutionOptions {
  agentWorkspace: AgentWorkspace;
  agentDir: string;
  transcriptDirectory: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  harnessSystemPrompt: string;
  defaultInteractionRoute?: string;
  additionalTools?: ToolDefinition[];
  skillSources?: PiSkillSources;
  loadContextMaterials?: (request: TurnRequest) => Promise<PiContextMaterials>;
  contextBudget?: Partial<ContextBudget>;
  toolTraceCompactor?: ToolTraceCompactor;
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
    });
    active.annotations.push({ inputId: input.id, annotationEntryId });
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
    private readonly defaultInteractionRoute: string | undefined,
    private readonly contextBudget: Partial<ContextBudget> | undefined,
    private readonly toolTraceCompactor: ToolTraceCompactor | undefined,
    private readonly ordinaryToolNames: Set<string>,
  ) {}

  start(request: TurnRequest, control: TurnControl): PiRunningExecution {
    if (this.#closed) throw new Error("Agent Execution is closed");
    if (this.#runningTurnId) throw new Error(`Agent Execution is already running Turn ${this.#runningTurnId}`);
    if (request.inputs.length !== 1) throw new Error("A new Pi Turn requires exactly one initial Input");
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
          await session.steer(inputText(input, {
            structureHumanInput: input.kind === "interaction",
            includeMessageReminder: Boolean(this.defaultInteractionRoute) && firstInteraction,
            humanArrivedDuringNonInteraction:
              request.inputs[0]!.kind !== "interaction" && firstInteraction,
          }));
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
      const systemPrompt = composeSystemPrompt(this.harnessSystemPrompt, workspaceSnapshot);
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
      if (this.defaultInteractionRoute) {
        turnTools.push(createMessageTool({
          control: lifecycle.control(request.turnId),
          routeRef: this.defaultInteractionRoute,
          decision: messageDecision,
        }));
      }
      const preparedSession = await this.createSession(
        systemPrompt,
        turnTools,
        toolActivityExtension(
          lifecycle.control(request.turnId),
          this.ordinaryToolNames,
        ),
        lifecycle,
        sessionManager,
      );
      session = preparedSession.session;
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
        structureHumanInput: Boolean(this.defaultInteractionRoute) && firstInteraction,
        includeMessageReminder: Boolean(this.defaultInteractionRoute) && firstInteraction,
      };
      const materialized = materializeTurnContext({
        currentInput: currentInputMessage(request.inputs[0]!, initialInputOptions),
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
      session.agent.state.messages = materialized.messages;
      const previousMessageCount = session.messages.length;
      const prompt = session.prompt(
        inputText(request.inputs[0]!, initialInputOptions),
        { expandPromptTemplates: false },
      );
      this.#sessionReady!.resolve(session);
      await prompt;
      this.#acceptsSteering = false;
      this.#throwIfAborted(request.turnId);
      if (this.defaultInteractionRoute
        && (requiresMessageDecision(request.inputs[0]!) || lifecycle.hasIncludedInteraction(request.turnId))
        && !hasMessageDecision(messageDecision)) {
        sessionManager.appendCustomEntry("loom.internal-prompt.v1", {
          version: 1,
          turnId: request.turnId,
          purpose: "message-decision-correction",
        });
        await session.prompt(messageDecisionFollowupText(), { expandPromptTemplates: false });
        this.#throwIfAborted(request.turnId);
        if (!hasMessageDecision(messageDecision)) {
          throw new Error("Main Agent did not choose message.send or message.no_reply after one correction");
        }
      }
      const evidence = await verifyPrimaryTranscriptEvidence({
        transcriptDirectory: this.transcriptDirectory,
        sourceId: request.recordingDay,
        sessionId: sessionManager.getSessionId(),
        inputs: lifecycle.evidenceRequest(request.turnId),
        ...(this.defaultInteractionRoute ? { terminalToolNames: ["message"] } : {}),
      });
      this.#throwIfAborted(request.turnId);
      const completedWindow = completeContextWindow(
        preparedWindow,
        serializeMessages(session.messages.slice(previousMessageCount)),
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
  const reservedTools = new Set<string>([
    ...MAIN_AGENT_BUILTIN_TOOLS,
    "expand_tool_result",
    "message",
  ]);
  const additionalToolNames = new Set<string>();
  for (const tool of options.additionalTools ?? []) {
    if (reservedTools.has(tool.name)) {
      throw new Error(`${tool.name} is maintained by Loom and cannot be supplied as an additional tool`);
    }
    if (additionalToolNames.has(tool.name)) {
      throw new Error(`Additional tool ${tool.name} is duplicated`);
    }
    additionalToolNames.add(tool.name);
  }
  if (options.defaultInteractionRoute !== undefined && !options.defaultInteractionRoute.trim()) {
    throw new Error("Default Interaction Route cannot be blank");
  }
  await Promise.all([
    mkdir(options.agentDir, { recursive: true }),
    mkdir(options.transcriptDirectory, { recursive: true }),
  ]);
  // Agent Workspace files are Individual material, not a Pi project configuration source.
  const settingsManager = SettingsManager.create(
    options.agentWorkspace.root,
    options.agentDir,
    { projectTrusted: false },
  );
  const createSession = async (
    systemPrompt: string,
    turnTools: ToolDefinition[],
    activityExtension: InlineExtension,
    annotationLifecycle: InputAnnotationLifecycle,
    sessionManager: SessionManager,
  ) => {
    const annotationExtension: InlineExtension = {
      name: "loom-input-annotation",
      factory: pi => {
        pi.on("message_start", event => annotationLifecycle.onMessageStart(event.message));
      },
    };
    const workspaceSkills = path.join(options.agentWorkspace.root, "skills");
    const hasWorkspaceSkills = await exists(workspaceSkills);
    const additionalSkillPaths = [
      ...(options.skillSources?.core ?? []),
      ...(hasWorkspaceSkills ? [workspaceSkills] : []),
      ...(options.skillSources?.integrations ?? []),
    ];
    let resourceLoader: DefaultResourceLoader;
    resourceLoader = new DefaultResourceLoader({
      cwd: options.agentWorkspace.root,
      agentDir: options.agentDir,
      settingsManager,
      extensionFactories: [annotationExtension, activityExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths,
      skillsOverride: result => resolveSkills(result.skills, result.diagnostics),
      systemPromptOverride: () => appendSkillDiagnostics(
        systemPrompt,
        resourceLoader.getSkills().diagnostics,
      ),
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const customTools = [...(options.additionalTools ?? []), ...turnTools];
    const { session } = await createAgentSession({
      cwd: options.agentWorkspace.root,
      agentDir: options.agentDir,
      modelRuntime: options.modelRuntime,
      model: options.model,
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      tools: [...MAIN_AGENT_BUILTIN_TOOLS, ...customTools.map(tool => tool.name)],
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    await session.bindExtensions({});
    const finalSkills = resourceLoader.getSkills();
    return {
      session,
      acceptedSkillCount: finalSkills.skills.length,
      skillDiagnostics: finalSkills.diagnostics,
    };
  };
  return new PerTurnPiAgentExecution(
    options.transcriptDirectory,
    options.agentWorkspace,
    createSession,
    options.loadContextMaterials ?? (async () => ({ turnLive: [], windowFrozen: [] })),
    options.harnessSystemPrompt,
    options.defaultInteractionRoute,
    options.contextBudget,
    options.toolTraceCompactor,
    new Set([
      ...MAIN_AGENT_BUILTIN_TOOLS,
      ...(options.additionalTools ?? []).map(tool => tool.name),
    ]),
  );
}

function compareSkills(left: Skill, right: Skill): number {
  return compareText(left.name, right.name) || compareText(left.filePath, right.filePath);
}

function resolveSkills(
  skills: Skill[],
  diagnostics: ResourceDiagnostic[],
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const rejectedPaths = new Set(diagnostics.flatMap(diagnostic =>
    diagnostic.type !== "collision" && diagnostic.path ? [diagnostic.path] : []));
  const collisionNames = new Set(diagnostics.flatMap(diagnostic =>
    diagnostic.type === "collision" && diagnostic.collision?.resourceType === "skill"
      ? [diagnostic.collision.name]
      : []));
  const manualDiagnostics: ResourceDiagnostic[] = skills.flatMap(skill => skill.disableModelInvocation ? [{
    type: "warning" as const,
    message: `skill "${skill.name}" disables model invocation`,
    path: skill.filePath,
  }] : []);
  return {
    skills: skills
      .filter(skill => !skill.disableModelInvocation
        && !rejectedPaths.has(skill.filePath)
        && !collisionNames.has(skill.name))
      .sort(compareSkills),
    diagnostics: [...diagnostics, ...manualDiagnostics].sort(compareDiagnostics),
  };
}

function compareDiagnostics(left: ResourceDiagnostic, right: ResourceDiagnostic): number {
  return compareText(left.path ?? "", right.path ?? "")
    || compareText(left.type, right.type)
    || compareText(left.message, right.message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toolActivityExtension(
  control: TurnControl,
  ordinaryToolNames: Set<string>,
): InlineExtension {
  const calls = new Map<string, { toolName: string; args: JsonValue }>();
  return {
    name: "loom-tool-activity",
    factory: pi => {
      pi.on("tool_execution_start", event => {
        if (!ordinaryToolNames.has(event.toolName)) return;
        calls.set(event.toolCallId, {
          toolName: event.toolName,
          args: serializeValue(event.args),
        });
      });
      pi.on("tool_execution_end", event => {
        const call = calls.get(event.toolCallId);
        calls.delete(event.toolCallId);
        if (!call || event.isError || event.toolName !== call.toolName) return;
        control.recordToolActivity({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          callArguments: call.args,
          result: serializeValue(event.result),
        });
      });
    },
  };
}

function appendSkillDiagnostics(systemPrompt: string, diagnostics: ResourceDiagnostic[]): string {
  if (diagnostics.length === 0) return systemPrompt;
  return `${systemPrompt}\n\n${section("Skill Diagnostics", JSON.stringify(diagnostics, null, 2))}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function inputText(input: ExecutionInput, options: {
  structureHumanInput?: boolean;
  includeMessageReminder?: boolean;
  humanArrivedDuringNonInteraction?: boolean;
} = {}): string {
  if (input.kind === "opportunity") return opportunityInputText(input);
  if (input.kind === "continuation") return afterChatContinuationInputText(input);
  if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    const text = input.payload.text;
    if (typeof text === "string") {
      if (!options.structureHumanInput && !options.humanArrivedDuringNonInteraction) return text;
      const lines = options.humanArrivedDuringNonInteraction ? [
          "A human message arrived while the non-interaction Turn was still running.",
          "Treat it as a real current interaction, not as part of the earlier background opportunity or continuation.",
          "",
        ] : [];
      lines.push(
        "<human_input>",
        text,
        "</human_input>",
      );
      if (options.includeMessageReminder) {
        lines.push(
          "",
          "To make a reply visible to the human, use message.send; ordinary assistant text is not delivered.",
          "If this interaction can naturally end without another message, use message.no_reply.",
          "This interaction must end with one of those decisions.",
        );
      }
      return lines.join("\n");
    }
  }
  return JSON.stringify(input.payload);
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

function afterChatContinuationInputText(input: ExecutionInput): string {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("Continuation Input requires a structured payload");
  }
  const observedAt = input.payload.observedAt;
  const deliveredAt = input.payload.deliveredAt;
  if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) {
    throw new Error("Continuation Input requires observedAt");
  }
  if (typeof deliveredAt !== "string" || Number.isNaN(Date.parse(deliveredAt))) {
    throw new Error("Continuation Input requires deliveredAt");
  }
  return [
    "<after_chat_continuation>",
    `Observed at: ${observedAt}`,
    `A message from the current activity was confirmed delivered ${elapsedTime(observedAt, deliveredAt)} ago.`,
    "No new human Input has been accepted since that delivery.",
    "</after_chat_continuation>",
    "",
    "This is not a human message or a task. The recent exchange may simply still be present.",
    "",
    "If something genuinely remains, you may look into it, continue private work, or say it through message. If nothing does, use message.no_reply and let it pass.",
    "",
    "Do not manufacture a follow-up merely because this continuation occurred.",
  ].join("\n");
}

export function behaviorForInput(
  input: Pick<ExecutionInput, "kind" | "payload">,
): WorkspaceTurnKind {
  if (input.kind === "interaction") return "interaction";
  if (input.kind === "opportunity") return "opportunity";
  if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    if (input.payload.sourceBehavior === "interaction") return "interaction";
    if (input.payload.sourceBehavior === "background") return "opportunity";
  }
  throw new Error("Continuation Input requires a source Behavior");
}

function opportunityInputText(input: ExecutionInput): string {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("Opportunity Input requires a structured payload");
  }
  const narrative = input.payload.narrative;
  const observedAt = input.payload.observedAt;
  const localTime = input.payload.localTime;
  const lastHumanInputAt = input.payload.lastHumanInputAt;
  if (typeof narrative !== "string" || !narrative.trim()) {
    throw new Error("Opportunity Input requires a narrative");
  }
  if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) {
    throw new Error("Opportunity Input requires observedAt");
  }
  const timing = typeof lastHumanInputAt === "string" && !Number.isNaN(Date.parse(lastHumanInputAt))
    ? [`Time since the latest human Input: ${elapsedTime(observedAt, lastHumanInputAt)}`]
    : [];
  return [
    "<proactive_opportunity>",
    `Observed at: ${observedAt}`,
    ...(typeof localTime === "string" && localTime.trim() ? [`Local time: ${localTime.trim()}`] : []),
    ...timing,
    "",
    "A possible point of attention was found:",
    "",
    narrative.trim(),
    "</proactive_opportunity>",
    "",
    "This is not a human message and it is not a task assignment. Treat it as a possible point of attention.",
    "You may let it pass, inspect or change Workspace material, continue private work, change direction, or reach out through the available interaction tools when something is genuinely worth sending.",
    "Do not report this wrapper or its internal fields to the human.",
  ].join("\n");
}

function elapsedTime(later: string, earlier: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(later) - Date.parse(earlier)) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} hours ${minutes % 60} minutes` : `${minutes} minutes`;
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
  options: Parameters<typeof inputText>[1],
): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: inputText(input, options) }],
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
): string {
  return [
    section("Harness System Guidance", harnessSystemPrompt),
    section("Identity", snapshot.identity),
    section("Behavior", snapshot.behavior),
    section("Long-term Memory", snapshot.longTermMemory),
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
