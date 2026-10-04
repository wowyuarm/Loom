import type { Context } from '@deepseek-ai/cordis'

/**
 * Stand-in for `@deepseek-ai/dsh-agent-preset-registry` in tests that compose Loom without the
 * real roster, which needs a loader and its preset declaration mounted. It records the compose
 * calls the way the registry would receive them, so a test can assert Loom joined its preset
 * inside the agent's creation window.
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
    // The registry's read-addressing face, which the continuity adapter calls to resolve the
    // compaction scope. The fake composes no compaction row, so nothing is resolvable — the same
    // answer the real registry gives for an agent whose preset mounts none.
    serviceFor: () => undefined,
  })
  return mounted
}
