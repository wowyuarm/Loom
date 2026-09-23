import { randomUUID } from 'node:crypto'
import type { AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RuntimeState } from '../contracts/index.ts'

export interface BootDeps {
  agents: Pick<AgentRegistry, 'create' | 'resume'>
  runtimeState: RuntimeState
  /** Absolute workspace path used as the created session's cwd. */
  workspace: string
  /** Session id minter for a first boot; overridable for deterministic tests. */
  newSessionId?: () => SessionId
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
  const pointer = deps.runtimeState.getCurrentSession()
  if (pointer !== undefined) {
    return deps.agents.resume({ resumeSessionId: SessionId(pointer.sessionId) })
  }
  const mint = deps.newSessionId ?? (() => SessionId(`loom-${randomUUID()}`))
  const sessionId = mint()
  const handle = await deps.agents.create({ sessionId, meta: { cwd: deps.workspace } })
  await deps.runtimeState.setCurrentSession({ sessionId })
  return handle
}
