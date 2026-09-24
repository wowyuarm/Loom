import type { Context } from '@deepseek-ai/cordis'
import type { Clock } from '../contracts/index.ts'

/**
 * The single time source, provided as `ctx.clock`. Loom's own code reads "now" here instead of
 * calling Date.now() directly — channels' acceptedAt and memory writes' writtenAt — so tests and
 * behavior eval can drive those deterministically. DSH's own internals keep their own time; this
 * seam covers Loom's writes, not the whole process.
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
