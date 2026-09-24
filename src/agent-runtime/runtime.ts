import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  ContextContinuityCoordinator,
  createContextProjectionDefinition,
  type ContextProjectionState,
  type TransitionPlan,
} from '@wowyuarm/dsh-context-continuity'
import type { AgentRuntime, RuntimeState } from '../contracts/index.ts'
import {
  createLoomContextProjectionConfig,
  createLoomContinuityTools,
  LOOM_CONTEXT_CODEC,
  LOOM_SUBJECT_ID,
  LoomContextContinuityHost,
  type LoomSubjectId,
} from '../context-continuity/host.ts'
import { bootAgent, presetSetup, type BootDeps } from './boot.ts'

export interface RuntimeDeps {
  agents: Pick<AgentRegistry, 'create' | 'resume'>
  runtimeState: RuntimeState
  /** Absolute workspace path used as each session's cwd. */
  workspace: string
  /** Loop options (provider/model); omit when a default-model plugin supplies them. */
  agentOptions?: AgentOptions
  /**
   * Compose each agent's capability set from its preset, inside its creation window. Every
   * generation joins the same preset, so a rollover successor sees the tools its predecessor did.
   */
  mountPreset?: (agentCtx: Context) => Promise<void>
  /** Read one live agent's engine-folded continuity state; omitted in unit tests without a projection. */
  projectionOf?: (agent: Agent) => ContextProjectionState | undefined
  /** Coordinator diagnostics sink; omitted in production unless a logger is wired. */
  log?: (message: string) => void
  /** Session id minter for a first boot; overridable for deterministic tests. */
  newSessionId?: () => SessionId
}

/**
 * Owns the one live agent across its whole life: the initial boot (resume-or-create) and every
 * generational context rollover. The context-continuity engine decides when to roll over (folding
 * the model's `context_rollover` result) and hands this a TransitionPlan; the mechanical swap
 * (dispose old, create successor, deliver) is this runtime's job because it holds the one handle.
 */
export class LoomAgentRuntime implements AgentRuntime {
  private handle: AgentHandle | undefined
  private readonly host: LoomContextContinuityHost
  private readonly coordinator: ContextContinuityCoordinator<LoomSubjectId>

  constructor(private readonly deps: RuntimeDeps) {
    this.host = new LoomContextContinuityHost({
      agentForSubject: () => this.handle?.agent,
      sessionForAgent: agent => agent.id,
      projectionForSubject: sessionId => {
        const agent = this.handle?.agent
        if (agent === undefined || agent.session.id !== sessionId) return undefined
        return this.deps.projectionOf?.(agent)
      },
      executeTransition: plan => this.executeTransition(plan),
      log: message => { this.deps.log?.(message) },
    })
    this.coordinator = new ContextContinuityCoordinator(this.host, LOOM_CONTEXT_CODEC)
  }

  current(): Agent | undefined {
    return this.handle?.agent
  }

  deliver(text: string): boolean {
    const agent = this.handle?.agent
    if (agent === undefined) return false
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return true
  }

  /**
   * Register the per-session continuity projection, the model-facing rollover tool, and the
   * drive seams: session events feed the coordinator, and a pending rollover arms the inbox
   * admission gate so old-generation turns capture rather than consume input owed to the
   * successor. Call before boot so the projection covers the session from its first event.
   */
  install(ctx: Context): void {
    ctx.effect(
      () => ctx.sessionProjections.register(createContextProjectionDefinition(createLoomContextProjectionConfig(this.host))),
      'context-continuity.projection',
    )
    const tools = createLoomContinuityTools()
    ctx.effect(() => ctx.tools.register(tools.rollover), 'context-continuity.rollover-tool')

    ctx.on('session/event', (session, event) => {
      const agent = this.handle?.agent
      if (agent !== undefined && session.id === agent.session.id) {
        this.coordinator.onSessionEvent(LOOM_SUBJECT_ID, agent, event)
      }
    })
    // A durable rollover result must not let a queued old-generation turn open another request:
    // capture that input for the successor instead of admitting it.
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (agent === this.handle?.agent && this.coordinator.needsAdmissionGate(agent)) {
        this.coordinator.captureQueuedInput(agent)
      }
    })
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (agent !== this.handle?.agent) return next()
      if (this.coordinator.needsAdmissionGate(agent)) {
        this.coordinator.captureClaimedInput(agent, messages)
        return { kind: 'reject' as const }
      }
      const decision = await next()
      if (decision.kind === 'reject' || !this.coordinator.needsAdmissionGate(agent)) return decision
      this.coordinator.captureClaimedInput(agent, messages)
      return { kind: 'reject' as const }
    })
  }

  async boot(): Promise<void> {
    const deps: BootDeps = {
      agents: this.deps.agents,
      runtimeState: this.deps.runtimeState,
      workspace: this.deps.workspace,
      ...(this.deps.agentOptions === undefined ? {} : { agentOptions: this.deps.agentOptions }),
      ...(this.deps.mountPreset === undefined ? {} : { mountPreset: this.deps.mountPreset }),
      ...(this.deps.newSessionId === undefined ? {} : { newSessionId: this.deps.newSessionId }),
    }
    this.handle = await bootAgent(deps)
    // Finish a swap a restart interrupted after the rollover result was durable but before the
    // successor took over: the engine re-derives the pending intent from the folded projection.
    this.coordinator.recoverPendingTransition(LOOM_SUBJECT_ID, this.handle.agent, this.handle.agent.id)
  }

  /**
   * One generation swap at an idle boundary: build the handoff, dispose the old agent (releasing
   * the single-active lease), create the successor at the plan's deterministic session id chained
   * to its predecessor, commit the current-generation pointer, then deliver the handoff ahead of
   * any carried input. The engine derived newSessionId/requestId, so a crash mid-swap re-drives to
   * the same identity; a throw here leaves the previous generation recoverable, which the
   * coordinator relies on.
   *
   * The successor's `parentSession` is the previous generation. That header field is the lineage:
   * the context-continuity engine walks it to classify a searched generation as current, prior, or
   * archived, and to decide which past generation a `context_rollover` may return to. The pointer
   * carries no lineage of its own — duplicating it there would be a second record nothing reads.
   */
  async executeTransition(plan: TransitionPlan): Promise<void> {
    const handoff = this.coordinator.handoffMessageFor(plan)
    const setup = presetSetup(this.deps.mountPreset)

    if (this.handle !== undefined) {
      await this.handle.dispose()
      this.handle = undefined
    }
    const successor = await this.deps.agents.create({
      sessionId: plan.newSessionId,
      meta: { cwd: this.deps.workspace, parentSession: plan.previousSessionId },
      ...(this.deps.agentOptions === undefined ? {} : { agentOptions: this.deps.agentOptions }),
      ...(setup === undefined ? {} : { setup }),
    })
    await this.deps.runtimeState.setCurrentSession({ sessionId: plan.newSessionId })
    this.handle = successor

    successor.agent.steer(handoff)
    for (const message of plan.carriedInput) successor.agent.followup(message)
  }

  async dispose(): Promise<void> {
    this.coordinator.dispose()
    if (this.handle !== undefined) {
      await this.handle.dispose()
      this.handle = undefined
    }
  }
}
