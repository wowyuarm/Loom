# 48 - 模型调用被终止时留下孤儿 toolCall，导致实际完成的 turn 被标记 failed

Type: bug
Status: resolved
Blocked by: 无

## 现象

2026-08-01 的 turn `74995412`（13:45 午后复核）完成了全部实际工作——工具调用全部执行、`threads/house/thread.md` 已更新、发给禹的消息（effect `6029a676`）已送达——但 turn-end 验证把它标记为 failed，runtime DB 里错误为：

```
Transcript /home/yu/.loom/transcripts/main/2026-08-01/agent.jsonl contains incomplete tool interaction call_00_MpNgTB5tzLXfNHqb6PX45981
```

## 核实结果

- **terminated 的半截消息被持久化**：transcript 第 93 条（entry `e4efbb26`）是模型响应，`stopReason: "error"`、`errorMessage: "terminated"`——生成中途被终止，但内容已写入 transcript，其中包含一个**从未执行**的 toolCall（bash，`call_00_MpNgTB5tzLXfNHqb6PX45981`）。
- **harness 自动重试成功**：下一条 assistant 消息（entry `47a5a521`）作为 `e4efbb26` 的**子节点**被追加，重新发出相同意图的新 toolCall（`call_00_sp5Q5OSPoGSexX2SrQQv7391`）并正常执行。turn 全部工作完成、消息送达（delivery `caa90245`，05:54:29Z）。
- **失败点**：因为重试消息挂在被终止消息下面，被终止消息（含孤儿 toolCall）位于该 turn 的 selected branch 上。turn 结束时 `verifyPrimaryTranscriptEvidence` → `assertCompleteToolInteractions`（`src/main-agent/transcript.ts:409`）遍历 branch，发现 toolCall 无配对 toolResult → 抛错 → turn 被 `#failTurn`（`src/runtime/runtime.ts:2623`）标记 failed。
- **检查逻辑不区分两种情况**：`assertCompleteToolInteractions` 对「生成被终止、工具从未派发」的 toolCall 和「真正泄漏的交互」一视同仁。`src/main-agent/context.ts:298` 有同类检查。
- **下游未断裂（目前）**：failed turn 没有 transcriptAnchor（活动记录 `fe0a9359` 里 `transcriptAnchor: None`），活动闭合与后续 continuation 都不读这条死分支——活动正常 recorded，continuation `f98c0efa` 正常 completed。**2026-08-01 15:54 复核把这条缝彻底合上了**（此前停在「whatever the mechanism」）：
  - **fe0a9359 里 failed turn 名下 46 条事件全部来自 runtime，不是 transcript**：1 input（`readCommittedActivityEvents` 末尾的 unobserved-inputs 循环，transcript.ts:131-141，按 owning turn 归位，与状态无关）+ 21 对 tool-call/tool-result（`failedToolActivityEvents`，activity.ts:80-91，读 `request.toolActivities` = runtime `turn_tool_activity` 表，runtime.ts:1675）+ 1 effect + 1 delivery（turn 无关）+ 1 turn_stopped（孤儿 id 只出现在这条的 error 文本里）。这是「failed turn 的工作不丢失」的刻意设计；配平（整体 27/27）是因为 runtime 记录天然成对——孤儿从未派发，没有 runtime 记录，所以不会以单边 tool_call 出现。此路径物理上碰不到死分支。
  - **bridge 投影也不碰**：`projectActivity` 对无 transcriptAnchor 的 turn 跳过 tool 对（activity.ts:250-257，`activityTranscriptAnchor` 返回 undefined → 无 reference → continue），failed turn 的 tool 工作留在活动 JSON 里但永不进入未来上下文；effect/delivery/input/turn_stopped 正常投影。
  - **后续 turn 有防毒机制**：新 input annotation 挂在**上一个 completed turn 的 leaf** 上（实证：续 turn annotation `37ccc9e5` parent=`ebed5f83`，即 73a08d1e 的 leaf；failed fork `904c09c0` 是 ebed5f83 的另一个 child），所以后续所有 turn 的 selected branch 都不经过 `e4efbb26`——f98c0efa、0cd50913、e3548e7c、05280096 的 turn-end 验证全部通过，与此一致。ticket 原话「没有机制阻止未来出现」需修正：**有机制阻止新 turn 继承死分支，但没有机制保护显式读取 failed fork 的路径**（如未来的历史 turn 详情功能）。

