# Loom src 初步整体审查与重构建议

审查日期：2026-08-08
审查范围：`src/`、对应 `test/`、`docs/architecture.md`、`CONTEXT.md`、ADR 与本主题前序 round 的现有材料。
审查基线：`main` 当前 `ee3e5db`；审查过程中 task #14 的改动已形成该 commit，本次未修改生产代码。

## 结论

当前代码的行为验证稳定：`npm run typecheck` 通过，`npm test` 通过，434/434 测试通过。

主要问题不是缺少通用工具，而是几个职责已经形成大模块，却仍由单个文件和单个类承担：

1. `src/runtime/runtime.ts` 同时承担 Runtime 编排、SQLite 读写、输入与 Wave、Turn、Effect/Delivery、Activity、Cognitive Organ、状态投影。
2. `Runtime.status()` 是完整历史诊断读取，却被 Scheduler 的每次运行用作调度判断，导致调度路径读取并解析不断增长的历史数据。
3. Main Agent Pi 执行、Raft Channel 与 Raft CLI Remote 都把协议/状态/编排/展示映射集中在一个实现文件中。
4. `runtime/types.ts` 把多个域的接口和状态类型集中在一个类型入口，增加导航和依赖理解成本。

建议按真实 seam 渐进拆分，保持现有公开接口和 Runtime Store 的具体 SQLite 实现不变。不要启动全仓库 `shared/utils` 清理，也不要预建可替换的 Store、Job Runner 或通用 Adapter 层。

## 检查结果

| 项目 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| 全量测试 | 434/434 通过 |
| 生产代码行数 | 25,296 行 TypeScript |
| 最大生产文件 | `src/runtime/runtime.ts`，4,914 行 |
| 最大测试文件 | `test/main-agent/pi-execution.test.ts`，3,859 行 |
| 当前工作区 | 生产代码无未提交改动；仅新增本审查报告 |

## 建议清单

### P1：拆分 `SqliteRuntime`，保留单一 Runtime Store

证据：

- `src/runtime/runtime.ts` 有 4,914 行、约 90 个方法和 208 处 SQLite `prepare` 调用。
- `SqliteRuntime` 的构造函数同时接收 Main Agent、Delivery、Activity Lifecycle、Life Recorder、Thread Maintainer、Attention Maintainer、Memory Reflector、Orientation、时间策略、租约、事件观察和 Cognitive Organ 策略。
- 同一个类同时修改 `inputs`、`turns`、`effects`、`delivery_attempts`、`active_segment`、`activities`、多个维护队列表和 `agent_runs`。

这会带来两个长期问题：一处生命周期变化需要在同一大文件的多个状态路径中同步修改；测试虽然穿过 `Runtime` 接口，但实现内部的状态耦合仍然难以局部验证。

建议按领域拆成 Runtime 内部模块，暂不改变 `Runtime` 对外接口：

- `InputAdmission`：Input 去重、Interaction Wave、scope gate、steering 和 Input 覆盖检查。
- `TurnExecution`：Turn claim、lease、execution state、tool activity、Effect 和 message decision。
- `DeliveryLifecycle`：Delivery claim、heartbeat、重试、未知结果和 after-chat continuation。
- `ActivityLifecycle`：Active Segment close/freeze、recording lease 和 Frozen Activity 提交。
- `CognitiveOrganCoordinator`：预算 attempt、取消宽限、soft deadline、agent run 与各器官域状态之间的协调。
- `RuntimeStatusReader`：完整诊断投影和运营状态投影。

这些模块可以共享同一个具体 `DatabaseSync` 和事务入口；不要为此引入公开的 database driver Interface。这样符合 ADR 0001：Store 仍由 Runtime 内部持有，SQLite 仍是唯一实现，变化只发生在实现内部。

验收标准：每一步保持 `Runtime`、`Scheduler` 和 Host 的公开行为不变；新增模块的测试仍通过公开或明确的内部 seam 观察，不直接暴露 SQLite 给调用方。

### P1：把调度快照与完整诊断分开，避免每次运行扫描全历史

证据：

