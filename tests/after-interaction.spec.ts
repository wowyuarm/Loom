/**
 * after-interaction: the pause's own record, one judgement, and the hand-off.
 *
 * Two layers, matching the two kinds of claim the ticket makes. The unit layer pins the fold and the
 * gate: what the judgement is allowed to see, and what a set of probabilities may conclude. The
 * integration layer boots Loom's real agent over a mock model and settles the tense cases — the
 * alarm rides a pause the person caused and never the plugin's own turn, a check that fires while
 * the agent is busy drops without rescheduling, a person arriving mid-judgement outranks the
 * hand-off, and a failed or unreadable judgement stays quiet.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { JevError } from '@wowyuarm/dsh-jev'
import type { JevAnswer, JevRequest, JevResult } from '@wowyuarm/dsh-jev'
import { AFTER_INTERACTION_SOURCE_KIND } from '../src/contracts/index.ts'
import { ManualClock } from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as AfterInteractionPlugin from '../src/after-interaction/index.ts'
import { MAX_SILENCE_MS, MIN_SILENCE_MS, SilenceAlarm, silenceDelay } from '../src/after-interaction/alarm.ts'
import { elapsedText, localInstant, MATERIAL_LIMIT, renderJudgeState, renderSituation, readMaterials } from '../src/after-interaction/materials.ts'
import {
  AFTER_INTERACTION_KEY,
  CONVERSATION_BUDGET,
  HUMAN_TEXT_LIMIT,
  REPLY_TEXT_LIMIT,
  applyAfterInteractionEvent,
  flatten,
  sentText,
  splitProvenance,
  type AfterInteractionState,
  type Exchange,
} from '../src/after-interaction/projection.ts'
import { QUIET_THRESHOLD, readVerdict } from '../src/after-interaction/verdict.ts'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/** One model-request message's source, and the after-interaction members of that union. */
type RequestSource = NonNullable<GenerateOptions['messages'][number]['source']>
type AfterInteractionSource = Extract<RequestSource, { kind: typeof AFTER_INTERACTION_SOURCE_KIND }>
type AfterInteractionNoticeSource = Extract<AfterInteractionSource, { form: 'notice' }>

/** The state a fold starts from, as the projection's own `init` builds it. */
function initial(): AfterInteractionState {
  return { turn: 0, exchanges: [], lastHumanInputTime: null, lastHumanTurn: 0 }
}

/** One session event carrying only the fields the fold reads. */
function event(type: string, time: number, data: unknown = {}): SessionEvent {
  return { type, time, data } as unknown as SessionEvent
}

function turnStart(turn: number): SessionEvent {
  return event('turn/start', 0, { turn })
}

/** One inbound message, framed the way the channel seam frames it. */
function inbound(text: string, time: number, kind = 'user'): SessionEvent {
  return event('user/message', time, { source: { kind }, content: [{ type: 'text', text }] })
}

function toolCall(time: number, name: string, args: unknown): SessionEvent {
  return event('tool/call', time, { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify(args) })
}

/** One judgement answer carrying a full distribution. */
function answer(choice: string, probabilities: Record<string, number>): JevAnswer {
  return { type: 'choice', choice, probabilities, confidence: 0.9 }
}

/** One judgement result over the one question a check asks. */
function verdict(probabilities: Record<string, number>): JevResult {
  const choice = Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'quiet'
  return { model: 'jev-stub', answers: { posture: answer(choice, probabilities) }, usage: undefined }
}

/** The text every message a request carried, for the ones this plugin produced. */
function situations(request: GenerateOptions | undefined): { text: string; source: AfterInteractionNoticeSource }[] {
  return (request?.messages ?? []).flatMap(message => {
    const source = message.source
    if (source === undefined || source.kind !== AFTER_INTERACTION_SOURCE_KIND) return []
    const text = (message.content ?? [])
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    return [{ text, source: source as AfterInteractionNoticeSource }]
  })
}

