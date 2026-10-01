import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as OrientationPlugin from '../src/orientation/index.ts'
import { DEFAULT_ORIENTATION } from '../src/orientation/index.ts'

describe('orientation section', () => {
  it('contributes the mechanical orientation as a system-prompt section', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(OrientationPlugin)
    await vi.waitFor(() => { expect(ctx.systemPrompt).toBeDefined() })

    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'loom:orientation')
    expect(section?.text).toBe(DEFAULT_ORIENTATION)
  })

  it('states the shared-vocabulary rule for writing to the person', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(OrientationPlugin)
    await vi.waitFor(() => { expect(ctx.systemPrompt).toBeDefined() })

    const assembly = await ctx.systemPrompt.assemble()
    const text = assembly.sections.find(s => s.name === 'loom:orientation')?.text ?? ''
    // The rule is why a person can read what the agent sends: everyday words or terms they used,
    // no private shorthand, and the agent's own machinery named only when reporting a file or
    // when they raised it first. Anchored on the load-bearing clauses so a rewrite cannot drop it.
    expect(text).toContain('use only words they already know')
    expect(text).toContain('Do not coin compressed private shorthand')
    expect(text).toContain('as unknown to them by default')
  })

  it('lets a deployment override the orientation text', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(OrientationPlugin, { text: 'custom orientation' })
    await vi.waitFor(() => { expect(ctx.systemPrompt).toBeDefined() })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(s => s.name === 'loom:orientation')?.text).toBe('custom orientation')
  })
})
