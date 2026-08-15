# 2026-08-14 Cleanup

Captured: 2026-08-14

Baseline: `01a3f8a`

Status: execution tickets created（cleanup #42；深化/行为 tickets #43–#46）

## Result

本轮执行 ponytail-audit 全仓裁剪扫描（三个并行子代理 + 主代理逐条回读源码复核），并把上一轮架构审查的深化候选固化进仓库。产出：

- [Ponytail 审计证据](research/ponytail-audit.md) —— 14 条裁剪 + 1 条依赖归类修正，净约 -215 行、0 依赖可删；每条附 file:line 与复核结论；被审查后拒绝的候选（jsonObjectsIn stdlib 替换行为不等价、Temporal polyfill 实测必需、Scheduler 工厂与 nextRunId borderline）连同理由一并记录，避免下轮重复推导。
- [深化候选固化](research/deepening-candidates.md) —— 架构审查的 R1/R2/A1/A2/M4/M1 等 12 个 shallow→deep 候选，与裁剪清单分离，留后续选单做 spec。
- [清理 spec](spec.md) —— 本轮工作单元（裁剪清单 + conventions 修正），`Status: ready-for-agent`。
- [Conventions 审计证据](research/conventions-audit.md) —— 以 typescript-conventions / testing-policy / defensive-patterns 三个文档为合同的第二轮扫描：9 条修正（含 2 条测试修正）+ 5 条 correctness 观察（2 条 teardown 纪律缺口待定、3 条按「不过度防御」规则裁决不修）。

已确认：validate-instance.mjs 删除（不进 scratch）；Scheduler 工厂与 nextRunId 两个 borderline 项留 grilling，不在本 spec 执行范围内。

## 2026-08-15 收敛

当前实现以代码、测试和正式文档为准。本轮核对结果、`workspaceMirror.intervalMinutes` 删除取舍和 tickets 边界见 [decision](decision.md)。

## 下一步

执行 Agent 独立 worktree 按 spec 裁剪，完成证据为 typecheck + 分层测试（test:fast / test:runtime / test:host）+ diff 检查；深化候选按需逐一 grilling 后另建 spec。