describe('loom after-interaction fold', () => {
  it('splits a framed inbound message into its routing line and the words', () => {
    expect(splitProvenance('[telegram · direct · from y u]\n我们去吃饭吧'))
      .toEqual({ place: 'telegram · direct · from y u', body: '我们去吃饭吧' })
    // Unframed: the whole message is what they said, newlines and all.
    expect(splitProvenance('在吗\n在的话回我一声')).toEqual({ place: '', body: '在吗\n在的话回我一声' })
    // Framed with nothing after it: a place, no words.
    expect(splitProvenance('[telegram]\n')).toEqual({ place: 'telegram', body: '' })
    expect(splitProvenance('[telegram]')).toEqual({ place: 'telegram', body: '' })
    // Known tradeoff: the frame is recognized by shape alone, so a message whose own first line is
    // bracketed reads as a frame. The seam owns the convention; tightening it here would drop real
    // frames from other channels instead.
    expect(splitProvenance('[笑]\n你猜')).toEqual({ place: '笑', body: '你猜' })
  })

  it('collapses whitespace within the bound the state carries', () => {
    expect(flatten('  a\n\n  b ', 100)).toBe('a b')
    const long = flatten('x'.repeat(HUMAN_TEXT_LIMIT + 100), HUMAN_TEXT_LIMIT)
    expect(long).toHaveLength(HUMAN_TEXT_LIMIT)
    expect(long.endsWith('…')).toBe(true)
  })

  it('keeps the person\'s words and what Loom actually sent, and ignores everything else', () => {
    let state = initial()
    // An injected snapshot is context, not something anyone said. It costs no new state either.
    expect(applyAfterInteractionEvent(state, inbound('<runtime-context>…</runtime-context>', 1, 'runtime-context')))
      .toBe(state)

    state = applyAfterInteractionEvent(state, turnStart(1))
    state = applyAfterInteractionEvent(state, inbound('[telegram · direct]\n在吗', 1_000))
    expect(state.exchanges).toEqual([
      { from: 'human', text: '在吗', place: 'telegram · direct', time: 1_000, turn: 1 },
    ])
    expect(state.lastHumanInputTime).toBe(1_000)
    // ① The turn the person's input opened is what lets a stopping turn arm a check at all.
    expect(state.lastHumanTurn).toBe(1)

    // Assistant text reaches nobody; what reached the person is the `message` tool's own text.
    expect(applyAfterInteractionEvent(state, event('assistant/message', 2_000))).toBe(state)
    expect(applyAfterInteractionEvent(state, toolCall(2_000, 'read_file', { path: 'x' }))).toBe(state)
    state = applyAfterInteractionEvent(state, toolCall(3_000, 'message', { text: '在的，怎么了？' }))
    expect(state.exchanges.at(-1)).toEqual({ from: 'loom', text: '在的，怎么了？', place: '', time: 3_000, turn: 1 })
  })

  it('spends the conversation budget from the newest message backwards, whole messages only', () => {
    // Each message is 100 characters long, so the budget holds forty of them and no more.
    const said = (index: number): string => `第 ${index} 句`.padEnd(100, '。')
    let state = initial()
    for (let index = 0; index * 100 < CONVERSATION_BUDGET + 500; index += 1) {
      state = applyAfterInteractionEvent(state, inbound(said(index), index))
      state = applyAfterInteractionEvent(state, turnStart(index + 1))
    }

    const kept = state.exchanges.map(exchange => exchange.text)
    expect(kept.length * 100).toBeLessThanOrEqual(CONVERSATION_BUDGET)
    // The newest message is in, and the one just past the budget is out — not cut in half.
    expect(kept.at(-1)).toBe(said(Math.ceil((CONVERSATION_BUDGET + 500) / 100) - 1))
    expect(kept.every(text => text.length === 100)).toBe(true)
    expect(kept).not.toContain(said(0))
    // Turn tracking is untouched by the trim: ① depends on it, not on the conversation.
    expect(state.turn).toBe(45)
    expect(state.lastHumanTurn).toBe(state.exchanges.at(-1)?.turn)

    // Re-folding an event that changes nothing returns the same reference: the framework reads that
    // as zero downstream work, and a checkpointed state must not churn on every event.
    expect(applyAfterInteractionEvent(state, turnStart(state.turn))).toBe(state)
  })

  it('always keeps the newest message, however much it fills the budget', () => {
    // The per-message limit is what makes the whole-message rule well defined: one message is never
    // larger than the budget on its own, so the newest one always survives the trim.
    const long = 'x'.repeat(HUMAN_TEXT_LIMIT)
    let state = initial()
    for (let index = 0; index < 12; index += 1) state = applyAfterInteractionEvent(state, inbound(long, index))
    expect(state.exchanges.at(-1)?.text).toHaveLength(HUMAN_TEXT_LIMIT)
    expect(state.exchanges.length).toBe(Math.floor(CONVERSATION_BUDGET / HUMAN_TEXT_LIMIT))
  })

  it('takes the sent text from a message call, first paragraph only, and survives a malformed one', () => {
    expect(sentText(JSON.stringify({ text: '第一段\n\n第二段' }))).toBe('第一段')
    expect(sentText('not json at all')).toBe('')
    expect(sentText(JSON.stringify({ text: 42 }))).toBe('')
    expect(sentText(JSON.stringify({ nothing: 'here' }))).toBe('')
    expect(sentText(JSON.stringify(['text']))).toBe('')
    expect(sentText(JSON.stringify({ text: '   ' }))).toBe('')
    const long = sentText(JSON.stringify({ text: 'a'.repeat(REPLY_TEXT_LIMIT + 50) }))
    expect(long).toHaveLength(REPLY_TEXT_LIMIT)
  })
})

