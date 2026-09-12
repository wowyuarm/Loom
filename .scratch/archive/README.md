# 归档主题索引

这些主题已经收口，材料用于追溯当时的设计、证据和判断。归档只代表当时的语境，不覆盖当前实现——当前行为以 `src/`、`test/`、真实运行状态和 `docs/` 为准，也不要为了对齐新代码而改写归档。

| 主题 | 收口结果 | 历史资料 |
| --- | --- | --- |
| harness-layers | Loom 逐层建设历史档案（issues 01→53，2026-07-18 → 2026-08-14）；当前行为以代码、测试和正式 docs 为准 | [`harness-layers/map.md`](harness-layers/map.md) |
| codebase | codebase 审查的时间轮次（4 轮，2026-08-05 → 2026-08-14）：设计简化、重构筛选、架构审查、清理 | [`codebase/README.md`](codebase/README.md) |
| organ-execution | 决策已形成（2026-08-29 评审确认「域行预算 + lane 循环」方向），`spec.md` 状态为 ready-for-agent；实施票尚未落地 | [`organ-execution/README.md`](organ-execution/README.md) |
| codebase-ablation | codebase 消融实验（2026-09-03）：模块删除、器官 stub、静态耦合图谱三轮 | [`codebase-ablation/README.md`](codebase-ablation/README.md) |
| test-ablation | 测试套件消融体检（2026-09-03）：leave-one-out 覆盖率、时长分布与冗余候选定性复核 | [`test-ablation/README.md`](test-ablation/README.md) |
| raft-channel | 评估并把 Raft 实现为 Loom 的 Interaction Channel 集成（2026-08 归档） | [`raft-channel/map.md`](raft-channel/map.md) |
| instance-operations | 单实例运维合同研究：整实例备份恢复、操作者可读状态、最小可持续维护实践（2026-08 归档） | [`instance-operations/map.md`](instance-operations/map.md) |
| web-access | 可选的 Web Access Integration：按需搜索公开网页、读取已知 URL 的有界正文（2026-08 归档，已 complete） | [`web-access/map.md`](web-access/map.md) |
