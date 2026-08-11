# Harness 自维护、故障检测与有界恢复模式调研

研究日期：2026-08-11

## 研究范围

本文只研究外部成熟系统如何分开处理以下问题：

- 运行单元是否还活着、是否仍在前进；
- 失败后由谁重试、重启或隔离；
- 哪些事实必须持久保存，进程重启后才能继续；
- 自动恢复何时必须停止并交给人工；
- 恢复机制自身失效时，是否还有独立的存活保障。

Loom 术语以现有文档为准：Cognitive Organs 是 Harness 内置、由 Runtime 持久队列调度的有界维护能力；`blocked` 表示重试耗尽、需要人工处理，Operator 可通过 `loom requeue-organ` 开启新的预算周期，但这不证明原始故障已经修复。[Loom Cognitive Organs](../../../docs/cognitive-organs.md)、[Loom Status And Diagnosis](../../../docs/operations/reference/status-and-diagnosis.md)

本文不提出通用 control plane、通用 job queue 或实现 ticket，也不把外部系统的完整架构直接移植进单个 Agent Individual 的 Harness。

## 结论

成熟系统没有一个机制同时完成“发现故障、诊断原因、安全修复、验证语义正确”。稳定做法是把权责分层：

1. **外部存活保障**只判断进程退出或明确的进度信号超时，并以有上限的进程重启恢复；Erlang/OTP 和 systemd 都在重启过密后停止或向上升级，而不是无限重启。[Erlang/OTP Maximum Restart Intensity](https://www.erlang.org/doc/system/sup_princ.html#maximum-restart-intensity)、[systemd `Restart=` / `WatchdogSec=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[systemd start rate limiting](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#StartLimitIntervalSec=interval,%20StartLimitBurst=burst)
2. **内部调度与恢复事实**要区分正在运行、等待重试和等待人工；Temporal 把一次逻辑 Activity、每次 Activity Task 尝试、超时、heartbeat 与持久 Event History 分开，Kubernetes controller 则反复比较 desired state 与 current state，而不是把一次调用返回值当成永久事实。[Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)、[Temporal Activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures)、[Temporal Event History](https://docs.temporal.io/workflow-execution/event)、[Kubernetes Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
3. **健康信号必须按用途分开**。Kubernetes 的 startup、liveness、readiness 分别表示“是否完成启动”“是否应重启”“是否应接收流量”；错误的 liveness 检查会制造级联重启。这支持 Loom 分开表示 Host 存活、Runtime 是否前进、某个 Cognitive Organ 是否 blocked 和 Instance 是否适合接收某类工作，不能压成一个 `healthy` 布尔值。[Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
4. **自动恢复必须受故障域和权限边界约束**。进程 supervisor 只能重启进程，controller 只能改它负责的资源，Temporal 只能重放已记录的控制流并重试 Activity；它们都不会自动修正错误的输入、目录所有权、永久性业务错误或已经重复发生的外部副作用。[Erlang/OTP Supervision Principles](https://www.erlang.org/doc/system/sup_princ.html)、[Kubernetes Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)、[Temporal Activity idempotency](https://docs.temporal.io/activity-definition#idempotency)

对单个 Agent Individual 的 Harness，最可迁移的不是某个产品，而是四条边界：**独立存活保障、有据可查的内部状态、按失败类型和预算进行的有界恢复、超过权限或预算后明确等待人工**。

## 模式比较

| 模式 | 能保证什么 | 明确不保证什么 | 故障域与权限边界 | 对单 Individual Harness 的迁移判断 |
| --- | --- | --- | --- | --- |
| Erlang/OTP supervision tree | 按 `one_for_one`、`one_for_all`、`rest_for_one` 等策略重启受监督子进程；超过 `intensity` / `period` 时 supervisor 连同 children 退出，由上一层决定重启或继续退出。[官方文档](https://www.erlang.org/doc/system/sup_princ.html#restart-strategy) | 不保证重启能修复相同的确定性错误；官方还警告，阈值配置不当会允许高频重启长期持续，多层 supervisor 的最大尝试量会相乘。[官方文档](https://www.erlang.org/doc/system/sup_princ.html#maximum-restart-intensity) | 每层只管理自己的 child processes；失败可沿 supervision tree 向上升级。 | 适合借鉴“局部隔离 + 重启强度上限 + 向上升级”；不适合把所有 Cognitive Organ 强行改造成 Erlang 式进程树。 |
| Kubernetes controller reconciliation | controller 持续观察资源 current state，并尝试让它接近 spec 中的 desired state；多个简单 controller 分别负责不同状态面。[官方文档](https://kubernetes.io/docs/concepts/architecture/controller/) | 文档明确允许系统持续变化、甚至从不达到稳定状态；只有 controller 仍在运行且能作出有效改变时，reconciliation 才有意义。[官方文档](https://kubernetes.io/docs/concepts/architecture/controller/#desired-versus-current-state) | controller 只应处理与其 controlling resource 关联的对象；需要外部改动时必须通过明确的外部 API。[官方文档](https://kubernetes.io/docs/concepts/architecture/controller/#design) | 适合借鉴“声明事实、观察偏差、幂等收敛”；不应引入 Kubernetes 式资源 API 或常驻通用控制面。 |
| Kubernetes startup / liveness / readiness probes | startup 成功前不执行 liveness/readiness；liveness 连续失败达到阈值后重启 container；readiness 失败后从匹配 Service 的 EndpointSlice 移除 Pod IP。[官方文档](https://kubernetes.io/docs/concepts/workloads/pods/probes/) | probe 只知道被检查端点公开的信号。官方明确警告错误 liveness 会导致级联故障、失败请求和剩余 Pod 负载升高。[官方文档](https://kubernetes.io/docs/concepts/workloads/pods/probes/#liveness-probe) | kubelet 对本节点 container 执行探测和重启；readiness 的直接权限是 Service 流量选择，不是数据修复。 | 强烈支持把“启动完成、能否继续服务、是否需要重启”分开。单实例没有副本可接流量，readiness 只能类比为暂缓某类新工作，不能宣称故障转移。 |
| Temporal retry / heartbeat / durable history | Activity 默认按 Retry Policy 重试；non-retryable failure 可停止重试；heartbeat timeout 可发现长任务失联并携带已送达的进度；持久、append-only Event History 让 Workflow 在崩溃后恢复并继续。[Retry](https://docs.temporal.io/encyclopedia/retry-policies)、[Heartbeat](https://docs.temporal.io/encyclopedia/detecting-activity-failures)、[History](https://docs.temporal.io/workflow-execution/event) | Activity 代码和部分外部副作用可能执行多次；官方要求写操作具备幂等性，并说明 worker 在完成后、上报前崩溃会导致重试。未送达 Service 的 heartbeat 进度也不能恢复。[Activity idempotency](https://docs.temporal.io/activity-definition#idempotency)、[Heartbeat throttling](https://docs.temporal.io/encyclopedia/detecting-activity-failures#throttling) | Temporal Service 保存控制流事实并安排 Task；外部副作用的去重由目标服务的 idempotency key 等机制负责。[官方文档](https://docs.temporal.io/activity-definition#idempotency) | 适合借鉴 work / attempt / retry wait / non-retryable / heartbeat / history 的分离；不应引入 Temporal，亦不能把重放误称为外部副作用 exactly-once。 |
| systemd watchdog + service restart | `WatchdogSec=` 要求服务定期发送 `WATCHDOG=1`；超时后服务进入 failed 并被终止。只有匹配的 `Restart=` 设置才会自动重启，重启还受 `StartLimitIntervalSec=` / `StartLimitBurst=` 限制。[service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#WatchdogSec=)、[unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#StartLimitIntervalSec=interval,%20StartLimitBurst=burst) | watchdog 只证明 systemd 按时收到 keep-alive；服务若在错误状态下仍发送 ping，systemd 无法判断。达到 start limit 后 systemd 会停止自动尝试，等待后续启动或人工 `reset-failed`。[官方文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#StartLimitIntervalSec=interval,%20StartLimitBurst=burst) | systemd manager 位于 Loom Host 进程之外，只能管理 unit 和进程生命周期，不拥有 Runtime / Workspace 语义。 | 适合作为 cognition-independent lifeline：即使 Main Agent、Scheduler 或 Cognitive Organ 自身卡住，外部 manager 仍可检测缺失的进度 ping；不能据此自动改数据库、Workspace 或权限。 |
| MAPE-K autonomic manager | 原始研究把自适应管理拆成 Monitor、Analyze、Plan、Execute，共享 Knowledge，并通过 sensors / effectors 连接 managed resource。[White et al., ICAC 2004](https://doi.org/10.1109/ICAC.2004.1301340)、[Kephart & Chess, Computer 2003](https://doi.org/10.1109/MC.2003.1160055) | 这是参考架构，不提供传感器真实、计划安全、收敛、多个 manager 冲突解决或 effect 权限充分性的保证。 | Execute 只能通过已提供且被政策允许的 effectors 改动 managed resource。 | 只适合作为审视清单：观测、判断、计划、执行、知识不能混为一个无边界“自愈”动作；不构成新增自治控制器的理由。 |

## 1. Erlang/OTP：重启是有界政策，不是修复证明

OTP supervisor 的职责是启动、停止、监控 child process，并在需要时重启。`one_for_one` 只重启失败 child，`one_for_all` 重启全部 siblings，`rest_for_one` 重启失败 child 及其启动顺序之后的 children；child 还可声明为 `permanent`、`transient` 或 `temporary`。[Erlang/OTP Supervision Principles](https://www.erlang.org/doc/system/sup_princ.html#restart-strategy)、[Supervisor API](https://www.erlang.org/doc/apps/stdlib/supervisor.html#restart-strategies)

更重要的是 restart intensity：在最近 `MaxT` 秒内发生超过 `MaxR` 次重启时，supervisor 会终止所有 children 和自己，原因是 `shutdown`；上一层 supervisor 再决定重启该 supervisor 或自行退出。官方说明这正是为了防止同一原因导致“死亡—重启”无限循环。[Maximum Restart Intensity](https://www.erlang.org/doc/system/sup_princ.html#maximum-restart-intensity)

这提供了两个可迁移原则：

- **恢复范围与依赖范围一致**：只有共享失败域的运行单元才一起重启；独立维护 lane 不应因另一 lane 的永久失败停止。
- **反复失败向上升级**：自动重启有 burst 和 sustained-rate 预算；超限后状态必须留给更高层或人工，而不是继续制造 CPU、日志和副作用。

它没有提供永久故障诊断。目录权限错误、无效输入、确定性代码错误在重启后仍会存在；这是从 supervisor 的进程级权限边界和官方“防止相同原因反复重启”的说明直接得出的迁移限制。[Maximum Restart Intensity](https://www.erlang.org/doc/system/sup_princ.html#maximum-restart-intensity)

## 2. Kubernetes：reconciliation 与健康信号分工

### Controller reconciliation

Kubernetes controller 是持续运行的 control loop：读取 spec 表示的 desired state，观察 current state，然后自己采取动作或通过 API Server 请求动作，使 current state 接近 desired state。Kubernetes 采用多个简单 controller 分管不同状态面，而不是一个相互缠绕的单体 control loop；官方明确指出 controller 自身也会失败。[Kubernetes Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)

该模式的价值不是承诺“最终一定成功”，而是让每轮判断建立在可持久观察的状态上。官方写明 cluster 可能一直变化、永远达不到稳定状态；条件是 controller 仍能运行并作出有用改变。[Desired versus current state](https://kubernetes.io/docs/concepts/architecture/controller/#desired-versus-current-state)

迁移到 Loom 时，desired state 只能是 Harness 已经有权声明的运行事实，例如“一个 work 正在等待重试、已经 blocked、或已经完成”，不能扩展成对 Individual 应该想什么、记什么或关注什么的外部目标。Cognitive Organ 仍只在其已有证据与写入边界内工作；controller 模式不能扩大认知权限。

### Startup、liveness 与 readiness

Kubernetes 将三个问题做成三个 probe：

- startup probe 判断应用是否完成启动；配置后，在它成功前 kubelet 不运行 liveness 或 readiness。startup 失败会终止 container，再按 restart policy 处理。[Startup probe](https://kubernetes.io/docs/concepts/workloads/pods/probes/#startup-probe)
- liveness probe 判断 container 是否应被重启，例如进程存在但发生 deadlock；超过容忍次数后 kubelet 重启 container。[Liveness probe](https://kubernetes.io/docs/concepts/workloads/pods/probes/#liveness-probe)
- readiness probe 判断 container 是否应接收流量；失败时 EndpointSlice controller 从匹配 Services 的 EndpointSlices 移除 Pod IP，但不重启 container。[Readiness probe](https://kubernetes.io/docs/concepts/workloads/pods/probes/#readiness-probe)

这三者故意具有不同后果。尤其是 liveness 必须只在状态确实不可恢复时失败；官方警告错误实现会引起高负载下的级联重启、请求失败和剩余 Pod 负载上升。[Liveness probe caution](https://kubernetes.io/docs/concepts/workloads/pods/probes/#liveness-probe)

对 Loom 的直接限制是：

- “systemd 仍显示 active”只说明 Host 进程存在，不说明 Scheduler、Channel 或某个 Cognitive Organ 在前进；Loom 当前运维文档已经明确写出这一非保证。[Loom Status And Diagnosis](../../../docs/operations/reference/status-and-diagnosis.md)
- 一个 blocked Cognitive Organ 不等于整个 Host 不存活；把它映射成全局 liveness failure 会造成无效重启。
- 单实例没有 Kubernetes Service 后面的健康副本，因此 readiness 失败最多用来拒绝或延后某类新工作，并清楚显示 degraded；它不能提供流量转移保证。

## 3. Temporal：持久历史、尝试边界和可重试分类

Temporal 默认重试 Activity，不默认重试整个 Workflow Execution。Activity 默认使用指数退避；当前官方默认值是初始 1 秒、系数 2、最大间隔 100 秒、无限尝试、没有默认 non-retryable errors。官方同时建议把可能失败、非确定性的外部操作放在 Activity 中，Workflow code 保持可重放的确定性。[Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)

这不是要求 Loom 使用相同默认值。相反，Temporal 的机制说明必须显式区分：

- 一项逻辑 work 与它的多次 attempt；
- 当前 `running` 与当前没有执行者的 retry wait；
- 暂时性失败与必须改变代码、输入或外部条件的 permanent failure；
- 单次 attempt 的 Start-To-Close 与整个逻辑 Activity 的 Schedule-To-Close。[Temporal Activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures)

Temporal 的 non-retryable error 是应用给出的政策，不是平台自动诊断。官方说明 permanent failure 需要改变逻辑或输入，适合直接显露而非继续重试；error type 可写入 Retry Policy，或把 Application Failure 明确标为 non-retryable。[Non-Retryable Errors](https://docs.temporal.io/encyclopedia/retry-policies#non-retryable-errors)

### Heartbeat 的保证与边界

Heartbeat 是正在执行 Activity 的 Worker 向 Temporal Service 报告“仍在前进且未崩溃”的 ping。它与 Heartbeat Timeout 配合；超时后当前 Activity Task 失败，只有 Retry Policy 允许时才会安排新 attempt。heartbeat payload 可以保存应用层进度，让下一 attempt 继续；取消也在 heartbeat 时送达，没有 heartbeat 的 Activity 无法通过该机制收到取消。[Activity Heartbeat](https://docs.temporal.io/encyclopedia/detecting-activity-failures#activity-heartbeat)、[Heartbeat Timeout](https://docs.temporal.io/encyclopedia/detecting-activity-failures#heartbeat-timeout)

Heartbeat 不等于无条件存活证明：SDK 会 throttle heartbeat，Worker 崩溃前未送达 Temporal Service 的最新进度不可恢复；官方也要求 heartbeat 表示可确定的进度，而不是仅按时间发送空泛的“还活着”。[Heartbeat throttling and suitability](https://docs.temporal.io/encyclopedia/detecting-activity-failures#throttling)

### Event History 的保证与边界

Temporal Service 为每个 Workflow Execution 保存 append-only Event History。它记录 Workflow 开始/结束以及 Activity scheduled、started、completed、failed、timed out、cancel requested 等事件；该历史持久保存，支持崩溃后恢复应用状态，也是审计记录。[Events and Event History](https://docs.temporal.io/workflow-execution/event)

该保证只覆盖已进入 Event History 的事实。Temporal 官方明确说明：Activity 成功执行后若 Worker 在上报前崩溃，History 看不到成功，Activity 会重试；代码和部分副作用可能执行多次，因此写操作必须幂等，必要时由外部系统执行稳定 idempotency key。[Temporal Activity idempotency](https://docs.temporal.io/activity-definition#idempotency)

Event History 也不是无限日志。当前文档在 10,240 events 后警告，并在超过 51,200 events、2,000 Updates 或 10,000 Signals 时终止 Workflow Execution；长期工作应通过 Continue-As-New 建立新历史。[Event History limits](https://docs.temporal.io/workflow-execution/event#event-history-limits)

对 Loom 可迁移的是“恢复依赖已提交事实”和“attempt 可以重做但外部副作用不能盲目重放”，不是复制 Temporal Service 或把 Cognitive Organ 输出当作可确定重放的纯函数。

## 4. systemd：不依赖认知调度器的外部存活保障

systemd 的 `WatchdogSec=` 在服务完成启动后生效。服务必须定期调用 `sd_notify()` 发送 `WATCHDOG=1`；两次 ping 超过配置时限，systemd 把服务置为 failed，并默认以 `SIGABRT` 终止。只有 `Restart=on-failure`、`on-watchdog`、`on-abnormal` 或 `always` 等包含该失败的策略才会自动重启；`WatchdogSec=` 默认关闭，`Restart=` 默认 `no`。[systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#WatchdogSec=)、[sd_watchdog_enabled](https://www.freedesktop.org/software/systemd/man/latest/sd_watchdog_enabled.html)

自动重启另受 `StartLimitIntervalSec=` 和 `StartLimitBurst=` 限制。超过阈值后不再自动启动，但后续可由人工、timer/socket 或 `systemctl reset-failed` 恢复尝试。[systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#StartLimitIntervalSec=interval,%20StartLimitBurst=burst)

这正是 cognition-independent lifeline：systemd manager 在 Loom Host 外运行，不依赖 Main Agent、Runtime Scheduler 或 Cognitive Organ 作出判断。它适合检测“进程已退出”以及“Host 明确承诺的进度 ping 停止”，不适合自行判断某条 Memory、Attention 或 Episode 是否正确，也没有权限安全修改 Runtime Store、Workspace 或文件所有权。

Loom 当前 service 已配置 `Restart=on-failure` 和 start-rate limit，但没有 `WatchdogSec=`；当前运维合同也明确说 external supervisor 负责 boot startup 和 crash restart，而 service active 不能证明模型、Channel、Integration 或 Cognitive Organ 正常。[Loom service template](../../../docs/operations/loom@.service)、[Instance Lifecycle](../../../docs/operations/reference/instance-lifecycle.md)、[Status And Diagnosis](../../../docs/operations/reference/status-and-diagnosis.md)

这里仍有一条关键安全限制：watchdog 若由同一个已卡死的 scheduler 路径发送，它就不能独立发现该路径卡死；若服务在错误状态下继续发送 ping，systemd 也会继续视为存活。因此 ping 必须对应一个窄、可核对的 Host 进度合同，而不是“进程还在”或“最近有任意消息”。这属于从 systemd watchdog 输入语义得出的迁移判断，不是 systemd 提供的业务正确性保证。[systemd `WatchdogSec=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#WatchdogSec=)

## 5. Autonomic / self-adaptive control loop：仅作职责检查表

IBM 的原始 autonomic computing 研究把 autonomic manager 与 managed element 分开，通过 sensors 观察、通过 effectors 行动，并将管理过程分成 Monitor、Analyze、Plan、Execute，共享 Knowledge；目标包括 self-configuring、self-healing、self-optimizing 和 self-protecting。[White et al., “An architectural approach to autonomic computing”, ICAC 2004](https://doi.org/10.1109/ICAC.2004.1301340)、[Kephart & Chess, “The vision of autonomic computing”, Computer 2003](https://doi.org/10.1109/MC.2003.1160055)

这两份来源支持 MAPE-K 作为职责分解，不支持把“autonomic”理解成无限权限的自动修复。参考架构本身不证明 sensors 真实、analysis 正确、plan 安全、多个 manager 不冲突、系统收敛或 effectors 有足够权限。

对 Loom 最有价值的用法是反向审查一项恢复动作：

1. 观测事实是否来自独立、可恢复的 source，而非模型猜测；
2. 故障分类是否区分暂时、永久、未知；
3. 计划是否有尝试/时间/副作用预算和停止条件；
4. 执行动作是否只使用明确授权的 effectors；
5. 执行后是否重新观测，而不是把“命令已发出”当作恢复成功。

该清单不要求新增一个 autonomic manager。对单 Individual Harness，引入一个同时读取全部私人材料、决定修复并改写全部状态的常驻 manager，反而会扩大故障域、权限和不可解释性。

## 对 Loom 的综合边界

### 可直接采用的原则

1. **只把真实执行视为占用**：`running` 有当前执行者；retry wait 和 `blocked` 是持久状态，但不应伪装成全局执行中。Temporal 的 work / attempt 分离和 Kubernetes 多 controller 分工都支持这一点。[Temporal failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures)、[Kubernetes controller design](https://kubernetes.io/docs/concepts/architecture/controller/#design)
2. **失败不跨越无依赖故障域**：一项 Cognitive Organ work 的永久失败可以保持 FIFO 或领域顺序，但不应停止独立的 Pulse、Attention、Reflection 或其他 organ lane。OTP 的 restart strategy 和 Kubernetes 分离 controller 支持按依赖确定影响范围。[OTP restart strategy](https://www.erlang.org/doc/system/sup_princ.html#restart-strategy)、[Kubernetes controller design](https://kubernetes.io/docs/concepts/architecture/controller/#design)
3. **自动恢复有预算**：尝试次数、总时限、退避和进程重启强度各自有明确上限；超限进入可见、可人工恢复的状态。[OTP maximum restart intensity](https://www.erlang.org/doc/system/sup_princ.html#maximum-restart-intensity)、[Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)、[systemd start rate limiting](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#StartLimitIntervalSec=interval,%20StartLimitBurst=burst)
4. **进程外保留最后一道存活保障**：内部 Runtime 负责语义状态和恢复事实，systemd 只负责进程退出或窄进度合同超时后的有界重启；两者不能互相冒充。[systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[Loom Status And Diagnosis](../../../docs/operations/reference/status-and-diagnosis.md)
5. **恢复后重新观测**：restart、requeue 或修复命令只证明动作发生，不证明原始故障消失。Loom 当前运维合同已明确 requeue 和 restart 的非保证；Kubernetes reconciliation 也通过下一轮观察判断 current state。[Loom Status And Diagnosis](../../../docs/operations/reference/status-and-diagnosis.md)、[Kubernetes Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)

### 不应从外部模式推出的结论

- 不应因为 Kubernetes 有 controller 就在 Loom 中新增通用 desired-state API 或 control plane。
- 不应因为 Temporal 能重试 Activity 就自动重试所有 `blocked` work；permanent failure 需要改变输入、代码或外部条件。[Temporal non-retryable errors](https://docs.temporal.io/encyclopedia/retry-policies#non-retryable-errors)
- 不应因为 systemd 能 watchdog restart 就允许 Harness 自动修改 Unix ownership、凭据、配置或 Individual-owned Workspace 内容。
- 不应把 heartbeat 计数当作语义进度；只有可验证 checkpoint 或独立 scheduler progress 才能支撑超时判断。[Temporal heartbeat suitability](https://docs.temporal.io/encyclopedia/detecting-activity-failures#which-activities-should-heartbeat)
- 不应声称重试提供 exactly-once 外部效果；Temporal 只保证允许重试的 Activity 被观察为完成一次，Activity code 和部分副作用仍可能执行多次。[Temporal Activity retry](https://docs.temporal.io/activity-definition#activity-retry-policy)
- 不应让任何自维护机制静默把失败 work 标为成功、删除证据，或用自动修复掩盖仍需人工处理的内容错误。

## Loom 现状：复杂度来自重复解释，不是来自状态本身

Loom 现有分层解决的都是真实问题：Runtime Store 保存恢复事实，Scheduler 推进有明确生命周期的工作，Process Driver 负责等待和唤醒，Host 持有一个 live Instance，Cognitive Organ 执行层管理 attempt 预算和重试，领域队列保留各自的顺序与 stale / supersede 规则。这些边界不应被一个通用任务系统替换。[ADR 0001](../../../docs/adr/0001-keep-runtime-store-concrete-and-internal.md)、[Drive a Runtime Instance](../issues/34-drive-a-runtime-instance.md)、[Run a Prepared Instance Host](../issues/37-run-a-prepared-instance-host.md)

当前风险集中在这些边界之间的状态翻译：

- Runtime Store 同时有 Input、Turn、Effect / Delivery、Active Segment、Activity、各领域维护队列、Pulse、continuation、`agent_runs` 和 `cognitive_work` 等状态机。[schema](../../../src/runtime/schema.ts)、[Cognitive Organ execution](../../../src/runtime/cognitive-organ-execution.ts)
- `#beginCognitiveOrganAttempt()` 目前用“有 claim / 有 nextAttemptAt / 两者都没有”表达 admission 结果；两者都没有可能表示 running、blocked、intervention required 或 domain mismatch。各个 organ entry 随后再次读取 `currentWork()`，自行决定返回 `busy`、`idle` 或等待。[Runtime](../../../src/runtime/runtime.ts)
- Scheduler 再把各入口的结果折叠成 `idle`、`waiting`、`busy` 或若干 `deferred`；Process Driver 看到普通 `busy` 就一秒后重跑，看到没有 `nextRunAt` 的非 busy 结果就无限等待外部 wake。[Scheduler](../../../src/runtime/scheduler.ts)、[Process Driver](../../../src/instance/process-driver.ts)
- `loom status` 能显示许多持久事实，但这些事实主要给 Operator 使用；`operational-events` 是可丢失的诊断输出，正式文档明确说它不是事实来源。目前没有同一份“Instance 正在何处退化”的有界证据同时供 status 和 Loom cognition 使用。[Status And Diagnosis](../../../docs/operations/reference/status-and-diagnosis.md)、[operational events](../../../src/operational-events.ts)

近期故障说明了这个问题：

| 事件 | 原始故障 | 扩大影响的接口问题 | 应保留的教训 |
| --- | --- | --- | --- |
| [issue #4](https://github.com/wowyuarm/Loom/issues/4) | 长时间运行或失败的工作让 Active Segment 无法关闭 | 七种阻塞原因曾全部折叠为 `busy`，Scheduler 无法区分正常执行与停滞 | Active Segment 需要保留，但 blocker 必须结构化，过期责任必须有下一次检查 |
| [issue #8](https://github.com/wowyuarm/Loom/issues/8) | 一条 Raft wake 无法解析 | 单条失败项占住严格 FIFO，后续独立输入全部停止 | 失败项必须持久、可见、可重试；无依赖工作必须隔离 |
| [issue #9](https://github.com/wowyuarm/Loom/issues/9) / [#10](https://github.com/wowyuarm/Loom/issues/10) | scope / wave 合同矛盾触发相同工具错误 | Turn heartbeat 持续续租，615 次同类错误没有停止条件 | heartbeat 必须代表有效进展；重复错误需要预算与断路，而不是无限证明“仍在运行” |
| [issue #17](https://github.com/wowyuarm/Loom/issues/17) | 一个 Cognitive Organ work 进入 `blocked` | 领域 pending 与共享 ledger blocked 被入口重新解释成全局 `busy`，形成一秒循环并饿死其他 organ 18 小时以上 | `blocked` 是等待处理的事实，不是执行占用；公平性在独立 organ lane 之间，领域内部 FIFO 仍由领域拥有 |
| [issue #18](https://github.com/wowyuarm/Loom/issues/18) | Thread Maintainer 对同一证据稳定触发 grounding 断言 | 三个预算周期、八次相同失败仍被人工 requeue；失败类别不足以说明这是确定性故障 | requeue 不是修复；相同故障指纹跨预算周期重复时必须停止自动消耗，并给出可诊断类别 |

因此，第一项设计工作应是**让状态只由拥有它的 Module 解释一次**：领域队列决定顺序和当前 domain item，共享 Cognitive Organ 执行层决定 attempt 的 running / retry wait / held，Scheduler 只消费显式结果并决定先后，Process Driver 只消费明确的下一次唤醒与进度合同。不能让每层重新从几个布尔值推断“busy”。

## Loom 故障模型与权限边界

下表不是新的状态机；它用于判断一项恢复动作应由哪一层负责。

| 故障层 | 可确认事实 | Harness 可自动执行 | 必须停止或升级的情况 |
| --- | --- | --- | --- |
| 单个 domain work | attempt 失败、超时、结果未提交、同一错误重复 | 在原预算内按分类退避重试；使用既有 fencing、幂等引用和 Workspace Mutation 恢复 | 确定性 invariant / grounding 错误、预算耗尽、未知外部副作用 |
| 单个 organ lane | queue head blocked、后续同领域 work 因 FIFO 等待 | 保留 head 和证据；让无依赖 organ lane 继续 | 不能擅自跳过有顺序依赖的 head；是否 retire / supersede 由该 organ 合同决定 |
| Runtime / Scheduler | 到期责任未推进、相同无进展结果反复出现、没有下一唤醒时间 | 限速重查、保持 Input / Delivery 等安全路径、记录有界退化事实 | 不能把反复 tick 当进展；未知状态解释或持续无进展必须暴露给 cognition / Operator |
| Host 进程 | 退出、event loop 或明确 Host 进度合同超时 | 由 systemd 有界重启 | 达到 start limit、重启后同一故障复现、数据或配置无法打开 |
| 存储与权限 | `EACCES`、完整性失败、恢复事实与 Workspace mutation 不一致 | fail closed；只执行已有、可证明安全的 crash recovery | 不自动 `chown`、删除、恢复备份或改配置；这些需要 Operator 授权 |
| Harness 代码 / invariant | 相同断言、状态不可能组合、版本不兼容 | 保护证据、隔离影响、停止重复消耗 | 不自行改源码、部署或把失败标成功；生成准确求助信息 |
| Channel / provider / Integration | 连接、鉴权、限流、单项 ingress 或 delivery 状态 | 各 adapter 在自身 durable state 内退避、隔离、重试 | 凭据、远端永久拒绝和未知 Delivery 需要外部条件或 reconciliation |

这也限定了“自主恢复”的含义：Loom 可以自主恢复它已经拥有、能验证且副作用有界的状态；它可以自主发现并说明权限外故障；故障本身不能给 Loom 新增 root、部署、凭据或跨 Individual 权限。

## 候选结构：三层恢复面，而不是一个自愈控制器

### 1. 深化现有 Runtime 接口

先消除已经确认的重复解释：

- Cognitive Organ admission 返回显式 tagged result，例如 `claimed`、`running`、`waiting`、`held` 和 `domain_mismatch`；`held` 再明确是 `blocked` 或 `intervention_required`。调用方不再用“没有 claim”猜状态。
- `busy` 只表示当前确有执行者或写入者。等待重试必须带 `nextRunAt`；terminal held 必须带稳定 work ref；依赖等待与 agent work 未获准使用各自的明确结果。
- 领域队列仍拥有 FIFO、stale 和 supersede。共享执行层不得把不同 domain 合成通用 FIFO，也不得替 Thread Maintainer 跳过 head。
- Scheduler 对一轮结果明确区分“发生进展”“有执行仍在进行”“等待已知时间”“退化但可让其他 lane 继续”。Process Driver 不再从裸 `busy` 推导一秒轮询。

这一步删除歧义，不新增恢复权限，也不需要通用 health framework。

### 2. 形成一份可供 status 与 Orientation 共用的退化事实

Loom 需要知道“自己的哪一部分已退化”，但不应复制一套调度状态。候选是 Runtime Store 中很小的 **Harness Condition** 投影：

- 来源仍是现有权威状态机；Condition 不参与 domain claim、顺序或完成判断。
- 每个 condition 以 `kind + subject ref` 去重，只记录 open / resolved 转换、首次和最近观察时间、有界失败类别、责任层和可核对引用；不保存原始消息、prompt、Workspace 内容、凭据或无界错误。
- 只在重要转换时形成认知证据：例如 work 首次 blocked、同一故障指纹跨预算周期重现、scheduled responsibility 明显 overdue、Channel ingress 进入 failed、Model Runtime blocked、Workspace recovery fail closed。普通 retry wait 不反复打扰 Individual。
- `loom status` 和 Orientation 读取同一投影；Main Agent 的普通 Turn 不直接接收 Condition。Condition 恢复后由原权威状态重新观察并标 resolved；“发出恢复命令”本身不能关闭它。

Condition 是可见证据和去重边界，不是新的 job registry、告警平台或 desired-state API。Orientation 是唯一 cognition consumer：它判断是否形成 Opportunity、私下处理或联系用户，不把故障事实直接注入每个对话 Turn。

### 3. 保留一个不依赖 cognition 的最小生命线

内部退化与进程死亡必须分开：

- Process Driver / Host 负责发现控制循环自身的无进展：例如相同结果在无 Runtime revision 变化时重复、某个承诺的 `nextRunAt` 已过期却没有形成新事实。它只能限速重试、形成 Condition 和继续接受可安全的 wake，不能改写业务完成状态。
- systemd 继续负责 crash restart。若以后启用 `WatchdogSec=`，ping 只能证明 Host event loop 和一个明确的 driver 进度合同仍可执行；不能因为某个 organ blocked 就让整个进程重启。
- semantic stall 默认不触发无限 restart。持久状态错误或代码 invariant 通常会在重启后原样复现，正确动作是保留事实、降低消耗并升级。
- 若 Scheduler、Main Agent 与 Interaction Route 同时失效，单个 Loom 进程无法保证自己还能通知人。这一层只能交给进程外 supervisor 或授权的 Operator；不能通过在 Host 内复制第二套 Scheduler 来假装消除该限制。

## 有界恢复循环

每一项自动或 Agent 发起的恢复都应满足同一闭环：

1. **观察**：从权威状态确认具体偏差，而不是根据模型猜测或进程存活推断。
2. **分类**：区分 transient、permanent / invariant、environment / authority 和 unknown。
3. **隔离**：先限制故障域、成本和副作用，保留其他无依赖工作。
4. **执行**：只调用该层明确拥有的 action，并消耗独立的尝试 / 时间 / 副作用预算。
5. **验证**：再次读取权威状态和领域结果；命令成功、进程重启或 work 被 requeue 都不是恢复证明。
6. **收口**：恢复后标 resolved；相同故障继续存在时抑制重复动作和重复通知，升级给 Individual 或 Operator。

其中 Harness 可以直接执行已有的 bounded retry、lease recovery、Workspace Mutation recovery、failure isolation 和 crash restart；Orientation 可以把重要 Condition 形成 Opportunity，Individual 再在自身 Workspace 与消息权限内调查、修正材料和求助。是否给 Main Agent 一个 condition-specific requeue action，需要单独决定并设置同一故障指纹下的次数上限；不应把现有 Operator `loom requeue-organ` 原样暴露成可无限调用的普通工具。

## 已确认的产品方向

YuCreate 于 2026-08-11 确认总体方向，并收窄了 cognition 边界：

- 一个 Cognitive Organ 失败时，无依赖的生活能力继续；真实依赖它的工作可以等待。
- Harness Condition 可以建立，但只供 Orientation 使用，不直接进入 Main Agent 的普通 Context。
- Orientation 后续需要明确 prompt 合同：判断影响、持续时间、权限和是否已处理，再决定 `none`、形成私人 Opportunity 或联系用户；它不能机械报警，也不能在 Condition 未 resolved 时声称恢复。
- Harness 自己负责正常的有界重试；Condition 只在明确不可重试或预算耗尽、已经形成实质退化时进入 Orientation，不把每次 attempt 失败变成 Proactivity 输入。

### 重试与 Condition 的先后

建议按失败分类运行：

1. retryable failure 继续使用现有 attempt / total deadline 预算和 backoff；预算内恢复时不形成面向 Orientation 的 active Condition。
2. 已明确的 permission、integrity、contract / invariant failure 不做无意义的模型重试，直接进入 blocked 并形成 Condition。
3. unknown failure 可以使用有界预算，但相同故障指纹连续出现时停止增加频率；预算耗尽后形成一个去重 Condition。
4. requeue 开启的是新的预算周期，不是恢复证明；同一指纹跨预算周期重现时不得自动继续 requeue。

## 当前依赖关系核对

“故障隔离”不能理解为所有 lane 永不等待。当前 Runtime 已有以下硬依赖、软依赖和独立关系，spec 应逐条保留或明确修改：

| 上游状态 | 必须等待的工作 | 可以继续的工作 | 原因 |
| --- | --- | --- | --- |
| Main Agent Turn 或任何真实 writer 正在运行 | 同一 Instance 的其他 writer、Activity close | 当前执行本身；新 Input 保持 durable pending | 单 Instance / Workspace 单写者与 fencing 边界 |
| 任一 Cognitive Organ 为 `intervention_required` | 新 Main Agent Turn、其他 model writer、维护与 Orientation | Input 接收、可安全的既有外部事实处理 | cancel grace 后不能证明旧 writer 已停止，必须全局保护 Workspace；这与普通 `blocked` 不同 |
| Pending Delivery | 新 Turn、Orientation、Activity close 通常让路 | Delivery 自身；Input 可先持久接收 | 人类已接受的 Effect 优先，不能因 Proactivity 改变发送顺序 |
| Delivery `reconciliation_required` | 同一 Effect 不得自动重发 | 新 wake 后可继续检查其他安全工作；外部 reconciliation 决定该 Delivery | 未知是否已发送，重试可能重复外部效果 |
| Life Recorder 对 Activity 失败 | 该 recorder lane 的后续 FIFO；Memory Reflection 对应日保持不完整 | Thread Maintainer、Attention、Pulse、Interaction 可在各自 idle / writer gate 满足时继续 | Reflection 明确要求当日 Activity 都 recorded；其他 organ 使用 Frozen Activity，不依赖 Episode receipt |
| Thread Maintainer 队首 retry / blocked | 同一 Thread maintenance FIFO 的后续 Activity | 其他 organ lane、Interaction 与 Pulse | Thread 内容有顺序依赖；跨 organ 没有同一 FIFO |
| Thread work 最新状态为 `blocked` | 后续 Thread work 仍等待 | 对应日 Reflection 可带着这一退化事实继续 | 当前 `#reflectionDayComplete()` 把 terminal blocked 视为可降级完成；running、retry wait、requeued 或 intervention 仍 gate Reflection |
| Active Segment 尚未安全冻结 | Life Recorder、Thread maintenance、Attention、Reflection 的新窗口；普通 Pulse 等待或按公平切分合同冻结 | 当前 Turn、Delivery、after-chat；新 Input 按优先级处理 | Frozen Activity 是维护证据边界；Pulse 的 fair split 是受前台和 Delivery gate 限制的例外 |
| Model Runtime `blocked` | 新 Main Agent、Orientation 和所有模型型 Cognitive Organ | Input 接收、确定的 Delivery、无模型 Activity close、nmem 等安全 reconciliation | 配置错误不能丢输入或撤销已有外部行动 |
| nmem / Channel 单项失败 | 该 Integration / Channel 自己的失败项或明确 FIFO 依赖 | Runtime 核心与其他 Integration / Channel | 外部系统有自己的 durable state 和 retry / failed 隔离，不应成为全局 Harness liveness |

这张表还揭示一个重要区别：`blocked` 表示已停止、可让无依赖工作继续；`intervention_required` 表示旧 writer 可能尚未释放，必须保持更大的安全 hold。二者不能为了“都需要人处理”而合并成同一种 Condition 后果。

### Orientation 对 Condition 的反应合同

后续 prompt / spec 至少要让 Orientation 依次判断：

1. Condition 是否仍在正常自动恢复阶段；若是，通常输出 `none`。
2. 哪项生活能力实际受影响，其他能力是否仍可用。
3. 是否存在 Individual 已有权限内的安全私人动作；没有权限时不制造修复。
4. 是否已需要用户行动；需要时说明故障、影响和请求，不暴露私人原始证据。
5. 原权威状态是否已将 Condition 标为 resolved；未 resolved 不能宣称恢复。
6. 同一 Condition 是否已被处理或告知；无状态变化时避免重复 Opportunity 和消息。

Orientation 仍保留判断和沉默权。Condition 是新的真实证据来源，不是把 Proactivity 改成运维告警器。

## 建议进入 spec 的最小范围

如果 YuCreate 认可上述方向，下一步先写一份 `Harness Degradation and Recovery Contract`，只收敛以下内容，不立刻建实现 ticket：

1. 明确 admission / scheduler / driver 的结果术语，删除 `busy` 的多义性；
2. 定义故障分类、condition 的最小字段、去重 / resolved 规则及隐私边界；
3. 定义 Condition 如何进入 `loom status` 与 Orientation，以及 Orientation 的 `none` / Opportunity / 求助边界，不增加第二条执行路径；
4. 列出首批允许的恢复 action、每项预算、验证事实和升级对象；
5. 定义 Process Driver no-progress 与 systemd watchdog 各自检测什么、绝不检测什么。

实现顺序应先修接口语义和现有错误分类，再建立有真实消费者的 Condition；最后才评估 watchdog。不要在第一版同时加入自动 requeue、自动重启、通用 action registry 或自动报 issue。

## 仍需由 Loom 自己定义的问题

外部资料不能替 Loom 决定以下产品与安全边界：

- 哪一个无歧义的 Host 进度事实足以驱动外部 watchdog；
- 哪些 Cognitive Organ work 可以安全自动 requeue，哪些必须保持 `blocked`；
- 某个领域 FIFO 与不同 organ lane 公平性冲突时，具体先后关系；
- 哪些修复动作属于 Harness 权限，哪些必须由经用户授权的 Operator Agent 执行；
- Instance 部分 degraded 时，哪些 Input、Delivery 或维护工作仍可安全继续。

成熟模式只能要求这些决定被明确记录、按故障域隔离、受预算限制并在执行后重新验证，不能替代 Loom 自己的领域合同。

## 一手资料清单

- Erlang/OTP: [Supervision Principles](https://www.erlang.org/doc/system/sup_princ.html), [Supervisor API](https://www.erlang.org/doc/apps/stdlib/supervisor.html)
- Kubernetes: [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/), [Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- Temporal: [Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies), [Detecting Activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures), [Events and Event History](https://docs.temporal.io/workflow-execution/event), [Activity Definition and Idempotency](https://docs.temporal.io/activity-definition)
- systemd: [`systemd.service`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [`systemd.unit`](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html), [`sd_watchdog_enabled`](https://www.freedesktop.org/software/systemd/man/latest/sd_watchdog_enabled.html), [`sd_notify`](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html)
- Autonomic computing primary literature: [White et al., 2004](https://doi.org/10.1109/ICAC.2004.1301340), [Kephart & Chess, 2003](https://doi.org/10.1109/MC.2003.1160055)
