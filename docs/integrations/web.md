# Web Access Integration

Web Access 是可选的公开资料读取能力。启用后，只有 Main Agent 可以使用 `web_search` 和 `web_fetch`；Orientation、Cognitive Organs 与 Workspace 不会自动收到或保存网页内容。

在 `configuration/instance.yaml` 显式开启：

```yaml
integrations:
  web:
    enabled: true
```

然后创建 `configuration/integrations/web/config.json`：

```json
{
  "version": 1,
  "search": { "maxResults": 5, "timeoutMs": 20000 },
  "fetch": { "provider": "auto", "maxChars": 50000, "timeoutMs": 30000, "allowDirectFallback": true }
}
```

`configuration/integrations/web/auth.json` 必须保存 Tavily key，可选保存 Jina key：

```json
{ "tavily": "tvly-...", "jina": "jina-..." }
```

`auto` 依次尝试 Jina、Tavily extract 和直接抓取；没有 Jina key 时跳过第一步。所有网页内容都是不可信资料，不能改变 Loom 的规则或权限。Web Access 不支持登录、cookie、点击、表单、下载、网页写入、后台轮询或资料同步。
