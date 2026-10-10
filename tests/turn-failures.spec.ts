/**
 * turn-failures: a turn that failed is reported to operations and to the individual.
 *
 * The unit layer pins what each reason kind renders and what the attention record says — a fact,
 * never an instruction. The integration layer boots the real stack over a mock model and proves the
 * wiring the way the deployment runs it: a failed turn warns once on the sink systemd captures, a
 * completed turn says nothing, a record that cannot be written cannot fail the turn, and the
 * record's version is committed by the next successful turn rather than by the one that wrote it.
 *
 * The log assertions ride `process.stderr` on purpose: that is the journal's own path, so a test
 * that passes here is evidence for the acceptance criterion, not a stand-in for it.
 */

import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'

import * as LogPlugin from '../src/log/index.ts'
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as WorkspaceHistoryPlugin from '../src/workspace-history/index.ts'
import * as TurnFailuresPlugin from '../src/turn-failures/index.ts'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse } from './support/mock-adapter.ts'

const ATTENTION = 'attention/attention.md'

/** A model call that fails the way the live deployment's did: a rate-limited route. */
function errorResponse(code: string, message: string, status?: number): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code, message, ...(status === undefined ? {} : { status }) } } }]
}

const RATE_LIMITED = errorResponse('RATE_LIMIT', '429: {"code":null,"message":"WorkBuddy: 您的使用量已超出频率限制"}')

/** A step that reached its output ceiling; the turn itself may still have been carried to a finish. */
const HIT_CEILING: StreamChunk[] = [{ type: 'finish', reason: { kind: 'max-tokens' } }]

describe('turn-failures: what a reason renders as', () => {
  it('names the routing code, the status when there was one, and the upstream text', () => {
    expect(TurnFailuresPlugin.failureDetail({ kind: 'error', error: { code: 'SERVER', status: 502, message: 'Bad Gateway' } }))
      .toBe('SERVER (HTTP 502) — Bad Gateway')
    // A transport failure never reached a status: printing one would invent a fact.
    expect(TurnFailuresPlugin.failureDetail({ kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } }))
      .toBe('TRANSPORT — fetch failed')
  })

  it('flattens and bounds a long multi-line upstream message', () => {
    const detail = TurnFailuresPlugin.failureDetail({
      kind: 'error',
      error: { code: 'SERVER', message: `first line\nsecond\tline\n${'x'.repeat(5000)}` },
    })
    expect(detail).not.toContain('\n')
    expect(detail.length).toBeLessThan(230)
    expect(detail).toContain('first line second line')
    expect(detail.endsWith('…')).toBe(true)
  })

  it('records a fact only for the two reasons that mean the answer was never produced', () => {
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'error', error: { code: 'SERVER', message: 'Bad Gateway' } }))
      .toMatchObject({ kind: 'record', line: '- (harness) turn 7 failed: SERVER — Bad Gateway' })
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'interrupted' }))
      .toMatchObject({ kind: 'record', line: '- (harness) turn 7 failed: interrupted' })
  })

  it('never calls a turn failed when its reason does not say so', () => {
    // A step hit its output ceiling and upstream says a plugin may still have continued the turn to
    // a good finish: writing "failed" here would put a falsehood in the channel reserved for facts.
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'max-tokens' }))
      .toEqual({ kind: 'warn', message: 'turn 7 hit the output-token ceiling' })
    // A refused pre-step did not run the work, but the reason carries no cause to quote, and
    // "blocked" on its own is not something the individual can use.
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'blocked' }))
      .toEqual({ kind: 'warn', message: 'turn 7 blocked: a pre-step was refused' })
    // Neither of the two reaches the individual: a warn has no line to append.
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'max-tokens' })).not.toHaveProperty('line')
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'blocked' })).not.toHaveProperty('line')
  })

  it('says nothing for an ending that is not a fault', () => {
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'completed' })).toEqual({ kind: 'silent' })
    // A person's own stop is not the agent's failure.
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'aborted', reason: { kind: 'user' } })).toEqual({ kind: 'silent' })
    // A fork seed is not a live ending; the loop never emits this marker.
    expect(TurnFailuresPlugin.reportFor(7, { kind: 'forked' })).toEqual({ kind: 'silent' })
  })

  it('reports an unfamiliar ending as the bare fact it is, never as a failure', () => {
    const unseen = { kind: 'something-new' } as unknown as TurnEndReason
    expect(TurnFailuresPlugin.reportFor(7, unseen)).toEqual({ kind: 'warn', message: 'turn 7 ended: something-new' })
  })

  it('records a fact and nothing that reads as advice', () => {
    const report = TurnFailuresPlugin.reportFor(96, { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } })
    expect(report.kind).toBe('record')
    const line = report.kind === 'record' ? report.line : ''
    expect(line).toBe('- (harness) turn 96 failed: RATE_LIMIT — slow down')
    expect(line).not.toMatch(/should|must|you need|please|recommend|next time/iu)
  })
})

