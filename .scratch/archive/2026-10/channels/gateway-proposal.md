# dsh-channel-gateway 方案

**Status:** 已实现（`@wowyuarm/dsh-channel-gateway@0.1.0`，dsh-channel-gateway 的本地 checkout）。本文保留作为设计依据；实现以代码为准。
**last-checked:** 2026-09-22

实现相对本方案的实际偏差（都是改进）：
- 契约多了 `ChannelSendResult.providerMessageId`（发出也拿到 id）和 `ChannelCapabilities`（attachments/buttons/edit/replyTo/maxTextLength，消费方据此降级）。
- `Channel` 接口用 `start(inbox)` + `inbox.deliver(msg)` 交付入站（而非让适配器直接拿事件）；鉴权在 gateway 内部。
- weixin 把短命的 `context_token` 编进 opaque `route`，不给契约加字段。
- 适配器状态：telegram 完整（附件走 url/file_id，不本地上传）；weixin text-only（入站附件只报 handle、不 fetch，出站带附件报错，`capabilities.attachments=false`）。weixin 全媒体为后续。

---

一个独立的 DSH plugin，把各家 channel 归一成统一的收发消息 + 一个 inbound 事件 + 鉴权。

## 定位

填 DSH 生态缺的那块：一个中立、零主张的 channel 归一层。现在生态里是一堆“个性” plugin（各自绑死用法），缺的正是一个大家能往上挂适配器、能被任何 agent host 消费的共享底座。不是 Loom 私有，面向生态，像 `dsh-context-continuity` 一样单独一个 repo。

直接后果：**它的契约是会被别人依赖的公开 API**。纪律是——契约保持小、稳、可版本化，不投机加字段；宁可少，以后按需扩。

## 为什么单独做，而不是先长在 Loom 里

- 抽象不投机：channel gateway 的形状（in/out 消息 + 每 channel 适配器 + bus + 鉴权）已被 nanobot（15+ channel）、OpenClaw 反复验证，假通用化风险低。
- 以后再抽有真成本（`dsh-context-continuity` 当初拆了一整轮）。现在就分清省掉那次拆解。
- 核心很小（契约 + service + event + 接口 + allowlist），telegram 适配器 fork 现成的。

## 核心原则：传输边界零使用主张

生态里现有 channel plugin 的问题是在传输层塞了使用主张：

- `hi-wenw/dsh-telegram-channel`：模型是"人遥控自己挑的 session"，`agent.followup` 裸投喂，无接受语义。
- nanobot：自动 stream 一切 + chat 映射到 session。

gateway **只做归一 + 分发 + 鉴权**，所有使用主张（去重、接受、路由、什么可见）放消费方。这是它成为 infra 而非又一个个性 plugin 的关键。

## 从 nanobot 借 / 丢

借（干净内核）：`InboundMessage/OutboundMessage` 统一契约、`BaseChannel` 接口（start/stop/send + emit inbound）、registry + 一个 inbound 事件、allowlist、每 channel 一适配器。

丢：
- `manager.py`（44KB）的多实例配置管理、feature action、重启通知、outbound 指纹去重、进度节流——nanobot 产品 opinion，不要。
- **streaming / reasoning delta 到 channel**——与 Loom 纪律冲突（普通 assistant 文本不对外可见，只投递显式 message Effect）。`send` 收一条完整消息，不是流。
- **chat→session 映射 / thread-scoped session**（`session_key_override`、`require_existing_session`）——Loom 只有一个 agent，不做 per-chat session。

## 契约

```
  InboundMessage  { channel, providerMessageId, actor, place, visibility,
                    text, attachments?, timestamp, raw? }
  OutboundMessage { channel, route(opaque), text, attachments?, replyTo? }
  Channel 接口     start() / stop() / send(OutboundMessage) + emitInbound(InboundMessage)
                   + capabilities（声明支持什么：附件/按钮/编辑……）
  gateway service  ctx.channels: register(channel) · send(OutboundMessage)
                   · 发 typed event `channel/inbound`
  auth             可插策略，默认 allowlist（pairing / OAuth 以后不改核心）
```

三个字段是 Loom 需要、nanobot 契约没有的，必须进 gateway 契约（gateway 自己不消费，只归一/透传）：

- **actor / place / visibility**：谁、在哪/给谁、可见性（私聊/群）。Loom 的 Input 语义要求。
- **providerMessageId**：provider 的稳定消息 id，透传给上层做去重 + 持久接受。gateway 自己不去重。
- **route（opaque）**：出站目的地是 opaque ref，上层不拼地址（Loom 的 Effect 在接受时固定 route）。

## 三 channel 对齐（接口不偏科）

```
  Telegram(长轮询)   start() 起轮询;send() 调 Bot API                 ✓
  微信(webhook)       start() 注册 HTTP 路由(需注入 web server);
                      回调 → emitInbound;send() 调微信 API             ✓（需注入 HTTP server）
  Raft                start() 连 Raft;wake → emitInbound;send() post   ✓
```

唯一依赖点：webhook 型 channel 需要一个注入的 HTTP server（DSH 有 WebServer），适配器声明该依赖。

## 分工

```
  dsh-channel-gateway（独立 plugin，零使用主张）
    契约 + registry + channel/inbound 事件 + send + allowlist + telegram 适配器(fork hi-wenw)

  loom-next channel 消费 plugin（Loom 的主张全在这）
    订阅 channel/inbound
      → 按 providerMessageId 去重
      → 持久接受为 ② Input 事实（含 actor/place/visibility）
      → agent.followup(createUserMessage(...)) 路由进那一个 agent
    Loom Effect → ctx.channels.send(OutboundMessage)
    只投递显式 message Effect，不 stream
```

## Loom 消费层设计

Loom 自己的 DSH plugin，`inject: [channels, continuityStore, agents]`，主张全在这里。三个已定的设计点：

1. **② 从“指针”扩到“最小 ingress 账本”**：channel 接入需要 ② 多存一样：已接受 Input 的去重记录（至少 `(channel, providerMessageId)` → accepted）。这是 ② 从“当前 session 指针”扩到 ingress 账本的第一步。接受先于喂给 agent；agent 执行失败，Input 不丢。
2. **自定义 source kind `loom-channel`**：`createUserMessage` 的 `source` 是 DSH `MessageSourceMap`，可 merge 扩展。把 actor/place/visibility 塞进去，这条 Input 在 session log 里就带全身份，投影/召回都看得到。
3. **出站走显式 `send_message` 工具**，不自动转发 assistant 文本——符合 Loom“普通 assistant 文本不对外可见，只投递显式 message Effect”的纪律；思考和对外发言分开。

## 参考

- nanobot channels：`HKUDS/nanobot` `nanobot/channels/`（base.py / contracts.py / bus events / 各适配器）。
- telegram 传输：`hi-wenw/dsh-telegram-channel`（MIT，`agent.followup` seam、轮询/收发/附件）。
- DSH seam：`agent.followup(createUserMessage({content, source}))` 把消息喂进已存在 agent，不开新 session。
