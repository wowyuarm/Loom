# Loom 文档索引

这里是本仓库维护中的工程文档。根 [`AGENTS.md`](../AGENTS.md) 只放每个任务都要知道的规则；本索引按问题路由到详细文档。**按需取用，不必通读。**

改动 `docs/` 之前先读 [`AGENTS.md`](AGENTS.md)（文档维护路由与纪律）。

## 现状

代码尚未落地，`docs/` 处于建立中。稳定的模块文档随每个模块讨论收敛、实现落地后逐条补入本表——现在为空是正常的。进行中的设计见 [`.scratch/active/`](../.scratch/README.md)。

## 文档入口

| 文档 | 用途 | 什么时候读 |
| --- | --- | --- |
| `CONTEXT.md`（待建） | 稳定的 Loom 术语与所有权边界 | 改动领域语义、类型命名或材料契约时 |
| `docs/architecture.md`（待建） | 模块/包关系、Host 边界、事实分层 | 改动跨越模块或包边界时 |
| `docs/subsystems/<capability>.md`（随模块补入） | 单个能力的实现契约（一个能力一篇） | 改动那个能力时 |
| `docs/adr/NNNN-*.md`（随决策补入） | 不可逆的持久化、恢复或 Session 取舍 | 做出或追溯此类决策时 |

## 能力目录（规划中，逐个讨论后落地）

DSH 的 `packages/` 与 `docs/subsystems/` 是一份能力菜单。Loom 的每个模块会逐一对照：能复用的 DSH plugin 直接复用，语义不合的自实现。当前的模块↔plugin 初判见 [`.scratch/active/continuity-and-memory/`](../.scratch/active/continuity-and-memory/README.md) 及后续讨论；每个模块定案后在此登记一行并补一篇 subsystem 文档。

## 从哪里开始

- **理解连续性/记忆设计**：先看 `.scratch/active/continuity-and-memory/DESIGN.md`。
- **理解 DSH 底座**：`@deepseek-ai/dsh` 的 `docs/architecture.md` 与 `docs/subsystems/`（Cordis、profile/bundle、session、system-prompt）。
- **改代码**：以对应包的源码和测试为权威，用本索引定位相关 subsystem 文档。
