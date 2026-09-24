/**
 * Shared service contracts. Implementations live in their own plugins; consumers inject a
 * service by key and depend only on these interfaces, never on a concrete plugin. The ctx
 * augmentation lives here (not in any implementation) so an alternative plugin can provide the
 * same service and be swapped in without touching consumers.
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The single time source. Everything reads "now" here instead of calling Date.now() directly. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number
}

/**
 * The session the agent is currently bound to. Just the id: this is the "which generation is
 * live now" pointer. Rollover lineage is not kept here — it lives on each successor session's
 * `parentSession` header, which is where the context-continuity engine walks it.
 */
export interface CurrentSession {
  sessionId: string
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
    agentRuntime: AgentRuntime
  }
}

/**
 * The one live agent of a deployment. Boot resumes it from the runtime-state pointer or creates
 * a first one; consumers (channels, continuity) reach the current agent through this.
 */
export interface AgentRuntime {
  /** The live agent, or undefined before boot completes or after disposal. */
  current(): Agent | undefined
  /**
   * Submit external text to the live agent as a new-turn followup. Returns false when there is
   * no live agent to receive it (before boot, or after disposal). Owning input delivery here
   * keeps the single agent handle's whole lifecycle — boot, rollover carry, external input — in
   * one place.
   */
  deliver(text: string): boolean
}

export type { SessionId }
