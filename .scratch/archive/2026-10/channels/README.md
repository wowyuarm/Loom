# channels 模块

**Status:** active（gateway 已实现并评审通过；Loom 消费层已实现，含入站/出站附件）

**last-checked:** 2026-09-25

## 实现状态

- **dsh-channel-gateway**：已由 team 实现，`@wowyuarm/dsh-channel-gateway@0.1.0`（本地 dsh-channel-gateway 的本地 checkout）。契约/gateway/telegram/weixin 适配器就位，32 个测试全绿、typecheck 与 boundaries 通过。评审结论：合适、零主张守住，契约比方案更完整（`ChannelSendResult`、`ChannelCapabilities`）。
  - **telegram**：完整，附件收发走 url/file_id（不做本地上传），`capabilities.attachments=true`。
  - **weixin**：text-only。入站附件只报告 handle、不 fetch；出站带附件报错；`capabilities.attachments=false`诚实降级。第一个切片（文本 ingress）够用。
  - **weixin 全媒体缺口**（后续，不阻塞切片）：入站媒体 fetch、出站媒体 item 格式、DSH attachment 上传、补齐后把 capabilities 翻成 true。
  - **小提醒**：weixin `send` 回的 `providerMessageId` 是适配器自 mint 的 client id（协议 send 回空 body），非服务端权威 id；消费层若用它做出站去重/编辑需知晓。
- **Loom channel 消费 plugin**（`src/channels/index.ts`）：已实现。去重 + 持久接受 + focus + `agentRuntime.deliver` 投递。附件走 workspace 模型（对齐 nanobot 的 `media/` 词、落 workspace 内以配合 DSH 沙箱）：
  - **入站**：`attachmentDownload=true` 的渠道，逐个 `resolveAttachment` 取字节写入 `workspace/media/<channel>/<providerMessageId>-<i>-<name>`，turn 文本嵌 `[image|file|audio|video: media/<channel>/…]` 标记；agent 用自己的 read/read_image 打开。不可下载或取字节失败 → 降级为无路径标记，不丢消息。
  - **出站**：`message` 工具加 `attachments` 参数（workspace 相对路径），读字节前校验不越出 workspace，渠道 `capabilities.attachments!==true` 时明确报错。
  - **不用 DSH attachment store**：入站落盘、出站读盘都走 workspace + node fs；attachment store 仅在 agent 主动 `read_image` 时被 DSH 内部使用（内容寻址，增长受 agent 行为约束）。DSH 沙箱把读写边界绑在 session cwd，故文件必须在 workspace 内，无法像 nanobot 那样单列只读 media 根。
  - **音频**：仅落盘 + 标记，无转写（base bundle 无转写能力）。

## 覆盖的 FRAMEWORK 模块

对应 [FRAMEWORK §5](../../../active/loom-architecture/FRAMEWORK.md) 的 **channels（①）** 行，是第一根竖切片剩下的最后一块。

## 两部分

1. **dsh-channel-gateway**（独立 DSH plugin，零使用主张，可复用）→ [gateway-proposal.md](gateway-proposal.md)。团队照此落地，telegram 作第一个适配器。
2. **Loom channel 消费 plugin**（Loom 的 ② ingress 主张全在这）→ 见 gateway-proposal.md 末尾"分工"，详细设计讨论中。

## 已定结论

- gateway 做成 DSH plugin，不做框架中立核心。
- gateway 在传输边界零主张：只归一 in/out 消息 + 分发 inbound 事件 + 鉴权；不去重、不映射 session、不 stream、不碰 DSH agent。
- Loom 消费层拥有全部使用主张：去重 + 持久接受（②）+ actor/place/visibility + `agent.followup` 路由进单 agent + 只投递显式 message Effect。
- 第一个适配器 fork `hi-wenw/dsh-telegram-channel` 的传输部分。

## 完成条件

- gateway 契约（InboundMessage/OutboundMessage/Channel 接口/`channel/inbound` 事件/allowlist）定稿，telegram 适配器实现。
- Loom 消费 plugin 能把一条真实外部消息走完：去重 → ② 接受 → `agent.followup` → agent 处理 → Effect → `ctx.channels.send`。
- 接口经 telegram / 微信 / Raft 三种形态确认不偏科。
