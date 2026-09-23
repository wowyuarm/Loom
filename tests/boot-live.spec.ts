import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'

const hasKey = (process.env.DEEPSEEK_API_KEY ?? '') !== ''

// Runs only with a real DEEPSEEK_API_KEY in the environment; skipped otherwise so the default
// suite stays offline and deterministic. `export DEEPSEEK_API_KEY=...` then `npx vitest run boot-live`.
describe.skipIf(!hasKey)('loom boot live (real DeepSeek)', () => {
  it('boots against llm-deepseek and completes one real turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'loom-live-'))
    const ctx = new Context()
    const fibers: Fiber[] = []
    const load = async (plugin: unknown, config?: unknown): Promise<void> => {
      fibers.push(await ctx.plugin(plugin as never, config as never))
    }
    try {
      await load(LlmRuntime)
      await load(SessionStore)
      await load(SessionProjectionRegistry)
      await load(SystemPrompt)
      await load(ToolRuntime)
      await load(AgentRegistry)
      await load(AgentLoop, { agents: [] })
      await load(Storage)
      await load(StorageSqlite, { path: ':memory:' })
      await load(StorageDomain, { backend: 'sqlite' })
      await load(LlmDeepSeek, {})
      await load(ClockPlugin)
      await load(RuntimeStatePlugin)
      await load(ResidentContextPlugin, { workspace })
      await load(AgentRuntimePlugin, {
        workspace,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
      })

      await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })
      const agent = ctx.agentRuntime.current()
      agent?.followup(createUserMessage({
        content: [{ type: 'text', text: 'Reply with the single word: pong.' }],
        source: { kind: 'user' },
      }))
      await agent?.whenIdle()

      expect(agent?.status).toBe('idle')
      const events = agent?.session.snapshotEvents() ?? []
      // The real turn produced at least the inbound and a model response beyond it.
      expect(events.length).toBeGreaterThan(1)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  }, 60_000)
})
