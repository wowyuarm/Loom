# 02 — Bind Agent Execution to Pi Transcript Evidence

Type: design and implementation
Status: resolved
Blocked by: None

## Question

Agent Execution 如何直接使用 Pi 运行主 Agent，并把真正进入所选 Pi branch 的 Input 和完整 Turn 结果转成可验证的 Primary Agent Transcript evidence，同时不形成第二套 executor，也不让 Runtime 依赖 Pi 内部细节？

## Already Decided

- Pi 是 Loom 唯一的 agent capability infrastructure；Loom 不再实现一套通用 session、model runner 或 tool loop。
- Agent Execution 是 Runtime 与 Pi 之间必要的小 Interface。它表达 Turn 的启动、运行中 Input 排队与实际纳入、取消和完成，不暴露 model、prompt、tool、session tree 或 provider 细节。
- `agent.jsonl` 是主 Agent 按日追加的完整执行证据，不是 Input、Effect、Delivery 或恢复事实的权威。
- 每个真正交给主 Agent 的 interaction 或 Proactive Opportunity 都有中性、版本化的 Pi custom annotation；内部 follow-up 不伪装成外部 Input。
- Runtime Store 只保存 Agent Execution 已验证的 Transcript Anchor。Pi event、内存中的 entry 和 `message_end` 都不能单独证明 JSONL 已经可读。
- Context materialization 属于 Agent Execution 内部的深 Module；Runtime 只交付结构化 Input，不组装 prompt，也不知道 daily、now、bridge 或 token budget。
- Primary Agent 与 Cognitive Organs 后续可以复用同一套 Pi factory 规则，但必须有独立 session、transcript、system material 和 tools。

## Evidence

- Pi `AgentSession.prompt()` 会等待 retry、auto-compaction 和 queued continuation，返回时 session 已 settled；此时才适合验证最终 selected branch 和 JSONL evidence。
- Pi `AgentSession.steer()` 只把消息加入进程内 queue，返回并不表示该 Input 已被模型接纳或写入 transcript。
- Pi subscriber 先收到 `message_end`，`SessionManager` 随后才 append 对应 entry；tool end 也早于最终 `toolResult` message。
- `SessionManager.appendCustomEntry()` 会立即改变 live leaf。在旧 assistant 或 tool 仍运行时预先 append steering annotation，会把 annotation 错插进上一段执行记录。
- 新 persistent Pi session 在首个 assistant message 前不会创建文件。首个 assistant 后使用同步文件写入，但没有断电级 `fsync` 保证。
- 当前 Runtime 的 `AgentExecution` seam 足够小，但现有 `steer() -> TranscriptAnchor` 把“已排队”“已开始纳入”和“evidence 已验证”错误合成了一个时点。

## Resolution

### Agent Execution seam

保留 Runtime 已有的 `AgentExecution.start()`、running execution、steering 和 completion 形状。它是 Loom 的生命周期 Interface，不是可替换 Pi 的通用 executor。production implementation 直接持有 Pi `AgentSession` 与 `SessionManager`；Pi model runtime、resources、tools、events 和 transcript verification 都留在该 Module 内。

Runtime 接受 Input 后应立即返回，不等待 Pi 当前 provider/tool activity 结束。`steer()` 只负责把 Input 交给 Pi queue，不返回 Transcript Anchor。

Agent Execution 在 Pi 实际发出对应 `message_start:user` 时，通过 Turn control 通知 Runtime 该 Input 已开始纳入。Runtime 此时把 prepared turn-input 转成 included，使随后产生的 Effect 能覆盖它；这不是 transcript durability 证明。Turn settled 后 Agent Execution 再返回每个 included Input 的 verified anchor 与 final Turn anchor，Runtime 在 completion transaction 中一并保存。排队但尚未出现 `message_start:user` 的 Input 保持 pending，可由下一 Turn 处理。

### Transcript annotation

每个外部 Input 使用 `loom.input.v1` custom entry，至少保存：

- `turnId`、`inputId`、`inclusionPosition`
- occurrence time
- `interaction` 或 `opportunity`
- 保真正文与媒体引用

annotation 不保存称呼、展示时区、route、credential、Effect、Delivery 或 Turn completion。annotation 不能在 `steer()` 入队时预写；Agent Execution 维护待纳入 Input metadata，并在 Pi 对应的 `message_start:user` lifecycle 内同步 append annotation，使随后由 Pi append 的 user entry 成为它的 child。Runtime 保存的是验证结果中的 session/entry anchor，不解析 annotation 内容。

### Initial Input and steering

