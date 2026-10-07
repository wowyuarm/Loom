/**
 * Shared service contracts. Implementations live in their own plugins; consumers inject a
 * service by key and depend only on these interfaces, never on a concrete plugin. The ctx
 * augmentation lives here (not in any implementation) so an alternative plugin can provide the
 * same service and be swapped in without touching consumers.
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The single time source. Loom's own code reads "now" here instead of calling Date.now(). */
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

/**
 * One outbound action the agent took toward the external world, recorded across its attempt so a
 * crash mid-send leaves recoverable evidence. `message` is the only kind in v1; `kind` is the
 * forward-compatible hook for later kinds (e.g. an external subscription), added mechanically then.
 *
 * Status is deliberately three-valued with no `not_sent`: a channel send either returns a result
 * or throws, and a throw cannot distinguish "never left" from "sent but the ack was lost", so a
 * throw is recorded as `unknown` (conservative — never claim not-sent and let the agent double-send).
 * `pending` is a send that was never resolved, i.e. a crash between the durable record and the send
 * completing.
 */
export interface DeliveryEffect {
  /** Stable id minted when the effect is recorded; the key and the event/idempotency handle. */
  effectId: string
  /** The action kind. Only `'message'` in v1. */
  kind: string
  channel: string
  route: string
  text: string
  status: 'pending' | 'delivered' | 'unknown'
  /** The provider's message id, present once `delivered`. */
  remoteId?: string | undefined
  /** The send failure, present once `unknown`. */
  error?: string | undefined
  /** epoch ms the effect was recorded, from the Clock. */
  createdAt: number
  /** epoch ms the effect resolved to delivered/unknown, from the Clock; absent while pending. */
  resolvedAt?: number | undefined
}

/** The pending effect a caller records before attempting delivery. */
export type PendingEffect = Pick<DeliveryEffect, 'effectId' | 'kind' | 'channel' | 'route' | 'text' | 'createdAt'>

/** The terminal outcome a caller writes back after a delivery attempt. */
export type DeliveryOutcome =
  | { status: 'delivered'; remoteId: string; resolvedAt: number }
  | { status: 'unknown'; error: string; resolvedAt: number }

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
 * Durable local state for one deployment: the current-session pointer, the accepted-input
 * dedup ledger, and the owned-session ledger. Kept outside the session log and the workspace
 * files.
 */
export interface RuntimeState {
  getCurrentSession(): CurrentSession | undefined
  setCurrentSession(session: CurrentSession): Promise<void>
  isAccepted(channel: string, providerMessageId: string): boolean
  recordAccepted(input: AcceptedInput): Promise<void>
  /**
   * Record one session id this deployment created. This is the search-authorization set: every
   * generation the subject ever lived in, including archived branches a checkpoint return left
   * off the active lineage. The active lineage is walkable from `parentSession` headers, but an
   * off-lineage branch is reachable only from this ledger.
   */
  recordSession(sessionId: string): Promise<void>
  /** Every session id this deployment created; the range `context_search` is authorized over. */
  ownedSessions(): string[]
  /**
   * Record one outbound effect as `pending` before its delivery is attempted; the resolve of this
   * write is the durable barrier a crash mid-send falls back to. Keyed by `effectId`.
   */
  recordEffect(effect: PendingEffect): Promise<void>
  /** Write back a recorded effect's terminal delivery outcome; returns the resolved record. */
  resolveEffect(effectId: string, outcome: DeliveryOutcome): Promise<DeliveryEffect>
  /**
   * Outbound effects whose delivery is still uncertain: `pending` or `unknown`, and not superseded
   * by a later `delivered` effect on the same (channel, route). This is the reconciliation set the
   * wake context names; a later successful send on the same conversation clears it on its own.
   */
  uncertainDeliveries(): DeliveryEffect[]
}

/**
 * Attribution id of the after-interaction plugin's own content: the situation it hands the agent when a
 * pause looks worth picking up. It sits here rather than in that plugin because two modules must
 * agree on it — the producer stamps it, and the continuity host classifies it.
 */
export const AFTER_INTERACTION_SOURCE_KIND = '@loom/after-interaction'

/**
 * Source kinds whose content is about a moment rather than a fact: an observation that was true
 * when it was written and that a successor generation should rederive from its own log instead of
 * inheriting as text. The continuity host answers `isEphemeralNotice` from this list, and each
 * producer stamps its own content with the same entry.
 */
export const ephemeralNoticeSourceKinds: readonly string[] = [AFTER_INTERACTION_SOURCE_KIND]

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** One outbound effect reached a terminal delivery status. A future followup/projection subscribes here. */
    'loom/delivery'(effect: DeliveryEffect): void
  }
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
   * Submit external text to the live agent as steering — the next step boundary. An idle agent
   * opens a turn with it; a running agent consumes it at its next step, so a message arriving
   * mid-tool-call waits for that call to finish rather than interrupting it. Returns false when
   * there is no live agent to receive it (before boot, or after disposal).
   *
   * There is deliberately no target parameter. External input is always steering: a turn ends
   * when the model owes no further response, never because it happened to send a message, so
   * nothing here can decide a turn is closed and hold the person's next words for a later turn.
   * Owning input delivery here keeps the single agent handle's whole lifecycle — boot, rollover
   * carry, external input — in one place.
   */
  deliver(text: string): boolean
}

export type { SessionId }
