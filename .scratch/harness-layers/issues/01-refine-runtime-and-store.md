# 01 — Refine Runtime and Runtime Store

Type: design
Status: resolved
Blocked by: None

## Question

在已确认的 Runtime 职责和 SQLite Runtime Store 方向下，Runtime 对其他层提供什么 Interface，运行事实如何转换，Runtime Store 与 Agent Execution、Primary Agent Transcript 和 Integrations 的依赖应在哪里形成 seam？

## Already Decided

- Runtime 负责 input、turn、effect/delivery、recovery、context materialization、调度原语、capability 执行和运行观测，不替 Individual 决定关注、主动、沉默或表达。
- 每个 Runtime Instance 使用本地 SQLite Runtime Store；它是恢复事实的唯一权威。
- Store 保存 input、turn、effect、delivery attempt、schedule、lease、active window、Integration 回执与迁移元数据；Workspace、Transcript、凭据和大型媒体不进入 Store。
- effect 必须在外部 I/O 前持久存在；delivery 为 `unknown` 时不盲目重发，也不重跑 originating input。
- Primary Agent Transcript 保留执行证据，Store 只保存可验证 anchor。

## To Refine

- Runtime 对 Agent Execution、Integrations 与 daemon/CLI 入口分别暴露哪些最小 Interface。
- input、turn、effect、delivery、schedule 与 lease 的必要状态和转换条件。
- 哪些转换必须位于同一事务，哪些外部动作必须在事务外执行。
- Runtime Store 如何验证和保存 Transcript anchor，而不解析 Individual 展示文字。
- recovery 如何从事实恢复进行中的工作，并明确区分可重试、已消费和需要 reconciliation 的状态。
- 这些 Interface 应如何以测试 Adapter 验证，而不提前建立多数据库、多 channel 或通用 executor 抽象。

## Resolution

### Runtime ownership

Runtime 是 input、turn、effect、delivery、lease 与恢复生命周期的唯一 owner。daemon、CLI 和 inbound Integration 只把 input 交给 Runtime、要求它推进工作或读取状态，不直接读写 Runtime Store，也不自行决定 replay。

Runtime 对 host 保持三个能力：

- 持久接受 input，并以来源 identity 去重；是否加入 active turn 或等待由 Runtime 决定。
- 推进一个到期工作单元，包括 main turn、delivery 或已注册 schedule；打开 Runtime 时自动 reconciliation。
- 返回只读运行状态和需要人工 reconciliation 的事实。

`steer`、恢复和 Store maintenance 不成为 host 必须正确编排的公开步骤。

### Real seams

- Agent Execution 提供启动主 Agent Turn、向运行中的 Turn 纳入新 Input、取消运行并返回执行结果与 Transcript Anchor 的 Interface。Pi 是 production Adapter，测试使用 deterministic Adapter。
- Integration 只接收已经持久存在的 delivery attempt，并返回 `delivered`、`not_sent` 或 `unknown` 观察结果。Integration 不写 Runtime Store，也不读取 Agent Workspace 的关系材料。
- Primary Agent Transcript 由 Agent Execution 持有。Runtime 只接受 Agent Execution 返回的已验证 anchor，不解析 transcript 展示文字。
- Runtime Store 是 Runtime 内部的具体 SQLite 实现。首版不定义 database driver Interface；测试直接使用临时 SQLite 数据库。

### Fact relationships

- Input 先持久接受，再参与执行。它同一时刻最多属于一个 running Turn；尚未实际纳入执行的 steering input 仍保持 pending。
- Turn 是一次 Runtime 控制的主 Agent 运行。provider fallback 属于 Agent Execution 内部；崩溃后的重新处理使用新的 Turn，并保留与原 Input 的关联。
- 一个 Turn 可包含 triggering Input 和后续 steering Inputs。每个已纳入 Input 都有单调递增的 inclusion position。
- Effect 属于产生它的 Turn，并记录创建时已经纳入的 Input position。这样恢复能区分 effect 之前已经参与判断的 Input 与尚未被外部行动覆盖的晚到 Input。
- 所有可能改变外部或 Workspace 状态的 capability 默认视为 effectful；只有明确声明为 read-only 的 capability 可以不产生 Effect。`no_reply` 是显式 Turn outcome，不是 Effect。
- Delivery attempt 属于一个 outbound Effect。重复尝试只推进该 Effect，不重新运行 originating Turn 或 Input。

### Current states

