# 03 - Materialize Context Windows per Turn

Status: resolved
Type: implementation

## Problem

Loom 已经能通过 Pi 执行 Turn，并用 `Primary Agent Transcript` 中可验证的 anchor 提交 Input 和 Turn 结果。但当前 `Agent Execution` 长期持有同一个 Pi session：下一轮会自然继承上一轮 session 的内存状态，包括失败或取消后尚未由 Runtime 提交的 branch。

这会把 transcript 的“原始执行证据”误当成下一轮 Context，也无法实现已经确认的材料节奏：有些材料每 Turn 读取，有些材料在活动窗口开始时冻结，当前窗口内的已提交轨迹则持续追加。

## Result

本票完成后，每个新 Turn 都从 Runtime 已提交的事实重新生成 Context，并创建独立的 Pi `AgentSession`。同一 Turn 中后来到达的 Input 仍通过 steering 进入该 session。Turn 完成后，只有通过 transcript evidence 验证并由 Runtime 成功提交的 branch 才能成为下一轮 Context 的来源。

Context 由一个深 Module 负责：调用方提供当前 Input、窗口材料和预算事实，Module 返回可直接交给 Pi 的 messages 以及不含正文的 planning record。调用方不需要理解 transcript branch 遍历、完整交互单元或预算选择细节。

## Confirmed Semantics

- `Primary Agent Transcript` 继续 append-only，保留成功、失败、取消及分支证据；它不承担 Runtime 恢复权威。
- Runtime Store 保存当前 active context window 的可恢复投影，以及最后一次成功提交的 transcript anchor。
- 新 Turn 只从最后 committed anchor 所在的连续 branch 恢复。失败或取消 branch 留在 transcript 中，但不会自动进入下一轮。
- 每个新 Turn 新建 Pi `AgentSession`；同一 Turn 的 steering 复用正在运行的 session；Turn settle 后 dispose。
- 当前 Input 是 required material。它在 Planner 中预留容量，但只由 Pi prompt 一次，不在预置 messages 中重复出现。
- assistant tool call 与对应 tool result 是不可拆分的 interaction unit。预算不足时整组保留或整组丢弃。
- Context 使用 normal material target 与 hard context limit。超出正常目标可以丢弃可选旧材料；当前 Input 本身无法进入 hard limit 时拒绝本次执行。
- Planner 的持久诊断只记录版本、预算、材料/单元标识、估算和选择理由，不记录 Input、消息、工具参数或工具结果正文。
- 预算值来自可校准配置。本票可沿用 Xi 已验证的默认起点，但不得把它们表达为永久产品常量。

## Material Timing

本票建立三类中性材料合同，不绑定 Agent Workspace 的具体文件名：

1. **Turn-live materials**：身份、长期记忆、行为材料、当前注意力、可用 skills 与 Model Runtime Revision 在新 Turn 边界重新读取或解析。
2. **Window-frozen seed**：recent narrative / bridge 等窗口背景在 active window 第一次 materialize 时固定，后续 Turn 与进程恢复复用同一版本。
3. **Committed active trace**：当前窗口内已经成功提交的 user、assistant、toolCall、toolResult 持续追加；失败或未提交的执行不追加。

本票允许测试用调用方直接提供这些材料，不提前建立 Workspace 文件布局、skill discovery 或 Configuration loader。

## Interface And Test Seam

主要验收 seam 是“给定 Runtime 已提交状态、当前 Input 与材料，准备并运行一个 Turn”：

- 可观察 Pi 在该 Turn 实际收到的 message 序列。
- 可观察 Turn 完成后返回并由 Runtime 提交的 Input anchors 与 leaf anchor。
- 可观察下一 Turn 是否只恢复 committed branch。
- 可观察 content-free planning record。

测试通过公开的 Context / Agent Execution interface，不直接断言内部 Planner 函数、SessionManager 调用顺序或 SQLite 行。

## Acceptance

