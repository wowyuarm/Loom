import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { ContextFormed, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PressureJudgement, PressureRelatedness } from '@wowyuarm/dsh-context-continuity'
import {
  createLoomPressurePolicy,
  LoomPressureHost,
  LOOM_SUBJECT_ID,
  type LoomPressureDeps,
} from '../src/context-continuity/pressure.ts'
import { contextBudgetFrom } from '../src/context-continuity/retrieval.ts'

/** The source the engine stamps its own steered messages with, so they are not the agent's input. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    '@loom/context-continuity': { kind: '@loom/context-continuity' } & ContextFormed
  }
}

/** A minimal live agent: only what the pressure host reads. */
function fakeAgent(
  overrides: Partial<{ generation: number; steer: (m: unknown) => void; messages: readonly UserMessage[] }> = {},
): Agent {
  const steer = overrides.steer ?? (() => {})
  return {
    steer,
    session: {
      id: 'loom-s0',
      inheritedEventCount: 0,
      snapshotEvents: () => [],
      surface: { replaceGeneration: overrides.generation ?? 3 },
      deriveMessages: () => overrides.messages ?? [],
    },
  } as unknown as Agent
}

/** Input the way the runtime delivers it: a user source, so it is the subject's own input. */
function userInput(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A producer notice: same user role, but the plugin's kind marks it as the machinery's own. */
function producerNotice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: '@loom/context-continuity', form: 'notice', summary: text },
  })
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

  it('refuses to steer a notice nobody can carry', () => {
    const host = new LoomPressureHost({
      agentForSubject: () => undefined,
      budgetOf: () => Promise.resolve(undefined),
      measure: () => undefined,
      compactionFor: () => undefined,
    })
    // Silently dropping the instruction would leave the engine believing it was delivered, so a
    // missing agent is a failure — the engine logs it and stays ungated rather than believing
    // otherwise.
    expect(() => host.steer(LOOM_SUBJECT_ID, producerNotice('context pressure'))).toThrow(/no live agent/)
  })

  it('offers the judge only when one is wired and a live agent is being admitted', () => {
    const judge = { decide: vi.fn() } as unknown as PressureJudgement
    const wired = new LoomPressureHost(depsWith({
      agentForSubject: () => fakeAgent(),
      judge: () => judge,
    }))
    expect(wired.judgeFor(LOOM_SUBJECT_ID)).toBe(judge)

    // No judge is a deployment choice, never a failure: the gate simply stays off.
    expect(new LoomPressureHost(depsWith({ agentForSubject: () => fakeAgent() })).judgeFor(LOOM_SUBJECT_ID)).toBeUndefined()
    // And there is nothing to judge for until an agent exists to admit input into.
    const dormant = new LoomPressureHost(depsWith({ agentForSubject: () => undefined, judge: () => judge }))
    expect(dormant.judgeFor(LOOM_SUBJECT_ID)).toBeUndefined()
  })

  it('scopes the admitted input to exactly one pre-step', async () => {
    const arriving = userInput('the arriving input')
    const earlier = userInput('an earlier input')
    let duringStep: PressureRelatedness | undefined
    const policy = createLoomPressurePolicy(depsWith({
      agentForSubject: () => fakeAgent({ messages: [earlier, arriving] }),
      budgetOf: () => {
        // The engine asks for its limits while the step is deciding — the only moment the
        // admitted input is readable, which is the whole reason this wrapper exists.
        duringStep = policy.host.relatednessFor(LOOM_SUBJECT_ID)
        return Promise.resolve(undefined)
      },
    }))

    await policy.onPreStep(LOOM_SUBJECT_ID, [arriving], new AbortController().signal)
    expect(duringStep).toEqual({ input: 'the arriving input', recent: ['an earlier input'] })

    // The window closes on the way out, so a later step can never read this one's input.
    expect(policy.host.relatednessFor(LOOM_SUBJECT_ID)).toBeUndefined()
    await policy.onPreStep(LOOM_SUBJECT_ID, [], new AbortController().signal)
    expect(policy.host.relatednessFor(LOOM_SUBJECT_ID)).toBeUndefined()
  })
})

/** Deps for a host that answers nothing by default; every test overrides only what it reads. */
function depsWith(overrides: Partial<LoomPressureDeps> = {}): LoomPressureDeps {
  return {
    agentForSubject: () => undefined,
    budgetOf: () => Promise.resolve(undefined),
    measure: () => undefined,
    compactionFor: () => undefined,
    ...overrides,
  }
}
