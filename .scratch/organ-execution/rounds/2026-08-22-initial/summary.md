# 2026-08-22 Initial Round

## Captured

- 证据采集时间：2026-08-22 10:00–12:30 CST（生产 journal 与 `loom status` 实时观测；代码审计同日完成）。
- 生产实例：xi-sg `loom@xi.service`，事故期间运行 `0.0.0+g32e124521240`，当日修复后运行 `0.0.0+g1742af07c044`。

## Baseline

- Loom main @ `1742af0`（"Classify incomplete model streams"），包含本轮四个修复提交：`709ec55`、`d7f672c`、`340c424`、`1742af0`。
- Xi 对照基线 @ `70e1595`。
- pi 包版本：`@earendil-works/pi-{ai,agent-core,coding-agent}` 0.84.2。

## Status

初步研究完成，待 team 讨论。未形成决策。

## Result

### 触发事件（摘要）

8 月 21 日晚重启后，blocked 的 Life Recorder（真实原因 429 GoUsageLimitError 被误分类为 workspace）使 Memory Reflection 持续返回 busy，ProcessDriver 以约 1 秒周期空转约 10 小时（3 万余次 driver pass、34% 单核）。修复部署过程中又暴露：配置漂移导致启动失败（无 preflight）、SIGTERM 后 scheduler 继续启动下一个后台任务、provider stream 失败（`Stream ended without finish_reason`）在 30 分钟内命中三个 organ 并消耗 attempt 预算、过期 retry_wait 长时间不被唤醒且 status 无法解释原因。

详细证据见 `research/incident-inventory.md`。

### 核心问题陈述

"有界自治"合同（organ 自动重试有上限，超限转人工恢复；2026-08 由 YuCreate 确认，2026-08-12 更新为 50-turn 封顶 + 3 次重试路径）要求的是：

1. 不无限烧钱；
2. 超限时人成为显式兜底。

当前实现把它翻译成了**持久化执行状态机**：`cognitive_work` 的 running/retry_wait/blocked/intervention_required、append-only attempts、cancel grace、requeue successor 语义。这引入了一个 Xi 没有的义务——**持久化的 claim 在崩溃/重启/打断后需要对账**。两天的全部事故与审计发现（假 running、requeue 先耗预算、cancel 窗口、busy 兜底空转）都是这一义务的偿还成本。

对照仓库内部已被生产验证的模式：nmem episodes / raft-channel 把 `{attempts, next_eligible_at, last_error}` 挂在**域行**上，执行本身是进程内短暂的——零同类事故。

### 初步论点（待讨论，非决策）

> 域事实应当持久化；执行意图不应当持久化。organ 执行层应从"持久状态机"降级为"域行计数 + 进程内短暂执行"，模型调用层启用 pi 已内置的 RetryPolicy/timeoutMs，人工介入从运行时状态降为域行标记。

目标形态（草案）：

```text
┌──────────────────────────────────────────────┐
│ 域层（保留现状 durable queue）                 │
│ 行上挂 { attempts, eligible_at, last_error }  │
├──────────────────────────────────────────────┤
│ 执行层（降到 Xi 形态：进程内布尔 + 顺序/独立 lane）│
│ 不持久化任何 "正在跑"；崩溃只丢当前一次调用     │
├──────────────────────────────────────────────┤
│ 模型调用层（pi 内置能力，已默认启用）           │
│ turn 重试 maxRetries=3 / 流空闲超时 300s        │
│ quota 快速失败上抛；缺口：重试事件不可观测       │
│ （勘误：初稿误判为零使用，见 pi-retry-capability）│
├──────────────────────────────────────────────┤
│ 人工介入                                      │
│ attempts 用尽后域行上的标记（status 可读）      │
│ 恢复 = 清计数，不再需要 requeue 状态机          │
└──────────────────────────────────────────────┘
```

该形态下：busy 兜底空转不可能存在；假 running / requeue 耗预算 / cancel 崩溃窗口整体消失（无持久 claim 可腐化）；错误分类只剩 pi 一处；`intervention_required` 与 requeue-organ 语义可整体退役。

### 反方论点与需压力测试的点

1. **无界重试烧钱风险**：Xi 模型每 tick 重试，配额耗尽时会持续调用。域行计数方案保留了预算上限，但需确认：重启后计数仍在（是，挂在域行）；429 上抛后 eligible_at 设多长（解析 reset 时间 vs 固定退避）。
2. **foreground 与 organ 并发写 Workspace 是否真的安全**：目前各 organ 文件路径天然不相交（daily/、memory/、attention.md、threads/），main agent turn 疑似不直接写 Workspace 文件——**待验证** tools 权限边界与 transcript 落盘位置。若不相交成立，preemption 与 cancel grace 失去存在理由；若相交，需要按路径的最小互斥而非全局串行。
3. **preemption 移除后 foreground 延迟**：今天的事故里 organ 单次挂起 5–10 分钟是主因；现已确认 pi 默认已有 300s 流空闲上限 + 会话内重试（勘误见 pi-retry-capability.md），单次调用本就有界。剩余问题：有界的多次重试叠加是否仍需抢占，或改为 organ 独立 lane（Xi 的 fire-and-forget）使问题不存在？
4. **"3 次"的语义重定义**：pi 内部自动重试不应计入 attempt 预算；只有 pi 报告最终失败才计一次。需确认与合同原意一致。
5. **单进程假设的寿命**：多 Instance 已按每 Individual 一个进程隔离；未来若单 Instance 内并行 agent 出现，本结论是否需要重审？
6. **Xi 模型的已知代价不能忽视**：旧 Xi 也出过 blocked item 卡住 segment close 约 20 小时的事故。fire-and-forget 只是让失败不传染，不等于自愈；域层的 FIFO/依赖关系仍需 Loom 现有的 durable queue 承载——这正是"域层保留、执行层降级"而非"全面退回 Xi"的理由。

### Open Questions

- ~~pi `timeoutMs` 对流空闲的行为~~ 已查明：默认 httpIdleTimeoutMs=300s，流静默 5 分钟被掐断；turn 重试已默认启用（勘误详见 pi-retry-capability.md）。剩余动作仅为把 `auto_retry_start/end` 接入 Loom 结构化日志。
- Delivery 的 `deliveriesNeedingAttention: 4` 缺单项可见性，属域投影缺失，可独立小步修，不阻塞本主题。
- `oldestPendingOrganAgeMs` 口径不含 ledger 的 retry_wait/blocked，status 投影需随新形态重做。

### Non-goals

- 不推倒域层 durable queue（activities / deliveries / ingress / segments）。
- 不触及 Identity / Memory 内容层与 organ prompt。
- 不讨论 channels 与外部集成协议。
