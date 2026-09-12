# Organ 执行层重构：域行预算 + Lane 循环

Status: ready-for-agent

立意出处：`.scratch/organ-execution/rounds/2026-08-22-initial/`（事故审计与 Xi 对照）与 2026-08-29 评审对话（8 项语义决策，YuCreate 拍板）。本 spec 是实施合同。

## Problem Statement

作为使用 Loom 的人，我观察到：organ 执行层的持久状态机（执行台账、intervention 状态、requeue 语义、cancel grace）反复出事故——busy 空转 10 小时、假 running、requeue 凭空耗预算、cancel 崩溃窗口、过期 retry_wait 不唤醒、SIGTERM 连锁启动。每次修复都在给既有机制打补丁，而补丁本身又成为新的出错面。系统容易停摆，停摆后需要我读代码排障；错误会以各种方式打扰我。过度工程暗含的兜底机制，很多根本不需要存在。

## Solution

把执行层从"持久状态机"降级为"域行计数 + 进程内短暂执行"：域行是唯一持久队列，行上挂 `{attempts, next_eligible_at, last_error, needs_human}`；执行是进程内 lane，崩溃最多丢一次模型调用；调度循环里不存在 busy——每条 lane 永远能回答"running / due / waiting(何时) / needs_human(原因)"之一。needs_human 是最后兜底且应当罕见：抵达后每天机械冷却重试，永不主动打扰人；是否把持续故障说出口由 Orientation 判断。人只在 approve / resolve 时入场。

## User Stories

1. 作为运营者，我希望 organ 的瞬时故障由有界自动重试消化，从而不需要在每次模型抖动后人工干预。
2. 作为运营者，我希望系统里不存在没有截止时间的重试路径，从而 busy 空转类事故在结构上不可能发生。
3. 作为运营者，我希望任何"为什么没在跑"都有带时间戳的答案，从而排障不依赖读代码或猜口径。
4. 作为运营者，我希望 needs_human 罕见到几乎不会出现，从而使用 Loom 不被各种错误困扰。
5. 作为运营者，我希望进程在任意时刻崩溃后重启即自动续上，从而不需要任何执行对账。
6. 作为运营者，我希望 SIGTERM 后进程快速收敛退出，从而部署不再被连锁启动拖住。
7. 作为运营者，我希望配额耗尽时 organ 自动 park 到 reset 时间且不烧预算，从而第二天自动恢复而不是等我批准。
8. 作为运营者，我希望人的消息始终拿走全部模型余量，从而 foreground 响应最快。
9. 作为运营者，我区分 approve 与 resolve 两个恢复动词，从而"重跑"与"接受缺口"不被系统猜测。
10. 作为运营者，我希望 attempt 预算只按 organ 级完整失败计数，从而模型调用层内部重试不虚耗预算。
11. 作为运营者，我希望 needs_human 后每天机械冷却重试一轮，从而持续故障最终能自愈或有界地等待。
12. 作为运营者，我希望每条 lane 的状态只有四种且含义固定，从而一眼看清系统全貌。
13. 作为运营者，我希望执行台账被整体移除，从而不再有第二套队列需要对账。
14. 作为运营者，我希望队列队首进入冷却时 status 显示"冷却至何时"，从而任何停滞可解释。
15. 作为运营者，我希望故障上报继承 Proactive Pulse 的节奏与 quiet hours，从而半夜不被叫醒。
16. 作为 Agent Individual，我希望任何 organ 的失败不阻塞其他 organ，从而我的生活继续。
17. 作为 Agent Individual，我希望 foreground Input 到达时在跑的 organ 立刻让路，从而我的在场优先。
18. 作为 Agent Individual，我希望 organ 让路后其工作原样保留、重跑不消耗预算，从而被打断不是惩罚。
19. 作为 Agent Individual，我希望原始系统错误永远不进入我的普通 Context，从而我的认知不被运维噪音污染。
20. 作为 Agent Individual，我希望 organ 内部保持 FIFO 保序，从而时序敏感的维护（按 activity sequence 反思、按日反思）结果正确。
21. 作为 Orientation，我希望故障 Condition 是对域行的一次只读投影，从而我不需要维护任何条件生命周期。
22. 作为 Orientation，我希望我在 none / Opportunity / 求助 三者间判断，从而不机械报警也不漏报持续影响。
23. 作为 Orientation，我希望 Condition 的出现与消失即时反映域行状态，从而恢复无需 resolved 事件。
24. 作为 Cognitive Organ，我希望我的域逻辑与 prompt 不被本次重构触及，从而维护语义保持不变。
25. 作为 Cognitive Organ，我希望被 abort 后留下的状态与崩溃等价并由域行自然重跑，从而不需要取消补偿机制。

