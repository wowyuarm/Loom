# Cognitive Organ 执行运行时模式调研

研究日期：2026-08-07

## 结论

成熟运行时对这类长时执行有四个稳定共识：

1. 取消通常是合作式的“请求”，不是立即停止；必须分别记录请求、实际结束和无法释放的状态。
2. 单次尝试预算与整个逻辑工作的总截止时间分开；重试等待、排队和失联检测不能共用一个模糊的 timeout。
3. 重试只适用于明确的暂时性失败，并受次数、总时限、最大退避间隔约束；失败后的重复执行要求幂等或 fencing。
4. 恢复事实采用追加式事件/尝试记录，正式结果与原始轨迹分离；崩溃恢复不能依赖内存状态。

这支持 Loom 已确认的最终形态：各 organ 继续拥有自己的领域状态、FIFO、lease 和正式结果；共享层只提供执行政策和 append-only attempt ledger，不新增通用 job queue，不复制 `agent.jsonl` 正文。

## 一手资料

### Temporal

- [Event History](https://docs.temporal.io/workflow-execution/event)：Workflow 的状态由持久化、追加式 Event History 驱动，worker 重启后从历史重放。对 Loom 的启示是：attempt 的开始、结束、失败、取消和结果引用都应落库，不能只依赖运行中对象。
- [Detecting Activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures)：Activity 区分 Schedule-To-Start、Start-To-Close、Schedule-To-Close 和 Heartbeat Timeout；长时 Activity 通过 heartbeat 传递进度并接收取消。对 Loom 的启示是单次 attempt、逻辑总时限和失联检测要拆开；只有确实有可验证进度的 organ 才需要 heartbeat。
- [Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)：Activity 可按指数退避重试，配置最大间隔、最大尝试次数或总时限，并可把永久错误标为 non-retryable。对 Loom 的启示是 provider/network/429/5xx 与非法输入、合同错误分开分类；不能把所有异常统一重试。
- [TypeScript Activity Context](https://typescript.temporal.io/api/classes/activity.Context)：取消通过 `AbortSignal` 暴露给 Activity，长任务仍需 heartbeat 才能收到服务端取消。对 Loom 的启示是 `cancel_requested` 与 `ended` 必须是两个事实。
- [CancellationScope](https://typescript.temporal.io/api/classes/workflow.CancellationScope)：取消可向子操作传播，清理可放在短小的不可取消区间。对 Loom 的启示是 Workspace/Effect 的最终原子提交和必要清理不能被半途打断，但不能把模型调用或长循环放进该区间。

### Kubernetes

- [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)：`activeDeadlineSeconds` 约束整个 Job（包括重试），优先于 `backoffLimit`；失败 Pod 使用有上限的递增退避。文档还警告同一 Job 可能启动两次，应用必须处理幂等、锁和未完成输出。对 Loom 的启示是总逻辑截止时间不应因重试或前台抢占重置，外部 Effect 需要稳定幂等键和 fencing。
- [Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)：终止先发送 TERM 并给宽限期，宽限期后才 KILL；应用应在宽限期内保存进度或撤销未完成变更。对 Loom 的启示是第一版软取消可在 10 秒后进入 `intervention_required`，不能假装已释放并行 writer。
- [Suspending a Job](https://kubernetes.io/docs/concepts/workloads/controllers/job/#suspending-a-job)：恢复 Job 会重置 `activeDeadlineSeconds`。这适合管理员批处理，不适合 Loom 的前台抢占，因为反复来信会让逻辑工作无限延长；Loom 的逻辑 deadline 必须保持不变。

### Node.js

- [AbortController / AbortSignal](https://nodejs.org/api/globals.html#class-abortcontroller)：`AbortSignal.timeout()` 和 `AbortSignal.any()` 能组合超时、人工取消和 Host shutdown；它们只是通知，调用方必须主动观察信号。
- [Child process](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)：子进程取消默认发送 SIGTERM，若进程捕获后不退出仍需等待实际退出。对 Loom 的启示是当前进程内只能承诺软截止；需要硬截止时再隔离到 Worker/子进程并采用 TERM → grace → kill。

### BullMQ

- [Important Notes](https://docs.bullmq.io/bull/important-notes)：至少一次执行和锁丢失会导致同一任务再次执行，任务必须简单、原子、幂等。
- [Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)：支持固定/指数退避、最大尝试次数和抖动；未配置退避时会立即重试。对 Loom 的启示是重试政策必须显式、有界，不能在 process loop 中无限立即重跑。

## 与 Loom Q1–Q15 的对应

| Loom 决策 | 一手资料支持的运行时原则 | 落到合同的含义 |
|---|---|---|
| Q1 软截止 | Temporal/Node 取消是通知；Kubernetes 另有强制终止层 | 先 `cancel_requested`，器官真正退出才终态；10 秒不退出进入人工处理，不并行启动 Main Agent |
| Q2 单次 10 分钟预算 | Temporal Start-To-Close 与逻辑总时限分离 | 固定 attempt budget，状态显示实际开始/结束/耗时 |
| Q3 明确失败才自动重试 | Temporal non-retryable error、BullMQ backoff | 只重试 timeout、provider/network/429/5xx；非法输入和 Workspace 合同错误 blocked |
| Q4 总共 3 次尝试 | BullMQ 最大 attempts、Kubernetes backoffLimit | 首次加两次重试；退避 1 分钟、5 分钟 |
| Q5 取消后仍不退出 | Kubernetes TERM + grace；Node AbortSignal 不保证停止 | 保留 Input，显示 `cancel_requested/intervention_required`，不自动重启、不并行写 Workspace |
| Q6 共享执行层 | Temporal 历史是执行事实，但不要求统一业务队列 | 新增共享 execution policy/ledger；各 organ 表继续拥有 pending/order/lease/result |
| Q7 45 分钟逻辑截止 | Temporal Schedule-To-Close、Kubernetes activeDeadlineSeconds | 覆盖排队、attempt、退避、抢占等待且永不重置；到期 blocked |
| Q8 轻量完整历史 | Temporal Event History 追加式、引用式恢复 | 保留 work/attempt/revision、失败/取消、时间和 transcript/result 引用；不复制正文 |
| Q9 暂不质量评分 | 运行时通常记录事实和结果，不把质量混入调度状态 | 第一版只积累可核对事实，后续再按 organ/revision/失败类型评估 |
| Q10 人工恢复不改写旧记录 | 追加式历史要求旧事件不可变 | 原 work 保持 blocked；人工恢复新增关联预算周期/执行记录 |
| Q11 领域过时由 organ 判断 | 业务结果与执行历史分离 | 共享层不复制领域对象；Life Recorder 无 Receipt 不得 supersede，其他 organ 由自身前提判断 |
| Q12 不接续半完成模型过程 | BullMQ 幂等、Kubernetes 未完成输出警告 | 自动重试从同一不可变输入重新执行；未提交 transcript/checkpoint 只作证据 |
| Q13 修正为每次 attempt 当前 revision | Temporal Activity 是独立执行尝试 | 每次新 attempt 开始读取当前有效 Model Runtime Revision，并在该 attempt 内固定、落 ledger |
| Q14 共享政策而非 job queue | Temporal 把执行历史与业务 Workflow 分开 | 保持各 organ FIFO、lease、完成证据；共享层只管预算/取消/重试/fencing/引用 |
| Q15 每 attempt 绑定 revision | 可重放/审计要求执行输入与版本可追溯 | 自动重试也作为新 attempt，记录当时 revision；不固定整个 work 的旧 revision |

## 验收重点

1. 取消请求、实际退出、人工介入三种状态不可混淆；未释放时不得并发 Workspace writer。
2. attempt timeout、人工抢占、Host shutdown 合并为一次终止流程；重复信号不产生重复终态。
3. 3 次 attempt、1 分钟/5 分钟退避和 45 分钟总时限都持久化，重启后继续而不是重置。
4. 失败分类验证永久错误不重试，429/5xx 等暂时错误才重试；退避有上限和抖动。
5. 旧 attempt 晚到结果因 fencing token 失效不能提交；已原子提交的 Workspace/Effect 保留为事实。
6. `agent.jsonl` 继续按 agent/organ、按天 append-only 保存；共享 ledger 只存引用链，不能另建正文副本。

## 不采用

- 不引入 Temporal/Kubernetes/BullMQ 或通用 job registry；它们的成熟模式只作为合同参考。
- 不用 `Promise.race()` 把超时包装成“任务已停止”。
- 不把前台抢占当失败重试，也不因抢占重置逻辑 deadline。
- 不将原始模型输出、凭据或 transcript 正文塞进 status 摘要。

