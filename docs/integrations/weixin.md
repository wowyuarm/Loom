# Weixin Integration

Loom 当前支持一个 Runtime Instance 配置一个 text-only Weixin route 和一个固定 peer。Integration 配置、凭据和动态状态都在 Agent Workspace 外；Main Agent 只看到 `message` 和不透明的默认 Interaction Route。

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
  "peerId": "WEIXIN_PEER_ID"
}
```

`baseUrl` 可选，缺省使用 Weixin iLink endpoint。非 secret 配置不应包含 token。

`configuration/integrations/weixin/auth.json`：

```json
{
  "version": 1,
  "token": "WEIXIN_BOT_TOKEN"
}
```

两个文件同时缺失表示未启用 Weixin。只存在一个文件、JSON 无效、字段不完整或 route 不一致时，Host 会拒绝打开。

动态 cursor、peer context token、最近成功 poll 和远程错误保存在 `runtime/integrations/weixin.db`。不要手工编辑或复制它来替代正常 Instance 备份。

## Runtime Behavior

- `connected`：最近一次 long poll 成功。
- `degraded`：远程连接或协议失败；Adapter 会继续重连，Host、Runtime 和私人活动保持运行。
- `stopped`：Host 已完成 graceful stop。

Inbound 只接受配置 peer 的完成 text message。Runtime 持久接受 Input 后，Adapter 才推进 cursor；重复拉取由 Runtime 的 source identity 去重。

Outbound 使用 Runtime Delivery attempt 的 idempotency key 作为 Weixin `client_id`。明确 API 拒绝进入 Runtime 的 `not_sent` 退避；网络或 HTTP 结果不明进入 `unknown`，不会自动重发。Weixin 明确报告 context token 过期时，Adapter 会在同一 Delivery attempt 内清掉 token 并重试一次。

图片、语音、文件、视频、引用媒体、typing 和登录/配对不属于当前 Integration。