## Implementation Decisions

总原则（2026-08-29 确认）：**这是减法重构**。每条机制的存留标准是"删掉它会改变已锁定语义吗"；禁止为假想故障新增兜底层。旧机制不是被替代，而是被证明不再需要后删除。

- **双层模型**：域层 Runtime Store 是唯一持久队列（activities、deliveries、各 organ 域表全部保留）；执行层不持久化任何"正在跑"。删除执行台账两张表（cognitive_work / cognitive_attempts）、其 reconcile、intervention_required、requeue-organ 与 cancel grace 全套机制。
- **域行预算**：各 organ 域行统一挂 `{attempts, next_eligible_at, last_error, needs_human}`。attention/reflection 域表已有的 attempt_count / next_run_after / last_error 统一为该语义；activities / thread_maintenance / deliveries 按各自域形态承接同一字段组。
- **Lane 抽象**：每个 organ 一个 lane（`isDue(row, now) → {due, retryAt}` + `run(row)`）；Orientation/Proactive Pulse 与 After-chat Continuation 也 lane 化。lane 只读自己的域行；跨 organ 依赖（如同日 Memory Reflection 等 Thread 维护完成）表达为 isDue 前置检查 + 对方完成时的 wake。
- **驱动循环**：替代现有 Scheduler runOnce 的多处置返回与 Process Driver 的 busy 轮询。循环 = 逐 lane 跑 due 工作 + sleep 到所有 lane 最早 retryAt 或 wake 事件。wake 源固定五个：Input 到达、Turn 结束、Delivery 完成、Activity 落库、Segment 关闭。任何路径不得返回无截止时间的"忙碌"。
- **attempt 计数语义**（语义决策 3）：1 attempt = organ 一次完整执行，内含 pi 会话级自动重试与 50-turn 上限；pi 重试成功零消耗；pi 报告最终失败计 1；人打断与配额 park 不计数。
- **配额 park**（语义决策 2）：429 / usage-limit 类错误写 `next_eligible_at` = provider reset 时间（解析不出则 6 小时），不计 attempts、无上限，status 全程可见。
- **失败退避与 needs_human**：真失败按 1min / 5min 退避（沿用现行 policy）；3 次真失败 → `needs_human` 置位并进入冷却：每 24h 机械重试一轮，成功即静默清标并留痕，持续失败保持置位（语义决策 6）。冷却细节（时长可按 organ 调整）归工程推断。
- **abort 语义**（语义决策 1）：foreground Input 到达 → 在跑 organ 收 AbortSignal 立即停止；无 grace 窗口、无 settling 竞态、无 cancelled 终态。正确性依据：organ 写入全部经 Workspace Mutation journal，abort 后状态与崩溃等价，域行自然重跑。前提事实（已核实）：foreground turn 不写 organ 的 transcript；foreground 与 organ 的 Workspace 路径相交仅靠约定隔离，abort 让路使该并发不产生。
- **FIFO 保序**（语义决策 4）：organ 内队首不被越过；队首进入冷却时本 organ 队列停滞且 status 显示"冷却至何时"（已知并接受的代价）。
- **恢复动词**（语义决策 5）：`approve` = 清标记重跑，仅对仍当前的项；`resolve` = 接受缺口跳过；对已过时项 approve 明确拒绝并提示。取代 requeue 状态机。
- **Condition 投影**：needs_human 行即 Condition——对若干已知域表的一次只读投影。无独立 Condition 子系统、去重或 resolved 生命周期；恢复即时可见。
- **Orientation 边界**（语义决策 7、8）：Condition 的唯一认知消费者仍是 Orientation，判断 none / Opportunity / 求助 三选一；Opportunity 仍为持久 Input 行（过期与"人先于机会"清理规则保留）；Proactive Pulse 的 fair-split 从 Scheduler 分支移入 orientation lane 内部。故障上报继承 pulse 节奏与 quiet hours，无突破 quiet hours 的紧急档，无绕过 Orientation 的机械上报通道。Orientation 自身 needs_human 时仅在 status 可见，其余 organ 照常。
- **Status 重做**：每 lane 四态 `running / due / waiting(next: 时间点) / needs_human(reason, since)`；域投影按新形态重做，顺带消除 delivery 需关注项无单项可见、oldest-pending 口径不含域行 deadline 两个已知问题。
- **迁移**：一次性把旧台账 blocked / intervention_required 映射为对应域项 needs_human，其余旧执行状态丢弃（域行本身即事实）。
- **边界不动**：域层 durable queue 语义、organ 域逻辑与 prompt、channels 与外部集成协议、Identity / Memory 内容层、50-turn 合同、四分离故障模型（重启 / 重试 / 诊断 / 语义修复分开）。

