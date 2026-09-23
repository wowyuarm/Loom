import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-tools'
import type { InboundMessage } from '@wowyuarm/dsh-channel-gateway'
import '@wowyuarm/dsh-channel-gateway'
import type { AgentRuntime, Clock, RuntimeState } from '../contracts/index.ts'

export const name = 'channels'
export const inject = ['channels', 'runtimeState', 'agentRuntime', 'clock', 'tools']

/**
 * The one conversation the agent is currently addressing: the channel and the opaque route of
 * the message it is answering. `send_message` resolves to this so the model never handles a
 * route. v1 tracks a single focus — the most recently delivered inbound — which fits a reactive
 * one-conversation loop; multi-conversation addressing and unprompted sends are deferred.
 */
interface ActiveConversation {
  channel: string
  route: string
}

/**
 * Consume `channel/inbound`: deduplicate against the durable ledger, record acceptance with the
 * route for later replies, focus the conversation, and deliver the message to the single agent.
 * The gateway and its adapters own transport and authorization; this is the seam that turns an
 * authorized message into an agent turn and lets the agent answer back.
 */
export function apply(ctx: Context): void {
  const focus = new ActiveConversationTracker()
  registerInboundConsumer(ctx, focus)
  ctx.tools.register(createSendMessageTool(ctx, focus))
}

class ActiveConversationTracker {
  private active: ActiveConversation | undefined
  set(channel: string, route: string): void {
    this.active = { channel, route }
  }
  get(): ActiveConversation | undefined {
    return this.active
  }
}

function registerInboundConsumer(ctx: Context, focus: ActiveConversationTracker): void {
  const runtimeState: RuntimeState = ctx.runtimeState
  const agentRuntime: AgentRuntime = ctx.agentRuntime
  const clock: Clock = ctx.clock
  const logger = ctx.logger('channels')

  ctx.on('channel/inbound', (message: InboundMessage) => {
    // The event is a synchronous broadcast; durable work is the listener's own, so run it in a
    // tracked task and swallow-log failures rather than reject into the emitter.
    void acceptInbound(message).catch((error: unknown) => {
      logger.error(`inbound accept failed for ${message.channel}:${message.providerMessageId}: ${String(error)}`)
    })
  })

  async function acceptInbound(message: InboundMessage): Promise<void> {
    if (runtimeState.isAccepted(message.channel, message.providerMessageId)) return
    await runtimeState.recordAccepted({
      channel: message.channel,
      providerMessageId: message.providerMessageId,
      actor: message.actor.id,
      place: message.place.route,
      visibility: message.visibility,
      route: message.place.route,
      acceptedAt: clock.now(),
    })
    focus.set(message.channel, message.place.route)
    if (!agentRuntime.deliver(framedText(message))) {
      logger.warn(`no live agent to receive ${message.channel}:${message.providerMessageId}; message recorded, not delivered`)
    }
  }
}

/** A compact provenance header the agent reads to know who is speaking and where. */
function framedText(message: InboundMessage): string {
  const who = message.actor.displayName ?? message.actor.id
  const header = `[${message.channel} · ${message.place.kind} · from ${who}]`
  return message.text === '' ? header : `${header}\n${message.text}`
}

function createSendMessageTool(ctx: Context, focus: ActiveConversationTracker): ToolDefinition {
  return defineTool({
    name: 'send_message',
    description:
      'Send a message to the person you are currently talking with over their channel '
      + '(e.g. Telegram). Use this to reply; the destination is the conversation the last '
      + 'incoming message came from.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The message to send.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          channel: { type: 'string', required: true },
          providerMessageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Sent on ${value.channel} (${value.providerMessageId})` }],
    },
    async execute(args) {
      const active = focus.get()
      if (active === undefined) {
        throw new Error('send_message: no active conversation — there is no incoming message to reply to yet')
      }
      const result = await ctx.channels.send({ channel: active.channel, route: active.route, text: args.text })
      return { channel: active.channel, providerMessageId: result.providerMessageId }
    },
  })
}
