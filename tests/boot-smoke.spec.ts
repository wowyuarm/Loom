import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
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
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

interface Loom {
  ctx: Context
  mock: MockAdapter
  workspace: string
  /** Preset ids the agent joined during its creation window. */
  presetsMounted: string[]
  dispose: () => Promise<void>
}

async function writeWorkspaceFile(workspace: string, rel: string, text: string): Promise<void> {
  const path = join(workspace, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** Compose the full stack over a mock model and boot Loom's single agent via agent-runtime. */
async function bootLoom(mock: MockAdapter): Promise<Loom> {
  const workspace = await mkdtemp(join(tmpdir(), 'loom-smoke-'))
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
  await load(ClockPlugin)
  await load(RuntimeStatePlugin)
  await load(ResidentContextPlugin, { workspace })
  const presetsMounted = provideFakePresets(ctx)
  await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })

  await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })
  return {
    ctx,
    mock,
    workspace,
    presetsMounted,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

describe('loom boot smoke', () => {
  it('boots the agent, records the pointer, and runs one turn against the resident context', async () => {
    const loom = await bootLoom(new MockAdapter([textResponse('hello back')]))
    try {
      await writeWorkspaceFile(loom.workspace, 'identity/identity.md', 'I am the test agent.')

      // The pointer was written for the freshly created session.
      const pointer = loom.ctx.runtimeState.getCurrentSession()
      expect(pointer).toBeDefined()

      // The agent joined its preset inside the creation window, before it was published — the
      // point at which the roster installs the tools and prompt sections the model will see.
      expect(loom.presetsMounted).toHaveLength(1)

      const agent = loom.ctx.agentRuntime.current()
      expect(agent).toBeDefined()
      expect(agent?.id).toBe(pointer?.sessionId)

      // The resident-context projection is wired into this composed context: identity is an
      // always-present system section read fresh from its file.
      const assembly = await loom.ctx.systemPrompt.assemble()
      const identity = assembly.sections.find(s => s.name === 'loom:identity')
      expect(identity?.text).toContain('I am the test agent.')

      // One real turn runs end to end against the mock model.
      agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent?.whenIdle()
      expect(loom.mock.requests).toHaveLength(1)
      expect(agent?.status).toBe('idle')
    } finally {
      await loom.dispose()
    }
  })

  it('lets the model write a memory note through the memory_write tool', async () => {
    const loom = await bootLoom(new MockAdapter([
      toolCallResponse('c1', 'memory_write', { concept: 'alpha', body: 'a durable note' }),
      textResponse('noted'),
    ]))
    try {
      const agent = loom.ctx.agentRuntime.current()
      agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'remember alpha' }], source: { kind: 'user' } }))
      await agent?.whenIdle()

      const note = await readFile(join(loom.workspace, 'memory/notes/alpha.md'), 'utf8')
      expect(note).toContain('a durable note')
      expect(loom.mock.requests.length).toBeGreaterThanOrEqual(2)
    } finally {
      await loom.dispose()
    }
  })

  it('rolls the context over to a fresh session when the model calls context_rollover, carrying lineage', async () => {
    const loom = await bootLoom(new MockAdapter([
      toolCallResponse('c1', 'context_rollover', { handoff: 'Continue as the same agent in a fresh context; nothing was rolled back.' }),
      textResponse('rolling over'),
      textResponse('fresh start'),
      textResponse('ok'),
    ]))
    try {
      const original = loom.ctx.runtimeState.getCurrentSession()?.sessionId
      expect(original).toBeDefined()

      const agent = loom.ctx.agentRuntime.current()
      agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'please roll over' }], source: { kind: 'user' } }))

      // The swap settles asynchronously at the idle boundary after the triggering turn ends.
      await vi.waitFor(() => {
        expect(loom.ctx.runtimeState.getCurrentSession()?.sessionId).not.toBe(original)
      }, { timeout: 5000 })

      const after = loom.ctx.runtimeState.getCurrentSession()
      expect(after?.sessionId).toMatch(/^loom-rollover-/)
      expect(loom.ctx.agentRuntime.current()?.id).toBe(after?.sessionId)

      // Lineage lives on the successor's session header, not the pointer: the context-continuity
      // engine walks parentSession to reach prior generations.
      const header = loom.ctx.agentRuntime.current()?.session.header as { parentSession?: string } | undefined
      expect(header?.parentSession).toBe(original)

      // The successor joined the same preset, so a rolled-over agent keeps the tools its
      // predecessor had rather than waking up with an empty catalog.
      expect(loom.presetsMounted).toHaveLength(2)
    } finally {
      await loom.dispose()
    }
  })

  it('returns to a checkpoint: a rollover citing a restorable ref seeds the successor with the prefix', async () => {
    const mock = new MockAdapter([
      toolCallResponse('ck1', 'context_checkpoint', { name: 'before risk' }),
      textResponse('checkpoint recorded'),
    ])
    const loom = await bootLoom(mock)
    try {
      const s0 = loom.ctx.runtimeState.getCurrentSession()?.sessionId
      expect(s0).toBeDefined()
      const agent = loom.ctx.agentRuntime.current()
      agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'checkpoint please' }], source: { kind: 'user' } }))
      await agent?.whenIdle()

      // The checkpoint resolved at the turn end; its ref is derived from the recording session
      // and the tool call id, the same rule recordCheckpoint used.
      const ref = `loom-checkpoint-${createHash('sha256').update(JSON.stringify([s0, 'ck1'])).digest('hex')}`

      // The model returns to it. The rollover response is enqueued now that s0 (and thus the ref)
      // is known.
      mock.enqueue(
        toolCallResponse('rb1', 'context_rollover', { handoff: 'returning to before the risky phase', checkpointRef: ref }),
        textResponse('returning'),
        textResponse('resumed'),
        textResponse('ok'),
      )
      loom.ctx.agentRuntime.current()?.followup(createUserMessage({ content: [{ type: 'text', text: 'return to before risk' }], source: { kind: 'user' } }))

      await vi.waitFor(() => {
        expect(loom.ctx.runtimeState.getCurrentSession()?.sessionId).not.toBe(s0)
      }, { timeout: 5000 })

      // A checkpoint return seeds the successor with the exact prefix and parents at the
      // checkpoint's source generation, unlike a fresh rollover which seeds nothing.
      const successor = loom.ctx.agentRuntime.current()
      expect(Number(successor?.session.inheritedEventCount)).toBeGreaterThan(0)
      const header = successor?.session.header as { parentSession?: string; isSeeded?: boolean } | undefined
      expect(header?.parentSession).toBe(s0)
      expect(header?.isSeeded).toBe(true)
    } finally {
      await loom.dispose()
    }
  })
})
