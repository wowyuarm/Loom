import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentRuntime } from '../contracts/index.ts'
import { bootAgent } from './boot.ts'

export interface AgentRuntimeConfig {
  /** Absolute workspace path used as the agent's session cwd. */
  workspace: string
}

class AgentRuntimeService implements AgentRuntime {
  private live: Agent | undefined

  constructor(handle: AgentHandle) {
    this.live = handle.agent
  }

  current(): Agent | undefined {
    return this.live
  }

  clear(): void {
    this.live = undefined
  }
}

export const name = 'agent-runtime'
export const inject = ['agents', 'runtimeState']

export async function apply(ctx: Context, config: AgentRuntimeConfig): Promise<void> {
  const handle = await bootAgent({ agents: ctx.agents, runtimeState: ctx.runtimeState, workspace: config.workspace })
  const service = new AgentRuntimeService(handle)
  ctx.provide('agentRuntime', service)
  ctx.effect(() => async () => {
    service.clear()
    await handle.dispose()
  }, 'agent-runtime.dispose')
}

export { bootAgent } from './boot.ts'
export type { BootDeps } from './boot.ts'
