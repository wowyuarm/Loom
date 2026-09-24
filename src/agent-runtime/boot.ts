import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RuntimeState } from '../contracts/index.ts'

export interface BootDeps {
  agents: Pick<AgentRegistry, 'create' | 'resume'>
  runtimeState: RuntimeState
  /** Absolute workspace path used as the created session's cwd. */
  workspace: string
  /**
   * Loop options (provider/model) for the agent. In a bundle over dsh-base the default-model
   * plugin supplies these, so this is usually omitted; a composition without a default model
   * (e.g. a test with a mock adapter) passes them here.
   */
  agentOptions?: AgentOptions
  /**
   * Compose the agent's capability set from its preset. Runs inside the creation window, before
   * the agent is published, so the tools and prompt sections exist before its first prompt
   * assembles. Required in a deployment that moved the model-facing rows to the agent plane:
   * an agent that joins no preset inherits only the global layer and reaches the model with an
   * empty tool catalog.
   */
  mountPreset?: (agentCtx: Context) => Promise<void>
  /** Session id minter for a first boot; overridable for deterministic tests. */
  newSessionId?: () => SessionId
}

/**
 * The agent's creation-window setup: join the preset so its tools and prompt sections exist
 * before the agent is published. Undefined when the deployment left the model-facing rows on
 * the host plane, where the global layer already reaches the agent.
 * @param mountPreset - the roster's compose call, or undefined.
 * @returns an {@link AgentSetup}, or undefined when there is nothing to compose.
 */
export function presetSetup(
  mountPreset: ((agentCtx: Context) => Promise<void>) | undefined,
): AgentSetup | undefined {
  if (mountPreset === undefined) return undefined
  return async (agentCtx) => { await mountPreset(agentCtx) }
}

/**
 * Boot the one agent: resume it from the runtime-state pointer, or create a first session and
 * record the pointer. Create-then-pointer: a crash between the two leaves an inert unpointed
 * session in storage (the next boot creates a fresh one), which is preferable to a pointer that
 * names a session `resume` cannot load.
 *
 * The single-active guard is free — create/resume acquire the DSH cross-process write lease and
 * reject (SessionAlreadyOwnedError) if another process already holds this deployment's agent.
 */
export async function bootAgent(deps: BootDeps): Promise<AgentHandle> {
  const agentOptions = deps.agentOptions
  const setup = presetSetup(deps.mountPreset)
  const pointer = deps.runtimeState.getCurrentSession()
  if (pointer !== undefined) {
    return deps.agents.resume({
      resumeSessionId: SessionId(pointer.sessionId),
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(setup === undefined ? {} : { setup }),
    })
  }
  const mint = deps.newSessionId ?? (() => SessionId(`loom-${randomUUID()}`))
  const sessionId = mint()
  const handle = await deps.agents.create({
    sessionId,
    meta: { cwd: deps.workspace },
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...(setup === undefined ? {} : { setup }),
  })
  await deps.runtimeState.setCurrentSession({ sessionId })
  await deps.runtimeState.recordSession(String(sessionId))
  return handle
}
