# 34 - Drive a Runtime Instance

Status: resolved
Type: implementation

## Problem

`LoomInstance.runOnce()` 已经能推进完整的 Runtime、Cognitive Organ 与 nmem projection 生命周期，但仍依赖调用方手工重复调用。它返回的唤醒信息也不完整：部分失败丢失已有的 retry time，nmem projection 的持久 backoff 只出现在 `status()`，新 Input 到达时没有一个负责立即叫醒等待循环的宿主入口。

本票增加最小 process driver。它不是新的 Scheduler、daemon framework、CLI 或 OS service；它只持续驱动一个已经装配好的 Runtime Instance。

## Confirmed Interface

- `LoomInstance.runOnce(observedAt)` 汇总 Scheduler 与 nmem projection 的最早 `nextRunAt`。宿主不读取 `status()` 重建调度知识。
- Activity Recorder、Thread Maintainer、Attention Maintainer、Memory Reflector 与 Orientation 的失败沿用各自恢复时间；model runtime blocked 使用短周期 revision refresh。未知 Delivery 没有自动重试时间，等待外部 reconciliation 后显式 wake。
- process driver 同时拥有 `runOnce` 与 ingress 驱动入口。`acceptInput` 先持久接受 Input，再立即 wake；直接调用底层 Instance 不属于受驱动的 channel 接入合同。
- driver 串行运行 `runOnce`，不会制造并发 tick。`busy` 只做短暂重试；未分类的抛出错误保留在公开 status，并按独立的 process recovery delay 重试。
- `stop()` 清除等待并等待当前 `runOnce` 自然结束；不取消已经开始的 Turn、Delivery 或 Cognitive Organ run。结束后关闭 Instance。
- driver 可以被显式 `wake()`，供配置变更或外部 reconciliation 使用。当前不增加文件 watcher、channel Adapter、signal handler、CLI 或 OS service。

## Test Seam

- `LoomInstance.runOnce`：nmem backoff 和各条 Scheduler retry lane 都能影响最早 `nextRunAt`，而未知 Delivery 不伪造自动重试。
- process driver：按 `nextRunAt` 等待；Input 到达立即唤醒并继续；没有 deadline 时安静等待；停止时等待正在运行的 `runOnce` 完成再关闭。
- unexpected run failure：公开 status 保留错误并按 process recovery delay 继续，不让循环静默退出。

## Out of Scope

- after-chat continuation 及其 prompt / Context 语义。
- daemon、CLI、systemd、signal wiring、channel endpoint 或 credential Adapter。
- 通用 cron、job registry、workflow engine 或可插拔 scheduler。
- workspace init、生产迁移与结构/行为验收。

## Source References

- Loom Tickets 25, 28, 30, 31, 32 and 33
- Xi `src/runtime/daemon.ts`
- Xi `docs/daemon-scheduling.md`

## Result

- `LoomInstance.runOnce` 现在把 Scheduler cadence、各条失败恢复时间与 nmem projection backoff 汇成最早 `nextRunAt`；model runtime blocked 使用 30 秒 refresh，未知 Delivery 保持无自动 deadline。
- 新增窄的 Process Driver Interface：`start`、`acceptInput`、`wake`、`status` 与 `stop`。它串行推进一个 Instance，新 Input 在持久接受后立即唤醒，且不会丢失发生在当前 `runOnce` 内的 wake。
- driver 对短暂 `busy` 做 1 秒重试，对未分类抛出错误做 30 秒 process recovery；最后一次 run result 与异常均可从 status 观察。没有 deadline 的 deferred work 安静等待显式 wake。
- `stop` 只结束等待，随后等当前 `runOnce` 自然完成并关闭 Instance；没有加入 cancellation、signal wiring、daemon、CLI、channel Adapter 或通用任务系统。

## Verification

- `npm run typecheck`
- `npm test` - 196 tests passed
- `git diff --check`
