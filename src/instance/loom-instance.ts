import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  loadInstanceConfiguration,
  openModelRuntimeRevisions,
  type ModelRuntimeRevisionStatus,
  type InstanceConfiguration,
} from "../configuration/index.js";
import {
  createScheduler,
  openRuntime,
  type AcceptedInput,
  type InteractionViewOptions,
  type InteractionViewPage,
  type Runtime,
  type RuntimeInput,
  type RuntimeInputOutcome,
  type RequeueInputResult,
  type RequeueCognitiveOrganWorkResult,
  type OutboundDelivery,
  type RuntimeStatus,
  type RuntimeOperationalStatus,
  type Scheduler,
  type SchedulerRunResult,
  type FormOpportunityResult,
} from "../runtime/index.js";
import {
  createNmemEpisodeReconciler,
  createNmemRecallTool,
  createNmemThreadReconciler,
  createNmemWorkingMemoryReader,
  type NmemEpisodeReconciler,
  type NmemProjectionStatus,
  type NmemRecallToolOptions,
  type NmemThreadReconciler,
} from "../integrations/nmem/index.js";
import { attachmentReferences } from "../attachments/index.js";
import { createMainAgentActivityLifecycle } from "../main-agent/activity.js";
import { AgentWorkspace } from "../workspace/agent-workspace.js";
import { recoverWorkspaceMutations } from "../workspace/workspace-mutation.js";
import { resolveInstanceLayout, type InstanceLayout } from "./layout.js";
import {
  assertNoLegacyAttachmentStore,
  openAttachmentStore,
  type AttachmentStore,
} from "../attachments/index.js";
import { createRevisionBoundMainAgent } from "./revision-bound-main-agent.js";
import type { InteractionChannelAgentSurface } from "../channels/surface.js";
import type { WebAccessIntegration } from "../integrations/web/index.js";
import type { OperationalEventObserver } from "../operational-events.js";
import {
  createRevisionBoundLifeRecorder,
  createRevisionBoundAttentionMaintenance,
  createRevisionBoundMemoryReflection,
  createRevisionBoundOrientation,
  createRevisionBoundThreadMaintenance,
  loadWorkspaceSkillIndex,
} from "./revision-bound-organs.js";

const MAIN_AGENT_ACTION_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "expand_tool_result",
  "attachment",
] as const;

const DEFAULT_MODEL_RUNTIME_REFRESH_MS = 30 * 1_000;

export type LoomInstanceRunResult = (
  | { disposition: "deferred"; reason: "model_runtime_blocked" }
  | SchedulerRunResult
) & { nextRunAt?: string };

export interface LoomInstanceStatus {
  runtime: RuntimeStatus;
  models: ModelRuntimeRevisionStatus;
  nmem?: {
    threads: NmemProjectionStatus;
    episodes: NmemProjectionStatus;
  };
}

export type LoomInstanceOpportunityResult =
  | FormOpportunityResult
  | { disposition: "deferred"; reason: "model_runtime_blocked" };

export interface LoomInstance {
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  interactionView(options?: InteractionViewOptions): InteractionViewPage;
  inputOutcome(inputId: string): RuntimeInputOutcome;
  requeueInput(inputId: string): RequeueInputResult;
  /** Create a successor budget cycle for blocked / intervention_required Cognitive Organ work. */
  requeueCognitiveOrganWork(workId: string): RequeueCognitiveOrganWorkResult;
  runOnce(observedAt: Date): Promise<LoomInstanceRunResult>;
  formOpportunity(): Promise<LoomInstanceOpportunityResult>;
  status(): LoomInstanceStatus;
  operationalStatus(options?: { since?: string }): RuntimeOperationalStatus;
  close(): void;
}

export interface OpenLoomInstanceOptions {
  root: string;
  machineTimeZone?: string;
  now?: () => Date;
  outboundDelivery?: OutboundDelivery;
  /** Whether at least one Interaction Channel is enabled; gates the message tool. */
  interactionEnabled?: boolean;
  channelAgentSurface?: InteractionChannelAgentSurface;
  webAccess?: WebAccessIntegration;
  nmem?: NmemRecallToolOptions;
  attachmentStore?: AttachmentStore;
  observe?: OperationalEventObserver;
}