- Initial Input 与 Steering Input 使用同一套纳入机制：Agent Execution 先登记 metadata，再把消息交给 Pi；只有对应 `message_start:user` 出现时才 append annotation，并立即通知 Runtime inclusion 已开始。
- Agent Execution 按实际 Pi user-message 顺序配对待纳入 Input，不能按正文唯一匹配；相同文本、多个 steer 和 Pi 的 `steeringMode=all` 都必须保持稳定。
- `message_end:user` subscriber 仍早于 Pi append，不能产生 anchor。session settled 后从实际 `agent.jsonl` 重新读取 selected continuous branch，确认每组 annotation -> user entry、完整 tool units 和 final leaf，再返回 evidence。
- Internal follow-up：由 Agent Execution 自己继续同一运行，不创建 Runtime Input annotation；其消息与工具记录仍保留在 Pi transcript。

### Completion and recovery

Turn completion 的顺序固定为：Pi run settled -> tool call/result 完整 -> selected branch 验证 -> JSONL evidence 验证 -> Agent Execution 返回每个 included Input anchor 与 final Turn anchor -> Runtime transaction 保存 anchors 并完成 Turn 与 Inputs。

进程若死在 transcript append 与 Runtime anchor commit 之间，Runtime 仍按自身事实将 Turn 视为 interrupted；没有 Effect coverage 的 Input 可进入新 Turn。Loom 首版不为这一个窗口加入跨 SQLite/JSONL 的两阶段提交，也不从 transcript 反推 Runtime completion。已有 evidence 保留在 transcript，不能被覆盖或伪装成已提交的 Runtime fact。

## Implementation Entry

本 ticket 只建立真实 Pi Agent Execution 与 transcript evidence 链：

1. 锁定并接入 `@earendil-works/pi-coding-agent@0.80.10`，显式组装 model runtime、resource loader、settings、session manager 和 tools。
2. 拆开 queue receipt、`message_start:user` inclusion 和 settled transcript evidence；让 steering acceptance 不阻塞 inbound，并让 Effect coverage 使用实际 inclusion position。
3. 让 Runtime completion 原子保存各 Input anchor 与 final Turn anchor；未开始的 queued Input 留在 pending。
4. 实现 fresh daily `agent.jsonl`、selected branch verifier、initial prompt completion与 live steering inclusion。
5. 通过真实 Pi session 的隔离测试验证 annotation、相同文本 steer、user/assistant/toolResult 顺序、reopen、branch 连续性，以及首个 assistant 前、live tool 中 steer 与 anchor commit 前的失败窗口。

本 ticket 不实现完整 Context policy、active window、Workspace layout、Cognitive Organs、真实 channel 或 model hot reload。Context 是本层的下一张 work item，以这里形成的 Pi session 和 transcript chain 为入口。

## Source References

- Xi [10 — Primary Agent Transcript](../../../../Xi/.scratch/harness-generalization/issues/10-define-primary-agent-transcript-protocol.md)
- Xi [Pi 0.80.10 SDK Boundary and Migration Evidence](../../../../Xi/.scratch/harness-generalization/research/09-pi-08010-sdk-boundary-and-migration-evidence.md)
- Xi `src/harness/agent.ts`, `src/harness/turn-context.ts`, `src/harness/windowed-context.ts`, `src/harness/truth-log.ts`
- Loom [01 — Refine Runtime and Runtime Store](01-refine-runtime-and-store.md)

## Result

Loom 已直接锁定实际 import 的 Pi coding-agent 与 ai packages 为 `0.80.10`；agent-core 由 coding-agent 依赖，等 Loom 首次直接 import 时再声明。Agent Execution 通过一个小型 Interface 接入真实 `ModelRuntime`、`AgentSession` 与 `SessionManager`。生产实现不包含第二套 executor，只暴露 read-only custom tools；需要改变状态或对外行动的工具仍须后续经过 Runtime Effect。

Input 的三个时点已拆开：Runtime 先持久接受并建立 prepared relation；Pi `message_start:user` 时同步写入 `loom.input.v1` annotation 并标记 included；Pi settled 后重新读取 `agent.jsonl`，验证 selected continuous branch、annotation -> user entry、完整 tool call/result、成功的 final assistant leaf，再由 Runtime completion transaction 保存各 Input anchor 与 Turn anchor。Initial Input 与 live steering 走同一条 inclusion 链，相同正文按 FIFO 和 Input ID 保持稳定。

取消会立即停止接受 steering、清空尚未开始的 Pi queue，并拒绝 completion；Pi 最终 `error` / `aborted` response 只作为失败证据保留，不能消耗 Input。未出现 `message_start:user` 的 queued Input 保持 pending。Pi 自身对非法非空 session file 的拒绝也经过回归测试，原文件不会被改写。

当前实现没有 internal follow-up 入口，因此没有为未来 continuation 预建另一套队列协议。Context 后续若真正引入 internal follow-up，必须在进入 Pi queue 时显式区分它与 external Input，不能让通用 user-message FIFO 误配 annotation。

在 Node `24.15.0` 下，`npm run typecheck`、`npm run build` 与 `npm test` 均通过；测试共 19 条，覆盖 fresh/reopen transcript、initial 与 live steering、重复正文、abort、provider error、非法 transcript、真实 custom tool/result、incomplete tool rejection、Runtime recovery、Effect coverage 与 delivery unknown。
