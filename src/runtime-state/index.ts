import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { AcceptedInput, CurrentSession, RuntimeState } from '../contracts/index.ts'
import { acceptedInputKey, runtimeStateDomain } from './domain.ts'

/**
 * Provides `ctx.runtimeState` over storage-domain. Write atomicity and crash recovery come
 * from the backend; this service only maps the two facts onto the domain.
 */
class RuntimeStateService implements RuntimeState {
  constructor(private readonly domain: Domain<typeof runtimeStateDomain>) {}

  getCurrentSession(): CurrentSession | undefined {
    return this.domain.global.get().current
  }

  async setCurrentSession(session: CurrentSession): Promise<void> {
    await this.domain.global.set({ current: session })
  }

  isAccepted(channel: string, providerMessageId: string): boolean {
    return this.domain.table('accepted_input').get(acceptedInputKey(channel, providerMessageId)) !== undefined
  }

  async recordAccepted(input: AcceptedInput): Promise<void> {
    await this.domain.table('accepted_input').put(acceptedInputKey(input.channel, input.providerMessageId), input)
  }

  async recordSession(sessionId: string): Promise<void> {
    await this.domain.table('owned_session').put(sessionId, { sessionId })
  }

  ownedSessions(): string[] {
    return [...this.domain.table('owned_session').keys()]
  }
}

export const name = 'runtime-state'
export const inject = ['storageDomain']

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(runtimeStateDomain)
  ctx.provide('runtimeState', new RuntimeStateService(domain))
  ctx.effect(() => async () => { await domain.close() }, 'runtime-state.close')
}

export { runtimeStateDomain } from './domain.ts'
