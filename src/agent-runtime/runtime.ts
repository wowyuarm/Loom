import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextContinuityCoordinator, TransitionPlan } from '@wowyuarm/dsh-context-continuity'
import type { AgentRuntime, RuntimeState } from '../contracts/index.ts'
import { createLoomContextManagement, type LoomSubjectId } from '../context-continuity/host.ts'
import { bootAgent, type BootDeps } from './boot.ts'

export interface RuntimeDeps {
  agents: Pick<AgentRegistry, 'create' | 'resume'>
  runtimeState: RuntimeState
  /** Absolute workspace path used as each session's cwd. */
  workspace: string
  /** Loop options (provider/model); omit when a default-model plugin supplies them. */
  agentOptions?: AgentOptions
  /** Coordinator diagnostics sink; omitted in production unless a logger is wired. */
  log?: (message: string) => void
  /** Session id minter for a first boot; overridable for deterministic tests. */
  newSessionId?: () => SessionId
}

/**
 * Owns the one live agent across its whole life: the initial boot (resume-or-create) and every
 * generational context rollover. The context-continuity engine decides when to roll over and
 * hands this a TransitionPlan; the mechanical swap (dispose old, create successor, deliver) is
 * this runtime's job because it is the holder of the single live handle.
 */
export class LoomAgentRuntime implements AgentRuntime {
  private handle: AgentHandle | undefined
  private readonly coordinator: ContextContinuityCoordinator<LoomSubjectId>

  constructor(private readonly deps: RuntimeDeps) {
    this.coordinator = createLoomContextManagement({
      agentForSubject: () => this.handle?.agent,
      sessionForAgent: agent => agent.id,
      // Engine-folded per-session state; wired together with the rollover trigger.
      projectionForSubject: () => undefined,
      executeTransition: plan => this.executeTransition(plan),
      log: message => { this.deps.log?.(message) },
    })
  }

  current(): Agent | undefined {
    return this.handle?.agent
  }

  async boot(): Promise<void> {
    const deps: BootDeps = {
      agents: this.deps.agents,
      runtimeState: this.deps.runtimeState,
      workspace: this.deps.workspace,
      ...(this.deps.agentOptions === undefined ? {} : { agentOptions: this.deps.agentOptions }),
      ...(this.deps.newSessionId === undefined ? {} : { newSessionId: this.deps.newSessionId }),
    }
    this.handle = await bootAgent(deps)
  }

  /**
   * One generation swap at an idle boundary: build the handoff, dispose the old agent (releasing
   * the single-active lease), create the successor at the plan's deterministic session id, commit
   * the pointer with lineage, then deliver the handoff ahead of any carried input. The engine
   * derived newSessionId/requestId, so a crash mid-swap re-drives to the same identity; a throw
   * here leaves the previous generation recoverable, which the coordinator relies on.
   */
  async executeTransition(plan: TransitionPlan): Promise<void> {
    const handoff = this.coordinator.handoffMessageFor(plan)
    const previous = this.deps.runtimeState.getCurrentSession()
    const lineage = [...(previous?.parentLineage ?? []), plan.previousSessionId]

    if (this.handle !== undefined) {
      await this.handle.dispose()
      this.handle = undefined
    }
    const successor = await this.deps.agents.create({
      sessionId: plan.newSessionId,
      meta: { cwd: this.deps.workspace },
      ...(this.deps.agentOptions === undefined ? {} : { agentOptions: this.deps.agentOptions }),
    })
    await this.deps.runtimeState.setCurrentSession({ sessionId: plan.newSessionId, parentLineage: lineage })
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
