import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Clock } from '../contracts/index.ts'
import {
  residentPath,
  residentFiles,
  notePath,
  notesDir,
  upsertMemoryRouting,
} from './layout.ts'

// A concept is used as a filename, so constrain it to a safe slug (no separators, no traversal).
const CONCEPT_RE = /^[a-z0-9][a-z0-9_-]*$/

interface Stamp {
  concept: string
  session: string
  writtenAt: number
  ref?: string
}

function noteWithStamp(body: string, stamp: Stamp): string {
  const lines = [
    '---',
    `concept: ${stamp.concept}`,
    `session: ${stamp.session}`,
    `written_at: ${stamp.writtenAt}`,
    ...(stamp.ref === undefined ? [] : [`ref: ${stamp.ref}`]),
    '---',
    '',
    body.trimEnd(),
    '',
  ]
  return lines.join('\n')
}

/**
 * Register `memory_write`: the one tool that maintains the memory unit as a pair — the note
 * file plus its routing line in the index — and stamps provenance. attention and threads are
 * single files the agent edits with the generic fs tools; only this pairing needs a tool.
 */
export function registerMemoryWrite(ctx: Context, workspace: string): void {
  ctx.tools.register(createMemoryWriteTool(ctx.clock, workspace))
}

export function createMemoryWriteTool(clock: Clock, workspace: string): ToolDefinition {
  return defineTool({
    name: 'memory_write',
    description:
      'Record settled knowledge about one concept into long-term memory. Writes the note and '
      + 'upserts its routing line in the memory index. Pass `ref` when the knowledge comes from a '
      + 'specific context search hit so it can be re-expanded precisely later.',
    parameters: {
      concept: {
        type: 'string',
        required: true,
        description: 'Slug identifying the concept (lowercase letters, digits, - and _). Becomes the note filename.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The note content in markdown.',
      },
      ref: {
        type: 'string',
        description: 'Optional context reference this knowledge was distilled from.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          concept: { type: 'string', required: true },
          note: { type: 'string', required: true },
          session: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Wrote memory note "${value.concept}" → ${value.note}` }],
    },
    async execute(args, exec) {
      const { concept, body, ref } = args
      if (!CONCEPT_RE.test(concept)) {
        throw new Error(`memory_write: concept must match ${CONCEPT_RE} (got ${JSON.stringify(concept)})`)
      }
      if (!exec.agent) {
        // The provenance stamp needs the owning session id; a non-agent caller has none.
        throw new Error('memory_write requires an owning agent session')
      }
      const session = exec.agent.id
      const stamp: Stamp = { concept, session, writtenAt: clock.now(), ...(ref === undefined ? {} : { ref }) }

      // Write the note first, then upsert the index. A crash in between leaves a benign orphan
      // note (self-healing on the next write); v1 keeps no journal.
      const note = notePath(workspace, concept)
      await mkdir(dirname(note), { recursive: true })
      await writeFile(note, noteWithStamp(body, stamp), 'utf8')

      const memoryFile = residentPath(workspace, residentFiles.memory)
      const current = await readMemoryOrEmpty(memoryFile)
      await writeFile(memoryFile, upsertMemoryRouting(current, concept), 'utf8')

      return { concept, note: `${notesDir}/${concept}.md`, session }
    },
  })
}

async function readMemoryOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(dirname(path), { recursive: true })
      return ''
    }
    throw err
  }
}