class AssembledLoomInstance implements LoomInstance {
  constructor(
    private readonly runtime: Runtime,
    private readonly revisions: ReturnType<typeof openModelRuntimeRevisions>,
    private readonly scheduler: Scheduler,
    private readonly workingMemoryReader: ReturnType<typeof createNmemWorkingMemoryReader> | undefined,
    private readonly attachmentStore: AttachmentStore,
    private readonly ownsAttachmentStore: boolean,
    private readonly nmem?: {
      threads: NmemThreadReconciler;
      episodes: NmemEpisodeReconciler;
    },
  ) {}

  acceptInput(input: RuntimeInput): Promise<AcceptedInput> {
    return this.runtime.acceptInput(input);
  }

  interactionView(options?: InteractionViewOptions): InteractionViewPage {
    return this.runtime.interactionView(options);
  }

  inputOutcome(inputId: string): RuntimeInputOutcome {
    return this.runtime.inputOutcome(inputId);
  }

  requeueInput(inputId: string): RequeueInputResult {
    return this.runtime.requeueInput(inputId);
  }

  requeueCognitiveOrganWork(workId: string): RequeueCognitiveOrganWorkResult {
    return this.runtime.requeueCognitiveOrganWork(workId);
  }

  async runOnce(observedAt: Date): Promise<LoomInstanceRunResult> {
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Loom Instance requires a valid observedAt");
    const result = await this.scheduler.runOnce(observedAt);
    await this.#reconcileAttachments(observedAt);
    if (result.disposition === "deferred" && result.reason === "agent_work_not_admitted") {
      const nmemNextRunAt = await this.#reconcileNmem();
      return mergeNextRunAt(
        mergeNextRunAt(
          { disposition: "deferred", reason: "model_runtime_blocked" },
          new Date(observedAt.getTime() + DEFAULT_MODEL_RUNTIME_REFRESH_MS).toISOString(),
        ),
        nmemNextRunAt,
      );
    }
    const nmemNextRunAt = await this.#reconcileNmem();
    return mergeNextRunAt(result, nmemNextRunAt);
  }

  async formOpportunity(): Promise<LoomInstanceOpportunityResult> {
    if ((await this.revisions.refresh()).state === "blocked") {
      return { disposition: "deferred", reason: "model_runtime_blocked" };
    }
    return this.runtime.formOpportunity();
  }

  status(): LoomInstanceStatus {
    const models = this.revisions.status();
    if (!models) throw new Error("Loom Instance model status is unavailable after opening");
    return {
      runtime: this.runtime.status(),
      models,
      ...(this.nmem ? {
        nmem: {
          threads: this.nmem.threads.status(),
          episodes: this.nmem.episodes.status(),
        },
      } : {}),
    };
  }

  operationalStatus(options: { since?: string } = {}): RuntimeOperationalStatus {
    return this.runtime.operationalStatus(options);
  }

  close(): void {
    this.runtime.close();
    this.workingMemoryReader?.close();
    if (this.ownsAttachmentStore) this.attachmentStore.close();
    this.nmem?.threads.close();
    this.nmem?.episodes.close();
  }

  async #reconcileNmem(): Promise<string | undefined> {
    if (!this.nmem) return undefined;
    await this.nmem.threads.reconcile();
    await this.nmem.episodes.reconcile();
    return earliestProjectionAttempt([
      this.nmem.threads.status(),
      this.nmem.episodes.status(),
    ]);
  }

  async #reconcileAttachments(observedAt: Date): Promise<void> {
    const status = this.runtime.status();
    const activeAttachmentIds = [
      ...status.inputs
        .filter(input => input.status === "pending" || input.status === "active")
        .flatMap(input => attachmentReferences(input.payload).map(attachment => attachment.id)),
      ...status.effects
        .filter(effect => effect.status === "pending" || effect.status === "reconciliation_required")
        .flatMap(effect => attachmentReferences(effect.payload).map(attachment => attachment.id)),
    ];
    await this.attachmentStore.reconcileRetention({ activeAttachmentIds, observedAt });
  }
}

