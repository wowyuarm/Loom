import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defaultCaps } from '../src/resident-context/projection.ts'
import { registerResidentWriteBudget } from '../src/resident-context/write-budget.ts'

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'loom-write-budget-'))
}

function textOf(content: ContentBlock[]): string {
  return content.map(b => (b.type === 'text' ? b.text : '')).join('')
}

/**
 * Drive the post-execute waterfall directly: register the observer, then invoke the same waterfall
 * the tool registry runs after a dispatch. The observer's job is to append a usage notice to the
 * accepted result when the just-written resident file is filling toward its cap — so the test seeds
 * the file on disk, runs the waterfall for a `write` call naming it, and inspects the decision.
 */
async function runPostExecute(
  ctx: Context,
  workspace: string,
  name: string,
  filePath: string,
): Promise<{ kind: string; content?: ContentBlock[] }> {
  const exec = { name, arguments: { file_path: filePath }, agent: { id: 's' } } as never
  const result = { isError: false, value: null, content: [{ type: 'text', text: 'Updated file.' }] } as never
  return ctx.waterfall(
    ctx as never,
    'tools/post-execute',
    exec,
    result,
    () => Promise.resolve({ kind: 'accept' as const }),
  )
}

describe('resident write-budget observer', () => {
  it('appends a usage notice when a write fills a resident file past half its cap', async () => {
    const ws = await tmpWorkspace()
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      // A tiny attention cap so a small file already sits past the half-cap notice threshold.
      registerResidentWriteBudget(ctx, ws, { ...defaultCaps, attention: 100 })

      const attention = join(ws, 'attention/attention.md')
      await mkdir(join(ws, 'attention'), { recursive: true })
      await writeFile(attention, 'x'.repeat(70), 'utf8')

      const decision = await runPostExecute(ctx, ws, 'write', attention)
      expect(decision.kind).toBe('accept')
      expect(textOf(decision.content ?? [])).toMatch(/\[attention: [\d.]+\/[\d.]+ KiB\]/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('flags an over-budget write with a prune-and-truncation notice', async () => {
    const ws = await tmpWorkspace()
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      registerResidentWriteBudget(ctx, ws, { ...defaultCaps, attention: 100 })

      const attention = join(ws, 'attention/attention.md')
      await mkdir(join(ws, 'attention'), { recursive: true })
      await writeFile(attention, 'x'.repeat(300), 'utf8')

      const decision = await runPostExecute(ctx, ws, 'edit', attention)
      expect(textOf(decision.content ?? [])).toContain('over budget')
      expect(textOf(decision.content ?? [])).toContain('truncated at the cap')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('flags memory core and index by their own segment names and caps', async () => {
    const ws = await tmpWorkspace()
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      registerResidentWriteBudget(ctx, ws, { ...defaultCaps, memoryCore: 100, memoryIndex: 100 })

      const memory = join(ws, 'memory/memory.md')
      await mkdir(join(ws, 'memory'), { recursive: true })
      await writeFile(memory, `${'c'.repeat(70)}\n\n## Notes\n${'- x → memory/notes/x.md\n'.repeat(4)}`, 'utf8')

      const decision = await runPostExecute(ctx, ws, 'write', memory)
      const text = textOf(decision.content ?? [])
      expect(text).toMatch(/\[memory-core: /)
      expect(text).toMatch(/\[memory-index: /)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('stays silent for a resident file with ample room', async () => {
    const ws = await tmpWorkspace()
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      registerResidentWriteBudget(ctx, ws, defaultCaps)

      const attention = join(ws, 'attention/attention.md')
      await mkdir(join(ws, 'attention'), { recursive: true })
      await writeFile(attention, 'small', 'utf8')

      const decision = await runPostExecute(ctx, ws, 'write', attention)
      expect(textOf(decision.content ?? [])).not.toMatch(/KiB\]/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('ignores writes to files outside the resident set', async () => {
    const ws = await tmpWorkspace()
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      registerResidentWriteBudget(ctx, ws, { ...defaultCaps, attention: 100 })

      const other = join(ws, 'library/notes.md')
      await mkdir(join(ws, 'library'), { recursive: true })
      await writeFile(other, 'x'.repeat(300), 'utf8')

      const decision = await runPostExecute(ctx, ws, 'write', other)
      expect(textOf(decision.content ?? [])).not.toMatch(/KiB\]/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
