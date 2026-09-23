import { describe, expect, it } from 'vitest'
import { applyBudget } from '../src/materials/budget.ts'
import {
  memoryCoreOf,
  memoryIndexOf,
  memoryRoutingLine,
  upsertMemoryRouting,
} from '../src/materials/layout.ts'

describe('memory.md core/index split', () => {
  const memory = 'Core knowledge line one.\nCore line two.\n\n## Notes\n- alpha → memory/notes/alpha.md\n'

  it('splits on the index heading', () => {
    expect(memoryCoreOf(memory)).toBe('Core knowledge line one.\nCore line two.')
    expect(memoryIndexOf(memory)).toBe('## Notes\n- alpha → memory/notes/alpha.md')
  })

  it('treats a file with no index heading as all core', () => {
    expect(memoryCoreOf('just core')).toBe('just core')
    expect(memoryIndexOf('just core')).toBe('')
  })
})

describe('upsertMemoryRouting', () => {
  it('creates the index section when absent', () => {
    const out = upsertMemoryRouting('Some core.', 'alpha')
    expect(out).toContain('## Notes')
    expect(out).toContain(memoryRoutingLine('alpha'))
    expect(memoryCoreOf(out)).toBe('Some core.')
  })

  it('appends a new routing line under an existing section', () => {
    const start = upsertMemoryRouting('core', 'alpha')
    const out = upsertMemoryRouting(start, 'beta')
    expect(out).toContain(memoryRoutingLine('alpha'))
    expect(out).toContain(memoryRoutingLine('beta'))
  })

  it('is idempotent for a concept already routed', () => {
    const once = upsertMemoryRouting('core', 'alpha')
    const twice = upsertMemoryRouting(once, 'alpha')
    expect(twice).toBe(once)
  })
})

describe('applyBudget', () => {
  it('leaves content within the cap untouched', () => {
    const r = applyBudget('hello', 1024)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('hello')
    expect(r.usedBytes).toBe(5)
  })

  it('truncates oversize content with a visible marker and stays valid text', () => {
    const big = 'x'.repeat(100)
    const r = applyBudget(big, 20)
    expect(r.truncated).toBe(true)
    expect(r.usedBytes).toBe(100)
    expect(r.text.startsWith('x'.repeat(20))).toBe(true)
    expect(r.text).toContain('over budget')
    // No lone/invalid surrogate: round-trips through UTF-16 without loss.
    expect(() => JSON.stringify(r.text)).not.toThrow()
  })

  it('counts bytes, not characters, for multi-byte content', () => {
    // '你' is 3 UTF-8 bytes; 4 of them = 12 bytes, over a 6-byte cap.
    const r = applyBudget('你你你你', 6)
    expect(r.usedBytes).toBe(12)
    expect(r.truncated).toBe(true)
  })
})