function earliestProjectionAttempt(statuses: NmemProjectionStatus[]): string | undefined {
  const attempts = statuses.flatMap(status => status.items)
    .flatMap(item => item.nextAttemptAt ? [item.nextAttemptAt] : []);
  return attempts.reduce<string | undefined>((earliest, candidate) =>
    !earliest || Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest, undefined);
}

function mergeNextRunAt(
  result: LoomInstanceRunResult,
  candidate: string | undefined,
): LoomInstanceRunResult {
  if (!candidate) return result;
  const current = "nextRunAt" in result ? result.nextRunAt : undefined;
  const nextRunAt = current && Date.parse(current) <= Date.parse(candidate) ? current : candidate;
  if (result.disposition === "idle") return { disposition: "waiting", nextRunAt };
  return { ...result, nextRunAt };
}

export async function openLoomInstance(options: OpenLoomInstanceOptions): Promise<LoomInstance> {
  const layout = resolveInstanceLayout(options.root);
  await assertNoLegacyAttachmentStore(layout.attachmentStoreRoot);
  const configuration = await loadAssemblyConfiguration(layout, options.machineTimeZone);
  const nmemEnabled = Boolean(options.nmem?.endpoint);
  if (configuration.integrations.nmem !== nmemEnabled) {
    throw new Error(configuration.integrations.nmem
      ? "Enabled nmem requires explicit connection configuration"
      : "nmem connection was provided while the Integration is disabled");
  }
  const agentWorkspace = new AgentWorkspace(layout.workspaceRoot);
  await prepareRuntimeDirectories(layout);
  await recoverWorkspaceMutations({
    workspaceRoot: layout.workspaceRoot,
    journalRoot: layout.workspaceMutationRoot,
  });
  await Promise.all([
    agentWorkspace.loadTurnSnapshot("interactivity"),
    agentWorkspace.loadStableFacts(),
  ]);
  const ownsAttachmentStore = !options.attachmentStore;
  const attachmentStore = options.attachmentStore ?? await openAttachmentStore({
    root: layout.attachmentStoreRoot,
    ...(options.now ? { now: options.now } : {}),
  });
  const recallTool = nmemEnabled ? createNmemRecallTool(options.nmem ?? {}) : undefined;
  const workingMemoryReader = nmemEnabled ? createNmemWorkingMemoryReader({
    stateRoot: layout.runtimeRoot,
    ...(options.nmem ?? {}),
    ...(options.now ? { now: options.now } : {}),
  }) : undefined;
  const revisions = openModelRuntimeRevisions({
    configurationFile: layout.configurationFile,
    authPath: layout.piAuthFile,
    modelsPath: layout.piModelsFile,
    modelsStorePath: layout.piModelsStoreFile,
    ...(options.machineTimeZone ? { machineTimeZone: options.machineTimeZone } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });
  await revisions.refresh();
  const execution = createRevisionBoundMainAgent({
    revisions,
    layout,
    agentWorkspace,
    attachmentStore,
    interactionEnabled: options.interactionEnabled ?? false,
    ...(options.observe ? { observe: options.observe } : {}),
    ...(options.channelAgentSurface ? { channelAgentSurface: options.channelAgentSurface } : {}),
    ...(configuration.defaultInteractionRoute
      ? { defaultInteractionRoute: configuration.defaultInteractionRoute }
      : {}),
    ...((recallTool || options.webAccess) ? { additionalTools: [
      ...(recallTool ? [recallTool] : []),
      ...(options.webAccess?.tools() ?? []),
    ] } : {}),
  });
  const orientation = createRevisionBoundOrientation({
    revisions,
    layout,
    agentWorkspace,
    ...(options.channelAgentSurface?.attentionSource
      ? { externalAttentionSource: options.channelAgentSurface.attentionSource }
      : {}),
    loadOrientationActionSpace: async () => ({
      skills: await loadWorkspaceSkillIndex(layout.workspaceRoot),
      mainAgentTools: [
        ...MAIN_AGENT_ACTION_TOOLS,
        ...(recallTool ? ["nmem_recall" as const] : []),
        ...((options.interactionEnabled ?? false) ? ["message"] : []),
        ...(options.channelAgentSurface?.tools.names ?? []),
      ],
      evidenceSources: [
        ...(options.nmem?.endpoint ? ["nmem"] : []),
        ...(options.channelAgentSurface?.attentionSource ? ["raft"] : []),
      ],
    }),
  });
  let runtime!: Runtime;
  const threadMaintenance = createRevisionBoundThreadMaintenance({
    revisions,
    layout,
    agentWorkspace,
    loadActivity: async activityId => runtime.frozenActivity(activityId),
  });
  runtime = openRuntime({
    root: layout.runtimeRoot,
    timePolicy: configuration.timePolicy,
    execution,
    orientation,
    activityLifecycle: createMainAgentActivityLifecycle({
      agentWorkspace,
      transcriptDirectory: layout.mainTranscriptDirectory,
    }),
    activityRecorder: createRevisionBoundLifeRecorder({
      revisions,
      layout,
      agentWorkspace,
      ...(options.now ? { now: options.now } : {}),
    }),
    attentionMaintenance: createRevisionBoundAttentionMaintenance({
      revisions,
      layout,
      agentWorkspace,
    }),
    memoryReflection: createRevisionBoundMemoryReflection({
      revisions,
      layout,
      agentWorkspace,
      ...(workingMemoryReader ? { workingMemoryReader } : {}),
      ...(recallTool ? { nmemRecallTool: recallTool } : {}),
    }),
    threadMaintenance,
    ...(options.outboundDelivery ? { outboundDelivery: options.outboundDelivery } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });
  const nmem = options.nmem?.endpoint ? {
    threads: createNmemThreadReconciler({
      runtime,
      stateRoot: layout.runtimeRoot,
      ...options.nmem,
      ...(options.now ? { now: options.now } : {}),
    }),
    episodes: createNmemEpisodeReconciler({
      runtime,
      agentWorkspace,
      stateRoot: layout.runtimeRoot,
      ...options.nmem,
      ...(options.now ? { now: options.now } : {}),
    }),
  } : undefined;
  return new AssembledLoomInstance(runtime, revisions, createScheduler({
    runtime,
    admitAgentWork: async () => (await revisions.refresh()).state !== "blocked",
    proactivePulse: {
      timeZone: configuration.timePolicy.timeZone,
      intervalMs: configuration.schedule.proactivePulse.intervalMinutes * 60 * 1_000,
      quietHours: {
        start: configuration.schedule.proactivePulse.quietHours.start,
        end: configuration.schedule.proactivePulse.quietHours.end,
        intervalMs: configuration.schedule.proactivePulse.quietHours.intervalMinutes * 60 * 1_000,
      },
    },
    attentionMaintenance: {
      intervalMs: configuration.schedule.attentionMaintenance.intervalMinutes * 60 * 1_000,
    },
    memoryReflection: {
      delayMs: configuration.schedule.memoryReflection.delayMinutes * 60 * 1_000,
    },
  }), workingMemoryReader, attachmentStore, ownsAttachmentStore, nmem);
}

async function loadAssemblyConfiguration(
  layout: InstanceLayout,
  machineTimeZone: string | undefined,
): Promise<InstanceConfiguration> {
  return loadInstanceConfiguration({
    file: layout.configurationFile,
    ...(machineTimeZone ? { machineTimeZone } : {}),
  });
}

async function prepareRuntimeDirectories(layout: InstanceLayout): Promise<void> {
  await Promise.all([
    mkdir(layout.runtimeRoot, { recursive: true }),
    mkdir(layout.mainTranscriptDirectory, { recursive: true }),
    mkdir(layout.organTranscriptRoot, { recursive: true }),
    mkdir(layout.backupRoot, { recursive: true }),
  ]);
}
