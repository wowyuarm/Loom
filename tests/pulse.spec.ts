import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { JevRequest, JevResult } from '@wowyuarm/dsh-jev'
import { PULSE_SOURCE_KIND } from '../src/contracts/index.ts'
import { ManualClock } from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as AfterInteractionPlugin from '../src/after-interaction/index.ts'
import * as PulsePlugin from '../src/pulse/index.ts'
import * as ChannelGateway from '@contexera/dsh-channel-gateway'
import * as ChannelsPlugin from '../src/channels/index.ts'
import * as TimeContextPlugin from '../src/time-context/index.ts'
import { AFTER_INTERACTION_KEY } from '../src/after-interaction/projection.ts'
import { pulseStateDomain } from '../src/pulse/ledger.ts'
import { readVerdict } from '../src/pulse/verdict.ts'
import { readPulseMaterials } from '../src/pulse/state.ts'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

function result(attend = 0.9): JevResult {
  return { model: 'jev-stub', answers: { pulse: { type: 'choice', choice: attend > 0.5 ? 'attend' : 'quiet',
    probabilities: { attend, quiet: 1 - attend }, confidence: 0.9 } }, usage: undefined }
}

async function boot(mock: MockAdapter, decide: (r: JevRequest) => Promise<JevResult>,
  options: { dryRun?: boolean; workspace?: string } = {}) {
  const workspace = options.workspace ?? await mkdtemp(join(tmpdir(), 'loom-pulse-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown) => {
    fibers.push(await ctx.plugin(plugin as never, config as never))
  }
  await load(LlmRuntime); await load(SessionStore); await load(SessionProjectionRegistry)
  await load(SessionPersistence, { root: join(workspace, '.sessions') })
  await load(SessionQuerySqlite, { path: ':memory:', openAt: 'never' }); await load(TokenMeter)
  await load(SystemPrompt); await load(ToolRuntime); await load(AgentRegistry); await load(AgentLoop, { agents: [] })
  await load(Storage); await load(StorageSqlite, { path: join(workspace, '.state.db') }); await load(StorageDomain, { backend: 'sqlite' })
  const clock = new ManualClock(Date.now())
  ctx.provide('clock', clock)
  const requests: JevRequest[] = []
  ctx.provide('jev', { decide: (r: JevRequest) => { requests.push(r); return decide(r) } } as unknown as Context['jev'])
  ctx.llm.registerAdapter(['mock'], mock)
  await load(Timer); await load(RuntimeStatePlugin); await load(ResidentContextPlugin, { workspace })
  provideFakePresets(ctx)
  await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })
  await load(TimeContextPlugin)
  await load(ChannelGateway, { allow: ['*'] })
  await load(ChannelsPlugin, { workspace })
  await load(AfterInteractionPlugin, { workspace })
  await writeFile(join(workspace, 'attention/attention.md'), 'Compare the remaining evidence; no person needs a message.')
  await writeFile(join(workspace, 'threads/index.md'), 'research — resume from threads/research.md')
  await writeFile(join(workspace, 'memory/memory.md'), 'Persistent understanding.\n\n## Notes\n- Evidence notes: memory/notes/evidence.md')
  await writeFile(join(workspace, 'identity/identity.md'), 'I am the same Individual.')

  const callbacks: (() => void)[] = []
  const afterCallbacks: (() => void)[] = []
  let armed = 0
  const real = globalThis.setTimeout
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 300_000) { callbacks.push(() => fn(...args)); return 0 as unknown as ReturnType<typeof setTimeout> }
    if (delay !== undefined && delay >= 180_000 && delay <= 840_000) {
      armed++; afterCallbacks.push(() => fn(...args)); return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return real(fn, delay, ...args)
  }) as typeof setTimeout)
  await load(PulsePlugin, { workspace, dryRun: options.dryRun ?? false })
  let stored: import('../src/pulse/ledger.ts').PulseState | undefined
  let checkCount = 0
  ctx.on('domain/changed', (change) => {
    if (change.domain !== pulseStateDomain.name) return
    if (change.operation === 'put' && change.table === '') stored = change.value as typeof stored
    if (change.operation === 'put' && change.table === 'check') checkCount++
  })
  return { ctx, clock, mock, workspace, requests,
    get stored() { return stored }, get armed() { return armed }, get checkCount() { return checkCount },
    afterTick: () => { const fn = afterCallbacks.shift(); if (!fn) throw new Error('no after-interaction alarm'); fn() },
    tick: () => { const fn = callbacks.shift(); if (!fn) throw new Error('no pulse poll'); fn() },
    dispose: async (remove = true) => { spy.mockRestore(); for (const f of fibers.reverse()) await f.dispose();
      if (remove) await rm(workspace, { recursive: true, force: true }) },
  }
}
async function human(h: Awaited<ReturnType<typeof boot>>, text = 'hello') {
  h.ctx.agentRuntime.deliver(text)
  await h.ctx.agentRuntime.current()!.whenIdle()
  await vi.waitFor(() => expect(h.stored?.lastActivityTime).not.toBeNull())
}
async function settleCheck(h: Awaited<ReturnType<typeof boot>>) {
  await vi.waitFor(() => expect(h.stored?.lastCheck).toBeDefined())
  await h.ctx.agentRuntime.current()!.whenIdle()
}

