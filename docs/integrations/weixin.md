# Weixin Integration

Loom 当前支持一个 Runtime Instance 配置一个 Weixin route 和一个固定 peer。第一阶段接收文字和单张图片，并可发送文字和一个 Agent Workspace 现有文件的不可变快照。Integration 配置、凭据、附件原始内容和动态状态都在 Agent Workspace 外；Main Agent 只看到 `message`、通用 Attachment 和不透明的默认 Interaction Route。

## Files

`configuration/instance.yaml` 的 route 必须与 Weixin 配置一致：

```yaml
version: 1
interaction:
  defaultRoute: primary-route
```

`configuration/integrations/weixin/config.json`：

```json
{
  "version": 1,
  "routeRef": "primary-route",
  "peerId": "WEIXIN_PEER_ID",
  "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c"
}
```

`baseUrl` 和 `cdnBaseUrl` 均可选，分别缺省使用 Weixin iLink 和 CDN endpoint。非 secret 配置不应包含 token。

`configuration/integrations/weixin/auth.json`：

```json
{
  "version": 1,
  "token": "WEIXIN_BOT_TOKEN"
}
```

两个文件同时缺失表示未启用 Weixin。只存在一个文件、JSON 无效、字段不完整或 route 不一致时，Host 会拒绝打开。

动态 cursor、peer context token、最近成功 poll 和远程错误保存在 `runtime/integrations/weixin.db`。附件原始内容和 retention 状态保存在 `runtime/integrations/attachments/`。不要手工编辑这些文件或只复制其中一部分来替代正常 Instance 备份。

## Runtime Behavior

- `connected`：最近一次 long poll 成功。
- `degraded`：远程连接或协议失败；Adapter 会继续重连，Host、Runtime 和私人活动保持运行。
- `stopped`：Host 已完成 graceful stop。

Inbound 只接受配置 peer 的完成消息。文字直接进入 Input；一张 PNG、JPEG、GIF 或 WebP 图片会先下载、解密并持久保存，再以通用 Attachment 引用进入同一 Input。单张图片上限 15 MiB。Runtime 持久接受 Input 后，Adapter 才推进 cursor；重复拉取由 Runtime 的 source identity 去重。

支持图片输入的当前模型会在当次 Turn 收到 Pi native image；不支持时只收到 Attachment 元数据和内容未展示的明确说明。Main Agent 可把值得长期保留的附件复制进 Agent Workspace。原始内容在活跃 Input/Effect 结束 30 天后清理，引用和活动证据仍保留。

Outbound 在接受 Effect 前把 `message.send` 指定的 Agent Workspace 文件快照进 Attachment Store，之后的文件修改不影响投递。Runtime Delivery attempt 的 idempotency key 是稳定前缀；带文字的附件分别使用 `:text` 和 `:attachment` client id。明确 API 拒绝进入 `not_sent` 退避；网络或 HTTP 结果不明进入 `unknown`。若文字已送达而附件失败，整个 Delivery 进入 `unknown`，不会自动重发文字。context token 明确过期时，Adapter 在同一 attempt 内清掉 token 并重试一次。

语音/ASR、入站普通文件、视频、引用媒体、typing、登录/配对和多附件不属于当前 Integration。
