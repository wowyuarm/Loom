/**
 * The pause's own record: what was last said, and which turn the person opened.
 *
 * Both facts predate the check and both are derived from the session log, so they are folded as a
 * session projection rather than read back when the alarm fires — DSH's rule for new derived state
 * (see the deprecate-synchronous-session-event-reads Agent Note, which prohibits new production
 * calls to `ownEvents`/`snapshotEvents`/`eventAt`). The framework folds it incrementally over
 * committed events and rebuilds it from the log on resume, so a restart mid-conversation does not
 * blind the first check that follows it.
 *
 * The fold keeps only what the judgement needs, and keeps it small because the framework
 * checkpoints the state as plain JSON:
 *
 * - the person's own words, with the channel provenance line removed — an injected snapshot
 *   (`source.kind` other than `user`) is context, not something anyone said, and would poison a
 *   reading of "what is the live thread here";
 * - what Loom actually sent them, which is the `message` tool's own `text`; assistant text reaches
 *   nobody. A send is only recorded once its matching `tool/result` has committed and reported
 *   success — a failed or still-pending call is not something Loom said; an unknown outcome may
 *   have reached the remote channel but cannot confirm that fact, so this projection stays
 *   conservative (see the delivery-is-the-external-fact ADR). The call is held pending until then,
 *   so the fold carries a small list of in-flight `message` calls alongside the conversation;
 * - the conversation under a whole-message character budget ({@link CONVERSATION_BUDGET}), spent
 *   from the newest message backwards, so the state stays small without ever cutting a message in
 *   half;
 * - the turn the latest human input opened, which is the fact that decides whether a stopping turn
 *   may arm a silence alarm at all (§4a① of the converged design: only a pause the person caused
 *   may arm one, or a proactive turn's own idle would arm the next check and never stop).
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Side-effect import: pulls the `sessionProjections` Context augmentation from dsh-session-projection.
import '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** This plugin's projection key. Host-only: no client view is published for it. */
export const AFTER_INTERACTION_KEY = 'loomAfterInteraction'

/**
 * How much conversation the judgement sees, in UTF-16 code units of message text — roughly
 * characters, and for Chinese roughly one per character. The bound is on the *total*, and it is
 * spent from the newest message backwards, one whole message at a time: a conversation the
 * judgement reads should be made of complete things people said, not of the newest sentence plus
 * the head of an older one. Per-message limits ({@link HUMAN_TEXT_LIMIT},
 * {@link REPLY_TEXT_LIMIT}) run first, which is what makes the whole-message rule well defined —
 * whatever a single message is, it always fits inside this budget on its own.
 *
 * Sized against jev's own ceiling: its state and questions together may reach 32k tokens, and a
 * conversation of about this many characters plus the capped resident materials leaves ample room.
 */
export const CONVERSATION_BUDGET = 4_000
/** Longest slice kept of one sent reply: a live thread shows in what the person said, not here. */
export const REPLY_TEXT_LIMIT = 150

/**
 * Bound on one inbound message. People write a sentence; this only stops a pasted document from
 * bloating a state the framework checkpoints on every folded event.
 */
export const HUMAN_TEXT_LIMIT = 500

/** The one tool whose text reaches the person. Assistant text is not shown to anyone. */
const SEND_MESSAGE_TOOL = 'message'

/** One thing said in the conversation: a person's message, or a reply Loom actually sent. */
export interface Exchange {
  /** Which side said it. */
  readonly from: 'human' | 'loom'
  /** What was said: the person's message without its provenance line, or Loom's sent text clipped. */
  readonly text: string
  /** Where a human message came from (`telegram · direct · from y u`); empty for Loom's own. */
  readonly place: string
  /** Event time, epoch milliseconds. */
  readonly time: number
  /** The turn this message belonged to. */
  readonly turn: number
}

/**
 * A `message` call the fold has seen but whose `tool/result` has not committed yet. Only a matching
 * successful result turns this into an {@link Exchange}: assistant text never reaches the person,
 * and neither does a call the tool answered with an error. Held by call id, the one key the result
 * carries back; the text, time, and turn are the call's own, so a late result still records when
 * the send was attempted.
 */
export interface PendingSend {
  /** The provider-issued id pairing this call with its `tool/result`. */
  readonly callId: string
  /** The clipped text the call asked to send, already validated by {@link sentText}. */
  readonly text: string
  /** Event time of the call, epoch milliseconds. */
  readonly time: number
  /** The turn the call was made in. */
  readonly turn: number
}

/** Everything a check needs from the log: the recent conversation and which turn the person opened. */
export interface AfterInteractionState {
  /** The turn the fold is currently inside; 0 before the first `turn/start`. */
  readonly turn: number
  /** The most recent exchanges, oldest first, bounded to {@link CONVERSATION_BUDGET} code units. */
  readonly exchanges: readonly Exchange[]
  /** `message` calls awaiting their result, oldest first. Empty when nothing is in flight. */
  readonly pending: readonly PendingSend[]
  /** Event time of the latest human input in the log, or null when the person never spoke here. */
  readonly lastHumanInputTime: number | null
  /** The turn that latest human input opened; 0 when there is none. */
  readonly lastHumanTurn: number
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    loomAfterInteraction: AfterInteractionState
  }
}

/**
 * Fold one committed session event. Every event the fold does not read returns the same state
 * reference, which is the projection framework's zero-work signal.
 */