- Input: `pending -> active -> consumed`。没有覆盖 Effect 的 interrupted/failed Turn 可将 Input 退回 `pending`；无法自动处理且需要介入时进入 `blocked`。
- Turn: `running -> completed | failed | timed_out | cancelled | interrupted`。terminal state 不倒退。
- Effect: `pending -> completed | reconciliation_required | abandoned`。是否允许新的 attempt 由 Effect policy 和已有结果决定。
- Delivery attempt: `prepared -> dispatching -> delivered | not_sent | unknown`。进程在 `dispatching` 后失去执行权时保守收敛为 `unknown`。
- Schedule: `pending -> running -> completed | cancelled`；失败是否重新 pending 由已注册 schedule policy 决定，不由 Runtime 猜测意图。

### Transaction boundaries

以下每项各自在一个短同步 transaction 中完成，并同时追加 transition audit：

1. 接受 Input、写 dedupe identity，并在 Integration 提供 checkpoint 时一同推进 checkpoint。
2. claim pending Inputs、创建 running Turn、建立 turn-input 关联并取得带 fencing token 的 lease。
3. 在 capability 或 delivery 外部 I/O 前创建 Effect 或 `dispatching` delivery attempt。
4. 外部 I/O 返回后写入完成、`not_sent` 或 `unknown` 事实。
5. Transcript 已 durable 且 anchor 验证成功后，终结 Turn，并原子更新所含 Inputs 与审计事实。

模型调用、Pi transcript append、Integration 请求、Workspace I/O、backup 和其他 `await` 不进入 SQLite transaction。每次终态写入校验 fencing token，拒绝旧进程或已取消 Turn 的迟到动作。

### Recovery

- running Turn 的 lease 失效后先标为 `interrupted`，不恢复进程内执行对象。
- 没有覆盖 Effect 的 Inputs 回到 pending，可由新 Turn 处理。
- 已被 Effect 覆盖的 Inputs 视为 consumed；恢复单位缩小到 Effect、Delivery 或 reconciliation。
- 晚于最后一个 Effect inclusion position 的 steering Inputs 可回到 pending，不因同一 Turn 早先已经对外行动而丢失。
- `dispatching` 且没有可靠结果的 attempt 变为 `unknown`。只有 Integration 能证明相同 idempotency key 可查询或安全重试时，才允许自动推进。
- Transcript Anchor 缺失或无效时不能推进依赖它的 window/Turn completion；Runtime 不通过解析 transcript 文案猜测完成状态。

### Implementation entry

第一个实现单元只建立 Runtime Store 的核心事实链：Input、Turn、turn-input inclusion、Effect、Delivery attempt、lease、transition audit，以及上述事务和恢复测试。它随实际代码初始化 Node/TypeScript 项目，并使用 `node:sqlite`；暂不接 Pi、真实 channel、schedule、active window 或迁移工具。

完成标准是通过 Runtime 的 Interface 用临时 SQLite 验证：重复 input、正常完成、无 Effect 崩溃重试、Effect 后崩溃、late steer、dispatching 后崩溃和 stale fencing token。Store 内部 SQL 不作为测试 Interface。

## Source References

- Xi [03 — Runtime Kernel Contract](../../../../Xi/.scratch/harness-generalization/issues/03-identify-the-runtime-kernel-contract.md)
- Xi [07 — Interaction Route and Message Contract](../../../../Xi/.scratch/harness-generalization/issues/07-define-interaction-route-and-message-contract.md)
- Xi [09 — Runtime Store and Recovery](../../../../Xi/.scratch/harness-generalization/issues/09-set-runtime-store-storage-and-recovery-boundaries.md)
- Xi `src/runtime/`, `src/state/`, `src/harness/turn-runner.ts`, `src/channels/outbound.ts`

## Out of Scope

- Agent Workspace 材料布局与 Evolution Protocol 细节。
- Cognitive Organ 的身份、prompt 和调度细节。
- 生产 Xi 状态迁移、兼容导入和多数据库支持。

## Result

- Runtime 对 host 收口为 input acceptance、`advance()` 与只读 status；reconciliation 在 Runtime 打开时自动完成。
- Agent Execution 与 Integration 成为两个真实 seam；SQLite Store 保持 Runtime 内部的具体实现。
- 已实现 Input、Turn、steering inclusion、Effect、Delivery attempt、lease/fencing、transition audit 和基于 Effect coverage 的崩溃恢复。
- 已通过 7 个 Runtime Interface 测试：去重、正常完成、无 Effect 恢复、lease 续期、Effect 后恢复、late steer 与 delivery `unknown`；并在 Node `24.15.0` 下复跑。
