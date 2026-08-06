# Scheduler、maintenance 与 Active Segment 审查

状态：evidence gathering（只读，未改实现）

范围：只检查调度、维护 lane、活动冻结和恢复中已有具体运行后果的设计；不把「代码较多」本身当问题。Xi 只作历史实现对照，不是 Loom 的回退目标。

## 已证实问题与约束

### 1. Reflection 把「每个终态 Turn 都有 Activity」当成运行前提

**最小场景**：Orientation 产生 Opportunity；Main Agent 完成 `no_reply`，既无普通工具、Effect，也无人类 Input。Runtime 按设计删除这个静默 Segment。到逻辑日结束后，Memory Reflection 检查该 Turn 发现没有同 id 的 Activity，永久返回 `busy`。Scheduler 随即退出，Pulse 到不了。Issue #5 和该场景的三次最小复现均已确认这一条链路。

**原保护目标**：Ticket 32 要求反思只消费「完整逻辑日」的本地证据，避免未完成 Activity recording 或 Thread maintenance 时过早改变核心材料。[Ticket 32](../../harness-layers/issues/32-schedule-memory-reflection.md) 没有要求每个 terminal Turn 必须形成 Activity。

**当前事实与成本**：

- `runtime.ts` 的 `#discardSilentOpportunitySegment()` 会恢复进入机会前的执行状态并删除 Segment，随后记录 `silent_opportunity`；这是静默机会的正常收尾。[runtime.ts:2882](../../../src/runtime/runtime.ts:2882)
- `#reflectionDayComplete()` 额外要求当天的 completed/failed/timeout/cancelled/interrupted Turn 的 `segment_id` 出现在 `activities` 中。[runtime.ts:1609](../../../src/runtime/runtime.ts:1609)
- 合法静默因此被当成遗失证据，反思 cursor 不会推进；Scheduler 将它压成没有 deadline 的 `busy`，Process Driver 每秒重试，且不会到后面的 Pulse 分支。[runtime.ts:849](../../../src/runtime/runtime.ts:849) [scheduler.ts:150](../../../src/runtime/scheduler.ts:150) [process-driver.ts:169](../../../src/instance/process-driver.ts:169)

**Xi 对照**：Xi 也在无 message、无非 message 工具的 background 后丢弃 standalone segment；文档明确「没有工具的静默 pulse 不留空活动」。[Xi actions.ts:377](/home/yu/projects/Xi/src/runtime/actions.ts:377) [Xi daemon scheduling.md:40](/home/yu/projects/Xi/docs/daemon-scheduling.md:40) Xi 的 reflector 等它自己的 nightly marker 与 working-memory 条件，不检查每个 Turn/segment 是否有 Activity。[Xi cognitive-maintenance.ts:157](/home/yu/projects/Xi/src/runtime/cognitive-maintenance.ts:157)

**建议：重设计。** 反思只检查它真正要读取的目标日 Activity 是否已冻结、recorded，以及有 Thread maintenance 的 Activity 是否完成。Segment 的合法终态应成为独立运行事实；无法解释的 orphan 另走诊断，不得作为 Reflection 的永久门槛。

### 2. 一个未完成 maintenance lane 变成所有后续 lane 的总开关

**最小场景**：某个 Thread Maintainer 或 Life Recorder 一直失败并保留 `pending`；同时 Attention、Memory Reflection 或 Pulse 已到期。`advance()` 先返回失败或 `busy`，`#isMaintenanceIdle()` 又因这一个 pending 项返回 false，后续维护和主动机会都不运行。

**原保护目标**：Ticket 25 的早期 scheduler 只有 Input/Turn/Delivery/freeze/Recorder 主链。外部投递不确定、冻结中的 Activity 与运行中的 Turn 不能并发推进，因此本轮停止是合理的。[Ticket 25](../../harness-layers/issues/25-schedule-runtime-lifecycle.md) Ticket 29/31/32 后来才将 Thread、Attention、Reflection 依次接入。

