# docs 维护与索引

触碰 `docs/` 会自动加载本文。它是 `docs/` 的入口：把问题路由到具体文档，并定维护纪律。文档描述当前状态与对外契约，行为以源码和测试为准（权威顺序见根 [`AGENTS.md`](../AGENTS.md)）。**按需取用，不必通读。**

## 索引：一个事实一个权威

每类事实只有一个落点，其它地方引用、不复制。

| 文档 | 放什么 | 什么时候读/写 |
| --- | --- | --- |
| [`dsh-platform.md`](dsh-platform.md) | DSH 的组合模型、Loom 用到的接缝、怎么跑部署、踩过的坑、绑 DSH 的风险 | 改任何能力前；写或改 bundle 清单；把部署跑起来 |
| [`deployment.md`](deployment.md) | 管理一个部署：`cordis.patch.yml` 的角色、三层落点、授权、换模型/provider | 换模型或 provider、加授权、搞清 cordis.patch.yml 干什么 |
| [`extending.md`](extending.md) | 为部署加 plugin：本地文件与 npm 包两种形态、插件最小形状、排错 | 装一个 plugin |
| [`agent-context.md`](agent-context.md) | 怎么写 subsystem 文档、怎么给 agent 建设工作上下文 | 写或补文档、交接、闭合工作项 |
| `CONTEXT.md`（待建） | 稳定的 Loom 术语与所有权边界 | 命名或所有权产生歧义 |
| `architecture.md`（待建） | 模块/包关系、Host 边界、事实分层 | 改动跨越模块或包边界 |
| `subsystems/<capability>.md`（随模块补入） | 单个能力的对外契约（一个能力一篇） | 改那个能力，或交接 |
| [`subsystems/model-switch.md`](subsystems/model-switch.md) | 模型热切换：控制文件放哪、什么格式、怎么生效与撤销、拒绝语义、边界 | 换活体的模型而想不重启；改这个能力 |
| `adr/NNNN-*.md`（随决策补入） | 不可逆的持久化、恢复或 Session 取舍及其理由 | 做出或追溯此类决策 |

易漂移的东西（命令、具体文件路径、代码片段）不进 `docs/`，它们属于源码、`package.json` 或脚本。

## 写文档

- **随模块落地补入**：一个模块讨论收敛、实现落地后，补一篇 `subsystems/<capability>.md` 并在上表登记一行。不为还不存在的模块预建空壳。
- **非平凡改动若改变公开契约或工作流**，同步更新受影响的文档，不留过期描述。
- 文档写调用方可观察的契约，不复述实现细节；注释和文档只写代码看不出的约束、原因、安全条件。

## scratch → docs

`.scratch/active/<work>/` 是当时的研究和设计记录。工作项收口后，稳定结论迁入上表对应的正式文档，过程材料按 [`.scratch/AGENTS.md`](../.scratch/AGENTS.md) 归档或清理。不为迎合新代码回写已归档材料——归档是历史。

## 双语

DSH 用 `<doc>.md` + `<doc>.zh.md` 双语。Loom 起步默认中文单文件；确有英文读者需求时再引入 `.zh.md`，不预先双写。
