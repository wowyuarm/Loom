# 28 - Schedule the Proactive Pulse

Status: resolved
Type: implementation

## Problem

`formOpportunity()` 已经能完成一次 Orientation -> Opportunity 的生命周期，但它仍然只能被手动调用。Runtime Instance 还没有一个跨重启持续的主动节律，因此“没有人输入时仍有自己的注意力与活动”尚未成为可运行的生命周期条件。

本票把已有的主动入口接入一个窄而持久的 Pulse policy。它不建立通用 job/workflow engine，也不接入其他 Cognitive Organ 或 nmem nightly；只让 Orientation Pulse 依据 Instance Configuration 在 Runtime Store 中可靠地到期、推进、失败后重试并跨重启恢复。

## Confirmed Interface

- `LoomInstance.runOnce(observedAt)` 仍是唯一的公开推进入口；调用方不需要读写 Pulse 状态。
- 首次打开的实例不会立即 pulse，第一次机会安排在约 30 分钟后。
- 普通时段默认每 30 分钟一次；quiet hours 默认是本地时间 01:00-07:00，Pulse 间隔为 90 分钟。quiet hours 只放慢后台节律，不阻断人类来信、回复或私人活动。
- Pulse 的时间参数属于 Instance Configuration，可显式配置；配置在实例重启后生效，当前不做热加载。
- 一个打开的 Active Segment 会阻止 Orientation。Scheduler 先等待并关闭闲置 Activity，不能创建并行的 background Activity。
- Orientation 返回 `none` 也算一次完成的 Pulse，并推进下一次时间；它不制造 Input。
- Orientation 失败不静默吞掉：Runtime Store 保留失败状态和下一次可恢复时间，后续 `runOnce` 可以重试。失败不伪造 Opportunity。
- Model Runtime blocked 时不 claim Orientation、不消费这次机会；due 状态保留，模型恢复后可继续。
- Pulse 成功或失败的持久事实属于 Runtime Store；Scheduler 不另造 JSON 状态文件，也不暴露 SQLite 接口。

## Configuration

在 `instance.yaml` 增加可选的 `schedule.proactivePulse`：

```yaml
schedule:
  proactivePulse:
    intervalMinutes: 30
    quietHours:
      start: "01:00"
      end: "07:00"
      intervalMinutes: 90
```

缺省值就是上面的政策。`quietHours` 支持跨午夜区间，但相同起止时间因语义含混而拒绝；`intervalMinutes` 必须是安全正整数。重试间隔是 Harness 内置的短暂恢复政策，不作为本票的公开配置项。

## Test Seam

测试只穿过公开的 `LoomInstance`：

- 冷启动后在首次 cadence 前不会请求 Orientation；到普通 cadence 后才运行。
- 在 quiet hours 内使用较长 cadence，跨出 quiet hours 后恢复普通 cadence。
- Activity 打开时不运行 Orientation；Activity 关闭后保留原先 due 的 Pulse。
- `none` 结果推进下一次 Pulse；Opportunity 结果进入已有 Main Agent 生命周期。
- Orientation 失败返回可观察的 deferred 结果，保存下一次尝试；之后的 `runOnce` 能成功重试。
- 关闭并重新打开同一 Instance 后，Pulse schedule 不丢失。
- Model blocked 时不请求 Orientation、不 claim 机会；修复配置后同一机会可以运行。

测试验证节律、恢复和实际 provider 请求次数，不断言 prompt 文案或模型的主动性、语言和叙事质量。

## Out of Scope

- process driver、daemon、signal handling 或 CLI；
- after-chat continuation、Attention / Thread / Memory maintenance 的 cadence；
- nmem Episode / Thread reconcile、nightly 或外部 Integration 调度；
- 热加载 schedule 配置；
- 把 Orientation、Life Recorder 和其他器官抽象成通用 job runner。

## Source References

- Xi source tickets 03, 05, 06, 09
- Xi `src/state/scheduler.ts` and `src/runtime/daemon.ts`
- Loom Tickets 14, 25, 26 and 27

## Result

- `LoomInstance.runOnce` 现在会初始化并推进一份 Runtime Store 内的 Proactive Pulse schedule；冷启动先等待默认 30 分钟，成功、`none`、失败和下次时间都成为可观察、跨重启的持久事实。
- `instance.yaml` 新增严格校验的 `schedule.proactivePulse`。普通 cadence、quiet-hours 起止和 quiet cadence 可配置，缺省为 30 分钟、01:00-07:00 与 90 分钟；Assembly 打开实例时固定该政策，当前不热加载。
- Scheduler 仍先推进 Input、Delivery、Activity closure 与 Life Recorder；只有没有 Active Segment 且达到静止后才运行 due Orientation。Activity 或 model blocked 不消费机会，之后继续同一 due Pulse。
- Orientation `none` 会推进下次时间；Opportunity 会原子写入 Input 并继续已有 Main Agent / Activity lifecycle。Orientation 失败保存错误与连续失败次数，默认 5 分钟后重试，不制造 Opportunity。
- 本票没有改变 Orientation、Main Agent、Cognitive Organ 的 prompt、tool description 或模型可见 Context，也没有引入 daemon、通用 job runner 或其他器官 cadence。

## Verification

- `npm run typecheck`
- `npm test` - 170 tests passed
- `git diff --check`
- 公开 `LoomInstance` 测试穿过真实 faux provider，验证首次延迟、quiet hours、自定义 cadence、Activity 互斥、Opportunity 纵切、失败/重启恢复与 model blocked。
