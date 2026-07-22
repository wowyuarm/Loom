import path from "node:path";

import type { ModelRuntimeRevision, ModelRuntimeRevisions } from "../configuration/index.js";
import { createPiToolTraceCompactor } from "../agents/tool-trace-compactor.js";
import { createPiAgentExecution, type PiAgentExecution } from "../main-agent/pi-execution.js";
import { HARNESS_SYSTEM_GUIDANCE } from "../main-agent/system-guidance.js";
import type {
  AgentExecution,
  RunningExecution,
  TurnControl,
  TurnRequest,
} from "../runtime/index.js";
import type { AgentWorkspace } from "../workspace/agent-workspace.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InstanceLayout } from "./layout.js";

export interface RevisionBoundMainAgentOptions {
  revisions: ModelRuntimeRevisions;
  layout: InstanceLayout;
  agentWorkspace: AgentWorkspace;
  defaultInteractionRoute?: string;
  additionalTools?: ToolDefinition[];
}

class RevisionBoundMainAgent implements AgentExecution {
  constructor(private readonly options: RevisionBoundMainAgentOptions) {}

  start(request: TurnRequest, control: TurnControl): RunningExecution {
    const revision = this.options.revisions.current();
    let execution: PiAgentExecution | undefined;
    const running = this.#start(revision, request, control).then(value => {
      execution = value.execution;
      return value.running;
    });
    return {
      result: running.then(delegate => delegate.result).finally(() => execution?.close()),
      steer: async input => (await running).steer(input),
      abort: async reason => (await running).abort(reason),
    };
  }

  async #start(
    revision: ModelRuntimeRevision,
    request: TurnRequest,
    control: TurnControl,
  ): Promise<{ execution: PiAgentExecution; running: RunningExecution }> {
    const role = request.inputs[0]?.kind === "opportunity" ? "main-background" : "main-interaction";
    const main = firstCandidate(revision, role);
    const compactorModel = firstCandidate(revision, "tool-trace-compactor");
    const compactor = await createPiToolTraceCompactor({
      agentDir: this.options.layout.piAgentDirectory,
      transcriptDirectory: path.join(this.options.layout.organTranscriptRoot, "tool-trace-compactor"),
      modelRuntime: compactorModel.modelRuntime,
      model: compactorModel.model,
      ...(compactorModel.thinkingLevel ? { thinkingLevel: compactorModel.thinkingLevel } : {}),
    });
    const execution = await createPiAgentExecution({
      agentWorkspace: this.options.agentWorkspace,
      agentDir: this.options.layout.piAgentDirectory,
      transcriptDirectory: this.options.layout.mainTranscriptDirectory,
      modelRuntime: main.modelRuntime,
      model: main.model,
      ...(main.thinkingLevel ? { thinkingLevel: main.thinkingLevel } : {}),
      harnessSystemPrompt: HARNESS_SYSTEM_GUIDANCE,
      ...(this.options.defaultInteractionRoute
        ? { defaultInteractionRoute: this.options.defaultInteractionRoute }
        : {}),
      ...(this.options.additionalTools ? { additionalTools: this.options.additionalTools } : {}),
      toolTraceCompactor: compactor,
    });
    return { execution, running: execution.start(request, control) };
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

export function createRevisionBoundMainAgent(options: RevisionBoundMainAgentOptions): AgentExecution {
  return new RevisionBoundMainAgent(options);
}
