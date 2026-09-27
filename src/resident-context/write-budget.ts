import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { budgetNotice, byteLength } from './budget.ts'
import type { ResidentContextCaps } from './projection.ts'
import { residentFiles, residentPath, memoryCoreOf, memoryIndexOf } from './layout.ts'

/**
 * The write-side half of the resident-file budget. The projection already truncates and flags an
 * oversized file when it is READ into context; this flags it the moment it is WRITTEN, so the agent
 * hears "prune this" while it still holds why — not a turn later when the file comes back clipped.
 *
 * The agent maintains every resident file — attention, threads, and memory with its index — using
 * the generic `write`/`edit` tools; there is no dedicated memory tool, so the feedback has to ride
 * those tools. It is a `tools/post-execute` observer that, after a successful write/edit to a
 * resident file, measures the result and appends a usage notice to the tool result when the file
 * is filling toward or past its cap. It never blocks the write: feedback over rejection
 * (DESIGN §7) — the file is already on disk and the notice tells the agent to trim it, matching
 * what the projection will otherwise do on its own.
 */
export function registerResidentWriteBudget(
  ctx: Context,
  workspace: string,
  caps: ResidentContextCaps,
): void {
  const targets = residentTargets(workspace, caps)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // Only successful full-file writes and edits touch a file on disk in a way worth measuring.
    if (decision.kind !== 'accept') return decision
    if (exec.name !== 'write' && exec.name !== 'edit') return decision
    const filePath = (exec.arguments as { file_path?: unknown } | undefined)?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) return decision
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(workspace, filePath)
    const target = targets.find(t => t.path === abs)
    if (target === undefined) return decision

    const notices = await target.notices()
    if (notices.length === 0) return decision

    const content: ContentBlock[] = decision.content ?? result.content
    return {
      kind: 'accept',
      content: [...content, { type: 'text', text: `\n\n${notices.join('\n')}` }],
      ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
    }
  })
}

interface ResidentTarget {
  path: string
  notices(): Promise<string[]>
}

/**
 * The resident files this observer watches, each resolved to an absolute path and paired with a
 * function that reads it fresh and returns any budget notices. memory.md is split like the
 * projection splits it — core and index carry separate caps — so a write that fills either segment
 * is flagged for that segment by name.
 */
function residentTargets(workspace: string, caps: ResidentContextCaps): ResidentTarget[] {
  const at = (rel: string): string => resolve(residentPath(workspace, rel))
  const read = async (path: string): Promise<string> => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return ''
    }
  }
  const single = (rel: string, name: string, cap: number): ResidentTarget => ({
    path: at(rel),
    notices: async () => noticesFor([[name, await read(at(rel)), cap]]),
  })
  return [
    single(residentFiles.identity, 'identity', caps.identity),
    single(residentFiles.threadsIndex, 'threads-index', caps.threadsIndex),
    single(residentFiles.attention, 'attention', caps.attention),
    {
      path: at(residentFiles.memory),
      notices: async () => {
        const text = await read(at(residentFiles.memory))
        return noticesFor([
          ['memory-core', memoryCoreOf(text), caps.memoryCore],
          ['memory-index', memoryIndexOf(text), caps.memoryIndex],
        ])
      },
    },
  ]
}

function noticesFor(segments: ReadonlyArray<readonly [string, string, number]>): string[] {
  const out: string[] = []
  for (const [name, text, cap] of segments) {
    const notice = budgetNotice(name, byteLength(text), cap)
    if (notice !== undefined) out.push(notice)
  }
  return out
}