export function applyAfterInteractionEvent(state: AfterInteractionState, event: SessionEvent): AfterInteractionState {
  if (event.type === 'turn/start') {
    const turn = event.data.turn
    if (turn === state.turn) return state
    // A send's result is committed inside the turn that made the call; a new turn means any call
    // still pending was interrupted and will never be answered. Drop it rather than let a stale id
    // squat in the state forever. (Call ids are provider-issued and unique, so this only forgets
    // orphans — it cannot mispair a later result.)
    const pending = state.pending.filter(send => send.turn === turn)
    return pending.length === state.pending.length ? { ...state, turn } : { ...state, turn, pending }
  }
  if (event.type === 'user/message') {
    if (event.data.source.kind !== 'user') return state
    const said = splitProvenance(blockText(event.data.content))
    if (said.body === '') return state
    return withExchange(state, {
      from: 'human',
      text: flatten(said.body, HUMAN_TEXT_LIMIT),
      place: said.place,
      time: event.time,
      turn: state.turn,
    }, { lastHumanInputTime: event.time, lastHumanTurn: state.turn })
  }
  if (event.type === 'tool/call') {
    if (event.data.name !== SEND_MESSAGE_TOOL) return state
    const text = sentText(event.data.arguments)
    // Malformed arguments are a call that asked to say nothing: fail closed rather than fold a
    // blank exchange or hold a placeholder pending forever.
    if (text === '') return state
    const callId = event.data.callId
    if (typeof callId !== 'string' || callId === '') return state
    if (state.pending.some(send => send.callId === callId)) return state
    return { ...state, pending: [...state.pending, { callId, text, time: event.time, turn: state.turn }] }
  }
  if (event.type === 'tool/result') {
    const result = event.data.message
    // Defensive on the shape as well as the value: an unreadable result cannot confirm anything.
    if (result === undefined || typeof result.toolCallId !== 'string') return state
    const index = state.pending.findIndex(send => send.callId === result.toolCallId)
    // A result the fold never saw a matching call for confirms nothing — no exchange, no state.
    if (index === -1) return state
    const pending = state.pending.toSpliced(index, 1)
    const send = state.pending[index]
    if (result.isError === true || send === undefined) return { ...state, pending }
    return withExchange({ ...state, pending }, { from: 'loom', text: send.text, place: '', time: send.time, turn: send.turn })
  }
  return state
}

/**
 * Append one exchange and spend the budget from the newest message backwards: the oldest whole
 * messages go until the rest fits. Whole messages only — the loop stops at the last one that still
 * fits rather than keeping a prefix of an older message, so cutting the conversation never rewrites
 * what someone said. The per-message limits guarantee the last remaining message always fits.
 */
function withExchange(
  state: AfterInteractionState,
  exchange: Exchange,
  patch: { lastHumanInputTime?: number; lastHumanTurn?: number } = {},
): AfterInteractionState {
  const exchanges = [...state.exchanges, exchange]
  let total = exchanges.reduce((sum, entry) => sum + entry.text.length, 0)
  let oldest = 0
  while (total > CONVERSATION_BUDGET && oldest < exchanges.length - 1) {
    total -= exchanges[oldest]?.text.length ?? 0
    oldest += 1
  }
  return { ...state, ...patch, exchanges: exchanges.slice(oldest) }
}

/** The text a user message carries, blocks joined the way the model would read them. */
export function blockText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Split one framed inbound message into its provenance line and the words themselves. The channel
 * seam frames every message as `[channel · kind · from who]` followed by the text; that first line
 * is routing metadata, and a judgement about whether the conversation is still alive reads the
 * words, not the envelope.
 */
export function splitProvenance(message: string): { place: string; body: string } {
  const newline = message.indexOf('\n')
  const first = newline === -1 ? message : message.slice(0, newline)
  const rest = newline === -1 ? '' : message.slice(newline + 1)
  const framed = /^\[([^\]]*)\]\s*$/.exec(first)
  const place = framed?.[1]
  if (place === undefined) return { place: '', body: message.trim() }
  return { place: place.trim(), body: rest.trim() }
}

/** One line of text within a bound, marked with an ellipsis when it was cut. */
export function flatten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * The text one `message` tool call sent, clipped to its first paragraph. The arguments are the
 * model's own JSON, so a malformed call contributes nothing rather than failing the fold.
 */
export function sentText(argumentsJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const text = (parsed as { text?: unknown }).text
  if (typeof text !== 'string') return ''
  const firstParagraph = text.split(/\n\s*\n/, 1)[0] ?? ''
  return firstParagraph.trim() === '' ? '' : flatten(firstParagraph, REPLY_TEXT_LIMIT)
}

export const afterInteractionProjection: ProjectionDefinition<typeof AFTER_INTERACTION_KEY, AfterInteractionState> = {
  key: AFTER_INTERACTION_KEY,
  stateSchema: z.object({
    turn: z.number(),
    exchanges: z.array(z.object({
      from: z.enum(['human', 'loom']),
      text: z.string(),
      place: z.string(),
      time: z.number(),
      turn: z.number(),
    })),
    pending: z.array(z.object({
      callId: z.string(),
      text: z.string(),
      time: z.number(),
      turn: z.number(),
    })),
    lastHumanInputTime: z.number().nullable(),
    lastHumanTurn: z.number(),
  }),
  init: () => ({ turn: 0, exchanges: [], pending: [], lastHumanInputTime: null, lastHumanTurn: 0 }),
  apply: applyAfterInteractionEvent,
  // 2: a `message` call is no longer folded on the call alone — the state gained pending sends and
  // only a successful matching `tool/result` appends an exchange. An older checkpoint is forward
  // incompatible, so the framework discards it on the version mismatch and refolds the log, where
  // every call and result is present again and succeeds into the same exchange it used to.
  stateVersion: 2,
}

/**
 * Register the fold. Mounted before the agent's session exists, so it covers the log from its
 * first event; the framework's lazy cell build covers it either way.
 */
export function registerAfterInteractionProjection(ctx: Context): void {
  ctx.effect(() => ctx.sessionProjections.register(afterInteractionProjection), 'after-interaction.projection')
}
