/**
 * The shape side of the resident materials, delivered at the moment it matters.
 *
 * The workspace's own housekeeping instructions have asked for the same things since the first
 * scaffold — each attention entry carrying a horizon, threads listing only open lines — and the record shows the
 * agent rewrote attention 17 times in three days without once writing a horizon. A standing page
 * it rarely re-reads does not shape the hand that writes; a line riding the read result it is
 * about to act on does. This is that line: after a successful `read` of attention or a threads
 * file, append one short reminder of the shape the materials are meant to keep.
 *
 * Deliberately the same seam as the write-budget observer (`tools/post-execute`), and just as
 * toothless: it never blocks, never validates, and says nothing on any other file, so an agent
 * that ignores it loses nothing.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { residentFiles } from './layout.ts'

/** The attention reminder: the three fields one entry carries, with a one-line example. */
const ATTENTION_SHAPE = [
  'Each attention entry carries three things: a horizon (roughly how long you expect to carry it), the current state, and — when it belongs to a live line — the thread it connects to.',
  'Example: "horizon: these few days · now: the three-axis model is settled, shaping attention/threads · → thread: loom-memory".',
  'When a horizon passes: drop the entry, or — if it still matters — give it a thread.',
].join('\n')

/** The threads reminder: what the index holds, and what a line's own files are. */
const THREADS_SHAPE = [
  'threads/index.md lists only the lines still open — one line each: the thread and how to resume it. A finished line leaves the index.',
  'A thread\'s own files hold its current full picture, rewritten in place — not an append-only log.',
].join('\n')

/**
 * Which reminder a successfully read path carries, if any. Paths are workspace-relative as the
 * read tool reports them; `threads/` matches every file of a thread directory, the index included.
 */
export function shapeReminderFor(relPath: string): string | undefined {
  const path = relPath.replaceAll('\\', '/')
  if (path === residentFiles.attention) return ATTENTION_SHAPE
  if (path === residentFiles.threadsIndex || path.startsWith('threads/')) return THREADS_SHAPE
  return undefined
}

/**
 * Register the read-time shape reminder on the resident-context plugin.
 *
 * The observer runs after the read succeeded, and only appends to a decision that already
 * accepts the result as it stands — a blocked read or a rewritten content is left untouched, so
 * this can only ever add a trailing text block, never change what the read returned.
 */
export function registerResidentShapeReminders(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    if (exec.name !== 'read') return decision
    const filePath = (exec.arguments as { file_path?: unknown } | undefined)?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) return decision
    const reminder = shapeReminderFor(filePath)
    if (reminder === undefined) return decision

    const content: ContentBlock[] = decision.content ?? _result.content
    return {
      kind: 'accept',
      content: [...content, { type: 'text', text: `\n\n${reminder}` }],
      ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
    }
  })
}
