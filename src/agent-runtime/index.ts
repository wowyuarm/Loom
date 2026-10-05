import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
// Side-effect import: the `agentDefaultModel` Context augmentation, read below when a deployment
// leaves the model to base's default-model plugin.
import '@deepseek-ai/dsh-agent-default-model'
// Side-effect import: the `agentPresets` Context augmentation, the roster this plugin composes
// each agent from.
import '@deepseek-ai/dsh-agent-preset-registry'
// Side-effect import: the `jev` Context augmentation, read lazily below. `inject` deliberately does
// not name it — the judgement service is optional, so a deployment without its key runs without a
// long-gap gate instead of losing the runtime that carries the gate's branch.
import '@wowyuarm/dsh-jev'
// Side-effect import: the `jobs` Context augmentation, read lazily below. Also optional by the same
// rule — a composition with no job registry omits the notice's jobs count instead of failing.
import '@deepseek-ai/dsh-jobs'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import { CONTEXT_CONTINUITY_PROJECTION_KEY, StoredSessionReader, type ContextComposition } from '@wowyuarm/dsh-context-continuity'
import { contextBudgetFrom, type ContextBudget } from '../context-continuity/retrieval.ts'
import { LoomAgentRuntime, type RetrievalDeps } from './runtime.ts'

export interface AgentRuntimeConfig {
  /** Absolute workspace path used as the agent's session cwd. */
  workspace: string
  /** Loop options (provider/model); omit to take base's default-model selection. */
  agentOptions?: AgentOptions
  /** Preset id the agent joins; omit for the roster's configured default. */
  agentPreset?: string
}

export const name = 'agent-runtime'
export const inject = [
  'agents', 'runtimeState', 'sessionProjections', 'tools', 'agentPresets',
  'sessionPersistence', 'sessionQuery', 'llm',
]

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

/**
 * The retrieval/return capabilities read from ctx: archived-log reads, the token meter, the
 * handoff budget derived from the route's context window, and the session-query engine. The
 * budget prefers the session's own persisted request context and falls back to resolving the
 * default-model selection, so a timeline read does not force a provider round-trip once a
 * generation has recorded its route.
 */
function retrievalDeps(ctx: Context): RetrievalDeps {
  const reader = new StoredSessionReader(ctx)
  const meter = (): ReturnType<typeof ctx.get<'tokenMeter'>> => ctx.get('tokenMeter')
  const budgetOf = async (agent: Agent): Promise<ContextBudget | undefined> => {
    const usageTokens = meter()?.measure(agent.session)?.totalTokens
    if (usageTokens === undefined) return undefined
    let contextWindow = agent.session.requestContext()?.contextWindow
    if (contextWindow === undefined) {
      // Before this generation's first request there is no request context yet; resolve the
      // route from the default-model selection, or the agent's own explicit options, so the
      // pressure policy has a bounded budget from the first step rather than failing closed.
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      const provider = selection?.provider ?? agent.options.provider
      const model = selection?.model ?? agent.options.model
      if (provider !== undefined && model !== undefined) {
        contextWindow = (await ctx.llm.resolveModelInfo(provider, model)).context?.contextWindow
      }
    }
    if (contextWindow === undefined) return undefined
    return contextBudgetFrom(usageTokens, contextWindow)
  }
  return {
    readAncestor: id => reader.read(id),
    meter,
    budgetOf,
    query: ctx.sessionQuery,
    // The token meter's own fold over this session, reshaped to the status line's field names.
    // Omitted entirely when the meter has not priced the session — an unpriced work set is never
    // reported as an empty one.
    compositionOf: (agent: Agent): ContextComposition | undefined => {
      const state = ctx.sessionProjections.stateOf(agent.session, 'contextBreakdown')
      if (state === undefined) return undefined
      return {
        systemTokens: state.breakdown.systemTokens,
        toolsTokens: state.breakdown.toolsTokens,
        messagesTokens: state.breakdown.messageTokens,
      }
    },
  }
}

/**
 * The labels of the jobs a rollover would actually take down: this agent's own, still live. The
 * registry also lists unowned jobs, which a switch does not cancel, and settled ones, which are
 * already collected — naming either would overstate what is at stake. The engine renders the count
 * rather than the labels, so this is a list and not a summary sentence.
 */
export function liveJobLabels(jobs: readonly JobView[]): readonly string[] {
  return jobs
    .filter(job => job.owner !== undefined && (job.status === 'running' || job.status === 'stopping'))
    .map(job => job.label)
}

export async function apply(ctx: Context, config: AgentRuntimeConfig): Promise<void> {
  const agentOptions = resolveAgentOptions(ctx, config)
  const runtime = new LoomAgentRuntime({
    agents: ctx.agents,
    runtimeState: ctx.runtimeState,
    workspace: config.workspace,
    projectionOf: agent => ctx.sessionProjections.stateOf(agent.session, CONTEXT_CONTINUITY_PROJECTION_KEY),
    mountPreset: async agentCtx => { await ctx.agentPresets.mount(agentCtx, config.agentPreset) },
    retrieval: retrievalDeps(ctx),
    pressure: {
      compactionFor: agent => ctx.agentPresets.serviceFor(agent, 'compaction'),
      judge: () => ctx.get('jev'),
      jobsFor: agent => {
        const jobs = ctx.get('jobs')
        return jobs === undefined ? [] : liveJobLabels(jobs.list(agent.session.id))
      },
    },
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
