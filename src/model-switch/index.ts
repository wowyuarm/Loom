/**
 * Model hot-switch: a deployment-side control file moves the live agent's model route without a
 * restart, through the platform's own selection seam.
 *
 * The seam is `installModelSelection` from `@deepseek-ai/dsh-agent`: it couples one mutable
 * selection to prompt assembly and request routing, and tells the agent in its own words when the
 * route moved. This plugin only owns the *decision* of what the selection holds — the agent's
 * initial route is the one the registry created it with (the default-model plugin's selection,
 * already resolved), and afterwards the control file is the only thing that can move it.
 *
 * The file is read once per step, before that step assembles, so a switch lands on the very next
 * request and never splits one in flight. Nothing here is model-facing: no tool, no message and
 * no prompt text reaches the selection, so the agent cannot move it — it is only told afterwards,
 * by the platform's own durable notice.
 *
 * @module loom/model-switch
 */
import { readFile } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'

export const name = 'model-switch'

/**
 * The provider registry, so a requested route can be checked before it is installed. Nothing here
 * needs the agent, the loop or the runtime: the seam is reached through the platform's own
 * `agent/created`, which is why this row can sit ahead of agent-runtime in the manifest.
 */
export const inject = ['llm']

export interface ModelSwitchConfig {
  /**
   * Absolute path of the deployment-side control file. Outside the agent's workspace on purpose:
   * it is an operator artifact, not something the agent maintains.
   */
  switchFile: string
}

/** The only fields a control file may set. A route is chosen whole, never patched field by field. */
const SWITCH_KEYS = ['provider', 'model', 'reasoningEffort'] as const

/** The route one control file asks for, before it has been checked against the provider. */
export interface SwitchRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export type SwitchDecision =
  | { readonly kind: 'route'; readonly route: SwitchRoute }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Parse one control file strictly. A file that sets anything beyond a provider/model pair (and an
 * optional effort) is rejected **whole** — a rejected file changes nothing at all, rather than
 * applying the part of itself that happened to be understood.
 *
 * This is the syntactic half only: it never builds a {@link ModelSelection}, because an effort is
 * a branded id that belongs to the adapter, and inventing one here would be exactly the unchecked
 * claim this plugin exists to refuse. {@link resolveSwitchRoute} checks the route against the
 * provider before anything moves.
 * @param text - the control file's contents.
 * @returns the requested route, or why the file was refused.
 */
