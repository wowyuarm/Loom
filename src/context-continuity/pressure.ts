import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import {
  ContextPressurePolicy,
  contextPressureNoticeText,
  type PressureLimits,
  type PressureLogSpan,
  type PressurePolicyHost,
  type PressureSurface,
} from '@wowyuarm/dsh-context-continuity'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { LOOM_CONTEXT_CONTINUITY_PLUGIN_ID, LOOM_SUBJECT_ID, type LoomSubjectId } from './host.ts'
import type { ContextBudget } from './retrieval.ts'

export interface LoomPressureDeps {
  /** The live agent, or undefined when not activated. */
  readonly agentForSubject: () => Agent | undefined
  /** The current generation's context budget (usage + handoff + hard limit), or undefined when unknown. */
  readonly budgetOf: (agent: Agent) => Promise<ContextBudget | undefined>
  /** Measured context tokens for a session, for the reduction proof; undefined when no meter. */
  readonly measure: (agent: Agent) => number | undefined
  /** The compaction engine in the agent's scope, or undefined when none is mounted. */
  readonly compactionFor: (agent: Agent) => CompactionEngine | undefined
  /** Diagnostics sink. */
  readonly log?: (message: string) => void
}

/**
 * Loom's single-subject host for the context-continuity pressure policy. The engine owns the
 * decision order (below handoff budget quiet; at it one durable one-shot notice; at the hard
 * limit a forced reduction that fails closed); this host only answers per-subject questions and
 * steers the notice the engine builds. Reuses the same budget the retrieval/timeline surface
 * prices against, so the notice and the return ladder agree on where the wall is.
 */
export class LoomPressureHost implements PressurePolicyHost<LoomSubjectId> {
  readonly pluginId = LOOM_CONTEXT_CONTINUITY_PLUGIN_ID

  constructor(private readonly deps: LoomPressureDeps) {}

  private requireAgent(): Agent | undefined {
    return this.deps.agentForSubject()
  }

  async limitsFor(): Promise<PressureLimits | undefined> {
    const agent = this.requireAgent()
    if (agent === undefined) return undefined
    const budget = await this.deps.budgetOf(agent)
    if (budget === undefined) return undefined
    return { usageTokens: budget.usageTokens, hardLimit: budget.hardLimit, handoffAt: budget.handoffAt }
  }

  surfaceFor(): PressureSurface {
    const agent = this.requireAgent()
    if (agent === undefined) return { generation: 0 }
    const tokens = this.deps.measure(agent)
    return { generation: agent.session.surface.replaceGeneration, ...(tokens === undefined ? {} : { tokens }) }
  }

  compactionFor(): { reduce: (reason: 'context-overflow', signal: AbortSignal) => Promise<unknown> } | undefined {
    const agent = this.requireAgent()
    if (agent === undefined) return undefined
    const engine = this.deps.compactionFor(agent)
    if (engine === undefined) return undefined
    // The engine's forced-reduction entry point takes the agent; the policy's capability does
    // not, so bind it here to the current agent.
    return { reduce: (reason, signal) => engine.compactIfNeeded(agent, reason, signal) }
  }

  logSpanFor(): PressureLogSpan {
    const agent = this.requireAgent()
    if (agent === undefined) return { sessionId: LOOM_SUBJECT_ID, inheritedEventCount: 0, events: [] }
    return {
      sessionId: String(agent.session.id),
      inheritedEventCount: Number(agent.session.inheritedEventCount),
      events: agent.session.snapshotEvents(),
    }
  }

  inHandFor(): { inHand: readonly string[]; jobs: readonly string[] } {
    // v1 carries no owned jobs or claims; the notice states usage and the handoff default only.
    return { inHand: [], jobs: [] }
  }

  steer(_subject: LoomSubjectId, notice: UserMessage): void {
    // Steering appends the notice to the agent's durable log, which is the evidence the engine's
    // once-per-generation latch reads back — so a restart stays quiet and a rollover re-arms.
    this.requireAgent()?.steer(notice)
  }

  failedFor(_subject: LoomSubjectId, diagnostic: string): void {
    this.deps.log?.(`context pressure blocked a step: ${diagnostic}`)
  }

  log(message: string): void {
    this.deps.log?.(message)
  }
}

/** Build the single-subject pressure policy over a Loom host. */
export function createLoomPressurePolicy(deps: LoomPressureDeps): ContextPressurePolicy<LoomSubjectId> {
  return new ContextPressurePolicy(new LoomPressureHost(deps))
}

export { LOOM_SUBJECT_ID, contextPressureNoticeText }
