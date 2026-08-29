# 01 — 域行预算引擎与列扩充

**What to build:** 给所有 Cognitive Organ 的域行补齐统一预算字段 `{attempts, next_eligible_at, last_error, needs_human}`，并提供一个共享的小型转移引擎：成功清零、真失败按 1min/5min 退避、第 3 次真失败置 needs_human 并进入 24h 冷却、配额类错误 park 到 reset 时间（解析不出 6h）不计数、abort 不计数。本票只落 schema 与引擎，不改变任何现有行为。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] attention_maintenance、memory_reflection 域表具备统一预算字段（已有的 attempt_count/next_run_after/last_error 统一语义，补 needs_human）
- [ ] activities、thread_maintenance 域行可表达同一字段组（按各自域形态承接）
- [ ] 转移引擎实现 spec 锁定的五种转移（success / fail / park / abort / cooldown-retry）且无 IO 副作用，可单测
- [ ] 全部现有测试保持绿色
