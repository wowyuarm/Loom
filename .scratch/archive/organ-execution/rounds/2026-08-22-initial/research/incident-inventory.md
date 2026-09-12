# Incident Inventory（2026-08-17 → 2026-08-22）

按层归类两天的生产事故与审计发现。证据来源：xi-sg journalctl 结构化事件、`loom status --json`、代码审计（reviewer subagent，只读）。

## 分层结论速览

| 层 | 事故数 | 说明 |
|---|---|---|
| organ 执行状态机 | 6 | busy 空转、假 running、requeue 耗预算、cancel 崩溃窗口、过期 retry_wait 不唤醒、stop 连锁 |
| 错误分类 / 模型调用边界 | 2 | 429 误分类 workspace；stream 失败裸调用烧预算 |
| 部署流程 | 1 | 配置漂移无 preflight |
| 域投影 / 可观测性 | 2 | delivery 无单项可见；oldestPendingOrgan 口径失真 |
| 域队列本体（activities/deliveries/ingress） | 0 | FIFO 记录、投递重试、ingress 隔离均正常工作 |

## 明细

### A. organ 执行状态机

| # | 时间 | 现象 | 直接原因 | 状态 |
|---|---|---|---|---|
| A1 | 08-21 16:40Z 起 | Driver 约 1s 周期空转约 10h：30,205 次 pass，34% 单核，rchar 2.2TB | blocked life-recorder 使 pending Activity 无法完成，`#reflectionDayComplete` 返回 `busy`，driver 对 busy 做 1s 重试 | 已修 `709ec55`（reflection 改 idle）+ `d7f672c`（intervention 显式 disposition） |
| A2 | 审计发现 | cancel grace 期间崩溃 → work 永远 `running` 且无 attempt，恢复为不可启动的假 running → 再次空转 | `reconcile()` 只处理 attempt=running；cancelled attempt 被 no-op 跳过 | 未修（本主题结构性消除方向） |
| A3 | 审计发现 | requeue 后、执行前重启 → 从未调用的 attempt 被记为 interrupted 失败，凭空消耗预算，多次重启可升级为 blocked | ledger 的 `running` 同时表示"排队"与"执行中" | 部分：`d7f672c` 加了 domain 变化时的 successor 取消；预算误耗未修 |
| A4 | 08-22 03:57–04:22Z | memory-reflector-207 `retry_wait` 过期 20+ 分钟不运行，status 无法解释 | lane 串行/依赖关系不可见；失败 disposition 不携带真实 nextAttemptAt，scheduler 用 15min 兜底 | 未修 |
| A5 | 08-22 部署期间 | SIGTERM 后当前 recorder 结束又启动 thread-maintainer/memory-reflector/orientation，graceful stop 无法收敛，最终 SIGKILL | scheduler pass 循环无停止检查 | 已修 `340c424`（AbortSignal 贯穿 runOnce） |
| A6 | 审计发现 | 并发调用 Runtime API 可绕过 attention/reflection 互斥布尔，破坏单写者 | 方向不对称的内存布尔 + 无全局 owner | 未修（单线程 scheduler 掩盖中） |

### B. 错误分类 / 模型调用边界

| # | 时间 | 现象 | 直接原因 | 状态 |
|---|---|---|---|---|
| B1 | 08-17 起 | life-recorder-201 blocked 5 天，failureCategory=workspace | 真实错误为 429 GoUsageLimitError，message 含 `/workspace/...` URL，regex 先匹配 workspace | 已修 `709ec55`（provider 先于 workspace）+ `1742af0`（stream ended 归 provider） |
| B2 | 08-22 03:07–04:19Z | `Stream ended without finish_reason` 命中 life-recorder/orientation/memory-reflector/thread-maintainer，每次烧掉 1 次 attempt；thread-maintainer 单次挂起 10m34s | 上游流中断在**会话内自动重试耗尽后**上抛（pi 默认 maxRetries=3、空闲超时 300s，见 pi-retry-capability.md 勘误）；每次 organ attempt 内部已含最多 3 次 pi 重试 | 部分修复：行为本身分层合理；**缺口是重试不可观测**——`auto_retry_start/end` 未接入 journal，排障时只能靠时长推断（本日即误导过诊断） |

### C. 部署流程

| # | 时间 | 现象 | 直接原因 | 状态 |
|---|---|---|---|---|
| C1 | 08-22 10:58 CST | 部署后 Host 启动即崩（config 含已删除字段 `workspaceMirror.intervalMinutes`），systemd 反复拉起 | 配置漂移 + 重启前无校验；该字段在 `6f396d2` 移除但生产 instance.yaml 未迁移 | 已补 `loom validate-config`（`d7f672c`）并写入 ops 文档 |

### D. 域投影 / 可观测性

| # | 现象 | 说明 | 状态 |
|---|---|---|---|
| D1 | `deliveriesNeedingAttention: 4` 长期存在但无单项 ID/状态 | status-reader 只给计数；无法安全判断能否重发 | 未修（独立小项） |
| D2 | `oldestPendingOrganAgeMs` ≈11h 但可见 work 均较新 | 口径取自域表局部，不含 ledger retry_wait/blocked 及其 deadline | 未修（随新形态重做） |

## 与 Xi 的对照要点

上述 A 类全部依赖"持久化执行状态"的存在；B1/B2 依赖自建 regex 分类与裸调用。旧 Xi 无这两样东西，故同类事故不可能发生；Xi 自己的事故模式是另一种（blocked item 卡住 segment close 约 20h，属域层饥饿，可见且阻塞源清除后自愈）。详见 `research/xi-and-precedents.md`。
