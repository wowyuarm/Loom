import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ManualClock } from '../src/clock/index.ts'
import { registerResidentContext, defaultCaps } from '../src/resident-context/projection.ts'
import { ensureWorkspaceScaffold } from '../src/resident-context/scaffold.ts'
import { createMemoryWriteTool } from '../src/resident-context/memory-write.ts'

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'loom-resident-context-'))
}

async function writeResidentFile(workspace: string, rel: string, text: string): Promise<void> {
  const path = join(workspace, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

describe('resident-context projection', () => {
  it('injects dynamic materials as contexts in wake-bundle order; an absent file contributes empty text', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'I am the agent.')
      await writeResidentFile(ws, 'attention/attention.md', 'Right now: testing.')
      await writeResidentFile(ws, 'memory/memory.md', 'Settled fact.\n\n## Notes\n- alpha → memory/notes/alpha.md\n')
      // threads/index.md intentionally absent.

      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, defaultCaps)

      const assembly = await ctx.systemPrompt.assemble()
      const ours = assembly.contexts.filter(c =>
        ['memory-core', 'memory-index', 'threads-index', 'attention'].includes(c.name))
      // identity is no longer a context; it is an always-present system section (see below).
      expect(ours.map(c => c.name)).toEqual(['memory-core', 'memory-index', 'threads-index', 'attention'])
      expect(ours.find(c => c.name === 'memory-core')?.text).toContain('Settled fact.')
      // A file with ample room carries no usage line — the signal is silent until it fills.
      expect(ours.find(c => c.name === 'memory-core')?.text).not.toMatch(/KiB\]/)
      expect(ours.find(c => c.name === 'memory-index')?.text).toContain('alpha → memory/notes/alpha.md')
      // Absent file: empty text, which contributes nothing to the rendered prompt (no usage line).
      expect(ours.find(c => c.name === 'threads-index')?.text).toBe('')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('injects identity as an always-present system section, read fresh and kept literal', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'I am the agent.')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, defaultCaps)

      const assembly = await ctx.systemPrompt.assemble()
      const identity = assembly.sections.find(s => s.name === 'loom:identity')
      // identity is read fresh from its file, kept literal so a stray brace cannot break assembly.
      expect(identity?.text).toBe('I am the agent.')
      expect(identity?.interpolate).toBe(false)
      // The memory-model guidance is no longer a system section — how to keep the files lives in
      // the workspace's own AGENTS.md, surfaced on-touch, not in the prompt.
      expect(assembly.sections.find(s => s.name === 'loom:memory-guidance')).toBeUndefined()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('splices the first-waking prompt only while bootstrap.md is present, ahead of identity', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'I am the agent.')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, defaultCaps)

      // Absent: the first-waking prompt contributes nothing.
      let assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find(s => s.name === 'loom:bootstrap')?.text ?? '').toBe('')

      // Present: its content renders literally and leads, ahead of identity.
      await writeResidentFile(ws, 'bootstrap.md', 'You are waking for the first time.')
      assembly = await ctx.systemPrompt.assemble()
      const boot = assembly.sections.find(s => s.name === 'loom:bootstrap')
      expect(boot?.text).toBe('You are waking for the first time.')
      expect(boot?.interpolate).toBe(false)
      const order = assembly.sections.map(s => s.name)
      expect(order.indexOf('loom:bootstrap')).toBeLessThan(order.indexOf('loom:identity'))
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('shows a usage line once a material fills toward its cap', async () => {
    const ws = await tmpWorkspace()
    try {
      // attention past half of a small cap: the prune signal appears, before the hard wall.
      await writeResidentFile(ws, 'attention/attention.md', 'x'.repeat(70))
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, { ...defaultCaps, attention: 100 })

      const assembly = await ctx.systemPrompt.assemble()
      const attention = assembly.contexts.find(c => c.name === 'attention')
      expect(attention?.text).toMatch(/\[attention: [\d.]+\/[\d.]+ KiB\]/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('truncates a resident file that exceeds its cap', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'z'.repeat(5000))
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, { ...defaultCaps, identity: 100 })

      const assembly = await ctx.systemPrompt.assemble()
      const identity = assembly.sections.find(s => s.name === 'loom:identity')
      expect(identity?.text).toContain('over budget')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe('workspace scaffold', () => {
  it('materializes the skeleton once and never re-seeds a scaffolded workspace', async () => {
    const ws = await tmpWorkspace()
    try {
      ensureWorkspaceScaffold(ws)
      // Material files exist (empty), plus the housekeeping guide and the first-waking prompt.
      expect(await readFile(join(ws, 'identity/identity.md'), 'utf8')).toBe('')
      expect(await readFile(join(ws, 'attention/attention.md'), 'utf8')).toBe('')
      expect(existsSync(join(ws, 'memory/notes'))).toBe(true)
      expect(await readFile(join(ws, 'AGENTS.md'), 'utf8')).toContain('Keeping your workspace')
      expect(await readFile(join(ws, 'bootstrap.md'), 'utf8')).toContain('waking for the first time')

      // Once born — identity written, bootstrap.md deleted — a second call must leave it untouched.
      await writeFile(join(ws, 'identity/identity.md'), 'I am the agent.', 'utf8')
      await rm(join(ws, 'bootstrap.md'))
      ensureWorkspaceScaffold(ws)
      expect(await readFile(join(ws, 'identity/identity.md'), 'utf8')).toBe('I am the agent.')
      expect(existsSync(join(ws, 'bootstrap.md'))).toBe(false)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('never overwrites a live individual and never drops it back into birth', async () => {
    const ws = await tmpWorkspace()
    try {
      // A workspace from before this feature: it holds an identity but no AGENTS.md yet.
      await writeResidentFile(ws, 'identity/identity.md', 'I am already someone.')
      ensureWorkspaceScaffold(ws)
      // Identity is preserved, the housekeeping guide is added, and no first-waking prompt appears.
      expect(await readFile(join(ws, 'identity/identity.md'), 'utf8')).toBe('I am already someone.')
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(true)
      expect(existsSync(join(ws, 'bootstrap.md'))).toBe(false)
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
