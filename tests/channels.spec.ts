import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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
import * as ChannelGatewayPlugin from '@wowyuarm/dsh-channel-gateway'
import type {
  Channel,
  ChannelAttachment,
  ChannelInbox,
  ChannelSendResult,
  InboundMessage,
  OutboundMessage,
  ResolvedAttachment,
} from '@wowyuarm/dsh-channel-gateway'
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as ChannelsPlugin from '../src/channels/index.ts'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/** A scripted in-memory transport: hand it inbound messages, read back what was sent. */
class MockChannel implements Channel {
  readonly name = 'mock-chat'
  readonly capabilities = {
    attachments: true,
    attachmentDownload: true,
    buttons: false,
    edit: false,
    replyTo: true,
    maxTextLength: 4096,
  }
  private inbox: ChannelInbox | undefined
  readonly sent: OutboundMessage[] = []
  private nextId = 1

  async start(inbox: ChannelInbox): Promise<void> {
    this.inbox = inbox
  }
  async stop(): Promise<void> {
    this.inbox = undefined
  }
  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    this.sent.push(message)
    return { providerMessageId: `out-${this.nextId++}` }
  }
  async resolveAttachment(attachment: ChannelAttachment): Promise<ResolvedAttachment> {
    return { bytes: new TextEncoder().encode(`bytes-of-${attachment.ref ?? 'unknown'}`) }
  }
  receive(message: InboundMessage): void {
    if (this.inbox === undefined) throw new Error('channel not started')
    this.inbox.deliver(message)
  }
}

function inbound(providerMessageId: string, text: string): InboundMessage {
  return {
    channel: 'mock-chat',
    providerMessageId,
    actor: { id: 'user-1', displayName: 'Alice' },
    place: { route: 'conv-42', kind: 'direct' },
    visibility: 'private',
    text,
    timestamp: new Date().toISOString(),
  }
}

function inboundWithImage(providerMessageId: string, text: string, ref: string): InboundMessage {
  return { ...inbound(providerMessageId, text), attachments: [{ kind: 'image', ref, mimeType: 'image/png' }] }
}

/** The concatenated text of the first user message the model was asked to generate against. */
function firstUserText(mock: MockAdapter): string {
  const message = mock.requests[0]?.messages.find(m => m.source?.kind === 'user')
  return (message?.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

interface Harness {
  ctx: Context
  channel: MockChannel
  mock: MockAdapter
  workspace: string
  dispose: () => Promise<void>
}

async function bootWithChannels(mock: MockAdapter): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'loom-ch-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> => {
    fibers.push(await ctx.plugin(plugin as never, config as never))
  }

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
  provideFakePresets(ctx)
  await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })
  await load(ChannelGatewayPlugin, { allow: ['*'] })
  await load(ChannelsPlugin, { workspace })

  await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })

  const channel = new MockChannel()
  const unregister = ctx.channels.register(channel)
  await vi.waitFor(() => { expect(ctx.channels.channels.map(c => c.name)).toContain('mock-chat') })

  return {
    ctx,
    channel,
    mock,
    workspace,
    dispose: async () => {
      unregister()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

describe('channels consumer', () => {
  it('accepts an inbound message, delivers it to the agent, and dedups a repeat', async () => {
    const h = await bootWithChannels(new MockAdapter([textResponse('ok'), textResponse('ok')]))
    try {
      const agent = h.ctx.agentRuntime.current()

      h.channel.receive(inbound('m1', 'hello'))
      // Acceptance runs async off the synchronous inbound broadcast, so wait for the turn it
      // drives rather than assuming it already started.
      await vi.waitFor(() => { expect(h.mock.requests).toHaveLength(1) })
      await agent?.whenIdle()
      expect(h.ctx.runtimeState.isAccepted('mock-chat', 'm1')).toBe(true)

      // A repeat of the same provider message id is dropped: no second turn.
      h.channel.receive(inbound('m1', 'hello'))
      await vi.waitFor(() => { expect(h.ctx.runtimeState.isAccepted('mock-chat', 'm1')).toBe(true) })
      await agent?.whenIdle()
      expect(h.mock.requests).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })

  it('replies to the active conversation via message', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'hi Alice' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'are you there?'))
      await vi.waitFor(() => { expect(h.channel.sent).toHaveLength(1) })
      await agent?.whenIdle()

      expect(h.channel.sent[0]).toMatchObject({ channel: 'mock-chat', route: 'conv-42', text: 'hi Alice', format: 'markdown' })
    } finally {
      await h.dispose()
    }
  })

  it('lands an inbound attachment under the workspace and points the agent at it', async () => {
    const h = await bootWithChannels(new MockAdapter([textResponse('ok')]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inboundWithImage('m1', 'look at this', 'img1'))
      await vi.waitFor(() => { expect(h.mock.requests).toHaveLength(1) })
      await agent?.whenIdle()

      const files = await readdir(join(h.workspace, 'media', 'mock-chat'))
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/\.png$/)
      const saved = await readFile(join(h.workspace, 'media', 'mock-chat', files[0] as string))
      expect(saved.toString()).toBe('bytes-of-img1')
      expect(firstUserText(h.mock)).toContain(`[image: media/mock-chat/${files[0] as string}]`)
    } finally {
      await h.dispose()
    }
  })

  it('sends a workspace file as an outbound attachment', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'here it is', attachments: ['note.txt'] }),
      textResponse('done'),
    ]))
    try {
      await writeFile(join(h.workspace, 'note.txt'), 'file body')
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'send me the note'))
      await vi.waitFor(() => { expect(h.channel.sent).toHaveLength(1) })
      await agent?.whenIdle()

      const [message] = h.channel.sent
      expect(message?.attachments).toHaveLength(1)
      expect(message?.attachments?.[0]).toMatchObject({ kind: 'file', name: 'note.txt' })
      expect(new TextDecoder().decode(message?.attachments?.[0]?.data)).toBe('file body')
    } finally {
      await h.dispose()
    }
  })
})
