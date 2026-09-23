# Loom 文档索引

这里是本仓库维护中的工程文档。根 [`AGENTS.md`](../AGENTS.md) 只放每个任务都要知道的规则；本索引按问题路由到详细文档。**按需取用，不必通读。**

改动 `docs/` 之前先读 [`AGENTS.md`](AGENTS.md)（文档维护路由与纪律）。

## 现状

六个插件已落地并通电（clock、runtime-state、resident-context、context-continuity、agent-runtime、orientation），`cordis.patch.yml` 把它们组合成一个叠在 `dsh-base` 上的 bundle，完整部署已用真 launcher 与真模型跑通。模块级 subsystem 文档随各能力收口后逐条补入下表。进行中的设计见 [`.scratch/active/`](../.scratch/README.md)。

## 文档入口

| 文档 | 用途 | 什么时候读 |
| --- | --- | --- |
| [`dsh-platform.md`](dsh-platform.md) | DSH 的组合模型、Loom 用到的接缝、怎么跑一个部署、踩过的坑 | 动手改任何能力之前；写或改 bundle 清单时；要把部署跑起来时 |
| `CONTEXT.md`（待建） | 稳定的 Loom 术语与所有权边界 | 改动领域语义、类型命名或材料契约时 |
| `docs/architecture.md`（待建） | 模块/包关系、Host 边界、事实分层 | 改动跨越模块或包边界时 |
| `docs/subsystems/<capability>.md`（随模块补入） | 单个能力的实现契约（一个能力一篇） | 改动那个能力时 |
| `docs/adr/NNNN-*.md`（随决策补入） | 不可逆的持久化、恢复或 Session 取舍 | 做出或追溯此类决策时 |

## 能力目录（规划中，逐个讨论后落地）

DSH 的 `packages/` 与 `docs/subsystems/` 是一份能力菜单。Loom 的每个模块会逐一对照：能复用的 DSH plugin 直接复用，语义不合的自实现。当前的模块↔plugin 初判见 [`.scratch/active/continuity-and-memory/`](../.scratch/active/continuity-and-memory/README.md) 及后续讨论；每个模块定案后在此登记一行并补一篇 subsystem 文档。

## 从哪里开始

- **理解 DSH 底座、写 bundle 清单、把部署跑起来**：[`dsh-platform.md`](dsh-platform.md)。
- **理解连续性/记忆设计**：先看 `.scratch/active/continuity-and-memory/DESIGN.md`。
- **改代码**：以对应包的源码和测试为权威，用本索引定位相关 subsystem 文档。