interface Harness {
  ctx: Context
  mock: MockAdapter
  workspace: string
  /** Everything the deployment wrote to stderr, which is what systemd captures as the journal. */
  stderr: string[]
  run: (text: string) => Promise<void>
  commits: () => string[]
  report: () => string[]
  dispose: () => Promise<void>
}

/** Boot the stack the deployment runs, with the failure reporter in it and a scripted model. */
async function boot(script: StreamChunk[][], options: { recordWorkspace?: string } = {}): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'loom-turn-failures-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const stderr: string[] = []
  const mock = new MockAdapter(script)
  const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> => {
    fibers.push(await ctx.plugin(plugin as never, config as never))
  }

  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stderr.write

  try {
    // First row in the deployment's own manifest, so the sink is in place before anything logs.
    await load(LogPlugin)
    await load(LlmRuntime)
    await load(SessionStore)
    await load(SessionProjectionRegistry)
    await load(SessionPersistence, { root: join(workspace, '.sessions') })
    await load(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
    await load(TokenMeter)
    await load(SystemPrompt)
    await load(ToolRuntime)
    await load(AgentRegistry)
    await load(AgentLoop, { agents: [] })
    await load(Storage)
    await load(StorageSqlite, { path: ':memory:' })
    await load(StorageDomain, { backend: 'sqlite' })
    ctx.llm.registerAdapter(['mock'], mock)
    await load(ClockPlugin)
    await load(RuntimeStatePlugin)
    await load(ResidentContextPlugin, { workspace })
    await load(WorkspaceHistoryPlugin, { workspace })
    // The recorder can be pointed at its own root, so a deployment whose record path is broken is
    // testable without breaking the workspace the agent itself reads and writes.
    await load(TurnFailuresPlugin, { workspace: options.recordWorkspace ?? workspace })
    provideFakePresets(ctx)
    await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })
    await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })

    // The repository is created by the deployment, not by the plugin: hand it over initialized, the
    // way the instance-side step does.
    execFileSync('git', ['init', '-q', workspace], { encoding: 'utf8' })

    const agent = ctx.agentRuntime.current()
    return {
      ctx,
      mock,
      workspace,
      stderr,
      run: async (text: string) => {
        agent?.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent?.whenIdle()
        // The record rides a promise chain the handler extends, and the snapshot rides its own.
        await new Promise(resolve => setTimeout(resolve, 250))
      },
      commits: () => {
        try {
          return execFileSync('git', ['log', '--pretty=format:%s'], { cwd: workspace, encoding: 'utf8' })
            .split('\n').filter(Boolean)
        } catch {
          // A repository with no commits yet is the expected state after a failed turn.
          return []
        }
      },
      report: () => stderr.filter(line => line.includes('[turn-failures]')),
      dispose: async () => {
        process.stderr.write = originalWrite
        for (const fiber of fibers.reverse()) await fiber.dispose()
        await rm(workspace, { recursive: true, force: true })
      },
    }
  } catch (error) {
    process.stderr.write = originalWrite
    throw error
  }
}

const EXISTING = '# 当前\n\n- **▶ 在办**：星露谷装 mod（等他选下一批）。\n'

