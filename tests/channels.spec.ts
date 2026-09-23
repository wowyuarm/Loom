import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as ChannelGatewayPlugin from '@wowyuarm/dsh-channel-gateway'
import type {
  Channel,
  ChannelInbox,
  ChannelSendResult,
  InboundMessage,
  OutboundMessage,
} from '@wowyuarm/dsh-channel-gateway'
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as ChannelsPlugin from '../src/channels/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/** A scripted in-memory transport: hand it inbound messages, read back what was sent. */
class MockChannel implements Channel {
  readonly name = 'mock-chat'
  readonly capabilities = { attachments: false, buttons: false, edit: false, replyTo: true, maxTextLength: 4096 }
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

interface Harness {
  ctx: Context
  channel: MockChannel
  mock: MockAdapter
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
  await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })
  await load(ChannelGatewayPlugin, { allow: ['*'] })
  await load(ChannelsPlugin)

  await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })

  const channel = new MockChannel()
  const unregister = ctx.channels.register(channel)
  await vi.waitFor(() => { expect(ctx.channels.channels.map(c => c.name)).toContain('mock-chat') })

  return {
    ctx,
    channel,
    mock,
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

  it('replies to the active conversation via send_message', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'send_message', { text: 'hi Alice' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'are you there?'))
      await vi.waitFor(() => { expect(h.channel.sent).toHaveLength(1) })
      await agent?.whenIdle()

      expect(h.channel.sent[0]).toMatchObject({ channel: 'mock-chat', route: 'conv-42', text: 'hi Alice' })
    } finally {
      await h.dispose()
    }
  })
})
