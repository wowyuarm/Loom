# 09 — Status 四态投影重做

**What to build:** 面向运营者的 status 按新形态重做：每条 lane 四态 `running / due / waiting(next: 时间点) / needs_human(reason, since)`，任何"为什么没在跑"有带时间戳的答案；顺带消除两个已知域投影缺陷——delivery 需关注项无单项可见、oldest-pending 口径不含域行 deadline。

**Blocked by:** 08

**Status:** resolved

## Result

完成于 organ-lanes 分支提交 `0e51f63`。delivery 单项可见；oldest-pending 纳入 pulse deadline。

- [x] 每 lane 四态投影，含义与 spec 一致，含"冷却至何时"表达
- [x] delivery 需关注项给出单项标识与状态
- [x] oldest-pending 口径覆盖域行 deadline（retry_wait/冷却）
- [x] status 测试覆盖四态与两处缺陷修复
