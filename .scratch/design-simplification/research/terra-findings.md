# Terra: Runtime Simplification Findings

Status: evidence gathering

## Scope

本记录只列今天排查和既有状态/队列对照中有可观察后果的候选。`confirmed` 表示已有生产只读证据或最小复现；`decision needed` 表示源码差异真实存在，但尚不能直接称为缺陷。

## 1. Segment 没有持久的最终结果

Status: confirmed, production incident #5

### 现象 / 最小复现

`opportunity -> no_reply -> 无工具 / Effect` 会让 Runtime 删除 Active Segment，且不生成 Activity。最小 Runtime 场景连续三次得到同一结果：segment transition 为 `active -> discarded`、reason 为 `silent_opportunity`，`activities=0`，随后 Memory Reflection 返回 `busy`。生产的 segment `6a5f684a` 已由只读查询确认有同一 transition。

### 原始目的

Ticket 14 有意把“没有实际行动”的主动机会排除在生活证据之外：不进入 Frozen Activity、Recent Activity 或 Life Recorder，以免把内部安静判断伪造成发生过的活动。[Ticket 14](../../harness-layers/issues/14-form-proactive-opportunities.md)

### 现在实际保护了什么

它正确保护了活动证据的真实性。Xi 同样会丢弃无消息、无普通工具的 background 段，只留下运行日志，不写空 activity。[Xi actions](../../../../Xi/src/runtime/actions.ts)；[Xi scheduling doc](../../../../Xi/docs/daemon-scheduling.md)

### 成本 / 错误行为