describe('turn-failures: the wiring, over a real turn', () => {
  it('warns once for a failed turn and leaves one fact in the attention material', async () => {
    const harness = await boot([RATE_LIMITED])
    try {
      await writeFile(join(harness.workspace, ATTENTION), EXISTING, 'utf8')
      await harness.run('hello')

      const reported = harness.report()
      const warned = reported.filter(line => line.includes(' warn [turn-failures]'))
      expect(warned).toHaveLength(1)
      expect(warned[0]).toContain('failed: RATE_LIMIT')
      expect(warned[0]).toContain('WorkBuddy')

      // The existing material is untouched and still first; exactly one line was added.
      const after = await readFile(join(harness.workspace, ATTENTION), 'utf8')
      expect(after.startsWith(EXISTING)).toBe(true)
      const added = after.slice(EXISTING.length).trim().split('\n')
      expect(added).toHaveLength(1)
      expect(added[0]).toMatch(/^- \(harness\) turn \d+ failed: RATE_LIMIT — /u)

      // The known limitation, as the deployment actually behaves: the record is on disk but no
      // snapshot carries it, because a snapshot rides a completed turn and this one failed.
      expect(harness.commits()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('commits the record with the next successful turn, attributing it to that turn', async () => {
    const harness = await boot([RATE_LIMITED, textResponse('noted')])
    try {
      await writeFile(join(harness.workspace, ATTENTION), EXISTING, 'utf8')
      await harness.run('hello')
      const record = (await readFile(join(harness.workspace, ATTENTION), 'utf8')).slice(EXISTING.length).trim()
      expect(record).toContain('failed: RATE_LIMIT')
      // Nothing committed the failed turn.
      expect(harness.commits()).toEqual([])

      await harness.run('again')

      // Data is not lost: the next successful turn's snapshot carries the record. Its version is
      // attributed to that turn, which is the accepted, documented limitation.
      const subjects = harness.commits()
      expect(subjects).toHaveLength(1)
      expect(subjects[0]).toMatch(/^turn \d+: /u)
      const committed = execFileSync('git', ['show', '--pretty=format:', '--', ATTENTION], { cwd: harness.workspace, encoding: 'utf8' })
      expect(committed).toContain('failed: RATE_LIMIT')
      // The successful turn reported nothing of its own: only the failure is announced.
      expect(harness.report().filter(line => line.includes(' failed:'))).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('says nothing at all for a turn that completes', async () => {
    const harness = await boot([textResponse('noted')])
    try {
      await writeFile(join(harness.workspace, ATTENTION), EXISTING, 'utf8')
      await harness.run('hello')

      expect(harness.report().filter(line => line.includes(' warn [turn-failures]'))).toEqual([])
      // Not one byte of the agent's material changed on a successful turn.
      expect(await readFile(join(harness.workspace, ATTENTION), 'utf8')).toBe(EXISTING)
    } finally {
      await harness.dispose()
    }
  })

  it('warns about a step that hit its output ceiling without writing the individual a word', async () => {
    const harness = await boot([HIT_CEILING])
    try {
      await writeFile(join(harness.workspace, ATTENTION), EXISTING, 'utf8')
      await harness.run('hello')

      const warned = harness.report().filter(line => line.includes(' warn [turn-failures]'))
      expect(warned).toHaveLength(1)
      expect(warned[0]).toContain('hit the output-token ceiling')
      // The whole point of the correction: no failure is claimed, and not one byte of the
      // individual's material changes on a turn whose reason does not say it failed.
      expect(warned[0]).not.toContain('failed')
      expect(await readFile(join(harness.workspace, ATTENTION), 'utf8')).toBe(EXISTING)
    } finally {
      await harness.dispose()
    }
  })

  it('reports a record it cannot write and lets the turn finish untouched', async () => {
    // A file where the record's directory belongs: the append fails for real, not by a mock, and
    // the agent's own workspace is untouched by it.
    const broken = await mkdtemp(join(tmpdir(), 'loom-turn-failures-broken-'))
    await writeFile(join(broken, 'attention'), 'not a directory', 'utf8')

    const harness = await boot([RATE_LIMITED, textResponse('noted')], { recordWorkspace: broken })
    try {
      await harness.run('hello')

      const reported = harness.report()
      expect(reported.some(line => line.includes('failed: RATE_LIMIT'))).toBe(true)
      expect(reported.some(line => line.includes('record not written'))).toBe(true)

      // The failed turn did not become a thrown error: the next turn still runs normally, and the
      // failure is still announced exactly once.
      await harness.run('again')
      expect(harness.report().filter(line => line.includes(' failed:'))).toHaveLength(1)
      expect(harness.commits()).toHaveLength(1)
    } finally {
      await harness.dispose()
      await rm(broken, { recursive: true, force: true })
    }
  })
})
