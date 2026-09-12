# 08 — 删执行台账 + 迁移 + approve/resolve

**What to build:** 契约收口：删除执行台账（两张表、模块、reconcile、cancel grace、requeue-organ 全套）及其在 Runtime、status 读取、Harness Condition 来源中的全部引用；一次性迁移把旧 blocked / intervention_required 映射为对应域项 needs_human；人工恢复改为两个动词——approve（清标记重跑，仅当前项）与 resolve（接受缺口跳过），取代 requeue 状态机。

**Blocked by:** 07

**Status:** resolved

## Result

完成于 organ-lanes 分支提交 `2761b46`。台账三表删除 + v22 迁移（blocked→needs_human）+ approve/resolve CLI 与四态 lane 投影。

- [x] 执行台账表、模块与全部引用删除，代码库无残留引用
- [x] 迁移：旧库打开后旧 blocked/intervention 工作映射为域项 needs_human，其余旧执行状态丢弃；迁移一次性且有测试
- [x] approve / resolve CLI 取代 requeue-organ；对已过时项 approve 明确拒绝并提示
- [x] Harness Condition 投影改读 needs_human 域行（ref/capability/impact/since 语义保持）
- [x] 崩溃重启零对账：重启后按域行重新 due（测试覆盖）