`reflectionDayComplete()` 却从 `turns.segment_id` 反推“每个 completed Turn 必须对应 activities”，把已经合法丢弃的 segment 当成丢失。该日 Reflection 永久卡住，且 Scheduler 随后不再检查 Pulse。[Runtime](../../../src/runtime/runtime.ts)；[issue #5](https://github.com/wowyuarm/Loom/issues/5)

### 当前方向与备选方案

当前方向是：Reflection 只检查它真正消费的 Activity 材料；无法解释的 segment/turn 不在 Reflection 内做 Runtime 体检，而进入独立 integrity/status 诊断。这样保留静默不造假 Activity 的边界，也不会让诊断问题永久阻塞认知维护。

“为每个 segment 新增 `recorded(activityId)` / `silent` 终态”保留为备选，而不是当前方向。它会给恢复判断更直接的事实，但也会把完整历史 segment 模型带回 Runtime；在确认现有 Activity 事实不足以表达未来消费者前，不应先引入这层状态。

## 2. 一个 maintenance lane 的 `busy` 会终止整轮调度

Status: confirmed, production incident #5 的第二个影响

### 现象 / 最小复现

2026-08-05 15:25-18:34 +08 没有 Active Segment，Pulse 已到期，但全天没有 Orientation。现场状态表明 Reflection 因 issue #5 返回 `busy`；Scheduler 在无 segment 分支先运行 Attention、再运行 Reflection，Reflection 的非 waiting 结果会直接 return，Pulse 永远到不了。

### 原始目的

Ticket 25 选择单一 `runOnce` 串行推进 Runtime，避免并行的模型/Workspace 写入互相覆盖；Ticket 32 又把 Reflection 放在普通 Runtime work、Activity 收尾和 Attention 之后。[Ticket 25](../../harness-layers/issues/25-schedule-runtime-lifecycle.md)；[Ticket 32](../../harness-layers/issues/32-schedule-memory-reflection.md)

### 现在实际保护了什么

串行领取仍有价值：同一时刻只能有一个写 Workspace 的器官，且新 Input/Delivery 必须先形成 Runtime 事实。

### 成本 / 错误行为

“该 lane 此刻不能开始”与“本轮所有后续工作必须停止”被混为一谈。合法静默的 Reflection 前提错误，连带饿死不依赖它的 Orientation；status 只显示笼统 `busy`，现场需反查数据库才能确定谁拦住谁。[Scheduler](../../../src/runtime/scheduler.ts)

### Xi 对照

Xi daemon 同一 tick 独立触发 Thread、Now、Memory 和 nmem maintenance；某项失败被记录，不作为后续 maintenance 的永久 gate。[Xi daemon](../../../../Xi/src/runtime/daemon.ts)；[Xi cognitive maintenance](../../../../Xi/src/runtime/cognitive-maintenance.ts)

### 倾向

简化 Scheduler 的结果模型：保持一次只领取一个会写材料的工作，但把 `not_due`、`blocked_by_evidence`、`running`、`retrying` 区分开。某 lane 未获准运行时继续检查后续独立 lane；只有实际已领取的工作、Input/Delivery 或明确共享资源冲突才结束本轮。

## 3. 两小时 soft split 与等待最终 Delivery 证据存在真实冲突

Status: confirmed conflict, not a simplification candidate yet

### 现象

已确认 `not_sent` 且处于退避中的 Delivery 仍会让 max-age close 返回 `busy`，所以两小时过去后 Segment 不能冻结。[Runtime](../../../src/runtime/runtime.ts)；[Ticket 33](../../harness-layers/issues/33-soft-split-long-activity.md)；[Ticket 38](../../harness-layers/issues/38-back-off-not-sent-delivery.md)

### 两边实际保护的对象

soft split 要保证长期 Segment 能形成 Frozen Activity；Delivery gate 要保证关闭时写入的 `frozen_activity_json` 是不可变证据，包含这段内 Effect 和 Delivery attempt。若在 `not_sent` 退避中先冻结，后续成功 attempt 不会进入既有 Frozen Activity，Life Recorder 会永久缺少最终送达证据。

### 当前处理

不把这个 gate 当作错误，也不直接放开 close。它是两个正确目标之间的冲突：后续需要决定是调整 soft split 承诺、把后续 Delivery 证据投影成独立材料，还是保留现状但把 blocker/下一次 retry 明确暴露给运行者。

## 4. 维护队列的全局空闲门槛可能把不相关的待处理项变成全局 gate

Status: confirmed by focused cross-day reproduction

### 现象

`runAttentionMaintenance()` 与 `runMemoryReflection()` 都要求 `#isMaintenanceIdle()`；该谓词同时检查任何 pending Activity recording 和任何 pending Thread maintenance，不按 Reflection 目标日或材料依赖范围区分。[Runtime](../../../src/runtime/runtime.ts)

### 原始目的

保证器官读取稳定的 Workspace / Activity 证据，避免与 Recorder 或 Thread Maintainer 的写入并发。

### 成本 / 风险

Ticket 32 的描述是“目标日”没有未完成 Activity/Thread 证据才可反思；现有实现的实际门槛更宽。最小场景已验证：8/4 的 Activity 已 recorded 且无 Thread maintenance；8/5 的 Activity recorded 后其 Thread Maintainer 故意失败并保持 pending；到 8/6 运行 8/4 Reflection 时，Reflection 没被调用而直接返回 `busy`。它把“不能同时写”扩大成“只要队列中有任何待办就完全不能开始”。[Ticket 32](../../harness-layers/issues/32-schedule-memory-reflection.md)

### Xi 对照

Xi 的 Thread Maintainer 失败会记日志并等待后续 debounce；Memory Reflector 有自己的日/失败上限，不读取 Thread Maintainer 的 pending 队列作为全局条件。[Xi cognitive maintenance](../../../../Xi/src/runtime/cognitive-maintenance.ts)

### 倾向

重设计为“实际运行中的写入互斥 + 目标材料的完整性检查”；不能把全局 pending 队列当作 Reflection 的证据完整性。具体 Workspace mutation 冲突仍由已有 lease/事务保护。

## 5. 普通失败的自动重试没有明确退出状态

Status: confirmed by minimal reproduction

### 现象

Xi 对普通 queue failure 有五次上限、退避和 `blocked` 终态；Loom 对没有 Effect/tool 覆盖的失败 Input 重新放回 pending，schema 没有 attempt count 或 next retry time。最小场景用同一无 Effect/tool 的 execution failure 连续运行四次：Input 每次都回到 pending、四个 Turn 都是 failed，Input 没有 attempts 字段或终态。直接调用 Runtime 会立即重领；Process Driver 则在错误后统一等待 30 秒再试。[Xi/Loom comparison](../../harness-layers/research/xi-loom-state-and-queue-comparison.md)；[Runtime](../../../src/runtime/runtime.ts)；[Process Driver](../../../src/instance/process-driver.ts)

### 原始目的

Loom 要避免因一次短暂模型/运行失败丢失用户 Input；已有 Effect/tool 的失败又必须不重放。

### 成本 / 风险

持续但非模型不可用的失败会无限重试，既没有可解释的人工处理状态，也可能反复占用单一运行通道。这与“每项保护都要有出口”的目标不一致。

### Xi 对照

Xi 用分类、退避和最终 blocked 给普通失败一个停止点，同时把 `model_unavailable` 留作例外。

### 倾向

不要直接照抄五次。先定义 Loom 的失败类别和可见人工处理语义；随后把 attempt、retry deadline 和 terminal blocked 作为 Input 生命周期的一部分，而非 Process Driver 的偶然行为。

## Not Candidates

- SQLite Runtime Store、lease/fencing、Effect/Delivery 分离和 `unknown` Delivery reconciliation 都有明确恢复消费者与测试，不能仅因 Xi 更简单而删除。
- 旧 Delivery 与新 Input 的先后顺序确实与 Xi 不同，但尚无用户可见坏结果；先作为产品语义问题，不列为简化工作。
- 既有积压 Input 的合批差异撤出候选：当前 Main 已有 Interaction Wave 与 Raft inbox 的批量准入语义，尚无证据证明 backlog 仍被错误拆成多轮；不应仅以 Xi 的 `queued_replay_batch` 为由重建队列层。
- Xi 的分散文件账本不应成为 Loom 的兼容目标。
