import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import type { AcceptedInput, RuntimeState } from '../src/contracts/index.ts'
interface Booted {
  loom: RuntimeState
  dispose: () => Promise<void>
}

async function boot(path: string): Promise<Booted> {
  const ctx = new Context()
  const fStorage = await ctx.plugin(Storage)
  const fSqlite = await ctx.plugin(StorageSqlite, { path })
  const fDomain = await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  const fLoom = await ctx.plugin(RuntimeStatePlugin)
  await vi.waitFor(() => { expect(ctx.runtimeState).toBeDefined() })
  const loom = ctx.runtimeState
  // Reverse-order teardown releases the sqlite medium so a later boot can reopen it.
  const dispose = async () => {
    await fLoom.dispose()
    await fDomain.dispose()
    await fSqlite.dispose()
    await fStorage.dispose()
  }
  return { loom, dispose }
}

function sampleInput(overrides: Partial<AcceptedInput> = {}): AcceptedInput {
  return {
    channel: 'telegram',
    providerMessageId: 'm-1',
    actor: 'user:alice',
    place: 'chat:42',
    visibility: 'direct',
    route: 'telegram:chat:42',
    acceptedAt: 1_000,
    ...overrides,
  }
}

describe('continuity store — currentSession pointer', () => {
  it('is absent until set, then round-trips the current-generation pointer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const { loom, dispose } = await boot(join(dir, 'continuity.sqlite'))
    try {
      expect(loom.getCurrentSession()).toBeUndefined()
      await loom.setCurrentSession({ sessionId: 's-1' })
      expect(loom.getCurrentSession()).toEqual({ sessionId: 's-1' })
      await loom.setCurrentSession({ sessionId: 's-2' })
      expect(loom.getCurrentSession()).toEqual({ sessionId: 's-2' })
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('continuity store — accepted-input dedup', () => {
  it('reports unseen inputs as not accepted and recorded inputs as accepted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const { loom, dispose } = await boot(join(dir, 'continuity.sqlite'))
    try {
      expect(loom.isAccepted('telegram', 'm-1')).toBe(false)
      await loom.recordAccepted(sampleInput())
      expect(loom.isAccepted('telegram', 'm-1')).toBe(true)
      // A different message id on the same channel is independent.
      expect(loom.isAccepted('telegram', 'm-2')).toBe(false)
      // Same message id on a different channel is independent (key includes channel).
      expect(loom.isAccepted('raft', 'm-1')).toBe(false)
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent: recording the same key twice stays accepted without error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const { loom, dispose } = await boot(join(dir, 'continuity.sqlite'))
    try {
      await loom.recordAccepted(sampleInput())
      await loom.recordAccepted(sampleInput({ acceptedAt: 2_000 }))
      expect(loom.isAccepted('telegram', 'm-1')).toBe(true)
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('continuity store — owned-session ledger', () => {
  it('accumulates every recorded session and is idempotent per id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const { loom, dispose } = await boot(join(dir, 'continuity.sqlite'))
    try {
      expect(loom.ownedSessions()).toEqual([])
      await loom.recordSession('s-0')
      await loom.recordSession('s-1')
      // An off-lineage branch and the active lineage both land in the same set.
      await loom.recordSession('s-branch')
      expect(new Set(loom.ownedSessions())).toEqual(new Set(['s-0', 's-1', 's-branch']))
      // Re-recording an id does not duplicate it.
      await loom.recordSession('s-0')
      expect(loom.ownedSessions()).toHaveLength(3)
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('continuity store — outbound effect ledger', () => {
  it('records a pending effect, resolves it delivered, and drops it from the uncertain set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const { loom, dispose } = await boot(join(dir, 'continuity.sqlite'))
    try {
      await loom.recordEffect({ effectId: 'e1', kind: 'message', channel: 'telegram', route: 'chat:42', text: 'hi', createdAt: 1_000 })
      // A pending effect is uncertain until it resolves.
      expect(loom.uncertainDeliveries().map(e => e.effectId)).toEqual(['e1'])
      const resolved = await loom.resolveEffect('e1', { status: 'delivered', remoteId: 'out-9', resolvedAt: 1_100 })
      expect(resolved).toMatchObject({ effectId: 'e1', status: 'delivered', remoteId: 'out-9' })
      expect(loom.uncertainDeliveries()).toEqual([])
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps an effect uncertain when the send is unknown or never resolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const { loom, dispose } = await boot(join(dir, 'continuity.sqlite'))
    try {
      // A send that threw: recorded unknown, still uncertain.
      await loom.recordEffect({ effectId: 'e1', kind: 'message', channel: 'telegram', route: 'chat:42', text: 'a', createdAt: 1_000 })
      await loom.resolveEffect('e1', { status: 'unknown', error: 'timeout', resolvedAt: 1_050 })
      // A crash mid-send: recorded pending, never resolved.
      await loom.recordEffect({ effectId: 'e2', kind: 'message', channel: 'telegram', route: 'chat:7', text: 'b', createdAt: 2_000 })
      expect(loom.uncertainDeliveries().map(e => e.effectId)).toEqual(['e1', 'e2'])
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clears an uncertain effect once a later send on the same conversation is delivered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const { loom, dispose } = await boot(join(dir, 'continuity.sqlite'))
    try {
      await loom.recordEffect({ effectId: 'e1', kind: 'message', channel: 'telegram', route: 'chat:42', text: 'a', createdAt: 1_000 })
      await loom.resolveEffect('e1', { status: 'unknown', error: 'timeout', resolvedAt: 1_050 })
      // A later delivered effect on the SAME (channel, route) supersedes the earlier uncertain one.
      await loom.recordEffect({ effectId: 'e2', kind: 'message', channel: 'telegram', route: 'chat:42', text: 'b', createdAt: 2_000 })
      await loom.resolveEffect('e2', { status: 'delivered', remoteId: 'out-2', resolvedAt: 2_100 })
      expect(loom.uncertainDeliveries()).toEqual([])
      // A delivered effect on a DIFFERENT route does not clear it.
      await loom.recordEffect({ effectId: 'e3', kind: 'message', channel: 'telegram', route: 'chat:9', text: 'c', createdAt: 3_000 })
      await loom.resolveEffect('e3', { status: 'unknown', error: 'timeout', resolvedAt: 3_050 })
      await loom.recordEffect({ effectId: 'e4', kind: 'message', channel: 'telegram', route: 'chat:42', text: 'd', createdAt: 4_000 })
      await loom.resolveEffect('e4', { status: 'delivered', remoteId: 'out-4', resolvedAt: 4_100 })
      expect(loom.uncertainDeliveries().map(e => e.effectId)).toEqual(['e3'])
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('recovers an uncertain effect after a restart on the same medium', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const path = join(dir, 'continuity.sqlite')
    try {
      const first = await boot(path)
      await first.loom.recordEffect({ effectId: 'e1', kind: 'message', channel: 'telegram', route: 'chat:42', text: 'a', createdAt: 1_000 })
      await first.loom.resolveEffect('e1', { status: 'unknown', error: 'timeout', resolvedAt: 1_050 })
      await first.dispose()

      const second = await boot(path)
      try {
        expect(second.loom.uncertainDeliveries().map(e => e.effectId)).toEqual(['e1'])
      } finally {
        await second.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('continuity store — durability across restart', () => {  it('recovers the pointer and dedup ledger after a fresh boot on the same medium', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-continuity-'))
    const path = join(dir, 'continuity.sqlite')
    try {
      const first = await boot(path)
      await first.loom.setCurrentSession({ sessionId: 's-live' })
      await first.loom.recordAccepted(sampleInput())
      await first.loom.recordSession('s-live')
      await first.dispose()

      const second = await boot(path)
      try {
        expect(second.loom.getCurrentSession()).toEqual({ sessionId: 's-live' })
        expect(second.loom.isAccepted('telegram', 'm-1')).toBe(true)
        expect(second.loom.ownedSessions()).toEqual(['s-live'])
      } finally {
        await second.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
