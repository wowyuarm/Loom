/**
 * After-interaction proactivity: what Loom does with the pause after it answers.
 *
 * A long-lived individual that only ever speaks when spoken to is a dead end, but unprompted
 * speech is exactly the thing that becomes noise if it is driven by the main model's mood. This
 * plugin puts a cheap judgement between the two: when a conversation the person opened goes quiet,
 * it waits a few minutes, asks one headless `choice` question — quiet, speak, or act — and only
 * when the judgement's own probability of quiet falls below the frozen threshold does it hand the
 * agent a short note saying what the pause looks like and what to do about it. That note asks for
 * the thing rather than hinting at it — the gate is where the caution lives — but the agent is the
 * one looking at the material and can still let the moment pass. The judgement proposes; the code
 * gates; the agent decides.
 *
 * What it deliberately does not do (all frozen in the converged design):
 *
 * - no cooldown, no count limit: the structural rule is enough, because an alarm is armed only by a
 *   pause the person caused and never re-armed by a check's own turn (§4a①);
 * - no quiet hours: the local hour and the elapsed gap go into the state, and the judgement weighs
 *   them (§4a⑤);
 * - no durable wake source: the alarm lives in this fiber and dies with it (§4a⑦);
 * - no second record of the conversation: the recent exchanges are folded from the log by a session
 *   projection, the same seam `time-context` uses for its baseline.
 *
 * When the agent wakes, it answers through the `message` tool as always, which addresses the
 * conversation the last delivered inbound came from — the pause's own route, not a channel this
 * plugin picks (§4a⑧).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { errorText, type JevResult } from '@wowyuarm/dsh-jev'
// Side-effect import: pulls the `jev` Context augmentation from dsh-jev, and the `timer` one from
// cordis-plugin-timer, so `ctx.jev` and `ctx.timeout` are typed where this plugin uses them.
import '@wowyuarm/dsh-jev'
import '@deepseek-ai/cordis-plugin-timer'
import { AFTER_INTERACTION_SOURCE_KIND } from '../contracts/index.ts'
import { SilenceAlarm, contextTimer, silenceDelay } from './alarm.ts'
import { readMaterials, renderJudgeState, renderSituation } from './materials.ts'
import { AFTER_INTERACTION_KEY, registerAfterInteractionProjection } from './projection.ts'
import { postureQuestion, readVerdict } from './verdict.ts'

export const name = 'after-interaction'
export const inject = ['agentRuntime', 'clock', 'jev', 'sessionProjections', 'timer']

export interface AfterInteractionConfig {
  /** The agent's workspace root; the check reads the resident materials under it. */
  workspace: string
}

/** One-line account of a situation notice, recorded in its durable source. */
const SITUATION_SUMMARY = 'after-interaction: a quiet pause worth a look'

/** The plugin logger as this module passes it around. */
type Logger = ReturnType<Context['logger']>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    '@loom/after-interaction': { kind: typeof AFTER_INTERACTION_SOURCE_KIND } & ContextFormed
  }
}

export function apply(ctx: Context, config: AfterInteractionConfig): void {
  registerAfterInteractionProjection(ctx)
  // The timer belongs to this fiber, so a restart drops a pending silence instead of replaying it.
  const alarm = new SilenceAlarm(contextTimer(ctx))
  const logger = ctx.logger('after-interaction')

  ctx.on('session/event', (session, event) => {
    const agent = ctx.agentRuntime.current()
    if (agent === undefined || session.id !== agent.session.id) return

    // A person speaking outranks a check that has not run yet: their message cancels the silence it
    // would have been measured against, and the pause that follows their own turn arms a new alarm.
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      alarm.cancel()
      return
    }

    // Arming rides the committed end of a turn rather than DSH's `agent/turn-stopping` boundary.
    // That boundary fires when a turn *proposes* to end and is then awaited, so a listener that
    // steers (channels does, for an unsent reply) keeps the turn going: a silence armed there can be
    // a silence that never happened. `turn/end` is the fact, and `completed` is what says the model
    // finished the turn rather than being blocked, aborted, or cut off mid-reply.
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const state = ctx.sessionProjections.stateOf(session, AFTER_INTERACTION_KEY)
    if (state === undefined) return
    // ① The design's one-clock rule (§4a①): only a pause the person caused may arm a check. The
    // turn that just committed has to be the one their input opened — a turn this plugin's own note
    // opened ends here too, and arming on it would make every check feed the next one.
    if (state.lastHumanTurn !== event.data.turn) return
    if (alarm.pending) return
    const delayMs = silenceDelay()
    logger.info(`silence armed after turn ${event.data.turn}: ${Math.round(delayMs / 1000)}s`)
    alarm.arm(delayMs, () => {
      void check(ctx, config, logger, agent)
    })
  })
}

