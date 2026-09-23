import type { Context } from '@deepseek-ai/cordis'
import type { Clock } from '../contracts/index.ts'

/**
 * The single time source, provided as `ctx.clock`. Everything that needs "now" reads it here
 * instead of calling Date.now() directly, so tests and behavior eval can drive time
 * deterministically (the injectable-clock seam).
 */

class RealClock implements Clock {
  now(): number {
    return Date.now()
  }
}

/**
 * A clock whose time only moves when told to. For tests and behavior eval: construct with a
 * start instant, then set/advance around the code under test.
 */
export class ManualClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current
  }

  set(epochMs: number): void {
    this.current = epochMs
  }

  advance(deltaMs: number): void {
    this.current += deltaMs
  }
}

export const name = 'clock'

export function apply(ctx: Context): void {
  ctx.provide('clock', new RealClock())
}
