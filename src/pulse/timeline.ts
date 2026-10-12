import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { PULSE_SOURCE_KIND, AFTER_INTERACTION_SOURCE_KIND } from '../contracts/index.ts'

export const PULSE_TIMELINE_KEY = 'loomPulseTimeline'

export const turnRecordSchema = z.object({
  sessionId: z.string(),
  turn: z.number(),
  endedAt: z.number(),
  reason: z.string(),
  sources: z.array(z.string()),
  tools: z.array(z.string()),
  toolErrors: z.number(),
  messageAttempts: z.number(),
  messageSuccesses: z.number(),
})
export type TurnRecord = z.infer<typeof turnRecordSchema>

export interface PulseTimeline {
  sessionId: string
  lastActivityTime: number | null
  lastHumanInputTime: number | null
  turn: number
  sources: string[]
  tools: string[]
  toolErrors: number
  messageCalls: string[]
  messageSuccesses: number
  lastTurn?: TurnRecord | undefined
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { loomPulseTimeline: PulseTimeline }
}

export function emptyTimeline(): PulseTimeline {
  return { sessionId: '', lastActivityTime: null, lastHumanInputTime: null, turn: 0, sources: [], tools: [],
    toolErrors: 0, messageCalls: [], messageSuccesses: 0, lastTurn: undefined }
}

export function applyPulseTimelineEvent(state: PulseTimeline, event: SessionEvent): PulseTimeline {
  switch (event.type) {
    case 'turn/start':
      return { ...state, turn: event.data.turn, sources: [], tools: [], toolErrors: 0,
        messageCalls: [], messageSuccesses: 0 }
    case 'user/message': {
      const kind = event.data.source.kind
      if (kind !== 'user' && kind !== PULSE_SOURCE_KIND && kind !== AFTER_INTERACTION_SOURCE_KIND) return state
      return { ...state, sources: state.sources.includes(kind) ? state.sources : [...state.sources, kind],
        lastHumanInputTime: kind === 'user' ? event.time : state.lastHumanInputTime }
    }
    case 'tool/call':
      return { ...state, tools: state.tools.includes(event.data.name) ? state.tools : [...state.tools, event.data.name],
        messageCalls: event.data.name === 'message' ? [...state.messageCalls, event.data.callId] : state.messageCalls }
    case 'tool/result': {
      const result = event.data.message
      return { ...state, toolErrors: state.toolErrors + (result.isError ? 1 : 0),
        messageSuccesses: state.messageSuccesses + (!result.isError && state.messageCalls.includes(result.toolCallId) ? 1 : 0) }
    }
    case 'turn/end':
      return { ...state, lastActivityTime: event.time,
        lastTurn: { sessionId: state.sessionId, turn: event.data.turn, endedAt: event.time, reason: event.data.reason.kind,
          sources: state.sources, tools: state.tools, toolErrors: state.toolErrors,
          messageAttempts: state.messageCalls.length, messageSuccesses: state.messageSuccesses } }
    default:
      // Other Session events do not establish activity or a tool outcome.
      return state
  }
}

export const pulseTimelineProjection: ProjectionDefinition<typeof PULSE_TIMELINE_KEY, PulseTimeline> = {
  key: PULSE_TIMELINE_KEY,
  stateSchema: z.object({ sessionId: z.string(), lastActivityTime: z.number().nullable(), lastHumanInputTime: z.number().nullable(),
    turn: z.number(), sources: z.array(z.string()), tools: z.array(z.string()), toolErrors: z.number(),
    messageCalls: z.array(z.string()), messageSuccesses: z.number(), lastTurn: turnRecordSchema.optional() }),
  init: header => ({ ...emptyTimeline(), sessionId: String(header.id) }),
  apply: applyPulseTimelineEvent,
  stateVersion: 1,
}

export function registerPulseTimelineProjection(ctx: Context): void {
  ctx.effect(() => ctx.sessionProjections.register(pulseTimelineProjection), 'pulse.timeline')
}

export function dueAt(timeline: { lastActivityTime: number | null; lastCheckTime: number | null },
  silenceWindowMs: number, cadenceMs: number): number | null {
  if (timeline.lastActivityTime === null) return null
  return Math.max(timeline.lastActivityTime + silenceWindowMs,
    timeline.lastCheckTime === null ? -Infinity : timeline.lastCheckTime + cadenceMs)
}