/**
 * Run one check from the true idle phase.
 *
 * The alarm says a pause happened, not that it is still happening: a long tool call, a background
 * task, or a turn that opened in between all mean this pause never really stopped, and the design
 * drops the check without rescheduling it (§4a②) — the next pause the person causes asks again.
 */
async function check(ctx: Context, config: AfterInteractionConfig, logger: Logger, agent: Agent): Promise<void> {
  if (agent !== ctx.agentRuntime.current()) {
    logger.info('after-interaction check dropped: the generation moved on')
    return
  }
  if (agent.status !== 'idle' || hasPendingInput(agent)) {
    logger.info('after-interaction check dropped: the agent is not idle')
    return
  }
  try {
    await agent.runMaintenance(signal => runPass(ctx, config, logger, agent, signal))
  } catch (error: unknown) {
    // `runMaintenance` throws synchronously when a turn or another maintenance task already owns the
    // agent. The phase check above is the guard; this is the backstop for the race it cannot see.
    logger.info(`after-interaction check dropped: ${String(error)}`)
  }
}

/** One judgement pass: read the materials, ask once, gate, and hand the agent a situation. */
async function runPass(
  ctx: Context,
  config: AfterInteractionConfig,
  logger: Logger,
  agent: Agent,
  signal: AbortSignal,
): Promise<void> {
  const state = ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)
  if (state === undefined || state.exchanges.length === 0) {
    // ⑥ Nothing to continue: a fresh session has no past worth acting on, and asking a judgement
    // about it would spend a call to be told so.
    logger.info('after-interaction check skipped: nothing in this session to continue')
    return
  }
  const now = ctx.clock.now()
  const materials = await readMaterials(config.workspace, state)
  if (hasPendingInput(agent)) {
    logger.info('after-interaction check stepped aside: the person wrote first')
    return
  }

  let result: JevResult
  try {
    result = await ctx.jev.decide({
      state: renderJudgeState({ now, lastHumanInputTime: state.lastHumanInputTime, materials }),
      questions: { posture: postureQuestion() },
      signal,
    })
  } catch (error: unknown) {
    // ④ Fail closed: a judgement that could not be made is a quiet one. The provider already bounds
    // its own retries with backoff and never blocks past them.
    logger.warn(`after-interaction judgement failed, staying quiet: ${errorText(error)}`)
    return
  }

  const verdict = readVerdict(result.answers.posture)
  if (verdict === undefined) {
    logger.warn('after-interaction judgement unreadable, staying quiet: no usable probabilities')
    return
  }
  // The probabilities are the operator's: they are what a calibration reads, and what the agent
  // must never see. They end up in this line and nowhere else.
  logger.info(`after-interaction judgement ${result.model}: quiet=${verdict.quiet.toFixed(2)} `
    + `speak=${verdict.speak.toFixed(2)} act=${verdict.act.toFixed(2)} → ${verdict.posture}`)
  if (verdict.posture === 'quiet') return

  // ③ The judgement call itself is the window: the person may have spoken again while it ran. The
  // snapshot was taken before the call, so anything later than it wins; nothing awaits between this
  // recheck and the hand-off, so nothing can slip in behind it.
  const latest = ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)
  if (hasPendingInput(agent) || (latest?.lastHumanInputTime ?? 0) > now) {
    logger.info('after-interaction stepped aside: the person spoke again before the check finished')
    return
  }
  agent.steer(situationNotice(renderSituation(verdict.posture)))
  logger.info(`after-interaction handed the agent a ${verdict.posture} situation`)
}

/**
 * Input already in the inbox and not yet committed is the one signal the log cannot carry: while a
 * maintenance task holds the agent, a person's message waits there, and the pass has to look.
 */
function hasPendingInput(agent: Agent): boolean {
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
}

/**
 * The situation the agent wakes to. Its own `source.kind` is what lets a successor generation
 * rederive it rather than inherit a note about a moment that has passed, and the summary is the
 * one-line account the durable log keeps.
 */
function situationNotice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: AFTER_INTERACTION_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(SITUATION_SUMMARY),
    },
  })
}
