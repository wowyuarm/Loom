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

// Section orders, ascending. Loom's orientation sits at 100; the memory-model guidance and
// the agent's own identity follow it, so the model reads harness mechanics, then how its memory
// works, then who it is — before the dynamic materials arrive as history snapshots.
const MIND_GUIDANCE_ORDER = 110
const IDENTITY_ORDER = 120

/**
 * How the agent uses its own memory: the two layers, the four resident files, and the handful of
 * operations over them. Neutral mechanics — it names organs and tools, never who the agent is or
 * what it should care about. That is the agent's own, carried by identity.md. A deployment may
 * override this text, but the default assumes Loom's resident-context organs and its continuity
 * tools; replacing those means replacing this.
 */
export const DEFAULT_MIND_GUIDANCE = `# How your memory works

You hold two kinds of memory, and they work differently.

Everything that happens — every message, tool call, and turn — is already recorded verbatim in your session log. You never write it down yourself. To recall the past, search: \`context_search\` finds by content across your past generations, and \`context_read\` expands an exact reference. When something you kept cites where it came from, read that reference directly instead of searching for it.

On top of that record you keep a small set of files you maintain by hand, shown to you at the start of every turn. They hold what search cannot give you — what must be present every turn, and where your open lines stand:

- **identity** — who you are: the root you judge everything else against. Highest threshold to change; it does not move with the events of a few days.
- **memory** — a small core of understanding that must bind every turn (cross-topic conclusions, standing rules), plus an index routing to notes. A note holds topic-specific knowledge you read on demand. Keep the core small: it is what would make you misjudge if it were not always in front of you.
- **threads** — the lines still open. \`threads/index.md\` lists the active ones; each \`threads/<id>/\` holds that line's current state and how to pick it back up. A thread is something still unfolding — re-entering means continuing the work, not looking up a settled fact.
- **attention** — what you are holding right now. Each item carries a horizon: roughly how long you expect to carry it. When a horizon passes, the item drops out, or becomes a thread if it still matters. attention is the most volatile of the four and sits nearest the current input.

How to use them:

- **Waking up or continuing a turn**: your standing understanding — identity, memory core, attention — is already in front of you. Enter the work without searching.
- **"Did I…? How was that decided?"**: search the record — \`context_search\`, then \`context_read\` to expand a hit.
- **"What do I know about X?"**: grep your notes.
- **You understood something lasting**: record it with \`memory_write\`, citing the source it came from. Settled knowledge becomes a note; a line still unfolding stays a thread.
- **Context filling up**: call \`context_rollover\` with a handoff. Before you do, refresh attention (clear what has passed, keep what you still carry) and distill any lasting conclusion into a note. The handoff carries only in-flight state across the boundary — the files above are reloaded for you on the other side, so do not repeat them in it.

Reference the past by searching for it; do not copy identifiers by hand.`

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

export interface ResidentContextOptions {
  /** Override the memory-model guidance section; defaults to {@link DEFAULT_MIND_GUIDANCE}. */
  mindGuidance?: string
}

/**
 * Contribute the resident context to every turn's prompt. Two parts, because they belong in
 * different places (see the placement decision):
 *
 * - **Stable system sections** (always rendered, never lost to compaction or rollover): the
 *   memory-model guidance, and identity — the agent's authoritative root, read fresh from its
 *   file. `interpolate: false` keeps identity's own prose literal, so a stray `{{…}}` in it can
 *   never break assembly.
 * - **Dynamic materials** (memory, threads, attention): user-role history snapshots via
 *   `context()`, so they can be revised, compacted, and re-injected, with attention nearest the
 *   current input. Ascending context order is the wake-bundle order. Providers read the file
 *   fresh at each assembly; the loop re-injects a changed or compaction-shadowed snapshot and
 *   loads them into a rollover successor's first turn on its own.
 */
export function registerResidentContext(
  ctx: Context,
  workspace: string,
  caps: ResidentContextCaps,
  options: ResidentContextOptions = {},
): void {
  const identityText = (): string =>
    applyBudget(readResidentFile(residentPath(workspace, residentFiles.identity)), caps.identity).text
  ctx.systemPrompt.section({
    name: 'loom:memory-guidance',
    order: MIND_GUIDANCE_ORDER,
    text: options.mindGuidance ?? DEFAULT_MIND_GUIDANCE,
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

  context('memory-core', 20, () => memoryCoreOf(memoryFile()), caps.memoryCore)
  context('memory-index', 25, () => memoryIndexOf(memoryFile()), caps.memoryIndex)
  context('threads-index', 30, () => readResidentFile(residentPath(workspace, residentFiles.threadsIndex)), caps.threadsIndex)
  context('attention', 40, () => readResidentFile(residentPath(workspace, residentFiles.attention)), caps.attention)
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
  if (budgeted.usedBytes < cap * USAGE_NOTICE_FRACTION) return budgeted.text
  return `${budgeted.text}\n\n[${name}: ${kib(budgeted.usedBytes)}/${kib(budgeted.capBytes)} KiB]`
}

// Show a material's usage only once it is this full; below it the file has ample room and a usage
// line would be noise.
const USAGE_NOTICE_FRACTION = 0.5

function kib(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}
