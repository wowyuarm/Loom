# 10 — delivery 需关注项只报未终结 effect

**What to build:** 部署后观察发现（生产 xi-sg 实例）：effect 经后续 attempt 已 `completed`（消息实际送达），但早期 `unknown` attempt 让 status 永远显示 "N Deliveries need attention"。修正 `loom-host` 的 operator 投影：`deliveriesNeedingAttention` 只统计所属 effect 未终结（非 `completed` / `abandoned`）的 `unknown` attempt；unknown attempt 本身保留为历史记录。

**Blocked by:** 09

**Status:** resolved

## Result

- [x] 投影联接 effect 终态，已终结 effect 的 unknown attempt 不再报
- [x] host 测试覆盖生产形态：已送达 effect 的 unknown 不报，reconciliation_required 的 unknown 仍报（26+1 用例全绿）
- [x] 已部署 xi-sg 验证 status 不再显示历史误报
