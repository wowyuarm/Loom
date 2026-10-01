import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  ContextContinuityCoordinator,
  createContextProjectionDefinition,
  createContinuityTools,
  type ContextProjectionConfig,
  type ContextProjectionState,
  type ContextSearchPort,
  type StoredSessionReadResult,
  type TransitionPlan,
} from '@wowyuarm/dsh-context-continuity'
import type { AgentRuntime, RuntimeState } from '../contracts/index.ts'
import {
  createLoomContextProjectionConfig,
  LOOM_CONTEXT_CODEC,
  LOOM_SUBJECT_ID,
  LoomContextContinuityHost,
  type LoomSubjectId,
} from '../context-continuity/host.ts'
import { LoomContextRetrieval, type ContextBudget } from '../context-continuity/retrieval.ts'
import { createLoomPressurePolicy } from '../context-continuity/pressure.ts'
import type { ContextPressurePolicy } from '@wowyuarm/dsh-context-continuity'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { bootAgent, presetSetup, type BootDeps } from './boot.ts'

/**
 * The file-effect stance this individual runs under: no write restriction. It is stated in code
 * rather than a deployment's environment because a session's mode lives in its own session log —
 * the last `sandbox/mode` event wins — so a mode pinned here reaches the session the moment it
 * activates, while a deployment default only reaches sessions created after that default changes.
 */
const SANDBOX_MODE: SandboxMode = 'danger-full-access'

/**
 * Pin {@link SANDBOX_MODE} on a session that just activated (boot's resume-or-create, or a
 * rollover successor). The switch IS its event, so only append when the last logged one differs:
 * pinning unconditionally would grow one redundant event per generation.
 *
 * @param session - the freshly activated session.
 * @returns whether an event was appended.
 */
function pinSandboxMode(session: Session): boolean {
  const logged = session.ownEvents().filter(event => event.type === 'sandbox/mode').at(-1)
  if (logged?.data.mode === SANDBOX_MODE) return false
  setSandboxMode(session, SANDBOX_MODE)
  return true
}

/**
 * The ctx-derived capabilities the retrieval and return surface needs: reading archived ancestor
 * logs, the token meter, the handoff budget, and the session-query engine. Present in a real
 * deployment; omitted in unit tests that exercise the swap mechanics without a search stack, where
 * only the rollover tool is registered.
 */
