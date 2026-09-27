/**
 * When a clock snapshot is due, and what it says. Both are pure functions over the caller's
 * values, so the sampling rule and the wording are testable without a session or a clock.
 */

import { formatLoomDuration, formatLoomTimestamp } from './format.ts'

/** Default minimum spacing between two snapshots within one turn, in ms. */
export const CLOCK_REFRESH_INTERVAL_MS = 1_800_000

/**
 * Whether this step appends a snapshot. The first step of a turn always does: every wake starts
 * at a fresh instant, and that is the line the agent needs before it decides anything. A later
 * step does only once the turn has outlived the refresh interval since the last snapshot it
 * landed, so a quick tool-dense turn stays at one line while a turn that runs for hours still
 * shows its real span. A step that samples nothing never backfills; its span folds into the next
 * snapshot's elapsed.
 * @param step - the step proposed by the loop, 1-based.
 * @param now - the current instant, from `ctx.clock`.
 * @param lastTurnInjection - when this turn last landed a snapshot, or undefined if it has not.
 * @param refreshIntervalMs - minimum spacing between two snapshots within one turn.
 */
export function shouldSampleClock(
  step: number,
  now: number,
  lastTurnInjection: number | undefined,
  refreshIntervalMs: number,
): boolean {
  if (step === 1) return true
  return lastTurnInjection === undefined || now - lastTurnInjection >= refreshIntervalMs
}

/**
 * Render one clock snapshot. The elapsed line measures against the preceding model-visible event
 * in this session's own log; when there is none — the first turn of a generation that inherited
 * nothing — it says so instead of inventing a baseline.
 */
export function renderClockSnapshot(input: {
  readonly now: number
  readonly turn: number
  readonly step: number
  readonly previous: number | null
}): string {
  const elapsed = input.previous === null
    ? 'unavailable (nothing earlier in this session\'s log)'
    : formatLoomDuration(input.now - input.previous)
  return `Loom clock sampled while preparing turn ${input.turn}, step ${input.step}: ${formatLoomTimestamp(input.now)}\n`
    + `Elapsed since the preceding model-visible event: ${elapsed}.`
}
