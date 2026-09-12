# 02 — Attention Maintainer 纵切（脱离执行台账）

**What to build:** Attention Maintenance 入口不再经过执行台账与 driveCognitiveOrgan：isDue 直接读 attention_maintenance 域行，预算转移走 01 的引擎；foreground Input 到达时在跑的 run 收 AbortSignal 立即停止（无 grace 窗口）；入口永不返回 busy——不 due 时返回带截止时间的 waiting。中间态仍由现有 Scheduler 驱动（它只看到 idle/waiting/failed 语义），保持每步绿色。

**Blocked by:** 01

**Status:** resolved

## Result

完成于 organ-lanes 分支提交 `2cc4339`。attention 脱离台账；abort 让路语义落地；advance 增加 organ 未释放闸门。

- [x] 真失败：退避 1min/5min，第 3 次置 needs_human；needs_human 后每 24h 冷却重试一轮，成功静默清标留痕
- [x] 配额类错误：park 到 reset/6h，不计 attempts
- [x] abort：域行不变、重跑不计 attempts、无 cancelled/intervention_required 终态
- [x] attention 的 needs_human 不影响其他 organ 入口
- [x] 全部现有测试保持绿色（台账相关断言随本票改写为域行断言）
