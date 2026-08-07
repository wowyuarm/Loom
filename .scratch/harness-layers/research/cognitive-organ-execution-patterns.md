# 长时 Cognitive Organ 的执行与抢占模式

研究日期：2026-08-07

## 结论

Loom 不需要引入 Temporal、Kubernetes Job 或 BullMQ，也不应把现有 Scheduler 扩成通用任务平台。适合 Loom 的最终形态是在现有 Runtime Store 和单实例调度边界内采用以下成熟模式：

1. 将“逻辑工作”与“单次执行尝试”分开。逻辑工作保存输入、整体截止时间和最终结果；每次尝试保存开始、结束、失败类别、取消请求和可恢复进度。
2. 将排队等待、单次尝试、整个逻辑工作的截止时间、失联检测分开。不要用一个模糊的 `timeout` 同时表达四种情况。
3. 前台来信持久接受后，请求取消当前可抢占的后台器官；取消是合作式协议，必须区分“已请求”与“已结束”。
4. 只重试明确可重试的失败，并使用有上限的指数退避和抖动。永久错误、主动取消、前台抢占不进入同一故障重试计数。
5. 半完成输出不能直接成为已完成结果。只有已经原子提交的 Workspace 变更或 Effect 是事实；模型草稿、未封口的 transcript 和未确认外部动作只保留为诊断证据。

## 一手资料中的稳定模式

### Temporal：持久事实、超时分层和合作式取消

