/**
 * Shared service contracts. Implementations live in their own plugins; consumers inject a
 * service by key and depend only on these interfaces, never on a concrete plugin. The ctx
 * augmentation lives here (not in any implementation) so an alternative plugin can provide the
 * same service and be swapped in without touching consumers.
 */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The single time source. Everything reads "now" here instead of calling Date.now() directly. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number
}

/** The session the agent is currently bound to, with its rollover lineage. */
export interface CurrentSession {
  sessionId: string
  parentLineage?: string[] | undefined
}

/** One external Input durably accepted before it was handed to the agent. */
export interface AcceptedInput {
  channel: string
  providerMessageId: string
  actor: string
  place: string
  visibility: string
  route: string
  /** epoch ms, supplied by the caller from the Clock — the store never reads time itself. */
  acceptedAt: number
}

/**
 * Durable local state for one deployment: the current-session pointer and the accepted-input
 * dedup ledger. Kept outside the session log and the workspace files.
 */
export interface RuntimeState {
  getCurrentSession(): CurrentSession | undefined
  setCurrentSession(session: CurrentSession): Promise<void>
  isAccepted(channel: string, providerMessageId: string): boolean
  recordAccepted(input: AcceptedInput): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    clock: Clock
    runtimeState: RuntimeState
  }
}

export type { SessionId }
