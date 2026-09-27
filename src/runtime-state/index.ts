import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {
  AcceptedInput,
  CurrentSession,
  DeliveryEffect,
  DeliveryOutcome,
  PendingEffect,
  RuntimeState,
} from '../contracts/index.ts'
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

  async recordEffect(effect: PendingEffect): Promise<void> {
    await this.domain.table('effect').put(effect.effectId, { ...effect, status: 'pending' })
  }

  async resolveEffect(effectId: string, outcome: DeliveryOutcome): Promise<DeliveryEffect> {
    const table = this.domain.table('effect')
    const current = table.get(effectId) as DeliveryEffect | undefined
    if (current === undefined) throw new Error(`resolveEffect: no effect ${effectId}`)
    const resolved = { ...current, ...outcome }
    await table.put(effectId, resolved)
    return resolved
  }

  uncertainDeliveries(): DeliveryEffect[] {
    const effects = [...this.domain.table('effect').entries()].map(([, effect]) => effect as DeliveryEffect)
    // A later delivered effect on the same conversation clears an earlier uncertain one: the
    // channel is working and the agent is active there, so the old uncertainty is moot.
    const latestDelivered = new Map<string, number>()
    for (const effect of effects) {
      if (effect.status !== 'delivered') continue
      const key = conversationKey(effect)
      const seen = latestDelivered.get(key)
      if (seen === undefined || effect.createdAt > seen) latestDelivered.set(key, effect.createdAt)
    }
    return effects
      .filter(effect => effect.status !== 'delivered')
      .filter(effect => (latestDelivered.get(conversationKey(effect)) ?? -Infinity) <= effect.createdAt)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
}

function conversationKey(effect: DeliveryEffect): string {
  return JSON.stringify([effect.channel, effect.route])
}

export const name = 'runtime-state'
export const inject = ['storageDomain']

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(runtimeStateDomain)
  ctx.provide('runtimeState', new RuntimeStateService(domain))
  ctx.effect(() => async () => { await domain.close() }, 'runtime-state.close')
}

export { runtimeStateDomain } from './domain.ts'
