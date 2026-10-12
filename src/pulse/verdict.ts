import type { JevAnswer, JevChoiceQuestion } from '@wowyuarm/dsh-jev'

export function pulseQuestion(): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions: 'Should Loom wake its subject right now? Judge only by whether the material holds a '
      + 'concrete, still-live line worth continuing at this moment: something unfinished, a line it '
      + 'chose to carry, or a signal that should be handled now. Do not lean toward waking because it '
      + 'would look attentive, or because the silence has gone on a while. Distinguish "not yet looked '
      + 'at" from "looked at and deliberately left": the latter, without anything new, is not a reason '
      + 'to wake.',
    criteria: {
      quiet: 'Stay quiet. Nothing in the material is really worth continuing right now, or the line '
        + 'was already looked at and deliberately left with nothing new since.',
      attend: 'Wake the subject. The material holds a concrete live line worth continuing now — what '
        + 'to do with it, and whether to act at all, is the woken subject\'s own call.',
    },
  }
}

/** One read judgement: whether to wake, and the two probabilities it was read from. */
export interface PulseVerdict {
  readonly attend: boolean
  /** Probability of attend, as the vendor sent it. Operator-facing only: the agent never sees it. */
  readonly pAttend: number
  readonly pQuiet: number
}

/**
 * Read one answer into a verdict, or `undefined` when it cannot be read — which the caller treats
 * exactly like quiet. The gate compares probabilities rather than reading the answer's own
 * `choice` field, because the threshold is anchored on `P(attend)` either way.
 */
export function readVerdict(answer: JevAnswer | undefined, threshold: number): PulseVerdict | undefined {
  if (answer === undefined || answer.type !== 'choice') return undefined
  const pAttend = probability(answer.probabilities, 'attend')
  const pQuiet = probability(answer.probabilities, 'quiet')
  if (pAttend === undefined || pQuiet === undefined || Math.abs(pAttend + pQuiet - 1) > 0.001) return undefined
  return { attend: pAttend > threshold, pAttend, pQuiet }
}

function probability(values: Readonly<Record<string, number>> | undefined, key: string): number | undefined {
  const value = values?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}
