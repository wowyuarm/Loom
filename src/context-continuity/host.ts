import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import {
  ContextContinuityCoordinator,
  ContextMessageCodec,
  createContinuityTools,
  type ContextContinuityHost,
  type ContextProjectionConfig,
  type ContextProjectionHost,
  type ContextProjectionState,
  type ContextSubject,
  type ContinuityToolAdapter,
  type ContinuityTools,
  type RolloverIdentity,
  type RolloverToolRequest,
  type TransitionPlan,
} from '@wowyuarm/dsh-context-continuity'

/**
 * Loom binds the context-continuity engine as a single-agent host: one subject, its live
 * Agent, and the runtime-state pointer. The engine owns every universal mechanic (idle-boundary
 * swap, carried input, checkpoint continuations, crash repair); this host supplies only the
 * single-agent lifecycle and the two domain dimensions the engine refuses to own.
 */

/** The one durable subject in a Loom deployment; N=1, so the id is a constant. */
export const LOOM_SUBJECT_ID = 'loom'
export type LoomSubjectId = typeof LOOM_SUBJECT_ID

/** Plugin identity that attributes context-continuity envelopes written by this host. */
export const LOOM_CONTEXT_CONTINUITY_PLUGIN_ID = '@loom/context-continuity'

/**
 * The one writer of context-continuity messages. The prose is neutral and mechanical: it
 * states the agent continues in a fresh context and that a context change rolls nothing back.
 * These lines are frozen by history — earlier generations' durable logs are read back through
 * the same identity, so changing them would rewrite the past.
 */
export const LOOM_CONTEXT_CODEC = new ContextMessageCodec({
  pluginId: LOOM_CONTEXT_CONTINUITY_PLUGIN_ID,
  handoffIntro: 'Context handoff: you are the same agent continuing in a fresh context window.',
  handoffVerifyNote:
    'Your handoff from the previous context follows. A context change never rolls back files, '
    + 'processes, or external effects — verify external state before relying on it.',
})

/** The single-agent lifecycle the host delegates to; supplied by the assembly layer. */
export interface LoomContinuityOptions {
  /** The live Agent, or undefined when it is not currently activated. */
  readonly agentForSubject: () => Agent | undefined
  /** The session the live Agent is bound to, or undefined when there is no live Agent. */
  readonly sessionForAgent: (agent: Agent) => SessionIdType | undefined
  /** Read one session's engine-folded continuity state, or undefined when not live. */
  readonly projectionForSubject: (sessionId: SessionIdType) => ContextProjectionState | undefined
  /**
   * Perform one prepared generation swap at a true idle boundary: commit the rollover (write
   * the runtime-state pointer), dispose the old Agent, archive the old session, create and
   * activate the successor, deliver the handoff first, then carried input.
   */
  readonly executeTransition: (plan: TransitionPlan) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
}

export class LoomContextContinuityHost implements ContextContinuityHost<LoomSubjectId>, ContextProjectionHost {
  constructor(private readonly options: LoomContinuityOptions) {}

  agentForSubject(_id: LoomSubjectId): Agent | undefined {
    return this.options.agentForSubject()
  }

  subjectForAgent(agent: Agent): ContextSubject<LoomSubjectId> | undefined {
    const sessionId = this.options.sessionForAgent(agent)
    if (sessionId === undefined) return undefined
    return { id: LOOM_SUBJECT_ID, sessionId }
  }

  projectionForSubject(_id: LoomSubjectId, sessionId: SessionIdType): ContextProjectionState | undefined {
    return this.options.projectionForSubject(sessionId)
  }

  executeTransition(_id: LoomSubjectId, plan: TransitionPlan): Promise<void> {
    return this.options.executeTransition(plan)
  }

  /**
   * Stable key over the previous session and the successful tool call, JSON-encoded so no
   * delimiter can alias across the two unconstrained fields, then hashed. Crash replay
   * converges on `loom-rollover-<digest>` and the recorded request id.
   */
  rolloverIdentity(previousSessionId: SessionIdType, toolCallId: string): RolloverIdentity {
    const digest = createHash('sha256').update(JSON.stringify([previousSessionId, toolCallId])).digest('hex')
    return {
      newSessionId: SessionId(`loom-rollover-${digest}`),
      requestId: `loom:rollover:${digest}`,
    }
  }

  /** Collision-resistant checkpoint ref keyed by the recording session and the successful call. */
  checkpointRefFor(sessionId: string, toolCallId: string): string {
    const digest = createHash('sha256').update(JSON.stringify([sessionId, toolCallId])).digest('hex')
    return `loom-checkpoint-${digest}`
  }

  /** Collision-resistant boundary ref; the session identity keeps repeated seqs across generations distinct. */
  boundaryRefFor(sessionId: string, seq: number): string {
    const digest = createHash('sha256').update(JSON.stringify([sessionId, seq])).digest('hex')
    return `loom-boundary-${digest}`
  }

  /**
   * v1 carries every queued message across a swap (returns false). The proactivity module will
   * later mark its own pulses/notices as ephemeral so the successor rederives rather than
   * re-reads them. The engine already excludes this host's handoff/continuation envelopes
   * before consulting this.
   */
  isEphemeralNotice(_message: UserMessage): boolean {
    return false
  }

  log(message: string): void {
    this.options.log(message)
  }
}

/** Build the engine coordinator over Loom's single-agent lifecycle. */
export function createLoomContextManagement(
  options: LoomContinuityOptions,
): ContextContinuityCoordinator<LoomSubjectId> {
  return new ContextContinuityCoordinator(new LoomContextContinuityHost(options), LOOM_CONTEXT_CODEC)
}

/**
 * The projection config the engine folds each session's continuity state with. It recognizes
 * this host's own envelopes (codec) and derives refs through the host; v1 anchors no domain
 * boundaries (no `domainBoundaryOf`), so nothing is offered as a "return to this topic" target.
 */
export function createLoomContextProjectionConfig(host: ContextProjectionHost): ContextProjectionConfig {
  return { codec: LOOM_CONTEXT_CODEC, host }
}

/**
 * The host half of the model-facing continuity tools. v1 exposes only the rollover tool, so the
 * checkpoint/timeline methods are unreachable and reject if ever called. requestRollover simply
 * acknowledges: the tool's successful result is the durable fact the projection folds, and the
 * swap follows at the next idle boundary.
 */
export class LoomContinuityToolAdapter implements ContinuityToolAdapter {
  requestRollover(_request: RolloverToolRequest, _exec: ToolRunContext): Promise<{ readonly mode: string }> {
    return Promise.resolve({ mode: 'scheduled' })
  }

  isRestorableRef(_checkpointRef: string, _exec: ToolRunContext): Promise<boolean> {
    return Promise.resolve(false)
  }

  recordCheckpoint(): Promise<never> {
    return Promise.reject(new Error('loom: checkpoints are not supported in v1'))
  }

  timeline(): Promise<never> {
    return Promise.reject(new Error('loom: the context timeline is not supported in v1'))
  }
}

/** The model-facing context tools Loom registers; v1 uses the rollover tool only. */
export function createLoomContinuityTools(): ContinuityTools {
  return createContinuityTools(new LoomContinuityToolAdapter())
}
