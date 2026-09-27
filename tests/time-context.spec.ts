import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionLogOffset } from '@deepseek-ai/dsh-session'
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
import { ManualClock } from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as TimeContextPlugin from '../src/time-context/index.ts'
import { applyTimeContextEvent, TIME_CONTEXT_KEY, timeContextProjection } from '../src/time-context/projection.ts'
import { formatLoomDuration, formatLoomTimestamp } from '../src/time-context/format.ts'
import { CLOCK_REFRESH_INTERVAL_MS, renderClockSnapshot, shouldSampleClock } from '../src/time-context/snapshot.ts'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/** Attribution this plugin stamps on its snapshots. */
const SNAPSHOT_KIND = '@loom/time-context'

/** One session event carrying only what the fold reads. */
function event(type: string, time: number): SessionEvent {
  return { type, time } as unknown as SessionEvent
}

/** The text of every snapshot one model request was given. */
function snapshots(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? [])
    .filter(message => message.source?.kind === SNAPSHOT_KIND)
    .flatMap(message => (message.content ?? [])
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text))
}

/** A mock model that moves the clock before each call, so one turn can outlive the interval. */
class ClockAdvancingAdapter extends MockAdapter {
  constructor(
    script: StreamChunk[][],
    private readonly clock: ManualClock,
    private readonly advanceMs: number,
  ) {
    super(script)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.clock.advance(this.advanceMs)
    yield* super.stream(options)
  }
}

describe('loom time-context formatting', () => {
  it('renders one instant in the fixed zone, identically on every read', () => {
    const instant = Date.parse('2026-09-27T14:31:55.000Z')
    expect(formatLoomTimestamp(instant)).toBe('2026-09-27T22:31:55+08:00')
    // The date itself rolls in the fixed zone, not in whatever locale the process runs in.
    expect(formatLoomTimestamp(Date.parse('2026-09-27T16:00:00.000Z'))).toBe('2026-09-28T00:00:00+08:00')
  })

  it('renders elapsed time as compact whole-second units, never negative', () => {
    expect(formatLoomDuration(0)).toBe('0s')
    expect(formatLoomDuration(999)).toBe('0s')
    expect(formatLoomDuration(1_000)).toBe('1s')
    expect(formatLoomDuration(60_000)).toBe('1m 0s')
    expect(formatLoomDuration(90_061_000)).toBe('1d 1h 1m 1s')
    expect(formatLoomDuration(-5_000)).toBe('0s')
  })

  it('renders the instant and the elapsed span, and says so when there is no baseline', () => {
    const now = Date.parse('2026-09-27T14:31:55.000Z')
    expect(renderClockSnapshot({ now, turn: 3, step: 1, previous: now - 90_061_000 }))
      .toBe('Loom clock sampled while preparing turn 3, step 1: 2026-09-27T22:31:55+08:00\n'
        + 'Elapsed since the preceding model-visible event: 1d 1h 1m 1s.')
    expect(renderClockSnapshot({ now, turn: 1, step: 1, previous: null }))
      .toBe('Loom clock sampled while preparing turn 1, step 1: 2026-09-27T22:31:55+08:00\n'
        + 'Elapsed since the preceding model-visible event: unavailable (nothing earlier in this session\'s log).')
  })
})

describe('loom time-context baseline fold', () => {
  it('folds only model-visible events, and returns the same state when nothing changed', () => {
    let state = timeContextProjection.init(undefined as never, SessionLogOffset(0))
    expect(state).toEqual({ lastEventTime: null })

    // Events the model never sees do not move the baseline, and cost no new state reference.
    for (const type of ['turn/start', 'turn/end', 'session/start']) {
      const unchanged = applyTimeContextEvent(state, event(type, 1_000))
      expect(unchanged).toBe(state)
    }

    state = applyTimeContextEvent(state, event('user/message', 5_000))
    expect(state.lastEventTime).toBe(5_000)
    state = applyTimeContextEvent(state, event('assistant/message', 9_000))
    expect(state.lastEventTime).toBe(9_000)
    state = applyTimeContextEvent(state, event('tool/result', 12_000))
    expect(state.lastEventTime).toBe(12_000)
    // The projection framework treats the same reference as zero downstream work; re-folding one
    // event must not churn it.
    expect(applyTimeContextEvent(state, event('tool/result', 12_000))).toBe(state)
  })

  it('samples the first step of every turn, and later steps only past the interval', () => {
    expect(shouldSampleClock(1, 1_000, undefined, CLOCK_REFRESH_INTERVAL_MS)).toBe(true)
    // A turn always opens with a fresh instant, however recently the previous turn sampled.
    expect(shouldSampleClock(1, 1_000, 999, CLOCK_REFRESH_INTERVAL_MS)).toBe(true)
    // No snapshot landed in this turn yet: silence would be indistinguishable from a fast turn.
    expect(shouldSampleClock(2, 1_000, undefined, CLOCK_REFRESH_INTERVAL_MS)).toBe(true)
    expect(shouldSampleClock(2, 1_000 + CLOCK_REFRESH_INTERVAL_MS - 1, 1_000, CLOCK_REFRESH_INTERVAL_MS)).toBe(false)
    expect(shouldSampleClock(2, 1_000 + CLOCK_REFRESH_INTERVAL_MS, 1_000, CLOCK_REFRESH_INTERVAL_MS)).toBe(true)
  })
})

