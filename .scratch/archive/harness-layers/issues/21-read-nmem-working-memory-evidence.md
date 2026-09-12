# 21 - Read nmem Working Memory Evidence

Status: completed
Type: implementation

## Problem

nmem 已能接收 Loom 的 Episode 与 Conversation Thread，并由自身处理跨时间结构，但 Loom 还不能以可靠、可判断新鲜度的方式读取 nmem Working Memory。照搬 Xi 的 server-local 文件镜像会要求共享文件系统，也会把外部派生材料混进 Agent Workspace；只做一次无状态 HTTP 请求则会在短暂故障时丢掉上一版仍有参考价值的证据。

## Decisions

- nmem Working Memory 是 Integration-owned derived evidence，不写入 Agent Workspace，也不成为 Current Attention、Long-term Memory 或 Runtime Store 的语义来源。
- nmem Module 提供一个窄 read Interface。成功时返回 `exists`、完整 `content`、nmem `sourceDate` 和本地 `fetchedAt`；当前接口没有可信的服务端更新时间，不伪造 `sourceUpdatedAt`。
- 最近一次成功结果缓存在 Runtime Store 的 nmem Integration 数据库。当前读取失败且存在缓存时返回 `stale`，同时给出原 `fetchedAt`、本次 `failedAt` 和失败类型；没有缓存时返回 `unavailable`。
- 未配置、temporary、authentication 与 incompatible 均 failure-soft。读取失败不改变缓存内容，也不阻塞 Runtime、Main Agent、Activity recording 或 Workspace。
- 缓存按 nmem connection fingerprint 隔离；endpoint、credential 或 space 改变后不能把旧目标的 Working Memory 当作新目标证据。
- 本票只建立 evidence Interface，不把工具加入 Attention Maintainer 或未来 Memory Reflector。任何模型可见 tool description、run context 和 prompt 方法在对应 Cognitive Organ ticket 中单独讨论。
- Loom 不复制 Xi 的 manual nightly triggers 或 feed auto-confirm。当前 nmem `0.10.31` 会立即提交 thread-synced 处理，并自行产生 KG、community、crystal 与 Working Memory 事件；在出现实际缺口前，Loom 只读取并呈现 freshness。

## Interface And Test Seam

调用方只持有 `read()` 与 `close()`。HTTP、capability、response validation、cache schema、connection isolation 和 error classification 留在 nmem Module 内。

测试通过同一 Interface 和假的 HTTP seam 验证结果，不读取 SQLite，也不创建 Agent Workspace 文件。

## Acceptance

- 成功读取保留原始语言和完整 content，并持久缓存来源日期与抓取时间。
- 重启后遇到临时或鉴权失败，可以返回明确 stale 的上一版；没有缓存时明确 unavailable。
- 不兼容 response 不会覆盖最后一次成功缓存。
- 连接目标改变后不复用旧缓存。
- 全量 typecheck、build 和测试通过。

## Out Of Scope

- Attention Maintainer、Memory Reflector 或 Main Agent 的模型可见工具与 prompt。
- manual nightly、feed mutation、scheduler、cadence 或 assembly。
- Agent Workspace 文件投影、自动 Context 注入或 per-Turn fetch。

## Source References

- Xi `src/memory/nmem/nightly.ts`
- Xi `src/agents/now-maintainer.ts`
- Loom `research/nmem-integration-boundary.md`
- Loom tickets 17, 19 and 20

## Implementation

- `src/integrations/nmem/working-memory.ts` exposes the narrow reader and owns the SQLite cache, freshness state, connection isolation and failure-soft results.
- `src/integrations/nmem/client.ts` reads and validates the current REST Working Memory shape without inventing a server update time.
- `test/integrations/nmem-working-memory.test.ts` verifies durable stale fallback and refusal to reuse evidence after the nmem connection changes.
- No Cognitive Organ prompt, tool description or run Context changed in this ticket.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` (120 tests passed)
- `git diff --check`