Temporal 为每个 Workflow 保存持久、追加式 Event History，用它在崩溃后恢复执行，也把它作为审计记录。Activity 的调度、开始、完成、失败、超时和取消分别形成事件；这说明“请求取消”不能直接等同于“工作已经取消”。[Temporal：Events and Event History](https://docs.temporal.io/workflow-execution/event)

Temporal 区分四种时间边界：

- Schedule-To-Start：排队到 worker 开始领取。
- Start-To-Close：一次尝试最多运行多久。
- Schedule-To-Close：包含全部重试在内的逻辑 Activity 最多持续多久。
- Heartbeat Timeout：运行中的 Activity 多久没有报告进度才视为失联。

官方建议长时 Activity 同时使用 Start-To-Close、频繁 heartbeat 和较短 Heartbeat Timeout。Heartbeat 可以携带应用层进度供下一次尝试接续；Activity 取消请求也只在 heartbeat 时送达，因此没有 heartbeat 的长任务不能及时收到取消。[Temporal：Detecting Activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures)

Temporal Activity 默认按指数退避重试：初始 1 秒、系数 2、最大间隔为初始值的 100 倍，默认不限次数；官方更推荐用 Schedule-To-Close 限制总重试时长，并把永久错误标为 non-retryable。Workflow 本身默认不重试，易失败的外部操作应放入可独立重试的 Activity。[Temporal：Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)

Temporal TypeScript SDK 将 Activity 取消公开为 `AbortSignal`，可直接传给 `fetch`、`child_process` 等支持取消的 API；Activity 仍必须 heartbeat 才能收到服务端取消。Workflow 的 Cancellation Scope 支持取消向子操作传播，并允许用短小的 non-cancellable scope 完成清理。[Temporal TypeScript：Activity Context](https://typescript.temporal.io/api/classes/activity.Context)、[Temporal TypeScript：CancellationScope](https://typescript.temporal.io/api/classes/workflow.CancellationScope)

### Kubernetes：宽限终止、最终强制结束和总时限

Kubernetes Job 的 `activeDeadlineSeconds` 覆盖从开始到全部重试的总时长，并优先于 `backoffLimit`；到期后会终止所有运行 Pod，并把 Job 标为 `DeadlineExceeded`。Job 默认失败上限为 6，失败 Pod 以 10、20、40 秒递增，最长间隔 6 分钟。官方同时明确：即使并行度和完成数都是 1，同一程序也可能启动两次，应用必须处理临时文件、锁和未完成输出。[Kubernetes：Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)

Pod 终止采用两阶段协议：先运行 `preStop`（如有）并发送 TERM，默认宽限期 30 秒；宽限期结束仍未退出则发送 KILL。宽限期内应用负责保存进度或撤销未完成变更。[Kubernetes：Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)

Job suspend 会向正在运行的 Pod 发送 SIGTERM，并在恢复时重置 `activeDeadlineSeconds` 计时。这个行为适合管理员暂停批处理，但不适合 Loom 的前台抢占：若每次来信都重置总时限，后台工作可以永久不结束。[Kubernetes：Suspending a Job](https://kubernetes.io/docs/concepts/workloads/controllers/job/#suspending-a-job)

### Node.js：组合取消信号，但不提供强制停止保证

Node 提供 `AbortSignal.timeout(delay)` 创建截止信号，`AbortSignal.any(signals)` 合并多个取消来源，`throwIfAborted()` 在安全点主动停止。`AbortSignal` 是通知机制；被调用代码必须观察信号，才能及时退出。[Node.js：AbortController / AbortSignal](https://nodejs.org/api/globals.html#class-abortcontroller)

`child_process.spawn`、`exec` 和 `fork` 支持 `AbortSignal`；超时或取消默认发送 SIGTERM。若子进程捕获 SIGTERM 后不退出，同步接口仍会等待它真正退出。这证明仅调用 `abort()` 不能构成硬截止保证。[Node.js：Child process](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)

### BullMQ：至少一次执行要求幂等

BullMQ 明确采用“至少一次”执行：worker 丢失锁后，stalled job 会重新执行，因此可能重复处理。它建议任务保持简单、原子和幂等，使首次成功与失败后重试得到相同最终状态。[BullMQ：Important Notes](https://docs.bullmq.io/bull/important-notes)、[BullMQ：Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)

BullMQ 支持固定或指数退避、最大尝试次数和抖动；没有设置 backoff 时会立即重试。这支持 Loom 明确配置重试政策，而不是在 process loop 中无界立即重跑。[BullMQ：Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)

## Loom 建议合同

### 1. Durable state

保留现有 Runtime Store 作为唯一恢复权威，并为每次器官运行保存以下事实：

- `runId`、器官名、不可变输入引用、模型 revision；
- `startedAt`、`attemptDeadlineAt`、`logicalDeadlineAt`、尝试次数；
- `cancelRequestedAt`、取消原因、`endedAt`；
- 终态：`succeeded | failed | timed_out | cancelled | interrupted`；
- 结构化失败类别和 `nextRetryAt`；
- transcript/evidence 引用，以及最终结果是否已提交。

状态转换必须带当前 attempt/fencing token。旧执行者在 lease 过期、前台抢占或 restart 后返回的晚到结果不得提交。

取消请求先写事实，再通知执行器；只有执行器退出并完成终态事务后，状态才从 `running` 进入 `cancelled` 或 `interrupted`。若取消调用超出宽限期，状态仍应显示 `cancel_requested`，不能假装已经结束。

### 2. Deadline

每种器官由 Harness policy 给出：

- 单次尝试预算 `attemptTimeout`；
- 包含排队、运行和退避的 `logicalDeadline`；
- 可选的进度失联期限，仅用于真正能报告确定进度的器官。

前台抢占不计为失败尝试，但不重置逻辑工作的整体截止时间。排队过久优先作为状态和指标暴露，不建议直接复用执行超时将其判死。

### 3. Foreground preemption

```text
human Input durable accept
  -> stop admitting new background work
  -> persist cancel request for active preemptible organ
  -> abort with signal: human-input OR attempt-timeout OR host-shutdown
  -> wait a short grace period
  -> run foreground Turn as soon as the organ has actually released the lane
```

器官只在明确安全点响应取消。最终 SQLite 提交和必要清理可以放在很短的不可取消区间；模型调用、网络等待和长循环不得放入该区间。

如果 Pi 或某个依赖不观察 `AbortSignal`，当前进程内实现只能承诺软取消。需要严格的最大延迟时，应把模型调用放进可终止的 Worker/子进程，并采用 TERM + grace + 强制终止；否则产品状态必须如实显示“取消已请求但仍在运行”。

### 4. Retry and evidence

- `provider/network/429/5xx` 可重试；认证、非法输入、无效结果和确定的 Workspace 合同错误默认不可重试。
- timeout 可重试，但受逻辑截止时间和尝试上限约束。
- 前台抢占在前台空闲后重新排队，不使用故障退避，也不增加故障次数。
- 使用带抖动的指数退避，并同时设置最大间隔和逻辑截止时间。
- 对外部动作使用稳定幂等键。结果不明时进入 reconciliation，不盲目重放。
- heartbeat 只记录可验证的进度或 checkpoint，不记录空泛的“仍在运行”。不能安全接续的器官从同一不可变输入重新执行。
- 取消前已原子提交的 Workspace 变更和 Effect 继续作为事实；未提交生成物仅保留为诊断材料，不能进入正式 Activity、Attention 或 Memory 结果。

## 验收边界

至少覆盖以下竞态和恢复场景：

1. 来信接受与器官成功提交同时发生，只有一个明确排序，不能既提交结果又把同一结果当作被取消。
2. 来信接受后 1 秒内发出取消；器官配合时前台继续，不配合时状态保留 `cancel_requested`，且不并行启动会冲突的 Turn。
3. attempt timeout、host shutdown 和 human-input 三种信号合并后只执行一次终止流程。
4. 取消后晚到的模型结果因 fencing token 失效而不能提交。
5. restart 后从持久状态恢复：已完成不重跑，明确可重试失败按 `nextRetryAt` 继续，结果不明进入 reconciliation。
6. 指数退避有最大间隔和抖动；永久失败不重试；反复前台抢占不会无限延长逻辑截止时间。
7. 半完成 transcript、Workspace mutation 和外部 Effect 分别验证：只有已提交事实保留，未提交结果不被正式消费。
8. status 能说明当前器官、开始时间、截止时间、取消请求、尝试次数、下次重试和最近一次失败类别。

## 不建议采用

- 不引入通用 job registry、独立队列数据库或新的恢复权威。
- 不用 `Promise.race()` 把超时包装成“任务已经停止”；底层工作可能仍在运行并晚到提交。
- 不因一次前台抢占删除历史 attempt 或重置整体 deadline。
- 不对所有异常统一重试，也不以固定短间隔无限重试。
- 不把原始错误、模型输出或凭据写进面向状态查询的摘要。
