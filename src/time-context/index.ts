/**
 * The agent's sense of "now".
 *
 * Loom's agent is a long-lived individual that can sit untouched for hours and is often woken by
 * something other than a person typing. Without a clock it cannot tell what time it is or how long
 * the gap since the last thing in its record was, so it reads every wake as if it happened
 * immediately after the last one. This plugin gives it one durable line per turn: the current
 * instant and the elapsed time since the preceding model-visible event.
 *
 * The line rides `agent/pre-step`, appended after every other injection so it sits nearest the
 * step, and lands in the session log as a `@loom/time-context` snapshot the model can see — an
 * observation about time, never a new source of authority over it. The instant comes from
 * `ctx.clock`, not `Date.now()`, so behavior eval can drive time deterministically; the baseline
 * it measures against is the session's own log, folded as a projection (see projection.ts).
 *
 * The zone is fixed at UTC+8 rather than taken from the machine or a client. This deployment
 * exists for one person in one zone, and a fixed offset renders one instant identically on every
 * reread path, which is what keeps the injected text stable for the context cache. Loom does not
 * mount the shipped `@deepseek-ai/dsh-time-context` for the same reason it fixes the zone: with no
 * browser zone in play — the normal case for a background wake — that plugin's policy text tells
 * the model to ask the user to clarify otherwise-unqualified dates, which is noise for an agent
 * whose only user may be asleep. The companion project's closing line about sequence and revision
 * ordering Team facts is deliberately not copied: that is a Team ledger concern, and this agent
 * has one log and one voice.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
// Side-effect import: pulls the `clock` and `agentRuntime` Context augmentation from Loom's contracts.
import '../contracts/index.ts'
import { registerTimeContextProjection, TIME_CONTEXT_KEY } from './projection.ts'
import { CLOCK_REFRESH_INTERVAL_MS, renderClockSnapshot, shouldSampleClock } from './snapshot.ts'

export const name = 'time-context'
export const inject = ['clock', 'agentRuntime', 'sessionProjections']

/** Attribution id for snapshots this plugin produces; the owner prefix is Loom's naming convention. */
const LOOM_TIME_CONTEXT_PLUGIN_ID = '@loom/time-context'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    '@loom/time-context': { kind: typeof LOOM_TIME_CONTEXT_PLUGIN_ID } & ContextFormed
  }
}

function clockSnapshot(now: number, turn: number, step: number, previous: number | null): UserMessage {
  const text = renderClockSnapshot({ now, turn, step, previous })
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: LOOM_TIME_CONTEXT_PLUGIN_ID, form: 'snapshot', sections: [{ name: LOOM_TIME_CONTEXT_PLUGIN_ID, text }] },
  })
}

export function apply(ctx: Context): void {
  registerTimeContextProjection(ctx)
  // Where this turn last landed a snapshot, for the refresh gate only. Not durable state: the
  // baseline the text needs is folded from the log by the projection above, and a turn never
  // outlives the process it runs in.
  let lastInjection: { sessionId: string; turn: number; at: number } | undefined

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // One Individual: a helper spawned as a subagent runs its own session and its own turns, and
    // is not the agent's own sense of time.
    if (agent !== ctx.agentRuntime.current()) return decision
    const baseline = ctx.sessionProjections.stateOf(agent.session, TIME_CONTEXT_KEY)
    // Unreachable while this plugin owns the key; skip rather than render a baseline invented here.
    if (baseline === undefined) return decision
    const now = ctx.clock.now()
    const injectedAt = lastInjection !== undefined
      && lastInjection.sessionId === agent.session.id
      && lastInjection.turn === turn
      ? lastInjection.at
      : undefined
    if (!shouldSampleClock(step, now, injectedAt, CLOCK_REFRESH_INTERVAL_MS)) return decision
    lastInjection = { sessionId: agent.session.id, turn, at: now }
    return { kind: 'enter', messages: [...decision.messages, clockSnapshot(now, turn, step, baseline.lastEventTime)] }
  }, { prepend: true })
}