- 连续两个成功 Turn 使用两个不同 Pi `AgentSession`，第二轮仍看到第一轮已提交轨迹。
- 同一 Turn 的 steering 与初始 Input 位于同一 session，并继续按 `loom.input.v1` 产生可验证 evidence。
- 一个失败或取消 Turn 在 transcript 留下 branch 后，下一 Turn 从失败前最后 committed anchor 继续，且不包含失败 branch 的消息。
- active window 的 frozen seed 在后续 Turn 和重新创建 execution 对象后不变化；Turn-live material 的更新在下一 Turn 可见。
- 当前 Input 只出现一次；即将 prompt 的 Input 仍参与 hard limit 计算。
- tool call/result 在正常选择和极限裁剪中始终成对。
- Planner 拒绝无法容纳当前 Input 的请求，并保持 Runtime Input 可恢复、未消费。
- planning record 可以审计 kept/dropped 与预算结果，但不包含任何材料正文。
- 现有 input inclusion、effect coverage、abort、provider final error 与 transcript evidence 测试继续通过。

## Deferred Context Work

以下工作已经确认属于 Context 路线，但不进入本票；关闭本票时必须把 frontier 指向其中仍未完成的下一项，不能从 map 中删除：

1. **Window Closure and Recent Activity Bridge**：活动窗口关闭、认知器官回执、closed-window index、recent narrative / bridge 的生成与恢复，以及无对外互动的私人活动窗口。
2. **Tool Trace Compaction and Evidence Expansion**：受保护工具轨迹容量、完整 call/result 压缩、失败 gate、稳定引用与原文展开。
3. **Logical Day and Cross-day Context Recovery**：每日 transcript 轮换、跨逻辑日窗口的 branch 验证与恢复。
4. **Workspace Material Sources**：把身份、长期记忆、行为材料、当前注意力和 workspace skills 的实际来源接入本票建立的材料合同。
5. **Configuration and Model Revision Input**：把可校准预算与每 Turn 生效的 Model Runtime Revision 接入正式 Configuration。

## Out Of Scope

- bridge、closed-window index 或认知器官的具体实现。
- tool trace compactor、压缩 gate 或 evidence expansion tool。
- 逻辑日、quiet hours、pulse 节律或 transcript 文件轮换。
- Agent Workspace 文件名、模板、初始化、skill discovery 或写入权限。
- 完整 Instance Configuration、热加载 watcher 或 assembly。
- Xi 历史迁移、兼容层、生产切换或特定 Individual 的措辞。

## Implementation Result

- `Agent Execution` 长期持有同一 append-only transcript 的 `SessionManager`，但每个 Turn 重新加载 Pi resources、创建并最终 dispose 一个 `AgentSession`；同 Turn steering 等待并复用该 session。
- 每轮先验证 Runtime 提供的 committed anchor，再把 `SessionManager` leaf 移回该 entry。失败或取消 branch 保留在 transcript tree 中，下一轮不会继承它。
- Runtime Store 新增 active context window 投影。window-frozen seed 在 provider 请求前准备并持久化；成功 Turn 只能扩展已准备 trace，不能替换 window ID、frozen seed 或既有 committed trace。
- `loadContextMaterials` 提供中性的 Turn-live 与 Window-frozen 输入 seam；具体 Workspace 文件来源仍留给后续层。Turn-live 每轮刷新，frozen seed 跨 Turn 和进程重建保持不变。
- Context Planner 计入当前 Input、system prompt 与 tool schemas；当前 Input 无法进入 hard limit 时在 provider 前拒绝。active trace 按最新连续完整单元选择，assistant tool call 与全部对应 results 不可拆分。
- Pi auto-compaction 在该执行路径关闭，避免绕过 Loom 的 Context 决策。Planner 产生不含正文的 budget/decision record，并随成功 Turn 原子写入 Runtime Store。
- `contextWindow` 与 `contextPlan` 成为成功 `ExecutionResult` 的必需事实；Runtime 会校验 result anchor、prepared window 与 fencing lease 后再完成 Turn。
- Loom 直接声明 `@earendil-works/pi-agent-core@0.80.10`，用于 Context 的真实 `AgentMessage` 合同；Pi 相关包继续锁定同一稳定版本。

## Verification

在 Node `24.15.0` 下通过：

- `npm run typecheck`
- `npm run build`
- `npm test`：28 tests passed
- `git diff --check`