- `src/runtime/scheduler.ts:151` 和 `:183` 在调度过程中调用 `runtime.status()`，只为读取 Active Segment、Pending Effect 和调度判断。
- `src/runtime/runtime.ts:1391` 的 `status()` 会读取所有 Input、Turn、Effect、Delivery、Activity 和维护记录，并解析 payload、execution record 等 JSON。
- Runtime 中没有对已完成 Input、Turn、Effect、Delivery 和 Transition 的常规历史清理；目前只清理未认领 Opportunity 等局部临时状态。
- `interactionView()` 已经有 cursor/limit 分页，说明历史读取与运行调度读取可以分开设计。

风险：Runtime Store 越运行越大后，每次 Scheduler tick 的读取和 JSON 解析成本随历史增长；运营状态本身只需要少量计数、最早待处理时间、Active Segment 和下次唤醒时间，却经过了完整历史投影。

建议：

1. 新增一个有界的 `schedulingSnapshot()` 或等价内部读取路径，只返回 Scheduler 需要的状态。
2. 运营 status 直接读取有界字段和按需聚合结果，不把完整 payload、execution record 和历史列表带入热路径。
3. 保留完整诊断读取作为明确的诊断接口，并为历史保留/压缩策略单独定边界；不要在本次重构中擅自删除 Runtime 事实。

这是性能和职责问题，不要求改变 Runtime Store 的恢复语义。

### P2：完成 Cognitive Organ 执行协调的内部拆分

现有 `src/runtime/cognitive-organ-execution.ts` 已经正确承载共享预算 ledger，但 `runtime.ts` 仍重复实现器官域 claim 和运行收口：

- `#advanceThreadMaintenance()` 与 `#advanceActivityRecording()` 都包含 pending 查询、budget claim、domain lease、heartbeat、取消释放、成功提交、失败回退和 agent run 收口。
- `runAttentionMaintenance()` 与 `runMemoryReflection()` 都包含 schedule 检查、budget claim、运行、取消/介入/失败/成功收口。
- `#runCognitiveOrgan()`、`#cancelActiveCognitiveOrgan()`、`#softDeadlineExpired()` 又在 Runtime 内承担另一组跨器官生命周期逻辑。

建议先把 `#runCognitiveOrgan`、取消宽限和 timer 迁入内部 `CognitiveOrganCoordinator`，再分别把 Activity Recording、Thread Maintenance、Attention 和 Reflection 的域状态保留在各自模块。共享的部分只覆盖真实相同的 attempt/lease 生命周期，不要做一个接受大量 SQL callback 的通用任务框架。

验收重点：取消后的 `cancelled` / `intervention_required`、重启恢复、重试预算、人工 requeue 和单写者约束全部保持现有测试语义。

### P2：拆分 Main Agent Pi 执行文件的现有 seam

`src/main-agent/pi-execution.ts` 有 1,240 行，当前文件同时包含：

- `PerTurnPiAgentExecution` 的 Turn 生命周期和 abort/steering；
- Pi Session 创建、Settings、Skill 合并与诊断；
- Context Window 恢复、压缩和首轮 prompt；
- Input 展示、Interaction Destination 展示和 Attachment 读取；
- Tool activity、错误断路器和 Operational Event；
- Transcript evidence 验证、图像脱敏和若干 JSON 转换。

建议沿已有函数和依赖 seam 拆分：

- `pi-session-factory`：Session、Settings、Skill 和工具装配；
- `pi-turn-runner`：每个 Turn 的恢复、prompt、steering、abort、evidence 收口；
- `input-presentation`：Input 文本、Interaction Context、Destination 和 Attachment 展示；
- `tool-activity`：工具开始/结束事件、失败断路器和 Runtime tool activity 记录。

不改变 `AgentExecution` / `RunningExecution` 接口。当前 `createSession` callback 已是可复用的内部 seam，可以先利用它拆文件，再评估是否需要更小的 Interface。

### P2：拆分 Raft Channel 与 CLI Remote 的协议层和本地状态层

证据：

- `src/channels/raft/raft-channel.ts` 有 1,706 行。`DefaultRaftChannel` 同时负责 Agent tools、模型可见 evidence、Wake ingress、SQLite spool、Destination/Reference 状态、Ambient attention、Delivery 和 status。
- `src/channels/raft/raft-cli-remote.ts` 有 1,298 行。`DefaultRaftCliRemote` 同时负责 CLI 子进程、bridge HTTP server、inbox spool、message/history/search 解析、profile 绑定、task/attention action 和 evidence 映射。
- `RaftRemote` 已经是一个真实的外部协议 seam；拆分应发生在实现内部，而不是再包一层通用 Channel Adapter。

建议顺序：

