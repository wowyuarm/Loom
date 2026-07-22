import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createHostTimePolicy,
  createTimePolicy,
  loadInstanceConfiguration,
  openModelRuntimeRevisions,
  DEFAULT_SCHEDULE,
  type ModelRuntimeRevisionStatus,
  type InstanceConfiguration,
} from "../configuration/index.js";
import {
  createScheduler,
  openRuntime,
  type AcceptedInput,
  type Runtime,
  type RuntimeInput,
  type OutboundDelivery,
  type RuntimeStatus,
  type Scheduler,
  type SchedulerRunResult,
  type FormOpportunityResult,
} from "../runtime/index.js";
import { createNmemRecallTool, type NmemRecallToolOptions } from "../integrations/nmem/index.js";
import { createMainAgentActivityLifecycle } from "../main-agent/activity.js";
import { AgentWorkspace } from "../workspace/agent-workspace.js";
import {
  DEFAULT_BACKGROUND_BEHAVIOR,
  DEFAULT_INTERACTION_BEHAVIOR,
} from "./default-materials.js";
import { resolveInstanceLayout, type InstanceLayout } from "./layout.js";
import { createRevisionBoundMainAgent } from "./revision-bound-main-agent.js";
import {
  createRevisionBoundLifeRecorder,
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
  "nmem_recall",
] as const;

export type LoomInstanceRunResult =
  | { disposition: "deferred"; reason: "model_runtime_blocked" }
  | SchedulerRunResult;

export interface LoomInstanceStatus {
  runtime: RuntimeStatus;
  models: ModelRuntimeRevisionStatus;
}

export type LoomInstanceOpportunityResult =
  | FormOpportunityResult
  | { disposition: "deferred"; reason: "model_runtime_blocked" };

export interface LoomInstance {
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  runOnce(observedAt: Date): Promise<LoomInstanceRunResult>;
  formOpportunity(): Promise<LoomInstanceOpportunityResult>;
  status(): LoomInstanceStatus;
  close(): void;
}

export interface OpenLoomInstanceOptions {
  root: string;
  machineTimeZone?: string;
  now?: () => Date;
  outboundDelivery?: OutboundDelivery;
  nmem?: NmemRecallToolOptions;
}

class AssembledLoomInstance implements LoomInstance {
  constructor(
    private readonly runtime: Runtime,
    private readonly revisions: ReturnType<typeof openModelRuntimeRevisions>,
    private readonly scheduler: Scheduler,
  ) {}

  acceptInput(input: RuntimeInput): Promise<AcceptedInput> {
    return this.runtime.acceptInput(input);
  }

  async runOnce(observedAt: Date): Promise<LoomInstanceRunResult> {
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Loom Instance requires a valid observedAt");
    const result = await this.scheduler.runOnce(observedAt);
    if (result.disposition === "deferred" && result.reason === "agent_work_not_admitted") {
      return { disposition: "deferred", reason: "model_runtime_blocked" };
    }
    return result;
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
    return { runtime: this.runtime.status(), models };
  }

  close(): void {
    this.runtime.close();
  }
}

export async function openLoomInstance(options: OpenLoomInstanceOptions): Promise<LoomInstance> {
  const layout = resolveInstanceLayout(options.root);
  await prepareInstanceDirectories(layout);
  await materializeDefaultBehavior(layout.workspaceRoot);
  const configuration = await loadAssemblyConfiguration(layout, options.machineTimeZone);
  const agentWorkspace = new AgentWorkspace(layout.workspaceRoot);
  const recallTool = createNmemRecallTool(options.nmem ?? {});
  const revisions = openModelRuntimeRevisions({
    configurationFile: layout.configurationFile,
    authPath: layout.piAuthFile,
    modelsPath: layout.piModelsFile,
    modelsStorePath: layout.piModelsStoreFile,
    ...(options.machineTimeZone ? { machineTimeZone: options.machineTimeZone } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await revisions.refresh();
  const execution = createRevisionBoundMainAgent({
    revisions,
    layout,
    agentWorkspace,
    ...(configuration.defaultInteractionRoute
      ? { defaultInteractionRoute: configuration.defaultInteractionRoute }
      : {}),
    additionalTools: [recallTool],
  });
  const orientation = createRevisionBoundOrientation({
    revisions,
    layout,
    agentWorkspace,
    loadOrientationActionSpace: async () => ({
      skills: await loadWorkspaceSkillIndex(layout.workspaceRoot),
      mainAgentTools: [
        ...MAIN_AGENT_ACTION_TOOLS,
        ...(configuration.defaultInteractionRoute ? ["message"] : []),
      ],
      evidenceSources: options.nmem?.endpoint ? ["nmem"] : [],
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
    }),
    threadMaintenance,
    ...(options.outboundDelivery ? { outboundDelivery: options.outboundDelivery } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
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
  }));
}

async function loadAssemblyConfiguration(
  layout: InstanceLayout,
  machineTimeZone: string | undefined,
): Promise<InstanceConfiguration> {
  try {
    return await loadInstanceConfiguration({
      file: layout.configurationFile,
      ...(machineTimeZone ? { machineTimeZone } : {}),
    });
  } catch {
    return {
      version: 1,
      timePolicy: machineTimeZone
        ? createTimePolicy({ timeZone: machineTimeZone })
        : createHostTimePolicy(),
      schedule: DEFAULT_SCHEDULE,
    };
  }
}

async function prepareInstanceDirectories(layout: InstanceLayout): Promise<void> {
  await Promise.all([
    mkdir(path.dirname(layout.configurationFile), { recursive: true }),
    mkdir(layout.piAgentDirectory, { recursive: true }),
    mkdir(layout.workspaceRoot, { recursive: true }),
    mkdir(layout.runtimeRoot, { recursive: true }),
    mkdir(layout.mainTranscriptDirectory, { recursive: true }),
    mkdir(layout.organTranscriptRoot, { recursive: true }),
    mkdir(layout.backupRoot, { recursive: true }),
  ]);
}

async function materializeDefaultBehavior(workspaceRoot: string): Promise<void> {
  const behaviorRoot = path.join(workspaceRoot, "behavior");
  await mkdir(behaviorRoot, { recursive: true });
  await Promise.all([
    writeIfMissing(path.join(behaviorRoot, "interaction.md"), DEFAULT_INTERACTION_BEHAVIOR),
    writeIfMissing(path.join(behaviorRoot, "background.md"), DEFAULT_BACKGROUND_BEHAVIOR),
  ]);
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
    throw error;
  }
}
