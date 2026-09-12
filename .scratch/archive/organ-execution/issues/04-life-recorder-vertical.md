# 04 — Life Recorder 纵切（脱离执行台账）

**What to build:** Life Recorder 的预算落到 activities 域行（按各自域形态承接字段组），脱离台账：recording 入口 isDue 读队首未记录 Activity 的行，FIFO 保序；abort 于 recording 中途等价于崩溃，由 Workspace Mutation journal 兜底、域行自然重跑；配额 park；无 busy。

**Blocked by:** 01

**Status:** resolved

## Result

完成于 organ-lanes 分支提交 `e1f03b6`。recording 预算落 activity 行；activity_attempts/lease 弃用；quota park 语义落地。

- [x] 与 02 相同的预算/abort/park/隔离验收（预算载体为 activity 域行）
- [x] FIFO：队首不被越过；队首冷却时后续不前移且可解释
- [x] 全部现有测试保持绿色
