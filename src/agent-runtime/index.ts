import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
// Side-effect import: the `agentDefaultModel` Context augmentation, read below when a deployment
// leaves the model to base's default-model plugin.
import '@deepseek-ai/dsh-agent-default-model'
// Side-effect import: the `agentPresets` Context augmentation, the roster this plugin composes
// each agent from.
import '@deepseek-ai/dsh-agent-presets'
import { CONTEXT_CONTINUITY_PROJECTION_KEY } from '@wowyuarm/dsh-context-continuity'
import { LoomAgentRuntime } from './runtime.ts'

export interface AgentRuntimeConfig {
  /** Absolute workspace path used as the agent's session cwd. */
  workspace: string
  /** Loop options (provider/model); omit to take base's default-model selection. */
  agentOptions?: AgentOptions
  /** Preset id the agent joins; omit for the roster's configured default. */
  agentPreset?: string
}

export const name = 'agent-runtime'
export const inject = ['agents', 'runtimeState', 'sessionProjections', 'tools', 'agentPresets']

/**
 * The model the created agent generates with: an explicit config override, else base's
 * default-model selection. Without either, the agent boots model-less and cannot generate — the
 * bug that let a booted agent receive input yet never reply.
 */
function resolveAgentOptions(ctx: Context, config: AgentRuntimeConfig): AgentOptions | undefined {
  if (config.agentOptions !== undefined) return config.agentOptions
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (selection === undefined) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

export async function apply(ctx: Context, config: AgentRuntimeConfig): Promise<void> {
  const agentOptions = resolveAgentOptions(ctx, config)
  const runtime = new LoomAgentRuntime({
    agents: ctx.agents,
    runtimeState: ctx.runtimeState,
    workspace: config.workspace,
    projectionOf: agent => ctx.sessionProjections.stateOf(agent.session, CONTEXT_CONTINUITY_PROJECTION_KEY),
    mountPreset: async agentCtx => { await ctx.agentPresets.mount(agentCtx, config.agentPreset) },
    ...(agentOptions === undefined ? {} : { agentOptions }),
  })
  runtime.install(ctx)
  await runtime.boot()
  ctx.provide('agentRuntime', runtime)
  ctx.effect(() => async () => { await runtime.dispose() }, 'agent-runtime.dispose')
}

export { bootAgent, presetSetup } from './boot.ts'
export type { BootDeps } from './boot.ts'
export { LoomAgentRuntime } from './runtime.ts'
export type { RuntimeDeps } from './runtime.ts'
