import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { TransitionPlan } from '@wowyuarm/dsh-context-continuity'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import { liveJobLabels } from '../src/agent-runtime/index.ts'
import { bootAgent } from '../src/agent-runtime/boot.ts'
import { LoomAgentRuntime } from '../src/agent-runtime/runtime.ts'
import type { RuntimeState } from '../src/contracts/index.ts'

/** Real runtime-state over an in-memory sqlite medium; only ctx.agents is faked. */
async function realRuntimeState(): Promise<{ runtimeState: RuntimeState; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fStorage = await ctx.plugin(Storage)
  const fSqlite = await ctx.plugin(StorageSqlite, { path: ':memory:' })
  const fDomain = await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  const fRuntime = await ctx.plugin(RuntimeStatePlugin)
  await vi.waitFor(() => { expect(ctx.runtimeState).toBeDefined() })
  return {
    runtimeState: ctx.runtimeState,
    dispose: async () => {
      await fRuntime.dispose()
      await fDomain.dispose()
      await fSqlite.dispose()
      await fStorage.dispose()
    },
  }
}

/**
 * Fake session log carrying just what the runtime's `sandbox/mode` pin reads and writes
 * (`ownEvents`/`append`), plus the recorded modes for assertions. `seededModes` replays modes a
 * real session would already carry (session creation pins the deployment default).
 */
function fakeSession(id: SessionId, seededModes: string[] = []) {
  const events: { type: string; data: { mode?: string } }[] = []
  for (const mode of seededModes) events.push({ type: 'sandbox/mode', data: { mode } })
  return {
    id,
    ownEvents: () => events,
    append: (type: string, data: { mode?: string }) => { events.push({ type, data }) },
    modes: () => events.filter(event => event.type === 'sandbox/mode').map(event => event.data.mode),
  }
}

function fakeAgents(seededModes: string[] = []) {
  const created: { sessionId: SessionId }[] = []
  const resumed: { resumeSessionId: SessionId }[] = []
  const sessions = new Map<SessionId, ReturnType<typeof fakeSession>>()
  const handle = (id: SessionId): AgentHandle => {
    const session = fakeSession(id, seededModes)
    sessions.set(id, session)
    return { agent: { id, session } as unknown as AgentHandle['agent'], dispose: () => Promise.resolve() }
  }
  return {
    created,
    resumed,
    session: (id: SessionId) => sessions.get(id),
    agents: {
      create: (opts: { sessionId: SessionId }) => { created.push(opts); return Promise.resolve(handle(opts.sessionId)) },
      resume: (opts: { resumeSessionId: SessionId }) => { resumed.push(opts); return Promise.resolve(handle(opts.resumeSessionId)) },
    } as never,
  }
}

describe('liveJobLabels', () => {
  const job = (overrides: Partial<JobView>): JobView => ({
    id: 'bash-1' as JobView['id'],
    kind: 'bash',
    label: 'bun test',
    status: 'running',
    startedAt: 0,
    output: { total: 0, earliest: 0 },
    ...overrides,
  } as JobView)

  it('names only the jobs a rollover would take down', () => {
    const owner = SessionId('loom-s0')
    // Live and owned: the states that are actually at stake when the agent is disposed.
    expect(liveJobLabels([
      job({ label: 'running', owner, status: 'running' }),
      job({ label: 'stopping', owner, status: 'stopping' }),
    ])).toEqual(['running', 'stopping'])

    // Settled work is already collected, and an unowned job outlives the swap — the registry
    // cancels only what the disposed owner owned, so naming either would overstate the cost.
    expect(liveJobLabels([
      job({ label: 'completed', owner, status: 'completed' }),
      job({ label: 'killed', owner, status: 'killed' }),
      job({ label: 'failed', owner, status: 'failed' }),
      job({ label: 'unowned', status: 'running' }),
    ])).toEqual([])
  })
})

