# 连续性 agent 的 session 与 memory 设计

**Status:** active（设计收敛，尚无实现）

**last-checked:** 2026-09-21

## 覆盖的 FRAMEWORK 模块

本工作项对应 [FRAMEWORK §5](../../../active/loom-architecture/FRAMEWORK.md) 的两行：

- **材料·记忆**（③）→ [DESIGN.md](DESIGN.md) 语义 + [materials-module.md](materials-module.md) 落法。
- **连续性（epoch/召回）**（④+②）→ [continuity-module.md](continuity-module.md)。

只覆盖**连续性**（agent 如何跨 session 连续存在），不覆盖**主动性**（agent 如何自己动起来）。主动性等基于 DSH 的 Loom（连续性 + 记忆 + 一个 channel）端到端跑通后再设计；架构上是加性层，靠两条纪律预留（见 continuity-module.md）。

## 文档分工

- [DESIGN.md](DESIGN.md)：材料/记忆层的**语义与决策**（identity/attention/memory/threads、醒来 bundle、记忆分层定位、心智 vs skill、预算）。只写 what/why。
- [materials-module.md](materials-module.md)：材料层**落到 DSH 的做法**（自写 `context()` provider、memory_write 工具、预算 helper）。
- [continuity-module.md](continuity-module.md)：连续性模块（复用 `dsh-context-continuity`、host binding、executeTransition、最小 runtime 的 current-session 指针、search 接线、预留挂点）。

## 已定的核心结论

- **两层数据**：记录层（session log，自写，靠 search 召回）vs 理解层（少量常驻材料，agent 手维护，引用记录层）。
- **三轴 + identity**：attention（当下、带 horizon、易失）/ threads（活线、可再进入）/ memory（沉淀理解 + 索引）/ identity（我是谁，最高门槛）。daily 砍掉——session log 就是那一天。
- **醒来 bundle**：稳定系统段（心智引导）+ 动态材料快照（`context()` 常驻全量、变了才刷新），attention 最贴当前 Input。
- **薄 memory 工具**：写"note + 索引行 + 来源戳"一个单元；memory 核心段与 attention/threads 走裸 fs。
- **search 双通道**：有引用按引用精确展开，无引用按内容搜索发现。
- **jev 接缝**：System 1 快模型，提议信号、不改状态；第一版可先用于 search 重排，主动性阶段承接机会路由。

## 完成条件

- agent 能跨 rollover 连续存在：醒来 bundle 从 workspace 投影、attention 随 handoff 刷新、memory 单元写入一致。
- 每类材料有明确的写入者（agent 自己）、常驻/按需投影、预算与失败行为；Harness 只做机械保障，不决定意义。
- search 双通道能从 note 的来源戳精确展开，也能按内容发现。
- prompt 心智引导 + 维护 skill 就位，agent 真能"醒来就在状态里"。

## 依赖与接缝

- 复用已发布的 `@wowyuarm/dsh-context-continuity`（rollover/checkpoint/timeline/search）作为记录层的 session 连续性与召回。
- 构建在 DSH（`@deepseek-ai/dsh`，Cordis）之上，遵循 everything-is-a-plugin：memory 层是 Loom 自有插件，装配进 Loom 的 profile/bundle。
- jev（typesafe.ai）作为可插入的 System 1 model，接缝留口，非阻塞。

## 正式文档出口

实现落地、稳定后，材料语义与所有权进入 `CONTEXT.md`，模块关系进入 `docs/architecture.md`，不可逆的持久化/恢复取舍进入 ADR。当前 scratch 不覆盖这些。