describe('pulse running with the real loop', () => {
  it('keeps quiet checks separate from activity, respects cadence and dry-run, and resumes persisted scheduling', async () => {
    const h = await boot(new MockAdapter([textResponse('ok')]), async () => result(), { dryRun: true })
    let again: Awaited<ReturnType<typeof boot>> | undefined
    try {
      await human(h)
      const activity = h.stored!.lastActivityTime!
      h.clock.set(activity + 29 * 60_000); h.tick()
      await new Promise(r => setTimeout(r, 25)); expect(h.requests).toHaveLength(0)
      h.clock.set(activity + 30 * 60_000); h.tick(); await settleCheck(h)
      expect(h.mock.requests).toHaveLength(1)
      expect(h.stored!.lastActivityTime).toBe(activity)
      expect(h.stored!.lastCheck?.outcome).toBe('shadow')
      h.clock.advance(5 * 60_000); h.tick()
      await new Promise(r => setTimeout(r, 25)); expect(h.requests).toHaveLength(1)
      const workspace = h.workspace
      await h.dispose(false)
      again = await boot(new MockAdapter([]), async () => result(0.1), { workspace, dryRun: true })
      again.clock.set(activity + 59 * 60_000); again.tick()
      await new Promise(r => setTimeout(r, 25)); expect(again.requests).toHaveLength(0)
      again.clock.set(activity + 600 * 60_000); again.tick(); await vi.waitFor(() => expect(again!.requests).toHaveLength(1)); await settleCheck(again)
      expect(again.requests).toHaveLength(1)
      expect(again.stored!.lastCheck?.outcome).toBe('quiet')
      again.tick(); await new Promise(r => setTimeout(r, 25)); expect(again.requests).toHaveLength(1)
    } finally { if (again) await again.dispose(); else await h.dispose() }
  })

  it('wakes with identity, fresh materials, memory, clock and the prior transcript, and carries materials into the successor', async () => {
    const mock = new MockAdapter([textResponse('past reply'), toolCallResponse('r1', 'context_rollover', { handoff: 'Preserve the evidence.' }), textResponse('end'), textResponse('successor')])
    const h = await boot(mock, async () => result())
    try {
      await human(h, 'past human input')
      const agent = h.ctx.agentRuntime.current()!
      const original = agent.id
      h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000)
      h.tick()
      await vi.waitFor(() => expect(mock.requests.length).toBeGreaterThanOrEqual(2))
      const request = mock.requests[1]!
      const text = JSON.stringify(request)
      expect(text).toContain('past human input'); expect(text).toContain('past reply')
      expect(text).toContain('I am the same Individual'); expect(text).toContain('remaining evidence')
      expect(text).toContain('threads/research.md'); expect(text).toContain('Persistent understanding'); expect(text).toContain('memory/notes/evidence.md')
      expect(text).toContain('autonomous wake'); expect(text).toContain('own working moment')
      expect(text).toContain('@loom/time-context'); expect(text).not.toContain('jev-stub')
      await vi.waitFor(() => expect(h.ctx.agentRuntime.current()!.id).not.toBe(original), { timeout: 5_000 })
      await h.ctx.agentRuntime.current()!.whenIdle()
      await vi.waitFor(() => expect(h.stored!.lastTurn!.sessionId).toBe(String(h.ctx.agentRuntime.current()!.id)))
      expect(h.stored!.lastActivityTime).toBeGreaterThanOrEqual(h.stored!.lastWake!.endedAt)
      expect(JSON.stringify(mock.requests.at(-1))).toContain('remaining evidence')
    } finally { await h.dispose() }
  })

  it('keeps present activity and material state when returning to an old checkpoint', async () => {
    const mock = new MockAdapter([toolCallResponse('ck1', 'context_checkpoint', { name: 'old point' }), textResponse('checkpoint recorded')])
    const h = await boot(mock, async () => result(), { dryRun: true })
    try {
      const original = h.ctx.agentRuntime.current()!.id
      await human(h, 'record a checkpoint')
      const oldTime = h.stored!.lastActivityTime!
      const ref = `loom-checkpoint-${createHash('sha256').update(JSON.stringify([original, 'ck1'])).digest('hex')}`
      await writeFile(join(h.workspace, 'attention/attention.md'), 'Present evidence after the old checkpoint.')
      mock.enqueue(toolCallResponse('return1', 'context_rollover', { handoff: 'Use current external evidence.', checkpointRef: ref }),
        textResponse('returning'), textResponse('resumed'))
      await human(h, 'return to the old point')
      await vi.waitFor(() => expect(h.ctx.agentRuntime.current()!.id).not.toBe(original), { timeout: 5_000 })
      await h.ctx.agentRuntime.current()!.whenIdle()
      await vi.waitFor(() => expect(h.stored!.lastTurn!.sessionId).toBe(String(h.ctx.agentRuntime.current()!.id)))
      expect(Number(h.ctx.agentRuntime.current()!.session.inheritedEventCount)).toBeGreaterThan(0)
      expect(h.stored!.lastActivityTime!).toBeGreaterThanOrEqual(oldTime)
      expect(JSON.stringify(mock.requests.at(-1))).toContain('Present evidence after the old checkpoint')
      const current = h.stored!.lastActivityTime!
      h.clock.set(current + 29 * 60_000); h.tick()
      await new Promise(r => setTimeout(r, 25)); expect(h.requests).toHaveLength(0)
    } finally { await h.dispose() }
  })

  it('counts an after-interaction wake as activity and delays the next pulse check', async () => {
    const mock = new MockAdapter([textResponse('ok'), textResponse('after-interaction work'), textResponse('pulse work')])
    const h = await boot(mock, async r => 'posture' in r.questions
      ? { model: 'jev-stub', answers: { posture: { type: 'choice', choice: 'act',
          probabilities: { quiet: 0.1, speak: 0.1, act: 0.8 }, confidence: 1 } }, usage: undefined }
      : result())
    try {
      await human(h)
      const original = h.stored!.lastActivityTime!
      h.clock.set(original + 5 * 60_000); h.afterTick()
      await vi.waitFor(() => expect(h.requests).toHaveLength(1))
      await h.ctx.agentRuntime.current()!.whenIdle()
      await vi.waitFor(() => expect(h.stored!.lastWake?.sources).toContain('@loom/after-interaction'))
      const renewed = h.stored!.lastActivityTime!
      expect(renewed).toBeGreaterThan(original)
      h.clock.set(original + 30 * 60_000); h.tick()
      await new Promise(r => setTimeout(r, 25)); expect(h.requests).toHaveLength(1)
      h.clock.set(renewed + 30 * 60_000); h.tick()
      await vi.waitFor(() => expect(h.requests).toHaveLength(2))
    } finally { await h.dispose() }
  })

  it('admits a human joining a pulse tool turn at the next step and arms only the resulting human pause', async () => {
    let release!: () => void
    let holding = false
    const held = new Promise<void>(resolve => { release = resolve })
    const h = await boot(new MockAdapter([textResponse('past reply'), toolCallResponse('park1', 'park', {}), textResponse('joined reply')]), async () => result())
    try {
      h.ctx.tools.register(defineTool({ name: 'park', description: 'Hold a tool step for the race test.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => { holding = true; await held; return 'finished' },
      }))
      await human(h)
      const armedBefore = h.armed
      const agent = h.ctx.agentRuntime.current()!
      h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000); h.tick()
      await vi.waitFor(() => expect(holding).toBe(true))
      expect(h.armed).toBe(armedBefore)
      await writeFile(join(h.workspace, 'attention/attention.md'), 'New evidence arrived during the tool step.')
      h.ctx.agentRuntime.deliver('I joined your ongoing work')
      expect(h.mock.requests).toHaveLength(2)
      h.tick(); await new Promise(r => setTimeout(r, 20)); expect(h.requests).toHaveLength(1)
      release(); await agent.whenIdle()
      await vi.waitFor(() => expect(h.stored!.lastWake?.sources).toContain('user'))
      expect(h.stored!.lastWake!.sources).toContain(PULSE_SOURCE_KIND)
      expect(h.stored!.lastWake!.tools).toEqual(['park'])
      expect(h.stored!.lastWake!.messageAttempts).toBe(0)
      expect(h.mock.requests).toHaveLength(3)
      expect(JSON.stringify(h.mock.requests[2])).toContain('I joined your ongoing work')
      expect(JSON.stringify(h.mock.requests[2])).toContain('New evidence arrived during the tool step')
      expect(h.armed).toBe(armedBefore + 1)
      const ai = h.ctx.sessionProjections.stateOf(agent.session, AFTER_INTERACTION_KEY)!
      expect(ai.lastHumanTurn).toBe(h.stored!.lastWake!.turn)
      const activity = h.stored!.lastActivityTime!
      h.clock.set(activity + 29 * 60_000); h.tick()
      await new Promise(r => setTimeout(r, 20)); expect(h.requests).toHaveLength(1)
    } finally { release(); await h.dispose() }
  })

  it('does not interpret a pure autonomous quiet turn as abandonment or a reason to arm after-interaction', async () => {
    const h = await boot(new MockAdapter([textResponse('ok'), textResponse('internal note'), textResponse('second quiet wake')]), async () => result())
    try {
      await human(h)
      const armedBefore = h.armed
      h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000); h.tick(); await settleCheck(h)
      await vi.waitFor(() => expect(h.stored!.lastWake).toBeDefined())
      expect(h.armed).toBe(armedBefore)
      expect(h.stored!.lastWake!.tools).toEqual([])
      expect(h.stored!.lastWake!.sources).toEqual([PULSE_SOURCE_KIND])
      h.clock.set(h.stored!.lastCheckTime! + 30 * 60_000); h.tick()
      await vi.waitFor(() => expect(h.requests).toHaveLength(2))
      const nextState = h.requests[1]!.state as string
      expect(nextState).toContain('tools called: none')
      expect(nextState).toContain('does not establish a decision to abandon')
      expect(nextState).not.toContain('judged it not worth waking')
    } finally { await h.dispose() }
  })

  it('keeps provider failure and malformed probabilities silent without retrying on every poll', async () => {
    let calls = 0
    const h = await boot(new MockAdapter([textResponse('ok')]), async () => {
      if (++calls === 1) throw new Error('transport failed')
      return { ...result(), answers: { pulse: { type: 'choice', choice: 'attend', probabilities: { attend: 2, quiet: -1 }, confidence: 1 } } }
    })
    try {
      await human(h)
      const activity = h.stored!.lastActivityTime!
      h.clock.set(activity + 30 * 60_000); h.tick(); await settleCheck(h)
      expect(h.stored!.lastCheck!.outcome).toBe('failed')
      h.clock.advance(5 * 60_000); h.tick(); await new Promise(r => setTimeout(r, 25)); expect(h.requests).toHaveLength(1)
      h.clock.set(activity + 60 * 60_000); h.tick()
      await vi.waitFor(() => expect(h.requests).toHaveLength(2))
      await h.ctx.agentRuntime.current()!.whenIdle()
      expect(h.mock.requests).toHaveLength(1)
      expect(readVerdict({ type: 'choice', choice: 'attend', probabilities: { attend: 0.9, quiet: 0.9 }, confidence: 1 }, 0.5)).toBeUndefined()
    } finally { await h.dispose() }
  })

  it('makes a completed autonomous outcome visible to the next turn without claiming completion', async () => {
    const h = await boot(new MockAdapter([textResponse('ok'), toolCallResponse('r', 'park', {}), textResponse('done'), textResponse('next')]), async () => result())
    try {
      h.ctx.tools.register(defineTool({ name: 'park', description: 'Read a piece of evidence.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'evidence' }))
      await human(h); h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000); h.tick(); await settleCheck(h)
      await vi.waitFor(() => expect(h.stored!.lastWake?.tools).toEqual(['park']))
      h.ctx.agentRuntime.deliver('what changed?'); await h.ctx.agentRuntime.current()!.whenIdle()
      const request = JSON.stringify(h.mock.requests.at(-1))
      expect(request).toContain('tools called: park')
      expect(request).toContain('Tool use does not establish completion')
      expect(request).not.toContain('jev-stub')
    } finally { await h.dispose() }
  })

  it('records a failed message attempt as an error rather than claiming the subject spoke successfully', async () => {
    const h = await boot(new MockAdapter([textResponse('ok'), toolCallResponse('m1', 'message', { text: 'unsent' }), textResponse('done')]), async () => result())
    try {
      await human(h); h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000); h.tick(); await settleCheck(h)
      await vi.waitFor(() => expect(h.stored!.lastWake?.messageAttempts).toBe(1))
      expect(h.stored!.lastWake!.messageSuccesses).toBe(0)
      expect(h.stored!.lastWake!.toolErrors).toBe(1)
    } finally { await h.dispose() }
  })

  it('marks truncated non-English materials and treats unreadable material as an error, not an empty source', async () => {
    const h = await boot(new MockAdapter([]), async () => result(), { dryRun: true })
    try {
      await writeFile(join(h.workspace, 'attention/attention.md'), '自己的线'.repeat(20))
      const materials = await readPulseMaterials(h.workspace, 20)
      expect(materials.attention).toContain('自己的线')
      expect(materials.attention).toContain('[truncated:')
      expect(materials.threads).toContain('[truncated:')
      await rm(join(h.workspace, 'threads/index.md'))
      expect((await readPulseMaterials(h.workspace, 200)).threads).toBe('')
      await mkdir(join(h.workspace, 'threads/index.md'))
      await expect(readPulseMaterials(h.workspace, 200)).rejects.toMatchObject({ code: 'EISDIR' })
    } finally { await h.dispose() }
  })

  it('aborts in-flight evaluation on plugin disposal before closing its state domain', async () => {
    let aborted = false
    const h = await boot(new MockAdapter([textResponse('ok')]), r => new Promise((_resolve, reject) => {
      r.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }, { once: true })
    }))
    await human(h); h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000); h.tick()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    await h.dispose()
    expect(aborted).toBe(true)
  })

  it('aborts a judgement on inbox insertion before the human message can enter the transcript', async () => {
    let aborted = false
    const h = await boot(new MockAdapter([textResponse('ok'), textResponse('human reply')]), r => new Promise((_resolve, reject) => {
      r.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }, { once: true })
    }))
    try {
      await human(h)
      h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000); h.tick()
      await vi.waitFor(() => expect(h.requests).toHaveLength(1))
      h.ctx.agentRuntime.deliver('I have arrived')
      expect(aborted).toBe(true)
      await settleCheck(h)
      expect(h.stored!.lastCheck!.outcome).toBe('cancelled')
      expect(JSON.stringify(h.mock.requests[1])).toContain('I have arrived')
      expect(JSON.stringify(h.mock.requests[1])).not.toContain('own working moment')
    } finally { await h.dispose() }
  })

  it('withdraws only its queued notice when a person beats its admission', async () => {
    const h = await boot(new MockAdapter([textResponse('ok'), textResponse('human reply')]), async () => result())
    try {
      await human(h)
      const agent = h.ctx.agentRuntime.current()!
      const steer = agent.steer.bind(agent)
      vi.spyOn(agent, 'steer').mockImplementation(message => {
        steer(message)
        if (message.source.kind === PULSE_SOURCE_KIND) h.ctx.agentRuntime.deliver('human wins')
      })
      h.clock.set(h.stored!.lastActivityTime! + 30 * 60_000); h.tick(); await settleCheck(h)
      expect(h.stored!.lastCheck!.outcome).toBe('withdrawn')
      expect(JSON.stringify(h.mock.requests[1])).toContain('human wins')
      expect(JSON.stringify(h.mock.requests[1])).not.toContain('own working moment')
    } finally { await h.dispose() }
  })
})
