/**
 * The judgement itself: one Choice, read at one threshold.
 *
 * The three postures are fixed — `quiet`, `speak`, `act` — rather than built from whatever lines
 * the materials happened to contain. Experiments on this model found it separates "act or not" but
 * not fine social stances, and that every extra option dilutes the distribution and hurts exactly
 * the case worth waking for, so the granularity is deliberately coarse and "what to say" stays the
 * agent's own work (§2 of the converged design).
 *
 * The gate anchors on the probability of `quiet`, not on the winner's: quiet is the pole this
 * model judges most reliably, and the frozen rule is `P(quiet) < 0.4 → wake`, taking whichever of
 * speak/act is higher as the posture.
 *
 * Nothing here invents a number. The provider passes the vendor's answer through unchecked, so an
 * answer whose probabilities are missing or not finite is a failed judgement, and a failed
 * judgement is quiet (§4a④): the alternative — defaulting the missing side to wake — would turn a
 * vendor change into an agent that talks to itself in the dark.
 */

import type { JevAnswer, JevChoiceQuestion } from '@wowyuarm/dsh-jev'

/** The three postures, in the wording the judgement is asked for them. */
export const postures = ['quiet', 'speak', 'act'] as const

/** The posture the judgement leaned toward. */
export type Posture = (typeof postures)[number]

/** Wake when the judgement's own probability for staying quiet is below this. */
export const QUIET_THRESHOLD = 0.4

/**
 * The one question of a check. Its wording is the most load-bearing parameter in this feature —
 * whether the conversation is really over is what the judgement has to answer, and it answers it
 * through these words — so it anchors on "is there a concrete live thread or something left
 * unfinished" and explicitly refuses the social-feeling framing ("is now a good moment to speak"),
 * which this model scores about the same either way. The wording, like the threshold, is calibrated
 * against real Chinese conversations; treat both as the knobs of that calibration.
 */
export function postureQuestion(): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions: 'What should Loom do right now? Judge only by whether the material holds a concrete '
      + 'live thread, something explicitly left unfinished, or a signal that should be handled now. Do not '
      + 'lean toward speaking because it would look attentive, or because the silence has gone on a while. '
      + 'If nothing here is really worth picking up, choose quiet.',
    criteria: {
      quiet: 'Stay quiet, do nothing. The conversation has run its course, or nothing here is worth acting on.',
      speak: 'Say something to them. The material holds a live thread worth continuing: a question they left '
        + 'open, something they raised that is worth returning to, or something that should be said now. What '
        + 'to say is Loom\'s own call.',
      act: 'Do not speak; do something. The material holds work that should move: something they asked for '
        + 'and is still undone, or a line in attention/threads that is still open and can be advanced now. '
        + 'What to do is Loom\'s own call.',
    },
  }
}

/** One read judgement: the posture and the three probabilities it was read from. */
export interface Verdict {
  readonly posture: Posture
  /** Probability of quiet, as the vendor sent it. Operator-facing only: the agent never sees it. */
  readonly quiet: number
  readonly speak: number
  readonly act: number
}

/**
 * Read one answer into a verdict, or `undefined` when it cannot be read — which the caller treats
 * exactly like quiet. The posture comes from comparing probabilities rather than from the answer's
 * own `choice` field, because the gate is anchored on the quiet probability either way and the
 * choice field is the same argmax only when the envelope is well formed.
 */
export function readVerdict(answer: JevAnswer | undefined): Verdict | undefined {
  if (answer === undefined || answer.type !== 'choice') return undefined
  const quiet = probability(answer.probabilities, 'quiet')
  const speak = probability(answer.probabilities, 'speak')
  const act = probability(answer.probabilities, 'act')
  if (quiet === undefined || speak === undefined || act === undefined) return undefined
  if (quiet >= QUIET_THRESHOLD) return { posture: 'quiet', quiet, speak, act }
  return { posture: speak >= act ? 'speak' : 'act', quiet, speak, act }
}

function probability(values: Readonly<Record<string, number>> | undefined, key: string): number | undefined {
  const value = values?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
