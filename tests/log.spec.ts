import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import * as log from '../src/log/index.ts'

describe('log sink', () => {
  it('writes each logger message to stderr, rendering errors and objects instead of [object]', async () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stderr.write

    try {
      const ctx = new Context()
      await ctx.plugin(log)
      ctx.logger('telegram').error(new Error('getUpdates failed'))
      ctx.logger('gateway').info('registered channel', { channel: 'telegram' })
    } finally {
      process.stderr.write = original
    }

    const out = written.join('')
    // The failing-channel case is the one this sink exists for: an Error must show its stack text.
    expect(out).toContain('error [telegram]')
    expect(out).toContain('getUpdates failed')
    // A structured arg is serialized, not collapsed to [object Object].
    expect(out).toContain('info [gateway]')
    expect(out).toContain('{"channel":"telegram"}')
  })
})
