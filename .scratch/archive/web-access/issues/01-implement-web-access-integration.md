# 01 - Implement Web Access Integration

Status: completed
Type: implementation
Blocked by: none

## Goal

实现一个只读、可选的 Web Access Integration。启用的 Runtime Instance 让 Main Agent 使用有界的 `web_search` 和 `web_fetch` 获取公开网页资料；关闭时完全不读取其配置或凭据，不注册工具，也不产生外部网络 I/O。

这是一项完整的纵切：配置解析、凭据边界、provider 行为、Main Agent 工具装配、Host 验证、文档和公开 seam 测试一起完成。

## Interface And Assembly

Web Integration 对 Host 提供一个小 Interface：打开已配置的 Integration 后，返回两个 Pi `ToolDefinition`。Host 以具名 `webAccess` 参数传入 `openLoomInstance`，Instance 再将它们追加到 Main Agent 的既有内部 `additionalTools`。不要把 `additionalTools` 提升为 Host 可接收的任意 Integration registry。

`createPiAgentExecution` 是唯一的工具合并点：它把 `additionalTools` 和 Channel Agent Surface 的 tools 统一注册，并拒绝与 Harness 内置工具或彼此冲突的名称。Web 不创建新的 tool schema、registry 或 `InteractionChannelAgentSurface`；它没有 channel guidance、attention evidence、route 或 Destination。

Main Agent 可见的工具合同：

- `web_search(query, max_results?)`：Tavily 搜索，最多 10 个结果，返回 title、URL 与有界摘要；缺少所需 key 时明确失败。
- `web_fetch(url, offset?, max_chars?)`：只允许 HTTP(S)，返回可读文本和 stable pagination metadata。`offset` / `max_chars` 让长资料按需继续读取，单次返回有合理硬上限。
- 两个工具都明确把结果标为 untrusted external evidence；页面文字、搜索摘要、重定向 URL 都不能被当成 Harness 指令。

## Configuration

`configuration/instance.yaml` 增加严格的启用开关：

```yaml
integrations:
  web:
    enabled: true
```

启用后读取：

```text
configuration/integrations/web/config.json
configuration/integrations/web/auth.json
```

`config.json` 使用 versioned、严格 schema，至少表达搜索 provider / max results / timeout，以及抓取 provider、正文上限、timeout 和 direct fallback。`auth.json` 保存 `tavily` 与可选 `jina` key；不得从环境变量默默读取或在状态、错误、tool result、日志和文档示例中回显 key。

配置有效性按实际能力判断：启用搜索必须有 Tavily key；只使用 direct fetch 时不要求 key；启用 Jina / Tavily extract 时必须有对应 key。错误配置、未知字段、无效 URL 策略或缺少必要 credential 都必须阻止 Host 打开，而不是暴露一个运行后才坏掉的工具。

## Fetch And Safety Rules

- 只允许 `http:` / `https:`；拒绝 userinfo 与显式本地/私有 IP。
- 在初始 URL、每次 DNS 解析结果和每次 redirect 后都执行同一地址检查，避免 redirect、私有 DNS 或 DNS rebinding 触及 Instance / 内网服务。
- direct fetch 只提取纯文本、Markdown 或 HTML 的 readable content；拒绝不可支持的 content type 和超过读取上限的响应。
- Jina / Tavily extract 只能在配置指定的顺序中作为读取 provider；失败是否降级由配置决定。所有 HTTP 调用都尊重 Turn cancellation 与 timeout。
- 不持久缓存网页正文、不创建 Runtime Input / Effect / Delivery，也不做后台重试。成功和失败都只作为普通 Main Agent 工具轨迹进入当前 Turn 的现有 Transcript / Activity 规则。

## Implementation Stages

1. 扩展 Instance Configuration、Instance Layout 与 `loom init` 的最小默认配置；`loom init` 明确写入 `web.enabled: false`，但不创建未启用的 Web config / auth 材料。新增 Web 配置和凭据解析，并用临时 Instance Root 验证 disabled / enabled / malformed / missing-credential 语义。
2. 在 `src/integrations/web/` 实现 provider-adapter 与两个工具。provider HTTP 接口从实现内部注入 fake remote；测试只通过 Web Integration Interface 观察参数、限额、超时、取消、分页、provider 降级与安全拒绝。
3. 让 Host 仅在 Web 启用时装配 Integration，并经 `additionalTools` 进入 Main Agent。验证工具名称统一冲突检查、关闭时工具缺席且 Web 文件未读取、以及 Main Agent 实际只能看到两个工具而 Orientation 不看到它们。
4. 更新 `README.md`、Web Integration 文档和初始化输出；以真实公开 URL 进行一次非 secret 的本地 Host 验收，确认搜索 / 抓取结果、分页和安全拒绝可观察。

## Test Seams

1. **Instance Configuration Interface**：严格解析启用状态，区分 disabled、有效 enabled 与不能安全装配的 enabled。
2. **Web Access Integration Interface**：以 fake provider remote 测试搜索、抓取、读取限额、降级、取消和 URL 防护，不访问真实网络。
3. **Main Agent Interface**：通过实际 Pi execution 观察启用后可用的两个工具、重名拒绝和 tool result 合同；不断言 prompt 字符串。
4. **Host Interface**：使用临时 Instance Root 验证配置 / auth 装配、disabled 零读取零 I/O，以及错误配置拒绝启动。

## Acceptance

- `npm run typecheck`、`npm test` 与 `npm run build` 全部通过。
- 启用 Web 的临时 Instance 可经真实 Main Agent 调用成功完成一次搜索与一次公开网页抓取；不记录 credential 或个人 Instance 内容。
- 关闭 Web 的临时 Instance 不读取 `configuration/integrations/web/`，Main Agent 和 Orientation 都不看到 Web 工具。
- direct、Jina、Tavily extract 的配置和降级语义可从公开测试与文档确定；redirect、私网地址、过大响应、超时和取消不越过安全规则。
- `CONTEXT.md`、配置文档、实现和实际模型可见工具一致；整个工作单元完成后再一起提交。

## Non-goals

- Orientation、Cognitive Organs、浏览器自动化、登录态、网页写入或后台抓取。
- 自动把网页内容变成 Workspace、Daily Narrative、Memory、Thread 或 nmem 资料。
- 抽象出可让任意未来 Integration 随意注册工具的 loader 或 registry。

## Comments

- 2026-08-04：已完成配置开关、严格 Web config/auth、`web_search` / `web_fetch`、具名 `webAccess` 装配和 Main Agent tool 合并。`npm test` 通过；临时配置下的真实 Tavily search 与对 `https://example.com` 的公开网页抓取均通过。测试 key 没有写入 Instance、仓库或输出。
