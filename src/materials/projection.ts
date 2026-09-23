import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect import: pulls the `systemPrompt` Context augmentation from dsh-system-prompt.
import '@deepseek-ai/dsh-system-prompt'
import { applyBudget } from './budget.ts'
import { materialPath, materialPaths, memoryCoreOf, memoryIndexOf } from './layout.ts'

/** Per-material byte caps. Total stays in the ~20-40 KiB resident range. */
export interface MaterialCaps {
  identity: number
  memoryCore: number
  memoryIndex: number
  threadsIndex: number
  attention: number
}

export const defaultCaps: MaterialCaps = {
  identity: 4 * 1024,
  memoryCore: 16 * 1024,
  memoryIndex: 8 * 1024,
  threadsIndex: 8 * 1024,
  attention: 8 * 1024,
}

function readMaterial(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    // A material the agent has not created yet is the normal case; anything else is a real
    // fault worth surfacing rather than silently dropping from context.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/**
 * Register one context provider per resident material. Ascending order is the wake-bundle
 * order: identity first, attention last (nearest the current Input). Providers are evaluated
 * at each assembly and read the file fresh; system-prompt already dedups unchanged snapshots.
 */
export function registerMaterials(ctx: Context, workspace: string, caps: MaterialCaps): void {
  const provider = (name: string, order: number, read: () => string, cap: number): void => {
    ctx.systemPrompt.context({ name, order, text: () => applyBudget(read(), cap).text })
  }

  const memoryFile = (): string => readMaterial(materialPath(workspace, materialPaths.memory))

  provider('identity', 10, () => readMaterial(materialPath(workspace, materialPaths.identity)), caps.identity)
  provider('memory-core', 20, () => memoryCoreOf(memoryFile()), caps.memoryCore)
  provider('memory-index', 25, () => memoryIndexOf(memoryFile()), caps.memoryIndex)
  provider('threads-index', 30, () => readMaterial(materialPath(workspace, materialPaths.threadsIndex)), caps.threadsIndex)
  provider('attention', 40, () => readMaterial(materialPath(workspace, materialPaths.attention)), caps.attention)
}