describe('loom after-interaction judgement', () => {
  it('reads a verdict only from a complete, finite distribution', () => {
    expect(readVerdict(undefined)).toBeUndefined()
    expect(readVerdict(answer('speak', { quiet: 0.1, speak: 0.8, act: 0.1 })))
      .toEqual({ posture: 'speak', quiet: 0.1, speak: 0.8, act: 0.1 })

    // ④ The provider passes the vendor's answer through unchecked, so a missing or non-finite
    // probability is a failed judgement — and a failed judgement is quiet, never a default wake.
    expect(readVerdict(answer('speak', { speak: 0.8, act: 0.2 }))).toBeUndefined()
    expect(readVerdict(answer('speak', { quiet: Number.NaN, speak: 0.8, act: 0.2 }))).toBeUndefined()
    expect(readVerdict(answer('speak', { quiet: Number.POSITIVE_INFINITY, speak: 0, act: 0 }))).toBeUndefined()
    expect(readVerdict({ type: 'noul', noul: 0.9 })).toBeUndefined()

    // The gate is anchored on P(quiet), inclusive at the threshold, and the posture is the higher
    // of the other two — read from the probabilities, not from the answer's own `choice` field.
    expect(readVerdict(answer('quiet', { quiet: QUIET_THRESHOLD, speak: 0.4, act: 0.2 }))?.posture).toBe('quiet')
    expect(readVerdict(answer('speak', { quiet: QUIET_THRESHOLD - 0.01, speak: 0.4, act: 0.21 }))?.posture).toBe('speak')
    expect(readVerdict(answer('act', { quiet: 0.1, speak: 0.2, act: 0.7 }))?.posture).toBe('act')
    expect(readVerdict(answer('act', { quiet: 0.1, speak: 0.7, act: 0.2 }))?.posture).toBe('speak')
  })

  it('draws the silence from the design window and holds one alarm at a time', () => {
    expect(silenceDelay(() => 0)).toBe(MIN_SILENCE_MS)
    for (const random of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const delayMs = silenceDelay(() => random)
      expect(delayMs).toBeGreaterThanOrEqual(MIN_SILENCE_MS)
      expect(delayMs).toBeLessThan(MAX_SILENCE_MS)
    }

    const scheduled: { fire: () => void; delayMs: number; cancelled: boolean }[] = []
    const alarm = new SilenceAlarm((fire, delayMs) => {
      const entry = { fire: () => { if (!entry.cancelled) fire() }, delayMs, cancelled: false }
      scheduled.push(entry)
      // Modelled on the deployment timer: cancelling clears the timer, so the callback cannot run.
      return () => { entry.cancelled = true }
    })
    const first = vi.fn()
    const second = vi.fn()

    expect(alarm.pending).toBe(false)
    alarm.arm(1_000, first)
    expect(alarm.pending).toBe(true)
    // Re-arming cancels the one already pending: one pause, one check.
    alarm.arm(2_000, second)
    expect(scheduled[0]?.cancelled).toBe(true)
    expect(scheduled.map(entry => entry.delayMs)).toEqual([1_000, 2_000])
    scheduled[0]?.fire()
    expect(first).not.toHaveBeenCalled()

    scheduled[1]?.fire()
    expect(second).toHaveBeenCalledTimes(1)
    // Fired is no longer pending, so nothing re-arms it from inside the alarm itself.
    expect(alarm.pending).toBe(false)

    alarm.arm(3_000, first)
    alarm.cancel()
    expect(scheduled[2]?.cancelled).toBe(true)
    expect(alarm.pending).toBe(false)
    // Cancelling twice is a no-op, not a second release.
    alarm.cancel()
    scheduled[2]?.fire()
    expect(first).not.toHaveBeenCalled()
  })
})

