# 25 — Schedule Runtime Lifecycle

Type: implementation
Status: resolved
Blocked by: None

## Problem

Loom 的 Runtime 已能持久接受 Input、执行 Turn、投递 Effect、关闭 Active Segment，并在 Life Recorder 失败后保留 pending Activity；但这些能力目前只能由调用方逐次手动推动。实例重启后也没有一个统一入口依据 Runtime Store 中的事实继续工作或在一段实际活动闲置后关闭它。

第一条 Scheduler 纵切需要把这条已有生命周期自动串起来，同时保持 Runtime Store 是唯一恢复权威。Scheduler 不能读取 SQLite、维护第二份 Active Segment 状态，或把未来的所有 cadence 提前做成通用任务系统。

## Confirmed Interface

- Runtime 公开 Active Segment 的 `openedAt` 与 `lastActivityAt`。后者只由 Runtime 在已提交的 Input inclusion、Turn terminal、tool activity、Effect 与 Delivery 事实发生时推进；Input 仅被接受但尚未进入 Turn 时不单独改变它。
- Runtime 提供带 inactivity guard 的 Activity close。Scheduler 提交一个政策 cutoff，Runtime 在同一 close claim transaction 中重新检查 Segment、pending work 与 `lastActivityAt`，因此新 Input 或新活动能阻止过时的 close 决定。
- Scheduler 的公开 Interface 只有 `runOnce(observedAt)`。一次运行顺序推进可恢复工作，遇到 busy、外部结果不明或失败便停止；达到 quiescence 后才判断 idle close。
- 默认 idle close 为 30 分钟，Scheduler 构造时可注入该政策值；Instance Configuration 的 cadence 分支后续再把配置接进来。
- Activity 成功冻结后，同一次运行继续尝试 Life Recorder。Recorder 失败时 Activity 保持 pending，本轮停止；后续 tick 或 restart 后的 `runOnce` 从同一 durable fact 重试。

## Ordering

```text
runOnce(observedAt)
  -> Runtime.advance() until quiescent or deferred
  -> guarded close when Active Segment is idle
  -> Runtime.advance() to record the Frozen Activity
```

新 Input 和已有 Runtime work 优先于 idle close。Scheduler 不调用 Orientation，也不运行 Attention、Thread、Memory 或 nmem maintenance。

## Test Seams

- Runtime Interface：`lastActivityAt` 随已提交活动推进；基于旧 cutoff 的 close 不能关闭后来发生过活动的 Segment。
- Scheduler Interface：一份 pending Input 可被推进到 idle wait；未到期不关闭，到期后冻结并记录 Activity。
- Recovery seam：Recorder 首次失败后，关闭并重新打开 Runtime；新的 Scheduler 从 pending Activity 完成记录，不重复冻结。

测试只通过 Runtime 与 Scheduler 的公开 Interface 观察，不查询 Runtime Store 或断言内部 SQL。

## Out of Scope

- Active Segment soft split。
- Orientation pulse、after-chat continuation 与 quiet hours。
- Attention / Thread / Memory maintenance、nmem reconcile 或 nightly。
- Model Runtime Revision、Instance Root assembly、process daemon 与 OS service。
- 通用 cron、workflow engine、可注册 job 或 schedule table。

## Source References

- Xi `src/runtime/daemon.ts`
- Xi `src/runtime/actions.ts`
- Xi `src/state/segments.ts`
- Xi `docs/daemon-scheduling.md`
- Xi `docs/recovery-model.md`
- Xi source tickets 06 and 09
- Loom tickets 01, 11, 22 and 24

## Result

- Active Segment 在 Runtime Store 中持久保存单调前进的 `lastActivityAt`；Input inclusion、tool activity、Effect、Delivery 与 Turn terminal 都在各自事实事务内推进它。
- `Runtime.closeActivity({ inactiveBefore })` 在 close claim transaction 内复核 pending work 与最新活动时间。过时的 Scheduler 观察只会得到 `not_due`，不会关闭后来又发生过活动的 Segment。
- 新增 `Scheduler.runOnce(observedAt)`。它顺序推进 Turn、Delivery 与 Activity recording，达到 quiescence 后才按默认 30 分钟政策关闭闲置 Activity，并在冻结后继续 Recorder。
- Recorder 失败和不确定 Delivery 会让本轮明确 deferred；Activity 与错误仍在 Runtime Store，restart 后可由新的 Scheduler 接续。
- Scheduler 不读取 SQLite、不保存第二份运行状态，也没有接入 soft split、Orientation、maintenance、nmem、Model Revision 或通用 job 注册。

## Verification

- `npm run typecheck`
- `npm test` — 144 tests passed
- `git diff --check`
