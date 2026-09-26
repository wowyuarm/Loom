import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { LoomPressureHost } from '../src/context-continuity/pressure.ts'
import { contextBudgetFrom } from '../src/context-continuity/retrieval.ts'

/** A minimal live agent: only what the pressure host reads. */
function fakeAgent(overrides: Partial<{ generation: number; steer: (m: unknown) => void }> = {}): Agent {
  const steer = overrides.steer ?? (() => {})
  return {
    steer,
    session: {
      id: 'loom-s0',
      inheritedEventCount: 0,
      snapshotEvents: () => [],
      surface: { replaceGeneration: overrides.generation ?? 3 },
    },
  } as unknown as Agent
}

describe('LoomPressureHost', () => {
  it('maps the context budget to pressure limits, and reports unknown when the budget is unknown', async () => {
    const agent = fakeAgent()
    const withBudget = new LoomPressureHost({
      agentForSubject: () => agent,
      budgetOf: () => Promise.resolve(contextBudgetFrom(1_000, 128_000)),
      measure: () => 1_000,
      compactionFor: () => undefined,
    })
    const limits = await withBudget.limitsFor()
    expect(limits).toEqual({ usageTokens: 1_000, hardLimit: 128_000 - 16_000, handoffAt: 128_000 - 24_000 })

    // A route whose capacity cannot be priced yields no limits — the policy fails closed on it.
    const unknown = new LoomPressureHost({
      agentForSubject: () => agent,
      budgetOf: () => Promise.resolve(undefined),
      measure: () => undefined,
      compactionFor: () => undefined,
    })
    expect(await unknown.limitsFor()).toBeUndefined()
  })

  it('binds the reduction capability to the current agent', async () => {
    const agent = fakeAgent()
    const compactIfNeeded = vi.fn<CompactionEngine['compactIfNeeded']>(() => Promise.resolve(null))
    const host = new LoomPressureHost({
      agentForSubject: () => agent,
      budgetOf: () => Promise.resolve(undefined),
      measure: () => undefined,
      compactionFor: () => ({ compactIfNeeded } as unknown as CompactionEngine),
    })
    const signal = new AbortController().signal
    await host.compactionFor()?.reduce('context-overflow', signal)
    expect(compactIfNeeded).toHaveBeenCalledWith(agent, 'context-overflow', signal)
  })

  it('reads the durable replacement generation and measured tokens for the reduction proof', () => {
    const host = new LoomPressureHost({
      agentForSubject: () => fakeAgent({ generation: 7 }),
      budgetOf: () => Promise.resolve(undefined),
      measure: () => 4_242,
      compactionFor: () => undefined,
    })
    expect(host.surfaceFor()).toEqual({ generation: 7, tokens: 4_242 })
  })

  it('steers the engine-built notice into the live agent for durable delivery', () => {
    const steer = vi.fn()
    const host = new LoomPressureHost({
      agentForSubject: () => fakeAgent({ steer }),
      budgetOf: () => Promise.resolve(undefined),
      measure: () => undefined,
      compactionFor: () => undefined,
    })
    const notice = { role: 'user' } as never
    host.steer('loom', notice)
    expect(steer).toHaveBeenCalledWith(notice)
  })
})
