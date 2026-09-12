# 31 - Schedule Current Attention Maintenance

Status: resolved
Type: implementation

## Problem

Loom 已有完整的 Attention Maintainer，但没有 Runtime-owned cadence、evidence cursor 或失败恢复。直接照搬 logical-day close 会把 Current Attention 错做成每日总结；把所有认知器官塞进一个 job framework 又会提前抽象尚未相同的窗口。

## Confirmed Interface

- Current Attention 是短周期、可重叠重看的中短期觉知，不按 logical day 一次性消费。
- Scheduler 默认每 6 小时尝试一次，可通过 `schedule.attentionMaintenance.intervalMinutes` 配置；它与 proactive Pulse cadence 独立。
- 维护只在没有 Active Segment、pending Input / Delivery、Activity recording 或 Thread maintenance 时运行。
- 本轮 evidence window 是“上次成功 cursor 之后、首次 attempt 时已经闭合”的 Frozen Activities；失败后固定该窗口重试，期间新 Activity 留给下一轮。
- `UPDATED` 与 `NO_CHANGE` 都算成功并推进 cursor；失败保留 cursor、窗口、attempt 和错误，按 15 分钟重试。
- Model Runtime blocked 时不领取模型工作；Instance status 暴露下一次时间、pending Activity、attempt、last result / error。
- 不修改 Attention Maintainer prompt、tool description 或首轮 Context，也不建立 logical-day close marker 或通用 job runner。

## Test Seam

- 配置默认值和独立覆盖。
- 成功后只消费一次窗口并推进 cursor。
- 失败和 restart 后使用相同窗口；失败期间新闭合 Activity 不混入重试。
- 与 proactive quiet-hours cadence 和 Instance model admission 共存。

## Result

- Runtime Store 新增持久 Attention maintenance lane，Scheduler 与 assembled Instance 已接线。
- 宿主从 `runOnce` 得到 Attention 或 Pulse 中更早的下一次唤醒时间。
- 维护发生在本地 Activity / Recorder / Thread 闭环之后；失败不改 `attention.md`，也不丢证据。
- Memory Reflection 仍应单独按 logical day 设计一次性 evidence window；本票没有预建共同调度框架。

## Verification

- `npm run typecheck`
- `npm test` - 180 tests passed
- `git diff --check`

## Source References

- Loom Tickets 17, 24, 25 and 30
- Xi `docs/daemon-scheduling.md`
- Xi `src/runtime/cognitive-maintenance.ts`