describe('loom after-interaction materials', () => {
  const now = Date.parse('2026-09-29T13:00:00.000Z')
  const lastHuman: Exchange = { from: 'human', text: '那个事你看了吗', place: 'telegram · direct', time: now - 300_000, turn: 1 }

  it('renders instants and gaps the way the rest of the deployment does', () => {
    expect(localInstant(now)).toBe('2026-09-29T21:00:00+08:00')
    expect(elapsedText(30_000)).toBe('less than a minute')
    expect(elapsedText(60_000)).toBe('1 minute')
    expect(elapsedText(300_000)).toBe('5 minutes')
    expect(elapsedText(3 * 3_600_000 + 20 * 60_000)).toBe('3 hours 20 min')
    expect(elapsedText(2 * 86_400_000 + 3 * 3_600_000)).toBe('2 days 3 h')
  })

  it('builds the judged state from the conversation with the resident files when they exist', () => {
    const state = renderJudgeState({
      now,
      lastHumanInputTime: lastHuman.time,
      materials: { recent: [lastHuman], attention: '在等他的回复', threads: '那个项目 — 还没收尾' },
    })
    expect(state).toContain(`Now: ${localInstant(now)}`)
    expect(state).toContain('Time since the last thing the person said: 5 minutes')
    expect(state).toContain('Recent conversation (oldest first):')
    expect(state).toContain('Person: 那个事你看了吗')
    expect(state).toContain("Loom's own attention list (attention.md):")
    expect(state).toContain('在等他的回复')
    expect(state).toContain('Threads still asleep (threads/index.md):')
    expect(state).toContain('那个项目 — 还没收尾')
    // The routing line is not part of what was said.
    expect(state).not.toContain('telegram · direct')
  })

  it('says so when a source is missing instead of inventing one', () => {
    const state = renderJudgeState({
      now,
      lastHumanInputTime: null,
      materials: { recent: [], attention: '', threads: '' },
    })
    expect(state).toContain('(nothing to continue)')
    expect(state).not.toContain('Time since the last thing the person said')
    expect(state).not.toContain('attention.md')
    expect(state).not.toContain('threads/index.md')
  })

  it('caps each resident source at the loose ceiling and marks what it cut', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'loom-ai-materials-'))
    try {
      await mkdir(join(workspace, 'attention'), { recursive: true })
      await mkdir(join(workspace, 'threads'), { recursive: true })
      await writeFile(join(workspace, 'attention/attention.md'), '在等他的回复'.padEnd(MATERIAL_LIMIT + 500, '。'))
      await writeFile(join(workspace, 'threads/index.md'), '那个项目 — 还没收尾')

      const materials = await readMaterials(workspace, initial())
      expect(materials.attention).toHaveLength(MATERIAL_LIMIT + ' …(truncated)'.length)
      expect(materials.attention.startsWith('在等他的回复')).toBe(true)
      expect(materials.attention.endsWith(' …(truncated)')).toBe(true)
      // Under the ceiling nothing changes: the cap is a backstop, not an editorial rule.
      expect(materials.threads).toBe('那个项目 — 还没收尾')

      // A workspace with no resident files at all is the normal first run, not an error.
      expect(await readMaterials(join(workspace, 'absent'), initial()))
        .toEqual({ recent: [], attention: '', threads: '' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('hands over the frozen note: the pause, then a direction to act on unless the agent sees otherwise', () => {
    expect(renderSituation('speak')).toBe(
      'The conversation has gone quiet. There\'s a thread here worth continuing — pick up what the human '
      + 'left open, or the thing you\'re still holding, and say what comes next. Only let it rest if, looking '
      + 'at it, there\'s genuinely nothing live: they\'re clearly done, or anything you\'d add would just be filler.')
    expect(renderSituation('act')).toBe(
      'The conversation has gone quiet. There\'s something here that should move — what the human handed you '
      + 'and you haven\'t done, or something left open in attention/threads you can act on now. Go take care of '
      + 'it. Only leave it if, on a closer look, it\'s already handled or shouldn\'t move yet.')

    for (const note of [renderSituation('speak'), renderSituation('act')]) {
      // The default is to do it, with one real opening for the agent's own reading to close.
      expect(note).toContain('Only ')
      expect(note).not.toContain('you might')
      // Nothing about the judgement that produced this, and no score it was read from.
      expect(note).not.toContain('jev')
      expect(note).not.toContain('0.39')
      expect(note).not.toContain('probability')
      // The last message and the elapsed gap are already in the agent's context; the note repeats
      // neither, and `human`/`they` is the person, never a gendered pronoun.
      expect(note).not.toContain('The last thing they said')
      expect(note).not.toContain('minutes')
      expect(note).not.toMatch(/\b(he|she|his|her)\b/)
    }
  })
})

interface Harness {
  ctx: Context
  mock: MockAdapter
  clock: ManualClock
  workspace: string
  /** Every judgement the plugin asked for, in order. */
  jevRequests: JevRequest[]
  /** The one silence the plugin armed, captured as this test's own trigger. */
  armed: ArmedSilences
  dispose: () => Promise<void>
}

/** What one judgement call answers. */
type Decide = (request: JevRequest) => Promise<JevResult>

/**
 * The silence the plugin armed, captured as the test's own trigger.
 *
 * The design's wait is three to fourteen minutes, which no test can sit through, and the alarm's
 * only seam is the deployment timer (`ctx.timeout`, which schedules on the platform `setTimeout`).
 * Intercepting exactly that delay lets a test fire the pause it wants — deterministic, and without
 * a fake clock fighting the loop's own scheduling and the fs reads a check performs.
 */
class ArmedSilences {
  private readonly real = globalThis.setTimeout
  private readonly restore: () => void
  /** The alarm armed most recently, or undefined once this test fired it. */
  fire: (() => void) | undefined
  delayMs: number | undefined
  /** How many silences were armed: the count is what proves a pause did *not* arm one. */
  count = 0

  constructor() {
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof delay === 'number' && delay >= MIN_SILENCE_MS && delay <= MAX_SILENCE_MS) {
        this.count += 1
        this.delayMs = delay
        this.fire = () => callback(...args)
        // Deliberately not scheduled: the test fires it by hand, so nothing keeps the process alive
        // for minutes and nothing races the assertions.
        return 0 as unknown as ReturnType<typeof setTimeout>
      }
      return this.real(callback as never, delay, ...args as never[])
    }) as typeof setTimeout)
    this.restore = () => spy.mockRestore()
  }

  /** Fire the pending silence, as the deployment timer would have. */
  trip(): void {
    const fire = this.fire
    if (fire === undefined) throw new Error('no silence was armed')
    this.fire = undefined
    fire()
  }

  stop(): void {
    this.restore()
  }
}

