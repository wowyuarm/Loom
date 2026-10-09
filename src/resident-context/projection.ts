import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect import: pulls the `systemPrompt` Context augmentation from dsh-system-prompt.
import '@deepseek-ai/dsh-system-prompt'
import { applyBudget, budgetNotice } from './budget.ts'
import { attachEntryAges } from './entry-ages.ts'
import { residentPath, residentFiles, memoryCoreOf, memoryIndexOf } from './layout.ts'
import { bootstrapFile } from './scaffold.ts'

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

// Section orders, ascending. The first-waking prompt leads (90, present only during
// initialization); Loom's orientation sits at 100; the agent's own identity follows at 120 —
// before the dynamic materials arrive as history snapshots.
const BOOTSTRAP_ORDER = 90
const IDENTITY_ORDER = 120

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
 * Contribute the resident context to every turn's prompt. Two parts, because they belong in
 * different places (see the placement decision):
 *
 * - **Always-present system sections** (never lost to compaction or rollover): the first-waking
 *   prompt while `bootstrap.md` exists, and identity — the agent's authoritative root, read fresh
 *   from its file. `interpolate: false` keeps their prose literal, so a stray `{{…}}` can never
 *   break assembly. How the agent keeps these files is not stated here; it lives in the
 *   workspace's own AGENTS.md, surfaced on-touch.
 * - **Dynamic materials** (memory, threads, attention): user-role history snapshots via
 *   `context()`, so they can be revised, compacted, and re-injected, with attention nearest the
 *   current input. Ascending context order is the wake-bundle order. Providers read the file
 *   fresh at each assembly; the loop re-injects a changed or compaction-shadowed snapshot and
 *   loads them into a rollover successor's first turn on its own. The two open-line materials
 *   carry each entry's derived age (see `entry-ages.ts`), which costs the agent nothing to keep.
 */
export function registerResidentContext(
  ctx: Context,
  workspace: string,
  caps: ResidentContextCaps,
): void {
  const identityText = (): string =>
    applyBudget(readResidentFile(residentPath(workspace, residentFiles.identity)), caps.identity).text
  // The first-waking prompt leads the prompt while it exists, then vanishes once the agent has
  // settled who it is and deleted the file.
  ctx.systemPrompt.section({
    name: 'loom:bootstrap',
    order: BOOTSTRAP_ORDER,
    text: () => readResidentFile(residentPath(workspace, bootstrapFile)),
    interpolate: false,
  })
  ctx.systemPrompt.section({
    name: 'loom:identity',
    order: IDENTITY_ORDER,
    text: () => identityText(),
    interpolate: false,
  })

  const context = (name: string, order: number, read: () => string, cap: number): void => {
    ctx.systemPrompt.context({ name, order, text: () => materialText(name, read(), cap) })
  }
  const memoryFile = (): string => readResidentFile(residentPath(workspace, residentFiles.memory))

  /**
   * The open lines, each tagged with how long it has been carried. The age is derived, never
   * written down: the agent keeps rewriting these files whole, so anything it recorded by hand
   * would be gone by the next save. A workspace without a repository — or without a clock to
   * measure against — contributes the material exactly as it is.
   */
  const aged = (rel: string, read: () => string): () => string => () => {
    const raw = read()
    const times = ctx.get('workspaceHistory')?.lineModifiedTimes(rel)
    const now = ctx.get('clock')?.now()
    return times === undefined || now === undefined ? raw : attachEntryAges(raw, times, now)
  }

  context('memory-core', 20, () => memoryCoreOf(memoryFile()), caps.memoryCore)
  context('memory-index', 25, () => memoryIndexOf(memoryFile()), caps.memoryIndex)
  context('threads-index', 30, aged(residentFiles.threadsIndex, () => readResidentFile(residentPath(workspace, residentFiles.threadsIndex))), caps.threadsIndex)
  context('attention', 40, aged(residentFiles.attention, () => readResidentFile(residentPath(workspace, residentFiles.attention))), caps.attention)
}

/**
 * A dynamic material's injected text: the budgeted content, plus a compact usage line once the
 * file is filling toward its cap, so the agent gets a prune signal before it hits the wall
 * (feedback, not a hard refusal — see DESIGN §7). Silent while there is ample room, so small files
 * carry no noise. An empty file contributes nothing. A file already over budget carries
 * applyBudget's truncation marker, which states the same counts, so no second usage line is added.
 */
function materialText(name: string, raw: string, cap: number): string {
  const budgeted = applyBudget(raw, cap)
  if (budgeted.text === '') return ''
  if (budgeted.truncated) return budgeted.text
  const notice = budgetNotice(name, budgeted.usedBytes, budgeted.capBytes)
  return notice === undefined ? budgeted.text : `${budgeted.text}\n\n${notice}`
}
