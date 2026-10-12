import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { errorText } from '@wowyuarm/dsh-jev'
import '@wowyuarm/dsh-jev'
import '@deepseek-ai/cordis-plugin-timer'
import { AFTER_INTERACTION_SOURCE_KIND, PULSE_SOURCE_KIND } from '../contracts/index.ts'
import { pulseStateDomain, type PulseState, type PulseCheckRow } from './ledger.ts'
import { dueAt, registerPulseTimelineProjection, PULSE_TIMELINE_KEY } from './timeline.ts'
import { PULSE_NOTE, readPulseMaterials, renderJudgeState, renderSituation, renderTurn } from './state.ts'
import { pulseQuestion, readVerdict } from './verdict.ts'

export const name = 'pulse'
export const inject = ['agentRuntime', 'clock', 'jev', 'sessionProjections', 'storageDomain', 'timer', 'systemPrompt']

export interface PulseConfig {
  workspace: string
  /** Idle window after any turn, including autonomous turns. Default 30 minutes. */
  silenceWindowMinutes?: number
  /** Minimum interval between check attempts, including failures and shadow results. Default 30 minutes. */
  checkCadenceMinutes?: number
  /** Poll resolution. Default 5 minutes. */
  pollMinutes?: number
  /** Per-file judgement budget, in UTF-16 code units. Default 8,000. */
  materialLimit?: number
  /** Uncalibrated initial gate; attend must strictly exceed it. Default 0.5. */
  attendThreshold?: number
  /** Record judgements without waking the subject. Default true. */
  dryRun?: boolean
}
const configSchema = z.object({ workspace: z.string().min(1),
  silenceWindowMinutes: z.number().positive().default(30), checkCadenceMinutes: z.number().positive().default(30),
  pollMinutes: z.number().positive().default(5), materialLimit: z.number().int().positive().default(8_000),
  attendThreshold: z.number().min(0).max(1).default(0.5), dryRun: z.boolean().default(true) })

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { '@loom/pulse': { kind: typeof PULSE_SOURCE_KIND } & ContextFormed }
}

