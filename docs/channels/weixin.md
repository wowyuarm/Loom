# Weixin Interaction Channel

Loom 当前支持一个 Runtime Instance 配置一个 Weixin route 和一个固定 peer。接收文字、图片、语音、文件和视频，并可发送文字和一个 Agent Workspace 现有文件的不可变快照。Channel 配置、凭据、附件原始内容和动态状态都在 Agent Workspace 外；Main Agent 只看到 `message`、通用 Attachment 和不透明的默认 Interaction Route。

## Files

`configuration/instance.yaml` 必须显式启用 Weixin（与 Raft 一起启用时多个 Interaction Channel 并行）：

```yaml
version: 1
channels:
  weixin:
    enabled: true
interaction:
  defaultRoute: primary-route
```

`configuration/channels/weixin/config.json`：

```json
{
  "version": 1,
  "routeRef": "primary-route",
  "peerId": "WEIXIN_PEER_ID",
  "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c"
}
```

`baseUrl` 和 `cdnBaseUrl` 均可选，分别缺省使用 Weixin iLink 和 CDN endpoint。非 secret 配置不应包含 token。

`configuration/channels/weixin/auth.json`：

```json
{
  "version": 1,
  "token": "WEIXIN_BOT_TOKEN"
}
```

`channels.weixin.enabled: false` 表示未启用，Host 不读取或连接 Weixin。显式启用后，两个文件必须同时存在；只存在一个文件、JSON 无效、字段不完整或 route 不一致时，Host 会拒绝打开。至少一个 Interaction Channel 必须启用：所有 Channel 都禁用时 Host 拒绝打开。

动态 cursor、peer context token、最近成功 poll 和远程错误保存在 `runtime/channels/weixin.db`。附件原始内容和 retention 状态保存在 `runtime/attachments/`。不要手工编辑这些文件或只复制其中一部分来替代正常 Instance 备份。

## Runtime Behavior

- `connected`：最近一次 long poll 成功。
- `degraded`：远程连接或协议失败；Adapter 会继续重连，Host、Runtime 和私人活动保持运行。
- `stopped`：Host 已完成 graceful stop。

Inbound 只接受配置 peer 的完成消息。文字直接进入 Input。图片、语音、文件和视频会先下载、解密并持久保存，再以通用 Attachment 引用进入同一 Input：图片存入时会按内容识别 PNG、JPEG、GIF 或 WebP；文件和视频按 wire item 声明的类型保存（视频为 `video/mp4`）。语音优先使用微信自己的转写 `voice_item.text` 作为该条 Input 的文字，语音本身不重复保存；没有转写时音频作为 file Attachment 保存，并在文字里标明「[语音]」。文件和视频同样以 `[文件: …]`、`[视频]` 标明到达内容，完全无法转写也无法下载的语音会以明确说明进入 Input，而不是被静默丢弃。单个媒体 item 上限 15 MiB，一条 Input 最多带一个 Attachment，同一条消息里的其余媒体会被丢弃而不是让整条消息失败。Runtime 持久接受 Input 后，Adapter 才推进 cursor；重复拉取由 Runtime 的 source identity 去重。

支持图片输入的当前模型会在当次 Turn 收到 Pi native image；不支持时只收到 Attachment 元数据和内容未展示的明确说明。音频和视频不会自动解析，Main Agent 需要时从 Attachment 读取。Main Agent 可把值得长期保留的附件复制进 Agent Workspace。原始内容在活跃 Input/Effect 结束 30 天后清理，引用和活动证据仍保留。

Runtime 持久接受 Input 后，Adapter 立刻向 peer 发送 typing，并周期性续期；一次 Delivery attempt 结束、Channel 停止或超过 2 分钟上限时取消。typing 只依赖 peer 的 typing ticket，任何失败都只影响这个指示本身，不改变 Ingress 或 Delivery 结果；个别不回复的 Turn 仍可能让 typing 停留到上限。出站消息在同一 peer 上按最小间隔排队，间隔只推迟某一次 Delivery attempt，不丢弃 Effect，也不改变投递结果。

Outbound 在接受 Effect 前把 `message.send` 指定的 Agent Workspace 文件快照进 Attachment Store，之后的文件修改不影响投递。Runtime Delivery attempt 的 idempotency key 是稳定前缀；带文字的附件分别使用 `:text` 和 `:attachment` client id。明确 API 拒绝进入 `not_sent` 退避；网络或 HTTP 结果不明进入 `unknown`。若文字已送达而附件失败，整个 Delivery 进入 `unknown`，不会自动重发文字。context token 明确过期时，Adapter 在同一 attempt 内清掉 token 并重试一次。

入站失败被隔离：无法表示的消息按 `invalid_message` 记录并跳过，可重试的失败保留 cursor 重试，连续 5 次后记录并放行，后续消息和 cursor 不受一条坏消息影响。轮询按服务端 `longpolling_timeout_ms`（限制在 5–60 秒）等待；等待窗口内没有新消息是正常空轮询，cursor 不动、Channel 保持 `connected`，不计失败也不进入重连。真正的失败（HTTP 错误、连接中断）连续 3 次后退避到 30 秒，`ret=-14`（bot session 过期）等待 10 分钟并依赖外部重新登录。`status().ingress` 暴露失败的条数、id 和分类。

引用媒体（`ref_msg`）、贴纸等无法表示的 item、多附件、第三方 ASR、自动视频解析、登录/配对不属于当前 Interaction Channel 能力范围。
