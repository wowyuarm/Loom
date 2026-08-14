# Web Access Integration

Status: completed

## Purpose

为 Loom Runtime Instance 增加一个可选的 Web Access Integration：Main Agent 可以按需搜索公开网页、读取已知 URL 的有界正文；它不成为浏览器自动化、Interaction Channel、外部记忆或后台资料同步系统。

## Confirmed Direction

- 首版只提供 `web_search` 与 `web_fetch`，只对 Main Agent 可见；Orientation 和 Cognitive Organs 不获得它。
- `web_search` 使用 Tavily；`web_fetch` 按配置使用 Jina、Tavily extract 或直接抓取，并以配置决定降级顺序。
- Integration 默认关闭。`instance.yaml` 只控制启用状态；非敏感行为配置放在 `configuration/integrations/web/config.json`，provider key 放在同目录私有 `auth.json`，动态运行状态不进入配置。
- Web Access 没有 Input、route、Destination、Effect Delivery、轮询、缓存同步或登录态。一次工具调用是可取消、有限时的外部读取；结果作为 untrusted external evidence 进入本次 Main Agent tool trace。
- 不新增通用 plugin loader 或第二套工具协议。Web Integration 返回既有 Pi `ToolDefinition[]`，由 Instance 通过现有 `additionalTools` seam 传给 Main Agent；Pi execution 统一注册、检查名称冲突并记录工具轨迹。
- Host 只在 `integrations.web.enabled: true` 时读取 Web 配置与凭据、校验并装配工具。关闭时不读取文件、不产生网络 I/O、不显示工具或空 prompt section。

## Tool Interface

```text
WebAccessIntegration
  tools(): readonly ToolDefinition[]
    web_search(query, max_results?)
    web_fetch(url, offset?, max_chars?)

Host -> openConfiguredWebAccess(...)
     -> openLoomInstance({ webAccess })
     -> Instance adds web.tools() to additionalTools
     -> createPiAgentExecution({ additionalTools })
```

`additionalTools` 已是 nmem recall 的内部装配入口；它在 Pi execution 内和 channel tools 合并，并拒绝与 Harness 内置工具或彼此重名的定义。Host / Instance 只得到具名的 `webAccess` 装配参数，不暴露一个让未来任意 Integration 注册工具的入口。Web 不进入 `InteractionChannelAgentSurface`，因为后者还带 channel guidance、Destination 与可选 attention evidence 语义。

## Work

| Issue | Status | Purpose |
| --- | --- | --- |
| [01 - implement Web Access Integration](issues/01-implement-web-access-integration.md) | completed | 已完成配置、工具装配、测试和公开 URL 验收。 |

## Non-goals

- 浏览器 profile、cookie、登录、点击、表单提交、下载或任意网页写操作。
- Webhook、网页轮询、抓取缓存、索引、外部资料自动写入 Workspace / Memory，或为 Orientation 开放工具。
- 多 provider 的通用 marketplace、plugin loader 或任意 Integration 工具注册框架。
