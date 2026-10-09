import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { registerResidentShapeReminders, shapeReminderFor } from '../src/resident-context/shape-reminders.ts'

function textOf(content: ContentBlock[]): string {
  return content.map(b => (b.type === 'text' ? b.text : '')).join('')
}

/**
 * Drive the post-execute waterfall the way the tool registry does after a read: the observer's
 * job is to append the shape reminder to an accepted read of attention or a threads file, and
 * leave every other result exactly as it stands.
 */
async function runPostExecute(
  ctx: Context,
  name: string,
  filePath: string,
): Promise<{ kind: string; content?: ContentBlock[] }> {
  const exec = { name, arguments: { file_path: filePath }, agent: { id: 's' } } as never
  const result = { isError: false, value: null, content: [{ type: 'text', text: 'the file' }] } as never
  return ctx.waterfall(
    ctx as never,
    'tools/post-execute',
    exec,
    result,
    () => Promise.resolve({ kind: 'accept' as const }),
  )
}

describe('resident shape reminders', () => {
  it('names each resident target and nothing else', () => {
    expect(shapeReminderFor('attention/attention.md')).toBeDefined()
    expect(shapeReminderFor('threads/index.md')).toBeDefined()
    expect(shapeReminderFor('threads/loom-memory/index.md')).toBeDefined()
    // Absolute or backslash forms of the same files still count.
    expect(shapeReminderFor(join('attention', 'attention.md'))).toBeDefined()
    expect(shapeReminderFor('/home/x/attention/attention.md')).toBeUndefined()
    expect(shapeReminderFor('memory/memory.md')).toBeUndefined()
    expect(shapeReminderFor('library/raven-proactivity.md')).toBeUndefined()
    // A lookalike must not trigger.
    expect(shapeReminderFor('attention/notes.md')).toBeUndefined()
  })

  it('appends the attention reminder to a successful read of attention.md', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loom-shape-'))
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      registerResidentShapeReminders(ctx)

      const decision = await runPostExecute(ctx, 'read', 'attention/attention.md')
      expect(decision.kind).toBe('accept')
      const text = textOf(decision.content ?? [])
      expect(text).toContain('the file')
      expect(text).toContain('horizon')
      expect(text).toContain('→ thread')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('appends the threads reminder to a read of any thread file, and stays silent elsewhere', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loom-shape-'))
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      registerResidentShapeReminders(ctx)

      for (const path of ['threads/index.md', 'threads/agent-memory-study/index.md']) {
        const decision = await runPostExecute(ctx, 'read', path)
        expect(textOf(decision.content ?? [])).toContain('only the lines still open')
      }

      const other = await runPostExecute(ctx, 'read', 'memory/memory.md')
      // Untouched: the accept carries no content of its own — the registry keeps the read's.
      expect(other.content).toBeUndefined()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('leaves a write, an error, and an upstream block alone', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loom-shape-'))
    try {
      const ctx = new Context()
      await ctx.plugin(Tools)
      registerResidentShapeReminders(ctx)

      // A write to the same file: the reminder rides reads, not writes.
      const write = await runPostExecute(ctx, 'write', 'attention/attention.md')
      expect(write.content).toBeUndefined()

      // An upstream decision that already blocked: unchanged, reminder or not.
      const exec = { name: 'read', arguments: { file_path: 'attention/attention.md' }, agent: { id: 's' } } as never
      const result = { isError: false, value: null, content: [] } as never
      const blocked = await ctx.waterfall(
        ctx as never, 'tools/post-execute', exec, result,
        () => Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'no' }] }),
      )
      expect(blocked.kind).toBe('block')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
