/**
 * The silence alarm: one timer, alive only for this pause.
 *
 * The design's trigger is a single random silence between three and fourteen minutes, armed when a
 * conversation stops and never re-armed on its own (§3.1, §4a①). Waiting is the point: answering at
 * once collides with someone still typing, and a few quiet minutes are what makes "the conversation
 * really stopped" a fact rather than a guess. Randomising the wait removes the mechanical feel of a
 * knock on the minute.
 *
 * It is deliberately not durable, and deliberately not rescheduled: a restart drops it and a missed
 * pass costs one unprompted line (§4a⑦). Only one may be pending at a time — arming cancels the
 * previous one — because "one pause, one check" is the structural half of the anti-loop rule.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Shortest silence before a check, in milliseconds. */
export const MIN_SILENCE_MS = 3 * 60_000

/** Longest silence before a check, in milliseconds. */
export const MAX_SILENCE_MS = 14 * 60_000

/** One random silence inside the design's window. The generator is a seam only tests use. */
export function silenceDelay(random: () => number = Math.random): number {
  return MIN_SILENCE_MS + Math.floor(random() * (MAX_SILENCE_MS - MIN_SILENCE_MS))
}

/**
 * The one pending silence, if any. `schedule` is the deployment's timer (`ctx.timeout`), which
 * returns a disposer and releases the timer with its fiber; a raw `setTimeout` would outlive a
 * disposed plugin, which the design explicitly rules out (§4a⑩).
 */
export class SilenceAlarm {
  private cancelPending: (() => void) | undefined

  constructor(private readonly schedule: (fire: () => void, delayMs: number) => () => void) {}

  /** Start the one silence. Any alarm already pending is cancelled first. */
  arm(delayMs: number, fire: () => void): void {
    this.cancel()
    this.cancelPending = this.schedule(() => {
      this.cancelPending = undefined
      fire()
    }, delayMs)
  }

  /** Drop the pending alarm, if any: a person speaking makes its silence moot. */
  cancel(): void {
    this.cancelPending?.()
    this.cancelPending = undefined
  }

  get pending(): boolean {
    return this.cancelPending !== undefined
  }
}

/** The deployment's timer, as this plugin's one scheduling seam. */
export function contextTimer(ctx: Context): (fire: () => void, delayMs: number) => () => void {
  return (fire, delayMs) => ctx.timeout(fire, delayMs)
}
