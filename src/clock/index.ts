import type { Context } from '@deepseek-ai/cordis'

/**
 * The single time source for Loom. Everything that needs "now" reads it here instead of
 * calling Date.now() directly, so tests and behavior eval can drive time deterministically
 * (the injectable-clock seam).
 */
export interface LoomClock {
  /** Current time in epoch milliseconds. */
  now(): number
}

class RealClock implements LoomClock {
  now(): number {
    return Date.now()
  }
}

/**
 * A clock whose time only moves when told to. For tests and behavior eval: construct with a
 * start instant, then set/advance around the code under test.
 */
export class ManualClock implements LoomClock {
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    loomClock: LoomClock
  }
}

export const name = 'loom-clock'

export function apply(ctx: Context): void {
  ctx.provide('loomClock', new RealClock())
}
