import path from "node:path";

import { access } from "node:fs/promises";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

import { createPiLifeRecorder } from "../agents/life-recorder.js";
import { createPiAttentionMaintainer } from "../agents/attention-maintainer.js";
import { createPiOrientation, type OrientationActionSpace } from "../agents/orientation.js";
import {
  createPiThreadMaintainer,
  threadObservationsFromActivity,
} from "../agents/thread-maintainer/index.js";
import type { ModelRuntimeRevision, ModelRuntimeRevisions } from "../configuration/index.js";
import type {
  ActivityRecorder,
  AttentionMaintenance,
  AttentionMaintenanceRequest,
  AttentionMaintenanceResult,
  FrozenActivity,
  LifeRecorderReceipt,
  Orientation,
  OrientationRequest,
  OrientationResult,
  ThreadMaintenance,
  ThreadMaintenanceRequest,
  ThreadMaintenanceResult,
} from "../runtime/index.js";
import type { AgentWorkspace } from "../workspace/agent-workspace.js";
import type { InstanceLayout } from "./layout.js";

export interface RevisionBoundOrganOptions {
  revisions: ModelRuntimeRevisions;
  layout: InstanceLayout;
  agentWorkspace: AgentWorkspace;
  loadOrientationActionSpace?: () => Promise<OrientationActionSpace>;
}

class RevisionBoundOrientation implements Orientation {
  constructor(private readonly options: RevisionBoundOrganOptions) {}

  async form(request: OrientationRequest): Promise<OrientationResult> {
    const selection = firstCandidate(this.options.revisions.current(), "orientation");
    const orientation = await createPiOrientation({
      agentWorkspace: this.options.agentWorkspace,
      agentDir: this.options.layout.piAgentDirectory,
      transcriptDirectory: path.join(this.options.layout.organTranscriptRoot, "orientation"),
      modelRuntime: selection.modelRuntime,
      model: selection.model,
      ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
      loadActionSpace: this.options.loadOrientationActionSpace ?? (async () => ({
        skills: await loadWorkspaceSkillIndex(this.options.agentWorkspace.root),
        mainAgentTools: [],
        evidenceSources: [],
      })),
    });
    return orientation.form(request);
  }
}

class RevisionBoundLifeRecorder implements ActivityRecorder {
  constructor(private readonly options: RevisionBoundOrganOptions) {}

  async record(activity: FrozenActivity): Promise<LifeRecorderReceipt> {
    const selection = firstCandidate(this.options.revisions.current(), "life-recorder");
    const recorder = await createPiLifeRecorder({
      agentWorkspace: this.options.agentWorkspace,
      agentDir: this.options.layout.piAgentDirectory,
      transcriptDirectory: path.join(this.options.layout.organTranscriptRoot, "life-recorder"),
      modelRuntime: selection.modelRuntime,
      model: selection.model,
      ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
    });
    return recorder.record(activity);
  }
}

class RevisionBoundThreadMaintenance implements ThreadMaintenance {
  constructor(private readonly options: RevisionBoundOrganOptions & {
    loadActivity: (activityId: string) => Promise<FrozenActivity | undefined>;
  }) {}

  observationsFor(activity: FrozenActivity) {
    return threadObservationsFromActivity(activity, this.options.agentWorkspace.root);
  }

  async maintain(request: ThreadMaintenanceRequest): Promise<ThreadMaintenanceResult> {
    const selection = firstCandidate(this.options.revisions.current(), "thread-maintainer");
    const maintainer = await createPiThreadMaintainer({
      agentWorkspace: this.options.agentWorkspace,
      agentDir: this.options.layout.piAgentDirectory,
      transcriptDirectory: path.join(this.options.layout.organTranscriptRoot, "thread-maintainer"),
      stateFile: path.join(this.options.layout.runtimeRoot, "thread-evidence.json"),
      modelRuntime: selection.modelRuntime,
      model: selection.model,
      loadActivity: this.options.loadActivity,
    });
    return maintainer.maintain(request);
  }
}

class RevisionBoundAttentionMaintenance implements AttentionMaintenance {
  constructor(private readonly options: RevisionBoundOrganOptions) {}

  async maintain(request: AttentionMaintenanceRequest): Promise<AttentionMaintenanceResult> {
    const selection = firstCandidate(this.options.revisions.current(), "attention-maintainer");
    const maintainer = await createPiAttentionMaintainer({
      agentWorkspace: this.options.agentWorkspace,
      agentDir: this.options.layout.piAgentDirectory,
      transcriptDirectory: path.join(this.options.layout.organTranscriptRoot, "attention-maintainer"),
      modelRuntime: selection.modelRuntime,
      model: selection.model,
    });
    return maintainer.maintain(request);
  }
}

function firstCandidate(
  revision: ModelRuntimeRevision,
  role: Parameters<ModelRuntimeRevision["selection"]>[0],
) {
  const selection = revision.selection(role);
  const candidate = selection.candidates[0];
  if (!candidate) throw new Error(`Model Runtime Revision has no candidate for ${role}`);
  return { modelRuntime: selection.modelRuntime, ...candidate };
}

export function createRevisionBoundLifeRecorder(options: RevisionBoundOrganOptions): ActivityRecorder {
  return new RevisionBoundLifeRecorder(options);
}

export function createRevisionBoundOrientation(options: RevisionBoundOrganOptions): Orientation {
  return new RevisionBoundOrientation(options);
}

export function createRevisionBoundThreadMaintenance(
  options: RevisionBoundOrganOptions & {
    loadActivity: (activityId: string) => Promise<FrozenActivity | undefined>;
  },
): ThreadMaintenance {
  return new RevisionBoundThreadMaintenance(options);
}

export function createRevisionBoundAttentionMaintenance(
  options: RevisionBoundOrganOptions,
): AttentionMaintenance {
  return new RevisionBoundAttentionMaintenance(options);
}

export async function loadWorkspaceSkillIndex(
  workspaceRoot: string,
): Promise<Array<{ name: string; description: string }>> {
  const directory = path.join(workspaceRoot, "skills");
  try {
    await access(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return loadSkillsFromDir({ dir: directory, source: "workspace" }).skills
    .filter(skill => !skill.disableModelInvocation)
    .map(skill => ({ name: skill.name, description: skill.description }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
