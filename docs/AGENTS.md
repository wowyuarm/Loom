# docs 维护规则

本文件只管"如何维护 `docs/`"。它不定义产品行为——行为以源码和测试为准。

## 落点纪律：一个事实一个权威

- 每条事实只有一个权威落点，其它地方引用它，不复制。
  - 稳定术语与所有权 → `CONTEXT.md`
  - 模块/包关系与事实分层 → `docs/architecture.md`
  - 单个能力的实现契约 → `docs/subsystems/<capability>.md`
  - 不可逆的持久化/恢复/Session 取舍 → `docs/adr/NNNN-*.md`
- 易漂移的东西（命令、具体文件路径、代码片段）不进 `docs/`，它们属于源码、`package.json` 或脚本。

## 什么时候写、写什么

- **随模块落地补入**：一个模块讨论收敛、实现落地后，补一篇 `docs/subsystems/<capability>.md` 并在 [`README.md`](README.md) 索引表登记一行。不为还不存在的模块预建空壳文档。
- **非平凡改动若改变公开契约或工作流**，同步更新受影响的文档，不留过期描述。
- 文档描述调用方可观察的契约，不复述偶然的实现细节；注释和文档只写代码看不出的约束、原因、安全条件。

## scratch → docs 迁移

- `.scratch/active/<work>/` 是当时的研究和设计记录。工作项收口后，稳定结论迁入上面对应的正式文档，过程材料按 [`.scratch/AGENTS.md`](../.scratch/AGENTS.md) 归档或清理。
- 不为迎合新代码回写已归档的 scratch 材料——归档是历史。

## 双语

DSH 与 dsh-agent-team 用 `<doc>.md` + `<doc>.zh.md` 双语。Loom 起步默认中文单文件；确有英文读者需求时再引入 `.zh.md` 约定，不预先双写。
