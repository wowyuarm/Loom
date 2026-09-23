import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  LOOM_SUBJECT_ID,
  LoomContextContinuityHost,
  type LoomContinuityOptions,
} from '../src/continuity/host.ts'

function host(overrides: Partial<LoomContinuityOptions> = {}): LoomContextContinuityHost {
  return new LoomContextContinuityHost({
    agentForSubject: () => undefined,
    sessionForAgent: () => undefined,
    projectionForSubject: () => undefined,
    executeTransition: () => Promise.resolve(),
    log: () => {},
    ...overrides,
  })
}

describe('rolloverIdentity', () => {
  it('is deterministic so crash replay converges on one operation', () => {
    const a = host().rolloverIdentity(SessionId('s-prev'), 'call-1')
    const b = host().rolloverIdentity(SessionId('s-prev'), 'call-1')
    expect(a).toEqual(b)
  })

  it('names the successor session and request id from the digest', () => {
    const id = host().rolloverIdentity(SessionId('s-prev'), 'call-1')
    expect(id.newSessionId).toMatch(/^loom-rollover-[0-9a-f]{64}$/)
    expect(id.requestId).toMatch(/^loom:rollover:[0-9a-f]{64}$/)
  })

  it('distinguishes different tool calls', () => {
    const a = host().rolloverIdentity(SessionId('s-prev'), 'call-1')
    const b = host().rolloverIdentity(SessionId('s-prev'), 'call-2')
    expect(a.newSessionId).not.toBe(b.newSessionId)
  })

  it('does not alias across the two unconstrained fields (JSON-encoded key)', () => {
    const a = host().rolloverIdentity(SessionId('a'), 'bc')
    const b = host().rolloverIdentity(SessionId('ab'), 'c')
    expect(a.newSessionId).not.toBe(b.newSessionId)
  })
})

describe('isEphemeralNotice', () => {
  it('carries every queued message in v1 (returns false)', () => {
    expect(host().isEphemeralNotice({} as UserMessage)).toBe(false)
  })
})

describe('subject resolution delegates to the lifecycle', () => {
  it('binds the live agent to the single subject and its session', () => {
    const agent = { id: SessionId('s-live') } as Agent
    const h = host({
      agentForSubject: () => agent,
      sessionForAgent: a => (a === agent ? SessionId('s-live') : undefined),
    })
    expect(h.agentForSubject(LOOM_SUBJECT_ID)).toBe(agent)
    expect(h.subjectForAgent(agent)).toEqual({ id: LOOM_SUBJECT_ID, sessionId: SessionId('s-live') })
  })

  it('reports no subject when the agent is not bound to a session', () => {
    expect(host().subjectForAgent({ id: SessionId('x') } as Agent)).toBeUndefined()
  })
})
