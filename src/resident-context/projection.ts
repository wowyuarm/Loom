import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect import: pulls the `systemPrompt` Context augmentation from dsh-system-prompt.
import '@deepseek-ai/dsh-system-prompt'
import { applyBudget } from './budget.ts'
import { residentPath, residentFiles, memoryCoreOf, memoryIndexOf } from './layout.ts'

/** Per-file byte caps. Total stays in the ~20-40 KiB resident range. */
export interface ResidentContextCaps {
  identity: number
  memoryCore: number
  memoryIndex: number
  threadsIndex: number
  attention: number
}

export const defaultCaps: ResidentContextCaps = {
  identity: 4 * 1024,
  memoryCore: 16 * 1024,
  memoryIndex: 8 * 1024,
  threadsIndex: 8 * 1024,
  attention: 8 * 1024,
}

function readResidentFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    // A file the agent has not created yet is the normal case; anything else is a real
    // fault worth surfacing rather than silently dropping from context.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/**
 * Register one context provider per resident file. Ascending order is the wake-bundle
 * order: identity first, attention last (nearest the current Input). Providers are evaluated
 * at each assembly and read the file fresh; system-prompt already dedups unchanged snapshots.
 */
export function registerResidentContext(ctx: Context, workspace: string, caps: ResidentContextCaps): void {
  const provider = (name: string, order: number, read: () => string, cap: number): void => {
    ctx.systemPrompt.context({ name, order, text: () => applyBudget(read(), cap).text })
  }

  const memoryFile = (): string => readResidentFile(residentPath(workspace, residentFiles.memory))

  provider('identity', 10, () => readResidentFile(residentPath(workspace, residentFiles.identity)), caps.identity)
  provider('memory-core', 20, () => memoryCoreOf(memoryFile()), caps.memoryCore)
  provider('memory-index', 25, () => memoryIndexOf(memoryFile()), caps.memoryIndex)
  provider('threads-index', 30, () => readResidentFile(residentPath(workspace, residentFiles.threadsIndex)), caps.threadsIndex)
  provider('attention', 40, () => readResidentFile(residentPath(workspace, residentFiles.attention)), caps.attention)
}
