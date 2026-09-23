import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ManualClock } from '../src/clock/index.ts'
import { registerMaterials, defaultCaps } from '../src/materials/projection.ts'
import { createMemoryWriteTool } from '../src/materials/memory-write.ts'

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'loom-materials-'))
}

async function writeMaterial(workspace: string, rel: string, text: string): Promise<void> {
  const path = join(workspace, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

describe('materials projection', () => {
  it('injects materials in wake-bundle order; an absent material contributes empty text', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeMaterial(ws, 'identity/identity.md', 'I am the agent.')
      await writeMaterial(ws, 'attention/attention.md', 'Right now: testing.')
      await writeMaterial(ws, 'memory/memory.md', 'Settled fact.\n\n## Notes\n- alpha → memory/notes/alpha.md\n')
      // threads/index.md intentionally absent.

      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerMaterials(ctx, ws, defaultCaps)

      const assembly = await ctx.systemPrompt.assemble()
      const ours = assembly.contexts.filter(c =>
        ['identity', 'memory-core', 'memory-index', 'threads-index', 'attention'].includes(c.name))
      expect(ours.map(c => c.name)).toEqual(['identity', 'memory-core', 'memory-index', 'threads-index', 'attention'])
      expect(ours.find(c => c.name === 'identity')?.text).toBe('I am the agent.')
      expect(ours.find(c => c.name === 'memory-core')?.text).toBe('Settled fact.')
      expect(ours.find(c => c.name === 'memory-index')?.text).toContain('alpha → memory/notes/alpha.md')
      // Absent file: empty text, which contributes nothing to the rendered prompt.
      expect(ours.find(c => c.name === 'threads-index')?.text).toBe('')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('truncates a material that exceeds its cap', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeMaterial(ws, 'identity/identity.md', 'z'.repeat(5000))
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerMaterials(ctx, ws, { ...defaultCaps, identity: 100 })

      const assembly = await ctx.systemPrompt.assemble()
      const identity = assembly.contexts.find(c => c.name === 'identity')
      expect(identity?.text).toContain('over budget')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe('memory_write tool', () => {
  const agentExec = { agent: { id: 'session-x' } } as never

  it('writes a stamped note and upserts the memory index', async () => {
    const ws = await tmpWorkspace()
    try {
      const tool = createMemoryWriteTool(new ManualClock(1_000), ws)
      const result = await tool.execute({ concept: 'alpha', body: 'Alpha is a thing.', ref: 'ctx:42' }, agentExec)
      expect(result).toEqual({ concept: 'alpha', note: 'memory/notes/alpha.md', session: 'session-x' })

      const note = await readFile(join(ws, 'memory/notes/alpha.md'), 'utf8')
      expect(note).toContain('concept: alpha')
      expect(note).toContain('session: session-x')
      expect(note).toContain('written_at: 1000')
      expect(note).toContain('ref: ctx:42')
      expect(note).toContain('Alpha is a thing.')

      const memory = await readFile(join(ws, 'memory/memory.md'), 'utf8')
      expect(memory).toContain('- alpha → memory/notes/alpha.md')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('is idempotent on the index when the same concept is written twice', async () => {
    const ws = await tmpWorkspace()
    try {
      const tool = createMemoryWriteTool(new ManualClock(1_000), ws)
      await tool.execute({ concept: 'alpha', body: 'first' }, agentExec)
      await tool.execute({ concept: 'alpha', body: 'second' }, agentExec)
      const memory = await readFile(join(ws, 'memory/memory.md'), 'utf8')
      expect(memory.match(/- alpha → /g)?.length).toBe(1)
      // The note reflects the latest body.
      expect(await readFile(join(ws, 'memory/notes/alpha.md'), 'utf8')).toContain('second')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('rejects an unsafe concept slug', async () => {
    const ws = await tmpWorkspace()
    try {
      const tool = createMemoryWriteTool(new ManualClock(1_000), ws)
      await expect(tool.execute({ concept: '../escape', body: 'x' }, agentExec)).rejects.toThrow(/concept must match/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('rejects a call without an owning agent session', async () => {
    const ws = await tmpWorkspace()
    try {
      const tool = createMemoryWriteTool(new ManualClock(1_000), ws)
      await expect(tool.execute({ concept: 'alpha', body: 'x' }, {} as never)).rejects.toThrow(/owning agent session/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
