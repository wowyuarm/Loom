# 33 - Soft-split Long-lived Activity

Status: resolved
Type: implementation

## Problem

Loom 只会在 Active Segment 闲置后冻结 Activity。若互动或私人活动长期每隔不到 idle interval 继续，Segment 可以无限增长，Life Recorder、Thread Maintainer、Attention Maintainer 与 Memory Reflector 都持续看不到这段已经发生的生活证据。

这不是 Context 长度补丁，而是 Activity lifecycle 的完整性问题。解决方式应复用已经验证的 freeze、successor Context、Recorder 与恢复路径，不建立另一种 split job 或专用状态机。

## Confirmed Interface

- Scheduler 为 Active Segment 同时计算 idle close 与 maximum age，选择更早的下一次唤醒；默认 idle 30 分钟、maximum age 2 小时。
- 到达任一条件时，Scheduler 调用同一个 `Runtime.closeActivity`。Runtime 在 close claim transaction 内重新检查 pending Input / Delivery、Segment identity、`lastActivityAt` 与 `openedAt`。
- `inactiveBefore` 与 `openedBefore` 是两个可独立成立的 policy cutoff。Activity 已闲置或 Segment 已达到最大年龄，任一条件成立即可关闭。
- soft split 只冻结证据窗口并安装现有 successor execution state。它不结束关系、清空持续 Context、运行新 prompt，或阻止下一份 Input 创建 successor Segment。
- 当前实现沿用 Harness 默认 2 小时；没有真实实例差异前不增加 Instance Configuration 字段。

## Test Seam

- 一段每 25 分钟继续、从不达到 30 分钟 idle 的活动，在打开两小时后冻结并完成 Recorder。
- Scheduler 在 idle deadline 与 max-age deadline 之间返回更早的 wake time。
- Runtime 对 `openedBefore` 做事务内复核，较新的 Segment 不会被过期观察误关。
- 既有 inactivity guard、freeze、successor Context、Recorder retry 与 restart recovery 测试继续覆盖共同路径。

## Result

- Scheduler 新增默认 `activityMaxMs = 2h`，与现有 `activityIdleMs` 一起决定 Activity closure。
- Runtime close policy 同时支持 `inactiveBefore` 与 `openedBefore`，`not_due` 返回当前 `openedAt` / `lastActivityAt`，调用方可重新计算下一次唤醒。
- 没有新增 schema、job runner、prompt、模型工具或 Workspace 材料。

## Verification

- `npm run typecheck`
- `npm test` - 189 tests passed
- `git diff --check`

## Source References

- Loom Tickets 11, 12, 23, 25 and 32
- Xi `src/runtime/actions.ts`
- Xi `src/state/segments.ts`
- Xi `docs/daemon-scheduling.md`