1. 先把纯解析和 target/reference/evidence 映射移到无副作用模块；
2. 再把 CLI 子进程、超时、bridge 生命周期移到 `raft-cli-process`；
3. 将 `DefaultRaftChannel` 的 Wake/Delivery 状态和 Model-facing Agent Surface 分开；
4. 保持 `RaftChannel` 和 `RaftRemote` 公开 Interface 不变。

这样可以让协议解析测试、进程故障测试、Runtime ingress/delivery 测试分别定位，不需要在一个 1,700 行类里修改三种行为。

### P3：按域拆分 `runtime/types.ts`，缩小调用方依赖

`src/runtime/types.ts` 有 754 行，混合了：Interaction/Input、Frozen Activity、Main Agent execution、Delivery、Cognitive Organ adapter、Runtime status、Scheduler options、Recovery result 和完整 `Runtime` Interface。

建议按稳定域拆成 `input.ts`、`activity.ts`、`execution.ts`、`delivery.ts`、`cognitive.ts`、`status.ts` 和 `runtime.ts`，由 `runtime/index.ts` 继续提供兼容的聚合导出。随后为高频调用方使用窄 Interface，例如 Scheduler 只依赖调度能力，nmem 只依赖活动读取能力。

这项主要改善导航和依赖方向，优先级低于 Runtime 实现拆分；不要为了拆类型而引入新的运行时抽象。

### P3：只在真实共同契约成立时收敛 nmem 投影状态

`src/integrations/nmem/threads.ts`、`episodes.ts` 和 `working-memory.ts` 都有独立 SQLite 状态、connection hash、失败分类和缓存/重试逻辑。Thread 与 Episode 的投影状态尤其相似，但各自的主键、内容 hash 和成功结果不同。

建议先不做全仓通用 `retry` / `errors` / `io` 模块。若后续继续修改 nmem，再设计一个 nmem 内部的投影 ledger seam，只隐藏真实共同字段：连接身份、内容版本、状态、attempt、nextAttemptAt 和错误分类；主键、成功结果和领域 reconciliation 仍留在各自模块。没有第二个真实 Adapter 或明确的共同持久契约时，不要抽象。

### P3：Schema、测试和低危 helper 只随上层 seam 迁移

- `src/runtime/schema.ts` 同时包含当前 DDL 和 10 个历史迁移，当前虽大但职责仍集中；只有在下一次 schema 变化时再按 migration 文件拆分，避免纯文件移动。
- `test/runtime/runtime.test.ts` 有 3,489 行，`test/main-agent/pi-execution.test.ts` 有 3,859 行。生产 seam 确定后，再按 Input/Turn/Delivery/Activity 或 Session/Presentation/Tool Activity 拆测试文件；现有测试已经主要通过公开接口观察行为，不应为拆文件而增加内部 SQL 测试。
- `withoutImagePixels`、`isObject`、`isMissing`、`errorMessage` 等重复 helper 不应触发全仓库 generic utility sweep。它们的错误策略和所属 Interface 不完全相同，保持局部或随所属模块迁移即可。

## 推荐执行顺序

1. 先落地有界调度/运营快照，验证长历史下 Scheduler 不再读取完整状态。
2. 在不改变 `Runtime` 公开 Interface 的前提下，拆 `RuntimeStatusReader`、Delivery 和 Activity 生命周期。
3. 再拆 Input/Wave/Reply Gate、Turn/Effect 和 Cognitive Organ 协调。
4. Runtime 稳定后拆 Pi 执行与 Raft 实现；每个 seam 单独迁移对应测试。
5. 最后处理类型聚合、nmem 投影 ledger、schema 文件和低危清理。

每个阶段都应保留：`npm run typecheck`、`npm test`、现有 SQLite 恢复测试、单写者约束测试和跨 Host 的端到端测试。每个 commit 对应一个可验证的 seam，不做“全仓库重构”单次提交。

## 不建议的方向

- 建立 `src/shared/guards`、`src/shared/io`、`src/shared/errors` 并批量迁移全仓调用点。
- 为 Runtime Store 预建 database driver、Repository 或可替换后端 Interface。
- 把 Cognitive Organs 改造成通用 Job Runner 或可注册插件系统。
- 为了降低文件行数而复制 SQLite 事务、租约和恢复逻辑到多个模块。
- 在没有明确保留策略前删除 Runtime 历史事实。