describe('bootAgent', () => {
  it('creates a first session and records the pointer when none exists', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      const reg = fakeAgents()
      const handle = await bootAgent({
        agents: reg.agents,
        runtimeState,
        workspace: '/ws',
        newSessionId: () => SessionId('s-new'),
      })
      expect(reg.created).toEqual([{ sessionId: SessionId('s-new'), meta: { cwd: '/ws' } }])
      expect(reg.resumed).toEqual([])
      expect(handle.agent.id).toBe(SessionId('s-new'))
      expect(runtimeState.getCurrentSession()).toEqual({ sessionId: 's-new' })
    } finally {
      await dispose()
    }
  })

  it('resumes the pointed-to session on a later boot instead of creating a new one', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      await runtimeState.setCurrentSession({ sessionId: 's-live' })
      const reg = fakeAgents()
      const handle = await bootAgent({ agents: reg.agents, runtimeState, workspace: '/ws' })
      expect(reg.resumed).toEqual([{ resumeSessionId: SessionId('s-live') }])
      expect(reg.created).toEqual([])
      expect(handle.agent.id).toBe(SessionId('s-live'))
    } finally {
      await dispose()
    }
  })
})

interface TrackedAgent {
  disposed: boolean
  steered: UserMessage[]
  followed: UserMessage[]
  order: string[]
}

/** Fake registry whose agents record steer/followup/dispose, keyed by session id. */
function trackAgents() {
  const byId = new Map<string, TrackedAgent>()
  const metaById = new Map<string, unknown>()
  const sessions = new Map<SessionId, ReturnType<typeof fakeSession>>()
  const track = (id: SessionId): AgentHandle => {
    const rec: TrackedAgent = { disposed: false, steered: [], followed: [], order: [] }
    byId.set(id, rec)
    const session = fakeSession(id)
    sessions.set(id, session)
    const agent = {
      id,
      session,
      steer: (m: UserMessage) => { rec.order.push('steer'); rec.steered.push(m) },
      followup: (m: UserMessage) => { rec.order.push('followup'); rec.followed.push(m) },
    }
    return { agent: agent as unknown as AgentHandle['agent'], dispose: () => { rec.disposed = true; return Promise.resolve() } }
  }
  return {
    agent: (id: string): TrackedAgent => {
      const rec = byId.get(id)
      if (rec === undefined) throw new Error(`no agent ${id}`)
      return rec
    },
    session: (id: SessionId) => sessions.get(id),
    createdMeta: (id: string): unknown => metaById.get(id),
    agents: {
      create: (opts: { sessionId: SessionId; meta?: unknown }) => { metaById.set(opts.sessionId, opts.meta); return Promise.resolve(track(opts.sessionId)) },
      resume: (opts: { resumeSessionId: SessionId }) => Promise.resolve(track(opts.resumeSessionId)),
    } as never,
  }
}

function textOf(message: UserMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('LoomAgentRuntime.executeTransition', () => {
  it('disposes the old generation, creates the successor chained to its predecessor, commits the pointer, and delivers handoff before carried input', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      const reg = trackAgents()
      const runtime = new LoomAgentRuntime({
        agents: reg.agents,
        runtimeState,
        workspace: '/ws',
        newSessionId: () => SessionId('s0'),
      })
      await runtime.boot()
      expect(runtime.current()?.id).toBe(SessionId('s0'))

      const carried = createUserMessage({ content: [{ type: 'text', text: 'do this next' }], source: { kind: 'user' } })
      const plan: TransitionPlan = {
        previousSessionId: SessionId('s0'),
        newSessionId: SessionId('s1'),
        handoff: 'HANDOFF-BODY',
        handoffEventSeq: 3,
        trigger: 'model',
        relatedFiles: [],
        requestId: 'req-1',
        carriedInput: [carried],
      }
      await runtime.executeTransition(plan)

      expect(reg.agent('s0').disposed).toBe(true)
      expect(runtime.current()?.id).toBe(SessionId('s1'))
      // The pointer is just the live generation; lineage lives on the successor's session header.
      expect(runtimeState.getCurrentSession()).toEqual({ sessionId: 's1' })
      // The successor is chained to its predecessor via parentSession — the field the
      // context-continuity engine walks to reach prior generations.
      expect(reg.createdMeta('s1')).toEqual({ cwd: '/ws', parentSession: SessionId('s0') })

      const s1 = reg.agent('s1')
      expect(s1.order).toEqual(['steer', 'followup'])
      expect(s1.steered).toHaveLength(1)
      expect(textOf(s1.steered[0]!)).toContain('HANDOFF-BODY')
      expect(s1.followed).toEqual([carried])
    } finally {
      await dispose()
    }
  })
})

