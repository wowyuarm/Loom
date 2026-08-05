# Xi / Loom 状态转换与队列处理对照

## 范围与判定方式

本记录只核对当前仓库中的一手源码、仓库正式文档和自动化测试。Xi 是只读 source reference；Loom 的现行源码、`CONTEXT.md`、ADR 和 ticket 才定义 Loom 的目标。这里的“风险”只表示两边在同一场景会产生不同外部处理结果，尚不是缺陷结论。

## 结论摘要

Loom 没有直接沿用 Xi 的 JSONL queue / claim / ledger 组合，而是有意把 Input、Turn、Effect、Delivery、Activity 和专用维护工作收进同一个 SQLite Runtime Store。两边仍共同保持两个核心恢复规则：输入先持久化，已经产生外部动作的输入不能盲目重跑。

当前最需要明确决定的不是存储格式，而是两个行为差异：Xi 会把同一目标的积压消息合成一次 replay turn，Loom 会逐条领取初始 Input；Xi 对普通连续失败有五次上限并进入 blocked，Loom 对未被 effect/tool 覆盖的 stopped-turn Input 会回到 pending，当前没有同等上限。另有一项可见的调度先后差异：Loom 会先推进到期 Delivery，Xi 的 daemon 会先处理 queue。

## 有意设计差异

### 1. 恢复事实的统一方式不同

| 项目 | 证据 | 判定 |
| --- | --- | --- |
| Xi | 入站 queue、queue claim、turn ledger、lock 与 active-turn snapshot 分别保存；`queue-index.json` 和 `turn-summary.json` 是可重建缓存。[`docs/recovery-model.md:7`](/home/yu/projects/Xi/docs/recovery-model.md:7)、[`docs/recovery-model.md:12`](/home/yu/projects/Xi/docs/recovery-model.md:12)、[`docs/recovery-model.md:17`](/home/yu/projects/Xi/docs/recovery-model.md:17)、[`docs/recovery-model.md:21`](/home/yu/projects/Xi/docs/recovery-model.md:21)。源码按 queue 与 claim 日志重建状态。[`src/state/queue.ts:248`](/home/yu/projects/Xi/src/state/queue.ts:248)、[`src/state/queue.ts:303`](/home/yu/projects/Xi/src/state/queue.ts:303)。 |  |
| Loom | 同一 SQLite schema 定义 Input、Turn、Effect、Delivery、transition audit、Activity、维护和 after-chat 状态。[`src/runtime/schema.ts:21`](/home/yu/projects/Loom/src/runtime/schema.ts:21)、[`src/runtime/schema.ts:35`](/home/yu/projects/Loom/src/runtime/schema.ts:35)、[`src/runtime/schema.ts:72`](/home/yu/projects/Loom/src/runtime/schema.ts:72)、[`src/runtime/schema.ts:114`](/home/yu/projects/Loom/src/runtime/schema.ts:114)、[`src/runtime/schema.ts:144`](/home/yu/projects/Loom/src/runtime/schema.ts:144)。ADR 明确选择 concrete internal SQLite，理由是单 writer 所需原子性和集中恢复规则。[`docs/adr/0001-keep-runtime-store-concrete-and-internal.md:3`](/home/yu/projects/Loom/docs/adr/0001-keep-runtime-store-concrete-and-internal.md:3)。 | **有意设计差异。** Loom 明确拒绝把 Xi 的多文件协议作为接口或兼容层。 |

两边的结果性规则仍相同：Xi 在模型工作前持久化输入。[`docs/recovery-model.md:3`](/home/yu/projects/Xi/docs/recovery-model.md:3)。Loom `acceptInput()` 在事务内以 `(source, sourceId)` 去重并写入 `pending`，随后才允许执行。[`src/runtime/runtime.ts:287`](/home/yu/projects/Loom/src/runtime/runtime.ts:287)、[`src/runtime/runtime.ts:293`](/home/yu/projects/Loom/src/runtime/runtime.ts:293)、[`src/runtime/runtime.ts:298`](/home/yu/projects/Loom/src/runtime/runtime.ts:298)。Loom 还用 restart/lease 测试验证已接收的 Input 可由替代 Runtime 重试。[`test/runtime/runtime.test.ts:1352`](/home/yu/projects/Loom/test/runtime/runtime.test.ts:1352)。

### 2. 出站失败的恢复单位不同