/** One scripted model call that blocks until the test releases it: a turn held open on purpose. */
class HeldAdapter extends MockAdapter {
  private held: Promise<void> = Promise.resolve()
  private release: (() => void) | undefined
  private holding = false

  /** Block the next model call. */
  hold(): void {
    this.holding = true
    this.held = new Promise(resolve => { this.release = resolve })
  }

  letGo(): void {
    this.holding = false
    this.release?.()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.holding) await this.held
    yield* super.stream(options)
  }
}

/**
 * Boot Loom's agent over a mock model with a hand-driven clock, as the deployment composes it:
 * the same plugin rows in the same order, with the two seams a test owns replaced — the clock, and
 * the judgement, which is the one thing a check would otherwise leave the process for.
 */
async function boot(mock: MockAdapter, decide: Decide): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'loom-ac-'))
  // Started at the real instant: the session's own event times come from DSH's clock, and a check
  // compares them against this one, so the two have to be on the same timeline.
  const clock = new ManualClock(Date.now())
  const ctx = new Context()
  const fibers: Fiber[] = []
  const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> => {
    fibers.push(await ctx.plugin(plugin as never, config as never))
  }
  const jevRequests: JevRequest[] = []

  await load(LlmRuntime)
  await load(SessionStore)
  await load(SessionProjectionRegistry)
  await load(SessionPersistence, { root: join(workspace, '.sessions') })
  await load(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  await load(TokenMeter)
  await load(SystemPrompt)
  await load(ToolRuntime)
  await load(AgentRegistry)
  await load(AgentLoop, { agents: [] })
  await load(Storage)
  await load(StorageSqlite, { path: ':memory:' })
  await load(StorageDomain, { backend: 'sqlite' })
  ctx.llm.registerAdapter(['mock'], mock)
  ctx.provide('clock', clock)
  ctx.provide('jev', {
    decide: (request: JevRequest) => {
      jevRequests.push(request)
      return decide(request)
    },
  } as unknown as Context['jev'])
  // The deployment's timer row, which is what `ctx.timeout` comes from.
  await load(Timer)
  await load(RuntimeStatePlugin)
  await load(ResidentContextPlugin, { workspace })
  provideFakePresets(ctx)
  await load(AfterInteractionPlugin, { workspace })
  await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })

  await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })
  const armed = new ArmedSilences()
  return {
    ctx,
    mock,
    clock,
    workspace,
    jevRequests,
    armed,
    dispose: async () => {
      armed.stop()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

/** Submit one input and wait for the turn it drives to close. */
async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Give a plugin's own async chain room to finish: a check awaits the fs and the judgement only. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise(resolve => setTimeout(resolve, 5))
}

/** The live agent, or a failed test: everything below needs one. */
function live(h: Harness): Agent {
  const agent = h.ctx.agentRuntime.current()
  if (agent === undefined) throw new Error('no live agent after boot')
  return agent
}

/**
 * Move the clock to the moment a silence alarm would fire: a few minutes after the person's last
 * message. A check reads its own `now` here, and compares it against the log's event times, so a
 * test that left the clock behind the conversation would trip the freshness guard instead.
 */
function reachThePause(h: Harness, agent: Agent): void {
  const folded = h.ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)
  h.clock.set((folded?.lastHumanInputTime ?? h.clock.now()) + 5 * 60_000)
}

