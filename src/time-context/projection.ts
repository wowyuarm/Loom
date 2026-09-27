/**
 * The clock baseline, folded as a session projection.
 *
 * The snapshot needs one fact that predates it: when the last model-visible thing happened. That
 * fact is derived state over the session log, and DSH's rule for new derived state is a
 * projection — the framework folds it incrementally over committed events, rebuilds it from the
 * log on resume, and checkpoints it as plain JSON (see the deprecate-synchronous-session-event-
 * reads Agent Note, which prohibits new production calls to `ownEvents`/`snapshotEvents`/
 * `eventAt`). Folding the log at each step would need one of those prohibited readers; carrying
 * it in a private store would be a second record of what the log already says.
 *
 * The fold starts at the empty log and sees every event the session carries, inherited prefix
 * included, so the baseline is whatever the log actually holds and nothing is invented: a
 * generation that inherited a seeded prefix measures from that prefix's last event, an unseeded
 * one starts with `null`.
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Side-effect import: pulls the `sessionProjections` Context augmentation from dsh-session-projection.
import '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** This plugin's projection key. Host-only: no client view is published for it. */
export const TIME_CONTEXT_KEY = 'loomTimeContext'

/** The clock baseline one session's log folds to. Plain JSON, so the framework can checkpoint it. */
export interface TimeContextState {
  /** Event time of the latest model-visible event in the log, or null before one lands. */
  lastEventTime: number | null
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    loomTimeContext: TimeContextState
  }
}

/**
 * Fold one committed session event into the clock baseline. Only events the model can see count:
 * a user message (the agent's input, including injected context), an assistant message, or a
 * tool result. Every other event returns the same state reference, which is the projection
 * framework's zero-work signal.
 */
export function applyTimeContextEvent(state: TimeContextState, event: SessionEvent): TimeContextState {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
      return state.lastEventTime === event.time ? state : { lastEventTime: event.time }
    default:
      return state
  }
}

export const timeContextProjection: ProjectionDefinition<typeof TIME_CONTEXT_KEY, TimeContextState> = {
  key: TIME_CONTEXT_KEY,
  stateSchema: z.object({ lastEventTime: z.number().nullable() }),
  init: () => ({ lastEventTime: null }),
  apply: applyTimeContextEvent,
  stateVersion: 1,
}

/**
 * Register the baseline fold. Mounted before the agent's session exists, so the fold covers the
 * log from its first event; the framework's lazy cell build covers it either way.
 */
export function registerTimeContextProjection(ctx: Context): void {
  ctx.effect(() => ctx.sessionProjections.register(timeContextProjection), 'time-context.projection')
}