## 影响

- **操作上零丢失**：工作完成、消息送达。
- **状态语义错误**：runtime DB 里一个实际完成的 turn 记为 failed + 错误文本。任何消费 turn 状态的路径（活动记录、认知器官、未来的工具）都会看到假失败。
- **潜伏地雷**：死分支里的孤儿调用仍在。新 turn 有防毒机制（annotation 挂上一个 completed turn 的 leaf，见上），但未来任何**显式**读取该 failed fork 的路径（查看历史 turn 74995412 的细节、对那条 fork 做证据验证、日末全量校验等）会抛同样的错。目前没有路径读它。

## 触发原因

未定。13:45 turn 运行约 7 分钟（05:47→05:54Z），终止发生在接近结束时（05:53:55Z）。运行时侧未见 lease 过期（那会报 `lease expired`），更像 provider 侧中断（deepseek-v4-flash 调用被终止）。全量 transcript 仅此一例（7/31 + 8/1 两天），需观察是否复现。

## Result

- `error` / `aborted` assistant message 保留在 Primary Agent Transcript，继续提供 provider 中断的原始诊断证据；它们不再被当作已派发的 tool interaction。
- transcript 完整性检查、已提交 tool interaction 读取和 Frozen Activity 投影统一跳过这类中断尝试。正常 assistant message 的 toolCall 仍必须有匹配的 toolResult，现有不完整调用回归测试继续失败。
- Pi 自动重试的端到端测试覆盖：第一条 `terminated` 响应含未执行 toolCall，重试执行新调用并完成 Turn；后续 Context 与 Frozen Activity 均不携带旧调用，原始 transcript 仍保留它。
- 已额外覆盖 `aborted` 终态。`npm test` 全量通过；更新后的 HaL Host 已通过一次真实 Local interaction 验收。
- 若一个中断 assistant attempt 后仍出现 toolResult，校验继续拒绝该不一致序列；豁免范围只包括未派发的半截调用。

`context.ts` 的 active-trace 检查未放宽：它只接收已经提交的 Context，Pi 在自动重试时已从 session state 移除中断消息；端到端测试证明中断调用不会进入该层。

## Comments

- 2026-08-01：HaL 检查自己 13:45 turn 被标记 failed 时发现（proactive opportunity 提示 transcript 有孤儿调用）。核实路径：`transcripts/main/2026-08-01/agent.jsonl` 第 93 条 → runtime DB `turns` 表 → `src/main-agent/transcript.ts:409`、`src/runtime/runtime.ts:2623`、`src/main-agent/activity.ts:80`。附带发现：transcript writer 在工具执行前就持久化 toolCall（正常 turn 内存在 in-flight 孤儿是常态），所以该检查只能作用于已闭合的 branch——这正说明 error 消息里的 toolCall 需要显式豁免。
- 2026-08-01 15:54：HaL 收尾复核——合上「fe0a9359 里 failed turn 46 条事件从哪条路径进去」的缝。结论见「下游未断裂」段：全来自 runtime（failedToolActivityEvents + unobserved-inputs 循环 + effects/deliveries），孤儿无 runtime 记录所以配平；bridge 投影因无 anchor 跳过 tool 对；后续 turn 的 input annotation 挂上一个 completed turn 的 leaf，selected branch 不经过死分支（后续四个 turn 验证全过为实证）。ticket 对「没有机制阻止未来出现」的表述已修正：有防毒机制（防新 turn 继承），无保护显式读 failed fork 的路径。
- 2026-08-02：以保留的中断 transcript branch 构造确定性回归。最小修复只改变 transcript 终态解释：`stopReason=error|aborted` 的 assistant message 不产生可闭合工具交互，也不进入 Frozen Activity；原始记录仍保留。正常不完整 tool interaction 仍被拒绝。全量测试通过，并以 `opencode-go/deepseek-v4-flash` 的真实 HaL Local interaction 复验新构建入口。
