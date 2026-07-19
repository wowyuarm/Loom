# 07 - Correct Runtime and Source Boundaries

Status: resolved
Type: architecture correction

## Problem

阶段回顾确认了两处不应继续向后累积的问题：

- 新 Runtime 若在旧 lease 到期前启动，只会在启动时对账一次；lease 后来过期时，`advance()` 仍会永久返回 busy。
- Runtime 直接定义并校验 `frozenSeed`、`committedTrace` 等主 Agent Context 结构，使后续 window closure、bridge 和 logical day 改动必须穿透 Runtime。

当前源码路径还把完整领域术语直接放进目录，`agent-execution`、`agent-workspace` 与 `cognitive-organs` 不利于快速导航；Runtime 的 `Integration` Interface 实际只负责 outbound delivery，名称也提前占用了更大的 Integration 概念。

## Confirmed Direction

- Runtime 在每次推进工作前对账到期 Turn 与 Delivery，而不只在创建时对账。
- Runtime Store 继续持久保存主 Agent 可恢复状态，但只把它当作不透明 JSON；Context schema、验证与演化归 main Agent Module。
- 源码目录使用 `runtime/`、`main-agent/`、`workspace/` 与 `agents/`；完整领域称呼继续用于 Interface 和文档。
- delivery seam 使用准确名称，不把 channel、nmem 与 extensions 都误称为 `deliver()`。
- 本票不实现写入型 agent 生命周期、Effect 后 Context 补偿、共享 Pi session Module 或新的 Integration。

## Test Seams

- Runtime Interface：用临时 SQLite 验证启动过早的 replacement Runtime 会在 lease 实际过期后恢复推进。
- Main Agent Interface：通过真实 Pi faux provider 验证 Runtime 不理解 Context 内容后，成功、失败、compaction 与恢复语义保持不变。

## Result

- `advance()` 在没有本地运行对象时先对账已过期的 Turn 和 Delivery；replacement Runtime 即使启动早于 lease 到期，也能在后续推进时恢复。
- Runtime 的 Interface 与 Store 只保存不透明的 `executionState` 和 `executionRecord`；Context Window schema、解析、replacement 约束与完成构造归入 Main Agent。
- 源码归为 `runtime/`、`main-agent/`、`workspace/`、`agents/`；目录使用短导航名，完整领域术语保留在 Interface 和 glossary。
- 只负责出站投递的 seam 命名为 `OutboundDelivery`；`Integration` 继续表示 channel、nmem 与 extensions 的完整接入概念。
- 删除未参与任何并发判断的 execution-state `revision`；原子 replacement 继续由 Runtime 事务内的当前值比较保证。
- build 在编译前清理 `dist/`，目录迁移不会遗留并重复执行旧测试产物。
- 本票没有改变模型可见 prompt、tool description 或 Agent Workspace 正式材料文字。

## Verification

- `npm run typecheck`
- `npm test`：50 tests passed；clean build 后没有旧目录测试重复。
- Node `24.15.0` 直接运行编译产物：50 tests passed。