**当前事实与成本**：

- `#isMaintenanceIdle()` 同时要求没有 active segment、pending input/delivery/recording/thread maintenance 等；Attention 与 Reflection 都把它当自己的先决条件。[runtime.ts:1569](../../../src/runtime/runtime.ts:1569) [runtime.ts:782](../../../src/runtime/runtime.ts:782) [runtime.ts:849](../../../src/runtime/runtime.ts:849)
- `advance()` 在 Recorder 或 Thread Maintainer 一次失败后立即返回；Scheduler 把该结果变为 deferred，不再走 close、Attention、Reflection 或 Pulse。[runtime.ts:777](../../../src/runtime/runtime.ts:777) [scheduler.ts:128](../../../src/runtime/scheduler.ts:128)
- 这与 Ticket 11 已确认的原则相冲突：冻结后新 Input 可以继续，Recorder failure 仅保留该 Frozen Activity 重试。[Ticket 11](../../harness-layers/issues/11-close-activity-lifecycle.md)
- Issue #5 已实证 Reflection 的一个 `busy` 使 Pulse 不可达；现有代码对 Recorder/Thread pending 采用相同的总闲置判定，因而存在同类长期饥饿路径。

**Xi 对照**：Xi 的 tick 先走核心 close/queue/background，再把 thread、now、reflector 各自启动并各自记录错误；一个维护失败不会用 return 截断后面的维护。[Xi daemon.ts:91](/home/yu/projects/Xi/src/runtime/daemon.ts:91) Xi 还明确把 terminal blocked queue 排除出 idle-close 的阻碍，避免旧失败永久阻塞之后的 lifecycle。[Xi recovery-model.md:61](/home/yu/projects/Xi/docs/recovery-model.md:61)

**建议：简化并重设计调度结果。** 保留主事实链内部的串行和 fencing；但 maintenance lane 应只声明自身 `waiting` / `retrying` / `blocked`，Scheduler 汇总各自的最早唤醒时间，而不是将一个 lane 的 `busy` 解释为整个 Runtime 不能推进。Workspace 真正互斥的写入继续由具体 mutation/lease 保护。

### 3. 两小时 soft split 与等待最终 Delivery 证据存在真实冲突

**最小场景**：互动 Turn 已创建 message Effect，渠道明确返回 `not_sent`；Effect 保持 `pending` 并按 1 分钟到 1 小时退避。Segment 过了两小时仍有该 pending Delivery。Scheduler 请求 close，但 `closeActivity()` 拒绝，返回 `busy`；同一 Segment 无法冻结，Life Recorder、Thread、Attention 和 Reflection 没有这段新证据。

**原保护目标**：Ticket 33 通过 max age 防止持续输入让 Segment 无限增大，同时复用已经验证的 freeze/recovery 路径，而不是做另一套 split 状态机。[Ticket 33](../../harness-layers/issues/33-soft-split-long-activity.md) Ticket 38 则要让明确未送达的 Effect 可持久退避重试且不丢失。[Ticket 38](../../harness-layers/issues/38-back-off-not-sent-delivery.md)

**两边实际保护的对象**：

- `#hasPendingDeliveryWork()` 把任何 pending、带 route 的 Effect 都视为 close 阻碍，未区分「正在 dispatch」与「已确认未送达、下一次重试在未来」。[runtime.ts:1772](../../../src/runtime/runtime.ts:1772)
- `#claimActivityClose()` 对 idle 和 max-age 使用同一个 pending Delivery 前置条件，因此两小时上限到达也不会 freeze。[runtime.ts:1839](../../../src/runtime/runtime.ts:1839)
- Scheduler 在 max-age 到达后把 close 的 `busy` 原样返回；Process Driver 按一秒 retry，却无法让下一次 Delivery 提前发生。[scheduler.ts:188](../../../src/runtime/scheduler.ts:188) [process-driver.ts:169](../../../src/instance/process-driver.ts:169)
- Ticket 38 明说「新 Input 和其他 Runtime work 可以在 Delivery 等待时继续」；现码允许新 Turn，但不允许旧活动收束，故这个保证没有覆盖活动边界。[Ticket 38](../../harness-layers/issues/38-back-off-not-sent-delivery.md)

