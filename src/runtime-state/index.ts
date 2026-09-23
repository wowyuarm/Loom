import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  acceptedInputKey,
  runtimeStateDomain,
  type AcceptedInput,
  type CurrentSession,
} from './domain.ts'

/**
 * Durable local state for one Loom deployment. Two consumers inject it:
 * - the continuity module: read/write the currentSession pointer (inside executeTransition).
 * - the channels consumer: dedup and record accepted Inputs.
 *
 * Write atomicity and crash recovery come from storage-domain; this service only maps.
 */
export interface LoomState {
  /** Current session pointer; undefined when none exists yet. Synchronous read. */
  getCurrentSession(): CurrentSession | undefined
  /** Update the current session pointer, durable. Called at rollover commit. */
  setCurrentSession(session: CurrentSession): Promise<void>
  /** Whether this (channel, providerMessageId) was already accepted. Synchronous read, for dedup. */
  isAccepted(channel: string, providerMessageId: string): boolean
  /** Durably record one accepted Input. Must resolve before the Input is handed to the agent. */
  recordAccepted(input: AcceptedInput): Promise<void>
}

class LoomStateService implements LoomState {
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
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    loomState: LoomState
  }
}

export const name = 'loom-runtime-state'
export const inject = ['storageDomain']

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(runtimeStateDomain)
  ctx.provide('loomState', new LoomStateService(domain))
  ctx.effect(() => async () => { await domain.close() }, 'loom-runtime-state.close')
}

export type { SessionId }
export { runtimeStateDomain } from './domain.ts'
export type { AcceptedInput, CurrentSession } from './domain.ts'
