# 06 — Orientation / After-chat lane 化

**What to build:** Orientation（Proactive Pulse）与 After-chat Continuation lane 化：pulse 的预算挂 pulse schedule 域行（脱离台账），fair-split 从 Scheduler 分支移入 orientation 入口内部；after-chat continuation 按域行 lane 形态驱动；Opportunity 仍为持久 Input 行，过期与"人先于机会"清理规则保留。tool-trace-compactor 若有台账依赖，一并迁移到其调用点的域形态。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] orientation 真失败退避 / 3 次封顶 / needs_human 冷却 / 配额 park / abort 全链路（预算载体为 pulse schedule 行）
- [ ] fair-split 语义不变（现有 proactive scheduling 测试保持绿色或等价改写）
- [ ] after-chat continuation 行为不变
- [ ] orientation 的 needs_human 仅在 status 可见，不产生任何机械上报
- [ ] 全部现有测试保持绿色
