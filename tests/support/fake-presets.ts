import type { Context } from '@deepseek-ai/cordis'

/**
 * Stand-in for `@deepseek-ai/dsh-agent-presets` in tests that compose Loom without the real
 * roster, which needs a loader and a preset file on disk. It records the compose calls the way
 * the roster would receive them, so a test can assert Loom joined its preset inside the agent's
 * creation window.
 * @param ctx - the root context the plugin under test will resolve `agentPresets` from.
 * @returns the list of preset ids `mount` was called with, newest last.
 */
export function provideFakePresets(ctx: Context): string[] {
  const mounted: string[] = []
  ctx.provide('agentPresets', {
    mount: async (_agentCtx: Context, id?: string): Promise<{ id: string }> => {
      mounted.push(id ?? 'default')
      return { id: id ?? 'default' }
    },
  })
  return mounted
}
