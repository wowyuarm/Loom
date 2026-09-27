import { join } from 'node:path'

/**
 * Filesystem layout of the resident files under the agent workspace. Each file is a
 * plain markdown file the agent maintains; the projection reads them into every turn's context.
 */
export const residentFiles = {
  identity: 'identity/identity.md',
  memory: 'memory/memory.md',
  threadsIndex: 'threads/index.md',
  attention: 'attention/attention.md',
} as const

/** Directory holding one file per memory concept, routed from the memory index. */
export const notesDir = 'memory/notes'

export function residentPath(workspace: string, rel: string): string {
  return join(workspace, rel)
}

/**
 * memory.md holds curated knowledge (the "core") followed by a routing table (the "index") under
 * this heading, both maintained by the agent with the generic file tools. The two projection
 * providers, and the write-budget observer, split the file on this marker.
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