Xi 的 `message` 先写 outbox `pending`，调用 sink 后再追加 `sent` 或 `failed`。[`src/channels/outbound.ts:66`](/home/yu/projects/Xi/src/channels/outbound.ts:66)、[`src/channels/outbound.ts:82`](/home/yu/projects/Xi/src/channels/outbound.ts:82)、[`src/channels/outbound.ts:102`](/home/yu/projects/Xi/src/channels/outbound.ts:102)、[`src/channels/outbound.ts:120`](/home/yu/projects/Xi/src/channels/outbound.ts:120)。其正式文档规定：失败投递是已发生的外部动作尝试，恢复应该面向 outbox 重发或人工处理，不能重放原 inbound。[`docs/channels.md:21`](/home/yu/projects/Xi/docs/channels.md:21)、[`docs/channels.md:31`](/home/yu/projects/Xi/docs/channels.md:31)。

Loom 将 Effect 与每一次 Delivery 分开：Effect 可为 `pending`、`completed` 或 `reconciliation_required`，Delivery 可为 `prepared`、`dispatching`、`delivered`、`not_sent` 或 `unknown`。[`src/runtime/schema.ts:72`](/home/yu/projects/Loom/src/runtime/schema.ts:72)、[`src/runtime/schema.ts:97`](/home/yu/projects/Loom/src/runtime/schema.ts:97)。已确认 `not_sent` 会保留同一 Effect 并持久记录下一次尝试时间；`unknown` 则停在显式 reconciliation。[`src/runtime/runtime.ts:3177`](/home/yu/projects/Loom/src/runtime/runtime.ts:3177)、[`src/runtime/runtime.ts:3182`](/home/yu/projects/Loom/src/runtime/runtime.ts:3182)、[`src/runtime/runtime.ts:3185`](/home/yu/projects/Loom/src/runtime/runtime.ts:3185)。该选择在 Loom ticket 中被明确写成目标行为，并由延迟、重启、指数退避和 unknown 测试覆盖。[`issues/38-back-off-not-sent-delivery.md:12`](/home/yu/projects/Loom/.scratch/harness-layers/issues/38-back-off-not-sent-delivery.md:12)、[`test/runtime/scheduler.test.ts:180`](/home/yu/projects/Loom/test/runtime/scheduler.test.ts:180)、[`test/runtime/scheduler.test.ts:204`](/home/yu/projects/Loom/test/runtime/scheduler.test.ts:204)、[`test/runtime/scheduler.test.ts:291`](/home/yu/projects/Loom/test/runtime/scheduler.test.ts:291)。

**判定：有意设计差异。** Loom 不是把 Xi 的失败 outbox 机制漏掉，而是改为可独立恢复的 Effect / Delivery 生命周期。

## 行为未对齐风险

### 1. 积压消息的处理颗粒度不同

Xi 会找出与最早可处理项同一 target 的全部 ready 项，按原始时间排序并合成一个 `queued_replay_batch` turn。[`src/runtime/actions.ts:686`](/home/yu/projects/Xi/src/runtime/actions.ts:686)、[`src/runtime/actions.ts:701`](/home/yu/projects/Xi/src/runtime/actions.ts:701)、[`src/runtime/actions.ts:727`](/home/yu/projects/Xi/src/runtime/actions.ts:727)。正式文档确认这是一项语义规则：同 target 的可处理项可以合并，但按原始顺序作为连续来信呈现。[`docs/recovery-model.md:51`](/home/yu/projects/Xi/docs/recovery-model.md:51)。

Loom 初始领取时只选一条 `pending` Input，按 `accepted_at, id` 排序并创建一个 Turn。[`src/runtime/runtime.ts:2617`](/home/yu/projects/Loom/src/runtime/runtime.ts:2617)、[`src/runtime/runtime.ts:2628`](/home/yu/projects/Loom/src/runtime/runtime.ts:2628)、[`src/runtime/runtime.ts:2661`](/home/yu/projects/Loom/src/runtime/runtime.ts:2661)。运行中的后来 Input 可以通过 steering 进入同一个 Turn，但这是 arrival-time 行为，不是对既有 backlog 的 target batch。[`src/runtime/runtime.ts:325`](/home/yu/projects/Loom/src/runtime/runtime.ts:325)、[`src/runtime/runtime.ts:329`](/home/yu/projects/Loom/src/runtime/runtime.ts:329)、[`src/runtime/runtime.ts:3295`](/home/yu/projects/Loom/src/runtime/runtime.ts:3295)。