export function parseSwitchFile(text: string): SwitchDecision {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { kind: 'invalid', reason: `not JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'not a JSON object' }
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !(SWITCH_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    return {
      kind: 'invalid',
      reason: `unknown key ${unknown.map(key => JSON.stringify(key)).join(', ')} — only `
        + `${SWITCH_KEYS.join(', ')} may be set`,
    }
  }
  const provider = record.provider
  const model = record.model
  if (typeof provider !== 'string' || provider === '') {
    return { kind: 'invalid', reason: 'provider must be a non-empty string' }
  }
  if (typeof model !== 'string' || model === '') {
    return { kind: 'invalid', reason: 'model must be a non-empty string' }
  }
  const effort = record.reasoningEffort
  if (effort !== undefined && (typeof effort !== 'string' || effort === '')) {
    return { kind: 'invalid', reason: 'reasoningEffort must be a non-empty string' }
  }
  return { kind: 'route', route: { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) } }
}

/**
 * Check a requested route against the provider, and build the selection from what the provider
 * itself reports. An unknown provider, an unknown model, or an effort this exact route does not
 * offer is refused — at read time, while the old route is still live, rather than at request time
 * with a request already in flight.
 * @param ctx - a context carrying the LLM runtime.
 * @param route - the route the control file asked for.
 * @returns the selection to install, or why the route was refused.
 */
export async function resolveSwitchRoute(
  ctx: Context,
  route: SwitchRoute,
): Promise<{ kind: 'selection'; selection: ModelSelection } | { kind: 'invalid'; reason: string }> {
  let info: Awaited<ReturnType<Context['llm']['resolveModelInfo']>>
  try {
    info = await ctx.llm.resolveModelInfo(route.provider, route.model)
  } catch (error) {
    return { kind: 'invalid', reason: `no such route: ${error instanceof Error ? error.message : String(error)}` }
  }
  const selection: ModelSelection = { provider: info.provider, model: info.id }
  if (route.reasoningEffort !== undefined) {
    // The effort ids are the adapter's own objects; the match hands one back rather than casting a
    // string into a brand that only an adapter may mint.
    const efforts = info.reasoning?.efforts ?? []
    const match = efforts.find(effort => String(effort.id) === route.reasoningEffort)
    if (match === undefined) {
      const offered = efforts.map(effort => String(effort.id)).join(', ')
      return {
        kind: 'invalid',
        reason: `reasoningEffort "${route.reasoningEffort}" is not one ${route.provider}/${route.model} offers `
          + `(${offered === '' ? 'this route declares none' : offered})`,
      }
    }
    selection.reasoningEffort = match.id
  }
  return { kind: 'selection', selection }
}

/**
 * The route the registry created this agent with. The default-model plugin already resolved it
 * into the loop options, so this reads a result instead of re-deriving one.
 */
export function routeOf(agent: Agent): ModelSelection | undefined {
  const { provider, model, reasoningEffort } = agent.options
  if (provider === undefined || model === undefined) return undefined
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/** `provider/model`, with the effort when one is set — the form both the log and its readers use. */
export function describeRoute(selection: SwitchRoute | undefined): string {
  if (selection === undefined) return 'none'
  return selection.reasoningEffort === undefined
    ? `${selection.provider}/${selection.model}`
    : `${selection.provider}/${selection.model} (${selection.reasoningEffort})`
}

function sameRoute(left: SwitchRoute | undefined, right: SwitchRoute | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

export function apply(ctx: Context, config: ModelSwitchConfig): void {
  const logger = ctx.logger('model-switch')
  /** One selection per live generation; a rollover successor gets its own on creation. */
  const selections = new Map<string, ModelSelectionRef>()
  /**
   * What was last *decided* about, per generation: the file's contents, or the read failure's
   * message. A control file left on disk is read every step, so this is what keeps a standing
   * decision from being re-reported — and re-logged — on every single one of them.
   */
  const decided = new Map<string, string>()

  const refresh = async (agent: Agent): Promise<void> => {
    const id = String(agent.session.id)
    const ref = selections.get(id)
    if (ref === undefined) return
    let text: string
    try {
      text = await readFile(config.switchFile, 'utf8')
    } catch (error) {
      // No file is the normal state: it means the operator has asked for nothing, and the agent
      // keeps the route it was created with.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      const reason = `cannot read ${config.switchFile}: ${error instanceof Error ? error.message : String(error)}`
      if (decided.get(id) !== reason) {
        decided.set(id, reason)
        logger.warn(reason)
      }
      return
    }
    if (decided.get(id) === text) return
    decided.set(id, text)
    const decision = parseSwitchFile(text)
    if (decision.kind === 'invalid') {
      logger.warn(`ignoring ${config.switchFile}: ${decision.reason}`)
      return
    }
    // Checked against the provider before anything moves. A file naming a route nobody serves, or
    // an effort this route does not offer, is refused while the old route is still live.
    const resolved = await resolveSwitchRoute(ctx, decision.route)
    if (resolved.kind === 'invalid') {
      logger.warn(`ignoring ${config.switchFile}: ${resolved.reason}`)
      return
    }
    if (sameRoute(ref.current, resolved.selection)) return
    logger.info(`model switch: ${describeRoute(ref.current)} -> ${describeRoute(resolved.selection)}`)
    ref.current = resolved.selection
  }

  // The seam belongs in the creation window: the platform holds queued input until every
  // `agent/created` listener returns, so the route is installed before the agent's first prompt
  // assembles. Every generation passes through here, which is what carries a switch across a
  // context rollover instead of losing it at the successor.
  ctx.on('agent/created', ({ agent }) => {
    const ref: ModelSelectionRef = { current: routeOf(agent), assembled: undefined }
    selections.set(String(agent.session.id), ref)
    // The control file is read here, in the waterfall the loop awaits immediately before it
    // assembles a step. The seam snapshots `current` as its own listener starts, so a refresh that
    // ran any later would be a step behind — and `agent/pre-step`, the obvious boundary, is
    // dispatched *after* assembly (dsh-agent-loop: assemble, then pre-step). Registered before
    // `installModelSelection` on purpose: waterfall listeners run in registration order.
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await refresh(agent)
      return next()
    })
    installModelSelection(agent.ctx, ref)
    return undefined
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.session.id)
    selections.delete(id)
    decided.delete(id)
  })
}
