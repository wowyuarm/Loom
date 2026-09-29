/**
 * What the judgement sees, and what the agent is handed when it wakes.
 *
 * The three sources go in whole and in the design's priority order — the recent conversation first,
 * then the agent's attention list, then the threads still asleep (§3.2 of the converged design).
 * The two resident files go in under a loose cap each ({@link MATERIAL_LIMIT}); the conversation
 * arrives already bounded by the fold. They are not normalized into candidate lines: the judgement
 * picks a posture out of three fixed ones, not one of these lines, which is what removed the
 * candidate-construction problem the earlier per-line design had.
 *
 * The agent's own note is deliberately smaller than the judge's state: attention and the threads
 * index are already read into every turn by `resident-context`, so repeating them would only spend
 * context to say what the agent can already see. The note says what the pause is, which way the
 * judgement leaned, and leaves everything else to the agent.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AfterInteractionState, Exchange } from './projection.ts'

/**
 * The resident files a check reads. They are the workspace's own convention rather than this
 * plugin's business: `resident-context` owns that layout and reads the same two files into every
 * turn. The paths are restated rather than imported because one capability plugin does not import
 * another's module (AGENTS.md: plugins meet at ctx services and contracts).
 */
const ATTENTION_FILE = 'attention/attention.md'
const THREADS_INDEX_FILE = 'threads/index.md'

/**
 * Loose ceiling on each resident source, in UTF-16 code units. These files are the agent's own and
 * are normally a page or two; the cap is a backstop, not an editorial rule. Without one, a source
 * that grew without bound would be read whole into the judgement's state, and a state past jev's
 * own ceiling fails the call — which §4a④ turns into silence, the one failure that leaves no trace.
 */
export const MATERIAL_LIMIT = 2_000

/** Marks a source the cap cut, so neither the judgement nor a reader mistakes it for the whole. */
const TRUNCATION_MARK = ' …(truncated)'

/** The materials of one check, as read at that moment. A source that is absent is simply empty. */
export interface Materials {
  /** The recent conversation, oldest first. */
  readonly recent: readonly Exchange[]
  /** The agent's always-present attention list. */
  readonly attention: string
  /** The threads index: the lines still asleep. */
  readonly threads: string
}

/** Read the materials of one check. Missing or empty sources degrade to nothing, never a failure. */
export async function readMaterials(workspace: string, state: AfterInteractionState): Promise<Materials> {
  const [attention, threads] = await Promise.all([
    readResident(join(workspace, ATTENTION_FILE)),
    readResident(join(workspace, THREADS_INDEX_FILE)),
  ])
  return { recent: state.exchanges, attention: bound(attention), threads: bound(threads) }
}

/**
 * A resident file the agent has not written yet is the normal case, and an unreadable one must not
 * turn a check into an error: the judgement runs on what is there.
 */
async function readResident(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return ''
  }
}

/** Cut one resident source at the cap, appending the marker outside it. */
function bound(text: string): string {
  return text.length <= MATERIAL_LIMIT ? text : `${text.slice(0, MATERIAL_LIMIT)}${TRUNCATION_MARK}`
}

/** The instant as Loom renders every instant: the deployment's fixed UTC+8 zone, second precision. */
export function localInstant(epochMs: number): string {
  return `${new Date(epochMs + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`
}

/** How long ago, in the words a person would use. */
export function elapsedText(ms: number): string {
  const minute = 60_000
  if (ms < minute) return 'less than a minute'
  const minutes = Math.floor(ms / minute)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ${minutes % 60} min`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ${hours % 24} h`
}

/**
 * The state one judgement call is evaluated against. The local hour is in it on purpose: the design
 * leaves "is it three in the morning" to the judgement rather than to a hard quiet-hours rule
 * (§4a⑤), so the hour and the elapsed gap are the two facts it weighs that the transcript itself
 * does not carry.
 */
export function renderJudgeState(input: { now: number; lastHumanInputTime: number | null; materials: Materials }): string {
  const lines: string[] = [
    'This is a pause in the conversation: Loom has just finished answering and nobody is speaking right now.',
    `Now: ${localInstant(input.now)}`,
  ]
  if (input.lastHumanInputTime !== null) {
    lines.push(`Time since the last thing the person said: ${elapsedText(input.now - input.lastHumanInputTime)}`)
  }
  lines.push('', 'Recent conversation (oldest first):')
  lines.push(...(input.materials.recent.length === 0
    ? ['(nothing to continue)']
    : input.materials.recent.map(exchange => `${exchange.from === 'human' ? 'Person' : 'Loom'}: ${exchange.text}`)))
  if (input.materials.attention !== '') {
    lines.push('', "Loom's own attention list (attention.md):", input.materials.attention)
  }
  if (input.materials.threads !== '') {
    lines.push('', 'Threads still asleep (threads/index.md):', input.materials.threads)
  }
  return lines.join('\n')
}

/**
 * The note handed to the agent when the judgement leans away from quiet.
 *
 * It carries the pause and the direction, and nothing else. Not the probabilities — those are the
 * operator's, and they are logged rather than shown. Not a quotation of the last message, and not
 * the elapsed time: a steer lands in the session it came from, so the conversation it refers to is
 * already in history and `time-context` puts the gap in front of every turn. Repeating either would
 * spend context to say what the agent can already see.
 *
 * The wording is deliberately *do it unless* rather than *you might*, and that is the whole point of
 * the line: the judgement has already found something live, so hedging a second time would multiply
 * two layers of caution into stillness. The veto stays real — the agent is the one looking at the
 * material, and the closing clause is a genuine opening for a judgement that misread the moment —
 * but closing it has to be the agent's own reading, not the note's timidity. Softness belongs in the
 * gate (the threshold decides how often this is asked at all), never in the ask: if this turns out
 * to speak too often, tighten the threshold rather than softening these words.
 */
export function renderSituation(posture: 'speak' | 'act'): string {
  return posture === 'speak'
    ? 'The conversation has gone quiet. There\'s a thread here worth continuing — pick up what the human '
      + 'left open, or the thing you\'re still holding, and say what comes next. Only let it rest if, looking '
      + 'at it, there\'s genuinely nothing live: they\'re clearly done, or anything you\'d add would just be filler.'
    : 'The conversation has gone quiet. There\'s something here that should move — what the human handed you '
      + 'and you haven\'t done, or something left open in attention/threads you can act on now. Go take care of '
      + 'it. Only leave it if, on a closer look, it\'s already handled or shouldn\'t move yet.'
}