**风险：** 同一批积压来信在 Xi 可作为一段连续上下文被一次处理，在 Loom 可能分成多个 Turn；这会改变一次回复能看到的范围、effect 覆盖边界以及 after-chat 的生成次数。当前 Loom 测试覆盖 live steering 的接收不阻塞，但没有覆盖既有 pending Input 的按 route 合批。[`test/runtime/runtime.test.ts:1461`](/home/yu/projects/Loom/test/runtime/runtime.test.ts:1461)。需要产品层明确是否保留 Xi 的“同目标合批”语义，不能由存储迁移自行推断。

### 2. 普通模型失败后的重试上限不同

Xi 对 queue item 计数 `started` 尝试，普通失败在五次后标为 `blocked`；只有 `model_unavailable` 例外不触发这个上限。[`src/state/queue.ts:60`](/home/yu/projects/Xi/src/state/queue.ts:60)、[`src/state/queue.ts:261`](/home/yu/projects/Xi/src/state/queue.ts:261)、[`src/state/queue.ts:275`](/home/yu/projects/Xi/src/state/queue.ts:275)。该终态和 1/5/15/60 分钟退避也在正式恢复文档中写明。[`docs/recovery-model.md:59`](/home/yu/projects/Xi/docs/recovery-model.md:59)。

Loom 失败 Turn 会检查每个已纳入 Input 是否已被 Effect 或普通 tool activity 覆盖；未覆盖的 Input 回到 `pending`，已覆盖的变为 `consumed`。[`src/runtime/runtime.ts:3333`](/home/yu/projects/Loom/src/runtime/runtime.ts:3333)、[`src/runtime/runtime.ts:3356`](/home/yu/projects/Loom/src/runtime/runtime.ts:3356)。对应测试明确验证 lease 到期后 Input 重试，以及 effect/tool 后不重放。[`test/runtime/runtime.test.ts:1352`](/home/yu/projects/Loom/test/runtime/runtime.test.ts:1352)、[`test/runtime/runtime.test.ts:1504`](/home/yu/projects/Loom/test/runtime/runtime.test.ts:1504)、[`test/runtime/runtime.test.ts:1544`](/home/yu/projects/Loom/test/runtime/runtime.test.ts:1544)。现行 Input schema 没有 attempt count 或 `next_retry_at` 字段。[`src/runtime/schema.ts:21`](/home/yu/projects/Loom/src/runtime/schema.ts:21)。

**风险：** 对持续、可重试但又非 `model_unavailable` 的失败，Xi 最终停止自动处理，Loom 会保留 pending Input；实际重试节奏由 Process Driver 的错误等待和之后的 `advance` 决定。[`src/instance/process-driver.ts:140`](/home/yu/projects/Loom/src/instance/process-driver.ts:140)。这会影响持续故障时的资源使用、人工介入时机和未处理输入的可见状态。现有来源没有把两者差异标成 Loom 的明确政策，应在引入失败分类或 UI 状态前先定语义。

### 3. 同时存在待投递 Effect 与待处理输入时，调度优先级不同

Xi daemon 的每次 tick 在 close 之后先调用 `processQueuedMessages()`，再处理 after-chat 和 background。[`src/runtime/daemon.ts:91`](/home/yu/projects/Xi/src/runtime/daemon.ts:91)、[`src/runtime/daemon.ts:96`](/home/yu/projects/Xi/src/runtime/daemon.ts:96)、[`src/runtime/daemon.ts:102`](/home/yu/projects/Xi/src/runtime/daemon.ts:102)、[`src/runtime/daemon.ts:106`](/home/yu/projects/Xi/src/runtime/daemon.ts:106)。

Loom `Runtime.advance()` 会先领取并执行到期 Delivery，然后才领取 pending Input。[`src/runtime/runtime.ts:550`](/home/yu/projects/Loom/src/runtime/runtime.ts:550)、[`src/runtime/runtime.ts:563`](/home/yu/projects/Loom/src/runtime/runtime.ts:563)、[`src/runtime/runtime.ts:593`](/home/yu/projects/Loom/src/runtime/runtime.ts:593)。其 Scheduler ticket 也确认一次运行在 quiescent 前按 Runtime work 推进，并让已有 Runtime work 优先于 idle close。[`issues/25-schedule-runtime-lifecycle.md:21`](/home/yu/projects/Loom/.scratch/harness-layers/issues/25-schedule-runtime-lifecycle.md:21)、[`issues/25-schedule-runtime-lifecycle.md:30`](/home/yu/projects/Loom/.scratch/harness-layers/issues/25-schedule-runtime-lifecycle.md:30)。

