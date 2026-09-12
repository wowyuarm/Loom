# Codex Source and Xi Review

Status: collecting

## Issue #5 Baseline

- 生产 turn `444e709a` 正常 completed/no_reply。
- segment `6a5f684a` 明确记录 `active -> discarded`，reason=`silent_opportunity`。
- Terra 的最小场景连续三次得到相同结果；这不是 Life Recorder 偶发漏写。
- Loom `#reflectionDayComplete` 仍要求每个终态 Turn 的 segment 出现在 `activities`，把合法静默误判为未收束。
- Sentinel 证明 2026-08-05 15:25-18:34 没有持续的 Input、Delivery、Turn 或 Active Segment 阻塞；Memory Reflection `busy` 让 pulse 分支完全走不到。

## Xi Comparison

Xi 的实际规则：

- background 开始时可以临时打开 segment 和 conversation window，以固定当前上下文。
- 发消息或调用非 `message` 工具才形成需记录的 Activity。
- 无消息、无工具的 background 直接清理 active segment/window，只留事件日志，不保留历史 segment 状态表。
- Memory Reflector 等 nmem/nightly 与工作材料，不检查每个 turn 是否对应 Activity。
- daemon 在同一 tick 中独立触发维护函数；Memory Reflector 有每日最多三次失败限制，不以一个 `busy` 提前截断整条调度链。

## Current Direction, Not Yet a Decision

- 不为 issue #5 新建完整历史 segment 模型。
- Reflection readiness 只应等待自己真正依赖的未完成材料。
- 无法解释的 orphan 应进入独立运行完整性诊断，不应永久阻塞记忆和 Orientation。
- 以上方向仍需放进全局候选清单，与其他过度防御一起审视后再确认。

## First Ticket-history Findings

### Ticket 25: stop-on-busy belonged to the core recovery chain

Ticket 25 的原始 Scheduler 只推进 Input、Turn、Delivery、Activity freeze 与 Life Recorder。它明确规定遇到 `busy`、未知外部结果或失败就停止；在这条核心事实链上，继续越过未确定状态可能破坏顺序或重复外部动作，因此原意成立。

后续 Ticket 28/31/32 把 Proactive Pulse、Attention Maintenance 和 Memory Reflection 作为独立 lane 接到同一个顺序中，但没有重新定义“前一 lane 暂时不可运行时，后一 lane 是否独立”。于是核心恢复链的保守停止规则扩散成跨 lane gate。这是当前 starvation 的历史来源，不是 Ticket 25 本身凭空设计错误。

### Ticket 32: confirmed interface was narrower than the implementation

Ticket 32 要求目标日没有“仍在 Active Segment、未完成 Activity recording、未完成 Thread maintenance”的 evidence。当前 `runMemoryReflection()` 已先经过 `#isMaintenanceIdle()`，它已经排除了 active segment、pending recording 和 pending thread maintenance。

实现又增加 `#reflectionDayComplete()`，要求目标日所有 terminal Turn 的 segment 都存在于 `activities`。这比 ticket 的必要条件更强，也把 intentionally discarded silent Opportunity 错当成未完成 evidence。当前问题属于实现和原合同之间的防御性漂移。

### Ticket 33: maximum age is a close request, not a completion guarantee

Ticket 33 的目标是让持续活动在两小时后复用既有 freeze 路径 soft split；它没有新增状态机，这部分设计克制。但当前 `closeActivity()` 将运行中 Turn、Delivery、Input、Recorder、Thread maintenance 等不同阻塞全部返回为 `busy`，所以达到 maximum age 并不代表能在有界时间内关闭，也无法说明被什么阻塞。

这更像必要生命周期缺少明确 admission/result，而不是 soft split 功能本身多余。应与“是否需要保留两小时 soft split”分开讨论。

### Maintainer terminal tokens duplicate durable side-effect evidence

Thread Maintainer、Attention Maintainer 和 Memory Reflector 都要求模型在工具写入后精确返回 `UPDATED`，无写入时精确返回 `NO_CHANGE`。但它们已经分别拥有更可靠的机械事实：

- Thread Maintainer 知道 transaction 是否 mutated、changed paths 是否非空，并在异常时通过 Workspace Mutation 回滚整棵 Thread tree。
- Attention Maintainer 知道 `replace_attention` 是否被调用，且替换是原子的。
- Memory Reflector 知道 replacement 数量，并通过 Workspace Mutation 保护多文件 revision。

精确尾词没有证明“所有应该做的工作已经完成”；grounding、read coverage、路径和写后结构检查才承担这项职责。尾词不匹配只会把已经通过机械检查的运行回滚并重新调用模型。2026-08-05 Thread Maintainer 已真实发生一次该失败，约十一分钟后重跑成功。

Xi 的 Thread Maintainer 直接返回自然语言总结，没有等价 terminal token；其保护更弱，但这足以证明 terminal token 不是器官语义所必需。候选方向是由已发生的 durable tool facts 推导 `updated` / `no_change`，保留其余 grounding 和结构检查。

### Serial `runOnce` grew from state safety into interaction latency

Ticket 25 的首条 Scheduler 只串行推进核心 Runtime facts；Ticket 34 的 Process Driver 又明确一次只运行一个 `runOnce`，并在 stop 时等待当前运行自然结束。后续所有 Cognitive Organ 都进入这条 await 链，导致“单次维护不能与 Main Agent 并发”变成“人类新 Input 虽已持久化，也必须等长运行器官完整结束”。

GitHub issue #2 已记录一次真实后果：Cognitive Organ 运行 13 分 36 秒后以 stream failure 结束，用户侧随后经历长时间沉默。这里不能直接照搬 Xi 的异步 `.catch()` 触发，因为 Loom 的器官会原子演化 Main Agent 下一 Turn 读取的 Workspace 材料；但现有全局串行也不是唯一安全方案。

后续需要从真正不变量反推：

- Main Agent 是否只需在 Turn 开始时固定一份完整 Workspace revision？
- 新人类 Input 是否应取消尚未开始写入的器官，或只在安全点抢占？
- 已开始的多文件 Workspace Mutation 能否继续隔离到提交，再让后续 Turn 选择旧/新完整 revision？
- 哪些器官只读或单文件原子替换，根本不需要占用同一全局执行通道？

在这些问题回答前，不把“并行 worker”当默认解法。