export interface RetrievalDeps {
  readAncestor: (sessionId: SessionId) => Promise<StoredSessionReadResult>
  meter: () => TokenMeter | undefined
  budgetOf: (agent: Agent) => Promise<ContextBudget | undefined>
  query: ContextSearchPort
}

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
  /** Retrieval/return capabilities; omit to register only the rollover tool (unit tests). */
  retrieval?: RetrievalDeps
  /**
   * Context-pressure capabilities: the compaction engine in the agent's scope, used to force a
   * reduction at the hard limit. Omit to run without a pressure policy (unit tests, or a
   * composition whose floor is elsewhere). Requires `retrieval` too, since the policy prices
   * against the same budget.
   */
  pressure?: {
    compactionFor: (agent: Agent) => CompactionEngine | undefined
  }
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
  private readonly config: ContextProjectionConfig
  private readonly retrieval: LoomContextRetrieval | undefined
  private readonly pressure: ContextPressurePolicy<LoomSubjectId> | undefined

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
    this.config = createLoomContextProjectionConfig(this.host)
    this.retrieval = this.deps.retrieval === undefined
      ? undefined
      : new LoomContextRetrieval({
          agentForSubject: () => this.handle?.agent,
          host: this.host,
          config: this.config,
          readAncestor: this.deps.retrieval.readAncestor,
          meter: this.deps.retrieval.meter,
          budgetOf: this.deps.retrieval.budgetOf,
          ownedSessions: () => this.deps.runtimeState.ownedSessions(),
          query: this.deps.retrieval.query,
        })
    this.pressure = this.deps.retrieval === undefined || this.deps.pressure === undefined
      ? undefined
      : createLoomPressurePolicy({
          agentForSubject: () => this.handle?.agent,
          budgetOf: this.deps.retrieval.budgetOf,
          measure: agent => this.deps.retrieval?.meter()?.measure(agent.session)?.totalTokens,
          compactionFor: this.deps.pressure.compactionFor,
          ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
        })
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
      () => ctx.sessionProjections.register(createContextProjectionDefinition(this.config)),
      'context-continuity.projection',
    )
    // The rollover tool is always present; the checkpoint, timeline, and retrieval-ladder tools
    // exist only when the retrieval stack was wired (a real deployment). A rollover result is the
    // durable fact the projection folds either way.
    if (this.retrieval === undefined) {
      const tools = createContinuityTools({
        requestRollover: () => Promise.resolve({ mode: 'scheduled' }),
        isRestorableRef: () => Promise.resolve(false),
        recordCheckpoint: () => Promise.reject(new Error('loom: checkpoints require the retrieval stack')),
        timeline: () => Promise.reject(new Error('loom: the context timeline requires the retrieval stack')),
      })
      ctx.effect(() => ctx.tools.register(tools.rollover), 'context-continuity.rollover-tool')
    } else {
      const tools = createContinuityTools(this.retrieval.toolAdapter())
      const search = this.retrieval.searchTools()
      ctx.effect(() => ctx.tools.register(tools.rollover), 'context-continuity.rollover-tool')
      ctx.effect(() => ctx.tools.register(tools.checkpoint), 'context-continuity.checkpoint-tool')
      ctx.effect(() => ctx.tools.register(tools.timeline), 'context-continuity.timeline-tool')
      ctx.effect(() => ctx.tools.register(search.search), 'context-continuity.search-tool')
      ctx.effect(() => ctx.tools.register(search.read), 'context-continuity.read-tool')
    }

    ctx.on('session/event', (session, event) => {
      const agent = this.handle?.agent
      if (agent !== undefined && session.id === agent.session.id) {
        this.coordinator.onSessionEvent(LOOM_SUBJECT_ID, agent, event)
        // A successful assistant response ends any open provider-overflow recovery sequence.
        if (event.type === 'assistant/message') this.pressure?.onAssistantMessage(LOOM_SUBJECT_ID)
      }
    })
    // A durable rollover result must not let a queued old-generation turn open another request:
    // capture that input for the successor instead of admitting it.
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (agent === this.handle?.agent && this.coordinator.needsAdmissionGate(agent)) {
        this.coordinator.captureQueuedInput(agent)
      }
    })
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      if (agent !== this.handle?.agent) return next()
      if (this.coordinator.needsAdmissionGate(agent)) {
        this.coordinator.captureClaimedInput(agent, messages)
        return { kind: 'reject' as const }
      }
      // Pressure rides the same seam after the admission gate: the handoff-budget notice steers
      // into this running turn, and the hard limit forces a reduction before the request is
      // forwarded — failing closed rejects the step rather than submitting over the limit.
      if (this.pressure !== undefined) {
        const pressure = await this.pressure.onPreStep(LOOM_SUBJECT_ID, signal)
        if (pressure.kind === 'reject') return { kind: 'reject' as const }
      }
      const decision = await next()
      if (decision.kind === 'reject' || !this.coordinator.needsAdmissionGate(agent)) return decision
      this.coordinator.captureClaimedInput(agent, messages)
      return { kind: 'reject' as const }
    })
    // Provider context-overflow recovery: one bounded reduce-and-retry sequence per failure chain.
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (agent !== this.handle?.agent || this.pressure === undefined) return next()
      return (await this.pressure.onRequestError(LOOM_SUBJECT_ID, failure, signal))
        ? { kind: 'retry' as const }
        : next()
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
    pinSandboxMode(this.handle.agent.session)
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
   *
   * A fresh rollover seeds nothing and parents at the previous generation. A checkpoint return
   * (`plan.checkpointRef`) instead seeds the successor with the exact prefix through the cited
   * anchor and parents at that anchor's source generation. The seed is resolved BEFORE the old
   * agent is disposed: a violation there fails the whole swap with the previous generation intact,
   * never a guessed seed over a wrong prefix.
   */
  async executeTransition(plan: TransitionPlan): Promise<void> {
    const handoff = this.coordinator.handoffMessageFor(plan)
    const setup = presetSetup(this.deps.mountPreset)
    const seed = plan.checkpointRef === undefined || this.retrieval === undefined
      ? undefined
      : await this.retrieval.resolveCheckpointSeed(plan.checkpointRef)

    if (this.handle !== undefined) {
      await this.handle.dispose()
      this.handle = undefined
    }
    const parentSession = seed === undefined ? plan.previousSessionId : seed.sourceSessionId
    const successor = await this.deps.agents.create({
      sessionId: plan.newSessionId,
      meta: {
        cwd: this.deps.workspace,
        parentSession,
        ...(seed === undefined ? {} : { isSeeded: true }),
      },
      ...(seed === undefined ? {} : { seed: seed.prefix, inheritedEventCount: SessionLogOffset(seed.prefix.length) }),
      ...(this.deps.agentOptions === undefined ? {} : { agentOptions: this.deps.agentOptions }),
      ...(setup === undefined ? {} : { setup }),
    })
    await this.deps.runtimeState.setCurrentSession({ sessionId: plan.newSessionId })
    await this.deps.runtimeState.recordSession(String(plan.newSessionId))
    this.handle = successor
    pinSandboxMode(successor.agent.session)

    successor.agent.steer(handoff)
    for (const message of plan.carriedInput) successor.agent.followup(message)
  }

  async dispose(): Promise<void> {
    this.pressure?.dispose()
    this.coordinator.dispose()
    if (this.handle !== undefined) {
      await this.handle.dispose()
      this.handle = undefined
    }
  }
}