## Testing Decisions

- 好测试只断言外部行为：给定域行状态与 fake clock，驱动 lane 循环或 organ 入口，断言域行变化、下次唤醒时间与 status 投影；不断言内部布尔量或调用序列。
- 复用两个现有测试缝，不新增缝：
  1. **Runtime organ 入口缝**：真实 Runtime Store（临时库）+ fake organ 实现与 fake AgentExecution，断言预算状态转移。现有 cognitive organ runtime 测试即此形态，作为先例。
  2. **驱动循环缝**：fake clock + fake runtime/lane，断言唤醒计算与无 busy 轮询。现有 scheduler 测试即此形态；新循环测试替换它。
- 必测行为清单：真失败退避与 3 次封顶；needs_human 冷却重试与静默清标；配额 park 不计 attempts；abort 后域行不变且重跑不计 attempts；队首冷却不越过；lane 互不阻塞（含 Orientation 自身 needs_human）；崩溃重启续跑（无对账代码可测，断言"重启后按域行重新 due"）；status 四态投影与"冷却至何时"；迁移映射（旧 blocked → needs_human）。
- 删除对应旧测试：执行台账单元测试、cancel grace 竞态、requeue 并发矩阵——被测机制不存在，测试随之退役。

## Out of Scope

- 域层 durable queue 本体（activities / deliveries / ingress）的行为变更。
- 各 organ 的域逻辑、prompt 与 Workspace 写入语义。
- channels 与外部集成协议；nmem 集成行为。
- Main Agent 被问及时按需读取 status 的能力——属 system guidance 层的 prompt 语义，后续另行考虑。
- 单 Instance 内多 agent 并行（当前按每 Individual 一进程隔离）。
- 部署动作本身：实现、合并、部署是分开的边界，部署另行授权。

## Further Notes

- 8 项语义决策全部由 YuCreate 于 2026-08-29 拍板，附带原则：needs_human 始终是最兜底、发生情况应很小，使用 Loom 的人不能被各种错误困扰；工程推断不采纳"多加兜底"方向。
- 写路径核实结论（2026-08-29）：foreground turn 的 transcript 与 organ transcript 分离且均在 Workspace 外；foreground 经 builtin 工具可写 Workspace 内任意路径（与 organ 路径相交仅靠职责约定隔离）。该事实成立的前提是 abort 让路语义（语义决策 1）使两类写入不并发。
- 效果验收基准：见 User Stories 1–25；其中 2、3、5、12、13 是结构性验收（机制不存在即通过），其余为行为验收。
