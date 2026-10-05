import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import {
  ContextPressurePolicy,
  contextPressureNoticeText,
  type PressureGate,
  type PressureJudgement,
  type PressureLimits,
  type PressureLogSpan,
  type PressurePolicyHost,
  type PressureRelatedness,
  type PressureStepDecision,
  type PressureSurface,
} from '@wowyuarm/dsh-context-continuity'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { LOOM_CONTEXT_CONTINUITY_PLUGIN_ID, LOOM_SUBJECT_ID, type LoomSubjectId } from './host.ts'
import type { ContextBudget } from './retrieval.ts'

/** How many earlier user inputs the long-gap judge is shown beside the arriving one. */
const RECENT_INPUT_LIMIT = 8

export interface LoomPressureDeps {
  /** The live agent, or undefined when not activated. */
  readonly agentForSubject: () => Agent | undefined
  /** The current generation's context budget (usage + handoff + hard limit), or undefined when unknown. */
  readonly budgetOf: (agent: Agent) => Promise<ContextBudget | undefined>
  /** Measured context tokens for a session, for the reduction proof; undefined when no meter. */
  readonly measure: (agent: Agent) => number | undefined
  /** The compaction engine in the agent's scope, or undefined when none is mounted. */
  readonly compactionFor: (agent: Agent) => CompactionEngine | undefined
  /**
   * The relatedness judge behind the long-gap gate, or undefined to leave the gate off. Resolved
   * per call because the judge is optional: a deployment without it simply never holds a step.
   */
  readonly judge?: () => PressureJudgement | undefined
  /**
   * This agent's own live background jobs, as one line each. Read from the job registry, which is
   * host-plane; undefined when the composition mounts no registry, so the notice omits the count
   * rather than claiming there is none.
   */
  readonly jobsFor?: (agent: Agent) => readonly string[]
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
    // No claims: Loom runs one Individual, so there is no peer-owned work to name. Jobs are real
    // and the registry is mounted, so they are read rather than assumed away — a rollover disposes
    // the agent and cancels the jobs it owned, which is exactly what this line warns about.
    const agent = this.requireAgent()
    const jobs = agent === undefined ? undefined : this.deps.jobsFor?.(agent)
    return { inHand: [], jobs: jobs ?? [] }
  }

  /**
   * Record the input one pre-step is admitting. The policy hands back no messages, and the only
   * copy of what is arriving is the pre-step's own argument, so the wrapper stashes it here for
   * the duration of the step and nothing outside that window can read a stale one.
   */
  beginStep(messages: readonly UserMessage[]): void {
    this.admitting = messages
  }

  endStep(): void {
    this.admitting = undefined
  }

  relatednessFor(_subject: LoomSubjectId): PressureRelatedness | undefined {
    const agent = this.requireAgent()
    const admitted = this.admitting
    // Without a live agent or a claimed step there is nothing to judge: the gate stays off rather
    // than holding an input it cannot describe.
    if (agent === undefined || admitted === undefined) return undefined
    const input = externalInputText(admitted)
    if (input.trim().length === 0) return undefined
    return { input, recent: recentInput(agent, admitted) }
  }

  judgeFor(_subject: LoomSubjectId): PressureJudgement | undefined {
    if (this.requireAgent() === undefined) return undefined
    return this.deps.judge?.()
  }

  steer(_subject: LoomSubjectId, notice: UserMessage): void {
    // Steering appends the notice to the agent's durable log, which is the evidence the engine's
    // once-per-generation latch reads back — so a restart stays quiet and a rollover re-arms.
    // Missing is a failure, never a no-op: the engine wraps this call, and a held step whose
    // instruction never arrived would stall behind a message that does not exist.
    const agent = this.requireAgent()
    if (agent === undefined) throw new Error('loom: no live agent to steer the context notice into')
    agent.steer(notice)
  }

  failedFor(_subject: LoomSubjectId, diagnostic: string): void {
    this.deps.log?.(`context pressure blocked a step: ${diagnostic}`)
  }

  log(message: string): void {
    this.deps.log?.(message)
  }

  private admitting: readonly UserMessage[] | undefined
}

/** The arriving input as one text body, keeping only the blocks the judge can read. */
function externalInputText(messages: readonly UserMessage[]): string {
  return messages
    .flatMap(message => message.source.kind === 'user' ? [messageText(message)] : [])
    .join('\n')
}

/**
 * This generation's earlier external inputs, oldest first. Loom's real input arrives through
 * `deliver()` as `source.kind === 'user'`; every engine and plugin notice carries its producer's
 * plugin id instead, so this filter is what keeps the agent's own machinery out of the judge's
 * continuity view. The admitted messages are dropped for being already the arriving input.
 */
function recentInput(agent: Agent, admitted: readonly UserMessage[]): readonly string[] {
  const admittedIds = new Set(admitted.map(message => message.id))
  return agent.session.deriveMessages()
    .flatMap(message => (
      message.role === 'user'
      && message.source.kind === 'user'
      && !admittedIds.has(message.id)
      ? [messageText(message)]
      : []
    ))
    .filter(text => text.trim().length > 0)
    .slice(-RECENT_INPUT_LIMIT)
}

function messageText(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * The pressure policy over a Loom host, wrapping the engine's so the claimed input of the current
 * pre-step is readable to the long-gap gate. The engine's `onPreStep(subject, signal)` takes no
 * messages — the host is asked about relatedness while the step is deciding — so the wrapper holds
 * them for exactly that call and clears them on the way out, success or failure.
 */
export class LoomPressurePolicy {
  /** The window holder: it owns the step-scoped admitting state this wrapper exists to scope. */
  readonly host: LoomPressureHost
  private readonly policy: ContextPressurePolicy<LoomSubjectId>

  constructor(deps: LoomPressureDeps) {
    this.host = new LoomPressureHost(deps)
    this.policy = new ContextPressurePolicy(this.host)
  }

  onPreStep(
    subject: LoomSubjectId,
    messages: readonly UserMessage[],
    signal: AbortSignal,
  ): Promise<PressureStepDecision> {
    this.host.beginStep(messages)
    return this.policy.onPreStep(subject, signal).finally(() => this.host.endStep())
  }

  onRequestError(
    subject: LoomSubjectId,
    failure: Parameters<ContextPressurePolicy<LoomSubjectId>['onRequestError']>[1],
    signal: AbortSignal,
  ): ReturnType<ContextPressurePolicy<LoomSubjectId>['onRequestError']> {
    return this.policy.onRequestError(subject, failure, signal)
  }

  onAssistantMessage(subject: LoomSubjectId): void {
    this.policy.onAssistantMessage(subject)
  }

  dispose(): void {
    this.policy.dispose()
  }
}

/** Build the single-subject pressure policy over a Loom host. */
export function createLoomPressurePolicy(deps: LoomPressureDeps): LoomPressurePolicy {
  return new LoomPressurePolicy(deps)
}

export { LOOM_SUBJECT_ID, contextPressureNoticeText }
