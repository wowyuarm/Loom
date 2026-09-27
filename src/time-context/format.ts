/**
 * The one agent-facing Loom time format. The instant the agent reads is rendered in the
 * deployment's fixed zone, UTC+8, with an explicit offset (`2026-09-27T22:31:55+08:00`). The
 * offset has no daylight-saving component, so one instant renders byte-identically wherever it is
 * reread — the invariant the snapshot text rests on, and the reason the zone is fixed rather than
 * taken from the machine. Durations use the compact whole-second vocabulary the harness's own
 * time-context speaks, so both clock families read the same way.
 */

/** The fixed deployment offset from UTC, in minutes. */
const ZONE_OFFSET_MINUTES = 8 * 60

/** Rendered offset text, e.g. `+08:00`. */
const OFFSET_TEXT = '+08:00'

/**
 * Format one epoch instant as the agent-facing Loom timestamp.
 * @param epochMs - epoch milliseconds, read from `ctx.clock`.
 * @returns the fixed-offset UTC+8 rendering.
 */
export function formatLoomTimestamp(epochMs: number): string {
  const shifted = new Date(epochMs + ZONE_OFFSET_MINUTES * 60_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${OFFSET_TEXT}`
}

/**
 * Format an elapsed millisecond count as compact whole-second units (`2d 3h 12m 8s`). A
 * non-positive count — a wall-clock rollback — renders `0s`, never a negative span.
 */
export function formatLoomDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}