export async function apply(ctx: Context, input: PulseConfig): Promise<void> {
  const config = configSchema.parse(input)
  registerPulseTimelineProjection(ctx)
  const ledger = await ctx.storageDomain.open(pulseStateDomain)
  const logger = ctx.logger('pulse')
  let disposed = false
  let active: { agent: Agent; controller: AbortController } | undefined
  let job: Promise<void> | undefined
  let revision = 0
  let writes: Promise<void> = Promise.resolve()

  // Read-modify-write must run in order: global.set replaces the entire record.
  const update = (change: (current: PulseState) => PulseState): Promise<void> => {
    const write = writes.then(() => ledger.global.set(change(ledger.global.get())))
    writes = write.catch(error => { logger.warn(`pulse state write failed: ${errorText(error)}`) })
    return write
  }

  ctx.effect(() => ctx.systemPrompt.section({ name: 'loom:pulse', order: 130, text: PULSE_NOTE,
    interpolate: false }), 'pulse.prompt')
  ctx.effect(() => ctx.systemPrompt.context({ name: 'pulse-outcome', order: 45, text: assembly => {
    if (assembly.agent !== ctx.agentRuntime.current()) return ''
    const record = ledger.global.get().lastWake
    return record === undefined ? '' : renderTurn(record)
  } }), 'pulse.outcome-context')

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent !== ctx.agentRuntime.current() || message.source.kind !== 'user') return
    revision += 1
    if (active?.agent === agent) active.controller.abort()
    // A claimed notice is already part of a turn: withdraw only still-pending notices.
    for (const notice of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (notice.source.kind === PULSE_SOURCE_KIND) agent.inbox.remove(notice.id)
    }
  })

  ctx.on('session/event', (session, event) => {
    const agent = ctx.agentRuntime.current()
    if (agent === undefined || session.id !== agent.session.id || event.type !== 'turn/end') return
    revision += 1
    const folded = ctx.sessionProjections.stateOf(session, PULSE_TIMELINE_KEY)
    if (folded?.lastTurn === undefined) return
    const record = folded.lastTurn
    void update(current => ({ ...current,
      lastActivityTime: latestTime(current.lastActivityTime, record.endedAt),
      lastHumanInputTime: latestTime(current.lastHumanInputTime, folded.lastHumanInputTime),
      lastTurn: record,
      ...(record.sources.includes(PULSE_SOURCE_KIND) || record.sources.includes(AFTER_INTERACTION_SOURCE_KIND)
        ? { lastWake: record } : {}),
    })).catch(() => { /* The write queue reports storage failure; the committed Session remains recoverable. */ })
  })

  const check = async (): Promise<void> => {
    const agent = ctx.agentRuntime.current()
    if (disposed || agent === undefined || agent.status !== 'idle' || hasPendingInput(agent)) return
    const startedRevision = revision
    await writes
    if (disposed || agent !== ctx.agentRuntime.current() || agent.status !== 'idle' || hasPendingInput(agent)) return
    const folded = ctx.sessionProjections.stateOf(agent.session, PULSE_TIMELINE_KEY)
    if (folded === undefined) return
    // Rebuild missed live writes from the current Session; persisted maxima prevent checkpoint returns rewinding time.
    const prior = ledger.global.get()
    if ((folded.lastActivityTime ?? -Infinity) > (prior.lastActivityTime ?? -Infinity)
      || (folded.lastHumanInputTime ?? -Infinity) > (prior.lastHumanInputTime ?? -Infinity)) {
      await update(current => ({ ...current,
        lastActivityTime: latestTime(current.lastActivityTime, folded.lastActivityTime),
        lastHumanInputTime: latestTime(current.lastHumanInputTime, folded.lastHumanInputTime),
        ...(folded.lastTurn !== undefined && folded.lastTurn.endedAt >= (current.lastTurn?.endedAt ?? -Infinity)
          ? { lastTurn: folded.lastTurn } : {}),
      }))
    }
    if (disposed || revision !== startedRevision || agent !== ctx.agentRuntime.current()
      || agent.status !== 'idle' || hasPendingInput(agent)) return
    const snapshot = ledger.global.get()
    const lastActivityTime = snapshot.lastActivityTime
    if (lastActivityTime === null) return
    const due = dueAt(snapshot, config.silenceWindowMinutes * 60_000, config.checkCadenceMinutes * 60_000)
    if (due === null || ctx.clock.now() < due) return
    const controller = new AbortController()
    const stale = (ownNoticeId?: string): boolean => disposed || controller.signal.aborted || revision !== startedRevision
      || agent !== ctx.agentRuntime.current() || [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
        .some(message => message.id !== ownNoticeId)
    active = { agent, controller }
    let task: Promise<void>
    try {
      task = agent.runMaintenance(async signal => {
        const combined = AbortSignal.any([signal, controller.signal])
        const at = ctx.clock.now()
        const materials = await readPulseMaterials(config.workspace, config.materialLimit)
        if (combined.aborted || stale()) return
        const state = renderJudgeState({ now: at, state: snapshot, materials })
        // Record the attempt before asking; a crash or failed request must not cause a rapid retry loop.
        await update(current => ({ ...current, lastCheckTime: at }))
        if (combined.aborted || stale()) return
        let record: PulseCheckRow = { at, state, outcome: 'failed' }
        try {
          const result = await ctx.jev.decide({ state, questions: { pulse: pulseQuestion() }, signal: combined })
          const verdict = readVerdict(result.answers.pulse, config.attendThreshold)
          record = { ...record, model: result.model,
            ...(verdict === undefined ? {} : { attend: verdict.pAttend,
              outcome: verdict.attend ? 'shadow' : 'quiet' }) }
        } catch (error) {
          logger.warn(`pulse judgement ${combined.aborted ? 'cancelled' : 'failed'}: ${errorText(error)}`)
        }
        if (combined.aborted || stale()) record = { ...record, outcome: 'cancelled' }
        logger.info(`pulse ${record.model ?? 'unavailable'}: attend=${record.attend ?? 'unreadable'} → ${record.outcome}`)
        await ledger.table('check').put(String(at), record)
        await update(current => ({ ...current, lastCheck: record }))
        if (combined.aborted || stale() || record.outcome !== 'shadow' || config.dryRun) return
        const notice = createUserMessage({ content: [{ type: 'text', text: renderSituation(at, lastActivityTime) }],
          source: { kind: PULSE_SOURCE_KIND, form: 'notice', summary: boundContextSummary('pulse: an autonomous working moment') } })
        agent.steer(notice)
        record = { ...record, outcome: 'queued' }
        await ledger.table('check').put(String(at), record)
        await update(current => ({ ...current, lastCheck: record }))
        if (combined.aborted || stale(notice.id)) {
          agent.inbox.remove(notice.id)
          record = { ...record, outcome: 'withdrawn' }
          await ledger.table('check').put(String(at), record)
          await update(current => ({ ...current, lastCheck: record }))
        }
      })
    } catch (error) {
      // Public idle includes maintenance; the driver is the authority on exclusive admission.
      logger.info(`pulse maintenance unavailable: ${errorText(error)}`)
      active = undefined
      return
    }
    try {
      await task
    } finally {
      active = undefined
    }
  }

  const poll = (): void => {
    if (disposed) return
    ctx.timeout(poll, config.pollMinutes * 60_000)
    if (job !== undefined) return
    job = check().catch(error => { logger.warn(`pulse check failed: ${errorText(error)}`) })
      .finally(() => { job = undefined })
  }
  ctx.timeout(poll, config.pollMinutes * 60_000)
  ctx.effect(() => async () => {
    disposed = true
    active?.controller.abort()
    await job
    await writes
    await ledger.close()
  }, 'pulse.dispose')
}

function latestTime(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b)
}
function hasPendingInput(agent: Agent): boolean {
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
}
