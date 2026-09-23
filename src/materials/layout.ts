import { join } from 'node:path'

/**
 * Filesystem layout of the resident materials under the agent workspace. Each material is a
 * plain markdown file the agent maintains; the projection reads them into every turn's context.
 */
export const materialPaths = {
  identity: 'identity/identity.md',
  memory: 'memory/memory.md',
  threadsIndex: 'threads/index.md',
  attention: 'attention/attention.md',
} as const

/** Directory holding one file per memory concept, routed from the memory index. */
export const notesDir = 'memory/notes'

export function notePath(workspace: string, concept: string): string {
  return join(workspace, notesDir, `${concept}.md`)
}

export function materialPath(workspace: string, rel: string): string {
  return join(workspace, rel)
}

/**
 * memory.md holds curated knowledge (the "core") followed by a machine-maintained routing
 * table (the "index") under this heading. memory_write upserts routing lines here; the two
 * projection providers split the file on this marker.
 */
export const memoryIndexHeading = '## Notes'

export function memoryCoreOf(memoryText: string): string {
  const at = memoryText.indexOf(memoryIndexHeading)
  return (at === -1 ? memoryText : memoryText.slice(0, at)).trimEnd()
}

export function memoryIndexOf(memoryText: string): string {
  const at = memoryText.indexOf(memoryIndexHeading)
  return at === -1 ? '' : memoryText.slice(at).trimEnd()
}

/** A routing line: concept → its note path, relative to the workspace. */
export function memoryRoutingLine(concept: string): string {
  return `- ${concept} → ${notesDir}/${concept}.md`
}

/**
 * Upsert one concept's routing line into memory.md, creating the index section when absent.
 * Idempotent: an existing line for the concept is left as-is.
 */
export function upsertMemoryRouting(memoryText: string, concept: string): string {
  const line = memoryRoutingLine(concept)
  if (memoryText.includes(line)) return memoryText
  if (!memoryText.includes(memoryIndexHeading)) {
    const core = memoryText.trimEnd()
    return `${core}${core ? '\n\n' : ''}${memoryIndexHeading}\n${line}\n`
  }
  return `${memoryText.trimEnd()}\n${line}\n`
}