/** One turn this plugin's own content opened: the pause that must never arm the next check. */
function ownTurn(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: AFTER_INTERACTION_SOURCE_KIND, form: 'notice', summary: 'test situation' },
  })
}

/** One turn nobody's message opened, and not this plugin's either. */
function injectedTurn(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: '@loom/time-context', form: 'snapshot', sections: [{ name: '@loom/time-context', text }] },
  })
}

describe('loom after-interaction check', () => {
  it('arms one silence on a pause the person caused, and none on a turn they did not', async () => {
    const h = await boot(new MockAdapter([
      toolCallResponse('c1', 'message', { text: '在的，怎么了？' }),
      textResponse('好'),
      textResponse('嗯'),
    ]), () => Promise.resolve(verdict({ quiet: 0.9, speak: 0.05, act: 0.05 })))
    try {
      const agent = live(h)
      // The resident materials the check reads, as the agent would have left them: one ordinary,
      // one past the loose ceiling, which the read marks rather than passing on whole.
      await writeFile(join(h.workspace, 'attention/attention.md'), '在等他的回复'.padEnd(MATERIAL_LIMIT + 200, '。'))
      await writeFile(join(h.workspace, 'threads/index.md'), '那个项目 — 还没收尾')

      await runTurn(agent, '[telegram · direct · from y u]\n在吗')
      // The fold is registered and has already seen the turn the person opened: arming reads it.
      const folded = h.ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)
      expect(folded?.lastHumanTurn).toBe(1)
      expect(h.armed.count).toBe(1)
      expect(h.armed.delayMs).toBeGreaterThanOrEqual(MIN_SILENCE_MS)
      expect(h.armed.delayMs).toBeLessThan(MAX_SILENCE_MS)

      // The pause arrives: the state carries the conversation and the resident files.
      const afterTurn = h.mock.requests.length
      reachThePause(h, agent)
      h.armed.trip()
      await agent.whenIdle()
      expect(h.jevRequests).toHaveLength(1)
      const request = h.jevRequests[0]
      expect(request?.questions.posture?.type).toBe('choice')
      expect(Object.keys((request?.questions.posture as { criteria: object }).criteria))
        .toEqual(['quiet', 'speak', 'act'])
      const state = request?.state
      expect(typeof state).toBe('string')
      expect(state).toContain('Person: 在吗')
      expect(state).toContain('Loom: 在的，怎么了？')
      expect(state).toContain('在等他的回复')
      expect(state).toContain('…(truncated)')
      expect(state).toContain('那个项目 — 还没收尾')

      // ③ Quiet: no wake, no further main-model call.
      expect(h.mock.requests).toHaveLength(afterTurn)

      // ① A turn nobody's message opened ends here too, and must never arm the next check — that is
      // the self-trigger the whole structural rule exists to stop.
      agent.steer(injectedTurn('injected context for the next turn'))
      await agent.whenIdle()
      expect(h.mock.requests).toHaveLength(afterTurn + 1)
      expect(h.armed.count).toBe(1)
    } finally {
      await h.dispose()
    }
  })

  it('drops a check that fires while the agent is busy, without rescheduling it', async () => {
    const mock = new HeldAdapter([textResponse('在的。'), textResponse('嗯。')])
    const h = await boot(mock, () => Promise.resolve(verdict({ quiet: 0.1, speak: 0.8, act: 0.1 })))
    try {
      const agent = live(h)
      await runTurn(agent, '在吗')
      expect(h.armed.count).toBe(1)

      // The agent is mid-turn when the silence runs out: a long tool call, or a turn that opened in
      // between. The pause never really stopped, so this check is dropped rather than deferred.
      mock.hold()
      agent.steer(injectedTurn('something else takes the agent'))
      await vi.waitFor(() => { expect(agent.status).toBe('running') })
      reachThePause(h, agent)
      h.armed.trip()
      await settle()
      expect(h.jevRequests).toHaveLength(0)

      // ⑨ No rescheduling: the next check waits for the next pause the person causes.
      mock.letGo()
      await agent.whenIdle()
      expect(h.mock.requests).toHaveLength(2)
      expect(h.armed.count).toBe(1)
      expect(situations(h.mock.requests[1])).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('steps aside when the person speaks while the judgement is in flight', async () => {
    let release: ((result: JevResult) => void) | undefined
    const judged = new Promise<JevResult>(resolve => { release = resolve })
    const h = await boot(new MockAdapter([textResponse('在的。'), textResponse('好')]), () => judged)
    try {
      const agent = live(h)
      await runTurn(agent, '那个事你看了吗')
      expect(h.armed.count).toBe(1)

      reachThePause(h, agent)
      h.armed.trip()
      await vi.waitFor(() => { expect(h.jevRequests).toHaveLength(1) })

      // ⑤ The judgement call is the window: their message lands in the inbox while the maintenance
      // task holds the agent, so the log cannot carry it yet and the pass has to look.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '算了，我想起来了' }], source: { kind: 'user' } }))
      release?.(verdict({ quiet: 0.05, speak: 0.9, act: 0.05 }))
      await agent.whenIdle()

      // Their turn ran, and no situation was handed over with it.
      expect(h.mock.requests).toHaveLength(2)
      expect(situations(h.mock.requests[1])).toHaveLength(0)
      // Their own pause is a pause they caused, so this one does arm.
      expect(h.armed.count).toBe(2)
    } finally {
      await h.dispose()
    }
  })

  it('drops the hand-off when the log holds a human input newer than the snapshot', async () => {
    const h = await boot(new MockAdapter([textResponse('在的。')]),
      () => Promise.resolve(verdict({ quiet: 0.05, speak: 0.9, act: 0.05 })))
    try {
      const agent = live(h)
      await runTurn(agent, '在吗')

      // The instant the check took its snapshot is behind the newest human input on record, so what
      // it judged is already out of date. The inbox is empty here, which leaves the timestamp as the
      // only thing that can drop this hand-off — and the judgement did lean away from quiet.
      const folded = h.ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)
      h.clock.set((folded?.lastHumanInputTime ?? 0) - 1_000)
      h.armed.trip()
      await agent.whenIdle()

      expect(h.jevRequests).toHaveLength(1)
      expect(h.mock.requests).toHaveLength(1)
      expect(situations(h.mock.requests[0])).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('stays quiet when the judgement call fails', async () => {
    const h = await boot(
      new MockAdapter([textResponse('在的。')]),
      () => Promise.reject(new JevError('transport', 'socket hang up')),
    )
    try {
      const agent = live(h)
      await runTurn(agent, '在吗')
      reachThePause(h, agent)
      h.armed.trip()
      await agent.whenIdle()
      // ⑩ Fail closed: a judgement that could not be made is a quiet one.
      expect(h.jevRequests).toHaveLength(1)
      expect(h.mock.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    } finally {
      await h.dispose()
    }
  })

  it('stays quiet when the judgement comes back without usable probabilities', async () => {
    const h = await boot(new MockAdapter([textResponse('在的。')]), () => Promise.resolve({
      model: 'jev-stub',
      answers: { posture: { type: 'choice', choice: 'speak', probabilities: {}, confidence: 1 } },
      usage: undefined,
    }))
    try {
      const agent = live(h)
      await runTurn(agent, '在吗')
      reachThePause(h, agent)
      h.armed.trip()
      await agent.whenIdle()
      expect(h.jevRequests).toHaveLength(1)
      expect(h.mock.requests).toHaveLength(1)
      expect(situations(h.mock.requests[0])).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('wakes the agent when the judgement leans away from quiet, and its own turn arms nothing', async () => {
    const h = await boot(new MockAdapter([textResponse('在的，怎么了？'), textResponse('那我去看一眼。')]),
      () => Promise.resolve(verdict({ quiet: QUIET_THRESHOLD - 0.01, speak: 0.4, act: 0.21 })))
    try {
      const agent = live(h)
      // The delivery proof: what the public status was at the instant the hand-off was made, and what
      // the driver did with it afterwards. A steer inside `runMaintenance` happens while the agent is
      // publicly idle, so only the loop's wake latch can turn it into a turn.
      const handoff: { status: string; turn: number }[] = []
      const steer = agent.steer.bind(agent)
      vi.spyOn(agent, 'steer').mockImplementation(message => {
        handoff.push({ status: agent.status, turn: h.ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)?.turn ?? -1 })
        steer(message)
      })

      await runTurn(agent, '[telegram · direct · from y u]\n那个事你看了吗')
      reachThePause(h, agent)
      h.armed.trip()
      await agent.whenIdle()

      // ④ Below the threshold the posture is the higher of speak/act, and it reaches the agent as a
      // situation through a steer — the same route a person's own message takes.
      const notice = situations(h.mock.requests[1])
      expect(notice).toHaveLength(1)
      expect(notice[0]?.source.form).toBe('notice')
      expect(typeof notice[0]?.source.summary).toBe('string')
      const text = notice[0]?.text ?? ''
      // The note is the frozen do-unless wording, and it is the agent's own observation — nothing in
      // it refers to a judgement, quotes the last message, or carries a score.
      expect(text).toBe(renderSituation('speak'))
      expect(text).not.toContain('jev')
      expect(text).not.toContain('0.39')
      expect(text).not.toContain('quiet=')
      expect(text).not.toContain('那个事你看了吗')

      // The steer was made from inside the maintenance task, with the agent publicly idle, and the
      // driver opened a *new* turn for it after that task settled.
      expect(handoff).toEqual([{ status: 'idle', turn: 1 }])
      expect(h.ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)?.turn).toBe(2)
      expect(agent.status).toBe('idle')

      // ① Its own proactive turn ends in the very idle this check came from. Arming on it would make
      // every check feed the next one, so the turn that just committed is the person's or nothing.
      expect(h.armed.count).toBe(1)
      expect(h.armed.fire).toBeUndefined()
    } finally {
      await h.dispose()
    }
  })
})