关闭时写入的 `frozen_activity_json` 是不可变快照，直接固化 Effect 和 Delivery attempt。若在 `not_sent` 退避中先冻结，后续成功的 attempt 不会进入这段 Activity，Life Recorder 会永久缺少最终送达证据。因此 pending Delivery gate 有真实保护对象，不能直接放开 close。

**Xi 对照**：Xi 的 idle close 会等待可重试 queue，但 soft split 仅检查 tool compaction、Xi active 与 close-in-progress，不检查 queue；因此「工作未送达」不会抹去软上限的收束能力。[Xi actions.ts:774](/home/yu/projects/Xi/src/runtime/actions.ts:774) [Xi actions.ts:811](/home/yu/projects/Xi/src/runtime/actions.ts:811)

**结论：保留为目标冲突，不进入简化候选。** 后续需要在三个方向中明确选择：调整 soft split 的上限承诺；把后续 Delivery 证据投影为独立材料；或保持现状但把 blocker 和下一次 retry 明确暴露给运行者。

## 待验证候选，不建议先改

### 4. 同一次 run 的两阶段 maintenance 调用

**最小场景**：Scheduler 每次 `runOnce()` 开头都用 `agentWork: "defer"` 调 Pulse、Attention、Reflection，忽略返回值；主链 idle 后又再次调用 Attention/Reflection，并在需要时调用 Pulse。

**原保护目标**：Ticket 28/31/32 需要持久 schedule 和最早唤醒时间；预调用至少会建立首次 schedule 行。

**当前事实与成本**：三次预调用在 [scheduler.ts:103](../../../src/runtime/scheduler.ts:103) 到 [scheduler.ts:128](../../../src/runtime/scheduler.ts:128)，结果没有参与本轮返回；正式路径在 [scheduler.ts:150](../../../src/runtime/scheduler.ts:150) 到 [scheduler.ts:188](../../../src/runtime/scheduler.ts:188)。空 Reflection 日甚至可以在预调用阶段推进 cursor。当前只能证实入口重复，尚未证实它造成错误或多余模型运行。

**Xi 对照**：Xi 每个 tick 直接在各自函数内检查到期条件，没有对应的「预初始化后忽略结果」层。[Xi daemon.ts:91](/home/yu/projects/Xi/src/runtime/daemon.ts:91)

**结论：降为观察项。** 先用启动、空日、due maintenance 与 driver wake 场景确认预调用是否仅为初始化；在没有可观察坏结果前，不进入 grilling 或简化候选。

## 不列为删减候选

Activity close 的 claim/fencing、冻结与 successor execution state 的原子提交、Recorder 的 FIFO retry、以及 Thread/Attention/Reflection 各自的 durable cursor 有明确 crash/retry 目标和不同的输入边界。[Ticket 11](../../harness-layers/issues/11-close-activity-lifecycle.md) [Ticket 29](../../harness-layers/issues/29-schedule-thread-maintenance.md) [Ticket 31](../../harness-layers/issues/31-schedule-attention-maintenance.md) [Ticket 32](../../harness-layers/issues/32-schedule-memory-reflection.md) 现有问题在于把这些局部保护扩大为全局门槛，或把不同阻塞原因压成 `busy`，不是这些持久事实本身。

## 核对

- `npm run build` 成功。
- 四个相关的已编译 runtime test（Delivery backoff、soft split、Reflection retry、Thread retry）通过。
- 同一条 `npm test -- --test-name-pattern=...` 随后也会直接执行源 `.ts` 测试；该项目当前 Node strip-only 路径无法解析 parameter property / 找到 `.js` source import，因而整命令以既有 35 个 source-test module resolution failure 结束。这与本次只读审查无关，且没有修改源码或测试。
