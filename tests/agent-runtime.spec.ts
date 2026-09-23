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
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import { bootAgent } from '../src/agent-runtime/boot.ts'
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

function fakeAgents() {
  const created: { sessionId: SessionId }[] = []
  const resumed: { resumeSessionId: SessionId }[] = []
  const handle = (id: SessionId): AgentHandle => ({ agent: { id } as AgentHandle['agent'], dispose: () => Promise.resolve() })
  return {
    created,
    resumed,
    agents: {
      create: (opts: { sessionId: SessionId }) => { created.push(opts); return Promise.resolve(handle(opts.sessionId)) },
      resume: (opts: { resumeSessionId: SessionId }) => { resumed.push(opts); return Promise.resolve(handle(opts.resumeSessionId)) },
    } as never,
  }
}

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