**风险：** 已到期的重投递与新来信同时存在时，Loom 会先重投旧 Effect，Xi 会先处理队列。两种顺序都会留下可恢复事实，但对关系性消息而言，可见回复的先后可能不同。应明确“未送达的旧回复”与“新来信”的优先级，而不是把当前顺序视为纯实现细节。

## 仅实现细节差异（现有外部规则一致）

### 1. 活跃 Turn 中来信的接入方式

Xi 先入队、写 `claimed` / `started`，再用 `steerActiveTurn()` 尝试注入当前 session；steer 不可用才留作 queue。[`src/runtime/actions.ts:529`](/home/yu/projects/Xi/src/runtime/actions.ts:529)、[`src/runtime/actions.ts:537`](/home/yu/projects/Xi/src/runtime/actions.ts:537)、[`src/runtime/actions.ts:541`](/home/yu/projects/Xi/src/runtime/actions.ts:541)、[`src/runtime/actions.ts:553`](/home/yu/projects/Xi/src/runtime/actions.ts:553)、[`src/runtime/actions.ts:556`](/home/yu/projects/Xi/src/runtime/actions.ts:556)。Xi 正式文档在这里写成“不入队直接 steer”，与现行源码的持久化步骤不一致；本文以源码为准。[`docs/recovery-model.md:77`](/home/yu/projects/Xi/docs/recovery-model.md:77)。

Loom 先原子接受 Input，随后把 steering 串到当前 Turn 的 `steeringTail`；若 steering 调用失败，已 prepared 的 inclusion 会被拒绝，而该 Input 仍保持可再次领取的状态。[`src/runtime/runtime.ts:325`](/home/yu/projects/Loom/src/runtime/runtime.ts:325)、[`src/runtime/runtime.ts:329`](/home/yu/projects/Loom/src/runtime/runtime.ts:329)、[`src/runtime/runtime.ts:3317`](/home/yu/projects/Loom/src/runtime/runtime.ts:3317)、[`src/runtime/runtime.ts:3324`](/home/yu/projects/Loom/src/runtime/runtime.ts:3324)。测试证明来信接收不等待 steering 完成。[`test/runtime/runtime.test.ts:1461`](/home/yu/projects/Loom/test/runtime/runtime.test.ts:1461)。

**判定：仅实现细节差异。** 两边的可观察规则一致：正在运行的 Turn 优先接纳新来信，接不进去时不能丢失，必须留待后续处理。

### 2. 并发与重启保护的手段

Xi 使用文件锁和可追加 ledger；恢复会根据 lock、active-turn、queue claim 与 outbound 事实决定清锁、ack、重试或不重放。[`docs/recovery-model.md:17`](/home/yu/projects/Xi/docs/recovery-model.md:17)、[`src/runtime/recovery.ts:15`](/home/yu/projects/Xi/src/runtime/recovery.ts:15)、[`src/runtime/recovery.ts:86`](/home/yu/projects/Xi/src/runtime/recovery.ts:86)。

Loom 为 Turn 和 Delivery 存 lease owner、fencing token 和过期时间。[`src/runtime/schema.ts:35`](/home/yu/projects/Loom/src/runtime/schema.ts:35)、[`src/runtime/schema.ts:97`](/home/yu/projects/Loom/src/runtime/schema.ts:97)，启动及每次 `advance()` 都会对过期工作做 reconciliation。[`src/runtime/runtime.ts:278`](/home/yu/projects/Loom/src/runtime/runtime.ts:278)、[`src/runtime/runtime.ts:555`](/home/yu/projects/Loom/src/runtime/runtime.ts:555)。

**判定：仅实现细节差异。** 二者都以持久状态阻止旧执行者在重启/接管后提交晚到结果；Loom 用数据库 lease/fencing 集中表达，Xi 用文件锁和可追加证据重建。

## 未发现的结论

- 没有证据表明 Loom 应与 Xi 保持同一个 JSONL 文件结构、队列 ID 格式或 daemon tick 实现；Loom 的 ADR 已明确否定这种兼容目标。
- 没有证据表明 Xi 的单独 outbox `failed` 状态等价于 Loom 的 `unknown`。Xi 的 `failed` 覆盖 sink 缺失和异常；Loom 由 Integration 明确报告 `not_sent` 或 `unknown`。[`src/channels/outbound.ts:93`](/home/yu/projects/Xi/src/channels/outbound.ts:93)、[`src/channels/outbound.ts:120`](/home/yu/projects/Xi/src/channels/outbound.ts:120)、[`src/runtime/types.ts:328`](/home/yu/projects/Loom/src/runtime/types.ts:328)。
