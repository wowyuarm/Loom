# 05 — Thread Maintainer 纵切（脱离执行台账）

**What to build:** Thread Maintainer 的预算落到 thread_maintenance 域行，脱离台账：按 activities.sequence FIFO 认领队首，队首不被越过（含冷却期停滞）；abort 等价崩溃；配额 park；无 busy。

**Blocked by:** 01

**Status:** resolved

## Result

完成于 organ-lanes 分支提交 `b7cc28a`。thread 脱离台账；ledger run 机器（drive/begin/grace）整体删除。

- [x] 与 02 相同的预算/abort/park/隔离验收（预算载体为 thread_maintenance 域行）
- [x] FIFO 与冷却期队首停滞可解释
- [x] 全部现有测试保持绿色
