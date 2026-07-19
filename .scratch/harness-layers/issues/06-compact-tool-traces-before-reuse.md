# 06 — Compact Tool Traces Before Context Reuse

Type: implementation
Status: resolved
Blocked by: 03 — Materialize Context Windows per Turn

## Outcome

实现第一个真实 Cognitive Organ：当已提交 Context 中完整的非消息工具交互达到保护阈值时，在下一次主 Agent provider 调用前把它们压缩为可复核的事实重放记录。压缩失败保留原始 Context 并阻止该次主 Agent 调用；压缩成功后原子替换 Runtime Store 投影，并可通过稳定引用分页展开原始完整交互。

## Confirmed Prompt Semantics

Tool Trace Compactor 的 system prompt 只定义以下职责：

- 输入是已完成 tool call 的参数与 tool result，不包含对话、assistant thinking、Identity、Memory 或 Behavior。
- 每个输入恰好返回 `toolCallId`、`callSummary`、`resultSummary`、`confirmedFacts`、`sourceClaims` 与 `limitations`。
- 只重放可确认事实；来源自身声称与直接确认事实分开。
- 不解释主 Agent 为什么调用工具，不推测其动机、立场或下一步，不给建议。
- 不复制或改写稳定原文引用；引用由 Harness 机械绑定。

主 Agent 新增 read-only `expand_tool_result` 工具。工具说明只表达：按压缩记录中的稳定引用分页读取原始完整工具交互；它不说明何时应该展开，也不把展开结果解释为行为指令。

## Interfaces And Test Seams

1. **Tool Trace Compactor Interface**：使用真实 Pi faux provider，输入完成的工具交互，观察模型实际收到的 system/user prompt、严格输出校验与返回记录。测试不约束 Pi session 内部调用顺序。
2. **Agent Execution Interface**：从真实已提交 transcript/context 进入下一 Turn，观察 provider 只收到原子压缩后的完整交互，并能通过 `expand_tool_result` 读回原文。
3. **Runtime Interface**：验证 Context replacement 使用当前 Turn lease 做 compare-and-swap；失败或 stale replacement 不改变 Runtime Store。

## Acceptance

- 只选择完整的非消息 tool call/result；普通对话、`message`、未完成交互、已经压缩的记录不送入 compactor。
- compactor 使用独立、fresh、无 tools/skills/extensions/Workspace materials 的 Pi session；不会看到主 Agent system prompt 或 Context。
- 输出 JSON 必须一一对应输入、无重复或额外 ID、字段完整且无额外字段；不合格则整个压缩失败。
- 多个压缩批次全部成功并完成校验后才产生 replacement；任一失败不暴露部分结果。
- Runtime 只在 active Context 与 expected 完全一致且 Turn lease 有效时替换；replacement 保留 window ID、frozen seed 和 transcript anchor。
- 压缩失败时 provider 与 Input inclusion 都不发生；下一次处理仍从原始 committed Context 重试。
- 压缩成功后重新运行 Context Planner，再调用主 Agent provider；完成 Turn 在压缩后的 trace 后追加新证据。
- 稳定引用只允许展开当前 Turn Context 实际出现的记录；分页结果包含原始 tool call 与 tool result，不依赖压缩摘要重建。
- 现有 Runtime、Transcript、Context、Workspace、skills 与 Agent Execution 行为不回归。

## Out Of Scope

- orientation、life-recorder、now/thread maintainer、memory-reflector 或通用 Cognitive Organ framework。
- logical day、跨日 transcript locator、window closure、recent activity bridge。
- Model Runtime Revision、模型 fallback、器官调度与 Instance Configuration。
- 图片像素重新注入；没有像素内容时只记录图像存在与类型。

## Result

- Tool Trace Compactor 使用每次调用独立的 Pi session，只接收有界的完整非消息工具交互；system prompt、输出字段与严格校验均保持在该 Cognitive Organ 内，没有建立通用器官 framework。
- Agent Execution 在主 Agent session 创建和 Input inclusion 之前检查 raw tool trace 阈值。所有批次成功后才生成 replacement，并通过 Runtime 当前 Turn lease 做原子替换；任一失败保留 raw Context，下一次从同一 committed state 重试。
- 稳定引用由 Primary Agent Transcript 的 `sessionId + result entryId` 机械生成。当前 Turn 只从 Context 持久元数据建立授权集合；猜测、过期或任意历史引用不能展开。
- `expand_tool_result` 常驻主 Agent tool schema，按 40,000 characters 确定分页，返回原始 tool call 参数与 tool result 文本；图像只返回存在与 MIME type，不重新注入像素。
- 已压缩 interaction 不再次进入 compactor；成功展开的 working material 在后续 gate 中机械收回，失败展开不会误送给摘要模型。
- Runtime 覆盖成功 replacement 后 provider 失败仍保留 replacement，以及 stale compare-and-swap 不改变当前 Store；Agent Execution 覆盖真实 transcript 压缩、分页展开、越权拒绝、多批全有或全无及失败重试。

## Source References

- Xi `6608fde` `src/agents/tool-trace-compactor.ts`
- Xi `6608fde` `src/harness/tool-trace-compaction.ts`
- Xi `.scratch/context-planner/issues/06-expand-one-compressed-tool-result.md`
- Xi `.scratch/context-planner/issues/07-enforce-tool-result-compaction-gate.md`
- Xi `.scratch/context-planner/issues/09-expand-complete-tool-interaction.md`
- Loom [03 — Materialize Context Windows per Turn](03-materialize-context-windows-per-turn.md)