interface Harness {
  ctx: Context
  mock: MockAdapter
  clock: ManualClock
  workspace: string
  dispose: () => Promise<void>
}

/**
 * Boot Loom's agent over a mock model with a hand-driven clock. The plugin rows load in the order
 * `cordis.patch.yml` lists them — time-context before agent-runtime — so the agent-runtime
 * dependency resolves through `inject` rather than through mount order. The caller owns the clock,
 * so a mock model can move it between the steps of one turn.
 */
async function bootWithManualClock(mock: MockAdapter, clock: ManualClock): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'loom-tc-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> => {
    fibers.push(await ctx.plugin(plugin as never, config as never))
  }

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
  // The deployment's single time source, handed to the test instead of the wall clock.
  ctx.provide('clock', clock)
  await load(RuntimeStatePlugin)
  await load(ResidentContextPlugin, { workspace })
  provideFakePresets(ctx)
  await load(TimeContextPlugin)
  await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })

  await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })
  return {
    ctx,
    mock,
    clock,
    workspace,
    dispose: async () => {
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

describe('loom time-context turn injection', () => {
  it('opens every turn with the instant, measuring the next one from the last event', async () => {
    const start = Date.parse('2026-09-27T14:31:55.000Z')
    const h = await bootWithManualClock(new MockAdapter([textResponse('first'), textResponse('second')]), new ManualClock(start))
    try {
      const agent = h.ctx.agentRuntime.current()
      expect(agent).toBeDefined()
      if (agent === undefined) return

      await runTurn(agent, 'hello')
      expect(h.mock.requests).toHaveLength(1)
      // The first turn of an unseeded generation has nothing earlier in its own log to measure
      // from, and the line says that rather than inventing a baseline.
      expect(snapshots(h.mock.requests[0])).toEqual([
        renderClockSnapshot({ now: start, turn: 1, step: 1, previous: null }),
      ])
      // It is appended after every other injection, so it sits nearest the step it describes.
      expect(h.mock.requests[0]?.messages.at(-1)?.source?.kind).toBe(SNAPSHOT_KIND)

      // The baseline is the session's own log, folded by the projection: the newest event of the
      // turn that just closed.
      const baseline = h.ctx.sessionProjections.stateOf(agent.session, TIME_CONTEXT_KEY)
      expect(baseline?.lastEventTime).not.toBeNull()
      const lastEventTime = baseline?.lastEventTime
      expect(typeof lastEventTime).toBe('number')
      if (typeof lastEventTime !== 'number') return

      // Two hours later, the next turn measures that real gap — the instant itself comes from the
      // clock, the baseline from the log.
      h.clock.set(lastEventTime + 7_200_000)
      await runTurn(agent, 'still there?')
      expect(h.mock.requests).toHaveLength(2)
      // The earlier snapshot stays in the conversation; the new turn appends exactly one more.
      expect(snapshots(h.mock.requests[1])).toHaveLength(2)
      expect(snapshots(h.mock.requests[1])?.at(-1)).toBe(
        renderClockSnapshot({ now: lastEventTime + 7_200_000, turn: 2, step: 1, previous: lastEventTime }),
      )
    } finally {
      await h.dispose()
    }
  })

  it('keeps a tool-dense turn at one line, and re-samples a turn that outlives the interval', async () => {
    const start = Date.parse('2026-09-27T14:31:55.000Z')
    const quiet = await bootWithManualClock(new MockAdapter([
      toolCallResponse('c1', 'no-such-tool', {}),
      textResponse('done'),
    ]), new ManualClock(start))
    try {
      const agent = quiet.ctx.agentRuntime.current()
      expect(agent).toBeDefined()
      if (agent === undefined) return
      await runTurn(agent, 'two steps please')
      // Both steps ran against the model, and the second saw the same single snapshot as the first:
      // a quick tool-dense turn does not repeat the line.
      expect(quiet.mock.requests).toHaveLength(2)
      expect(snapshots(quiet.mock.requests[0])).toHaveLength(1)
      expect(snapshots(quiet.mock.requests[1])).toEqual(snapshots(quiet.mock.requests[0]))
    } finally {
      await quiet.dispose()
    }

    const longClock = new ManualClock(start)
    const long = await bootWithManualClock(new ClockAdvancingAdapter([
      toolCallResponse('c1', 'no-such-tool', {}),
      textResponse('done'),
    ], longClock, CLOCK_REFRESH_INTERVAL_MS + 60_000), longClock)
    try {
      const agent = long.ctx.agentRuntime.current()
      expect(agent).toBeDefined()
      if (agent === undefined) return
      await runTurn(agent, 'a long one please')
      expect(long.mock.requests).toHaveLength(2)
      // The turn outlived the interval, so its second step shows its real span: one snapshot per
      // elapsed interval, each stamped with the instant it was taken.
      expect(snapshots(long.mock.requests[0])).toHaveLength(1)
      expect(snapshots(long.mock.requests[0])?.[0]).toContain(formatLoomTimestamp(start))
      expect(snapshots(long.mock.requests[1])).toHaveLength(2)
      expect(snapshots(long.mock.requests[1])?.[1])
        .toContain(formatLoomTimestamp(start + CLOCK_REFRESH_INTERVAL_MS + 60_000))
    } finally {
      await long.dispose()
    }
  })
})
