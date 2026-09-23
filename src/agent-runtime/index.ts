import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { LoomAgentRuntime } from './runtime.ts'

export interface AgentRuntimeConfig {
  /** Absolute workspace path used as the agent's session cwd. */
  workspace: string
  /** Loop options (provider/model); omit when a default-model plugin supplies them. */
  agentOptions?: AgentOptions
}

export const name = 'agent-runtime'
export const inject = ['agents', 'runtimeState']

export async function apply(ctx: Context, config: AgentRuntimeConfig): Promise<void> {
  const runtime = new LoomAgentRuntime({
    agents: ctx.agents,
    runtimeState: ctx.runtimeState,
    workspace: config.workspace,
    ...(config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
  })
  await runtime.boot()
  ctx.provide('agentRuntime', runtime)
  ctx.effect(() => async () => { await runtime.dispose() }, 'agent-runtime.dispose')
}

export { bootAgent } from './boot.ts'
export type { BootDeps } from './boot.ts'
export { LoomAgentRuntime } from './runtime.ts'
export type { RuntimeDeps } from './runtime.ts'