describe('LoomAgentRuntime.deliver', () => {
  it('submits external text at the requested inbox boundary', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      const reg = trackAgents()
      const runtime = new LoomAgentRuntime({
        agents: reg.agents,
        runtimeState,
        workspace: '/ws',
        newSessionId: () => SessionId('s0'),
      })
      await runtime.boot()

      expect(runtime.deliver('into this turn', 'steer')).toBe(true)
      expect(runtime.deliver('its own turn', 'followup')).toBe(true)

      const s0 = reg.agent('s0')
      expect(s0.order).toEqual(['steer', 'followup'])
      expect(textOf(s0.steered[0]!)).toBe('into this turn')
      expect(textOf(s0.followed[0]!)).toBe('its own turn')
    } finally {
      await dispose()
    }
  })

  it('refuses when there is no live agent to receive the text', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      const reg = trackAgents()
      const runtime = new LoomAgentRuntime({
        agents: reg.agents,
        runtimeState,
        workspace: '/ws',
        newSessionId: () => SessionId('s0'),
      })
      expect(runtime.deliver('nobody home', 'steer')).toBe(false)
    } finally {
      await dispose()
    }
  })
})

/**
 * The individual runs unrestricted; the stance is stated in agent-runtime code, so it reaches the
 * session on activation (a deployment default only reaches sessions created after it changes).
 */
describe('LoomAgentRuntime sandbox pin', () => {
  function runtimeWith(
    reg: { agents: ConstructorParameters<typeof LoomAgentRuntime>[0]['agents'] },
    runtimeState: RuntimeState,
  ) {
    return new LoomAgentRuntime({
      agents: reg.agents,
      runtimeState,
      workspace: '/ws',
      newSessionId: () => SessionId('s0'),
    })
  }

  it('pins danger-full-access on a session that carries no mode yet', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      const reg = fakeAgents()
      await runtimeWith(reg, runtimeState).boot()
      expect(reg.session(SessionId('s0'))?.modes()).toEqual(['danger-full-access'])
    } finally {
      await dispose()
    }
  })

  it('re-pins a session still on the deployment default', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      await runtimeState.setCurrentSession({ sessionId: 's-live' })
      const reg = fakeAgents(['workspace-write'])
      await runtimeWith(reg, runtimeState).boot()
      expect(reg.session(SessionId('s-live'))?.modes()).toEqual(['workspace-write', 'danger-full-access'])
    } finally {
      await dispose()
    }
  })

  it('leaves an already-pinned session alone, so a boot adds no redundant event', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      await runtimeState.setCurrentSession({ sessionId: 's-live' })
      const reg = fakeAgents(['danger-full-access'])
      await runtimeWith(reg, runtimeState).boot()
      expect(reg.session(SessionId('s-live'))?.modes()).toEqual(['danger-full-access'])
    } finally {
      await dispose()
    }
  })

  it('pins the rollover successor as well', async () => {
    const { runtimeState, dispose } = await realRuntimeState()
    try {
      const reg = trackAgents()
      const runtime = runtimeWith(reg, runtimeState)
      await runtime.boot()
      await runtime.executeTransition({
        previousSessionId: SessionId('s0'),
        newSessionId: SessionId('s1'),
        handoff: 'HANDOFF-BODY',
        handoffEventSeq: 3,
        trigger: 'model',
        relatedFiles: [],
        requestId: 'req-1',
        carriedInput: [],
      })
      expect(reg.session(SessionId('s1'))?.modes()).toEqual(['danger-full-access'])
    } finally {
      await dispose()
    }
  })
})
