# Loom Harness Layers

Status: active

## Purpose

从 Xi 已讨论的 source tickets 中选择、归并并分辨 Loom 的主要层次，为后续逐层讨论与实现提供导航。这里不重开项目方向，也不把地图本身当作代码前置交付物。

## Whole

Loom 是完整的 Agent Harness。`Harness` 不作为与 Runtime、Workspace 或 Cognitive Organs 并列的内部层名；Xi `src/harness/` 中与主 Agent 调用有关的职责在 Loom 中归入 Main Agent。

## Executing Modules

| Module | Owns |
| --- | --- |
| Runtime | input、时间、调度、turn、effect/delivery、恢复与运行观测。 |
| Main Agent | 主 Agent 的 Pi 执行、Context、Primary Agent Transcript 与 tool trace。 |
| Cognitive Organs | Harness 内化且版本化的认知维护能力。 |
| Integrations | channel、nmem、extensions 及其具体 Adapter。 |

## Owned Surfaces

| Surface | Meaning |
| --- | --- |
| Agent Workspace | Individual 的身份、关系、记忆、行为材料、skills 与私人工作。 |
| Runtime Store | Runtime 恢复所需事实的唯一权威。 |
| Primary Agent Transcript | 主 Agent 的原始执行证据，不承担恢复真相。 |
| Instance Configuration | 实例装配、时间节律、模型策略与默认 route 引用。 |

Skills 只有一套发现与加载机制，来源只表示维护权；tools 是 Main Agent 暴露的动作面，两者都不单独成为主层。

## Detail Order

1. Runtime + Runtime Store
2. Main Agent + Primary Agent Transcript + Context
3. Agent Workspace
4. Cognitive Organs
5. Integrations
6. Instance Configuration and assembly

这个顺序用于讨论依赖，不预先规定代码目录或实施提交顺序。

## Current Frontier

- Completed: [01 — Refine Runtime and Runtime Store](issues/01-refine-runtime-and-store.md)
- Completed: [02 — Bind Agent Execution to Pi Transcript Evidence](issues/02-bind-pi-execution-and-transcript.md)
- Completed: [03 — Materialize Context Windows per Turn](issues/03-materialize-context-windows-per-turn.md)
- Completed: [04 — Bind Agent Workspace Materials to Turns](issues/04-bind-agent-workspace-materials-to-turns.md)
- Completed: [05 — Unify Skill Discovery per Turn](issues/05-unify-skill-discovery.md)
- Completed: [06 — Compact Tool Traces Before Context Reuse](issues/06-compact-tool-traces-before-reuse.md)
- Completed: [07 — Correct Runtime and Source Boundaries](issues/07-correct-runtime-and-source-boundaries.md)
- Completed: [08 — Run Life Recorder from Frozen Activity Evidence](issues/08-run-life-recorder-from-frozen-activity.md)
- Completed: [09 — Correct Life Recorder Context and Grounding](issues/09-correct-life-recorder-context-and-grounding.md)
- Completed: [10 — Define Replayable Episodes and the Life Recorder Method](issues/10-define-replayable-episodes-and-recorder-method.md)
- Completed: [11 — Close Activity without Blocking Continuity](issues/11-close-activity-lifecycle.md)。Runtime 已持久连接 Active Segment、Frozen Activity、successor Context、pending Life Recorder 与 Receipt，并建立 Workspace 受限 `read` / `ls`。durable freeze 允许后继 Input；器官运行本身不进入 lived Activity。其最初按 pending 状态选择 bridge 的做法已由 Ticket 12 修正。
- Completed: [12 — Bound the Recent Activity Bridge](issues/12-bound-recent-activity-bridge.md)。Recent Activity 与 Recorder 队列已解耦；successor 固定最近四段紧凑 bridge，普通工具 pair 共享 1K 额度、保留 200 字预览，并通过现有 `expand_tool_result` 读取完整证据。
- Completed: [13 — Bind Main Agent Message Decisions](issues/13-bind-main-agent-message-decisions.md)。Main Agent 在装配默认 Interaction Route 时获得通用 `message`；`send` 先形成持久 Effect，`no_reply` 形成明确 Turn outcome，成功的 Harness terminal tool result 可作为已验证 Transcript 末尾。
- Completed: [14 — Form Proactive Opportunities](issues/14-form-proactive-opportunities.md)。Orientation 通过隔离 Pi session、Stable Facts、Workspace 受限读取和专用 Activity 分页形成 Opportunity 或 none；Runtime 只在持续空闲时原子接纳，主动 Turn 的静默、私活、message、途中来信和失败前工具活动均已闭合到 Active Segment / Frozen Activity 生命周期。
- Completed: [15 — Calibrate Orientation Framing](issues/15-calibrate-orientation-framing.md)。Orientation 明确把 Workspace 与 Activity 视为 Individual 的生活材料，负责交代前因和入口而不完成意义判断；关系性关切是一等 Opportunity 来源，grounded `none` 与模型可见的 `<proactive_opportunity>` 均保留。
- Completed: [16 — Bind Main Agent Workspace Actions](issues/16-bind-main-agent-workspace-actions.md)。真实 Main Agent 以 Agent Workspace 为 `cwd`，固定获得 Pi `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`；这些动作沿用 ordinary-tool Activity 路径，Workspace 仍不宣称为宿主机级安全 sandbox。
- Completed: [17 — Maintain Current Attention](issues/17-maintain-current-attention.md)。Current Attention 已定义为跨天自然带着的 Workspace 觉知；Main Agent 完整保留该 Turn-live 材料，受限 Maintainer 可依据 Workspace 与近期 Activity 原子更新或明确不改。
- Completed: [18 — Maintain Thread Continuity and Structure](issues/18-maintain-thread-continuity.md)。Thread Maintainer 在完整读取当前变更 Turn 后维护 `threads/` 的入口、独立 notes、全局导航、关联和可恢复生命周期；稳定 Thread Evidence Reference 保留跨调用来源，结构写入在失败时整轮回滚。
- Completed: [19 — Integrate nmem Episodes and Recall](issues/19-integrate-nmem-episodes-and-recall.md)。nmem 第一纵切只从 durable Life Recorder Receipt 幂等投影 Workspace Episode，并向 Main Agent 提供显式、bounded、failure-soft 的 `nmem_recall`；Integration Receipt、退避与 diagnostics 留在 Runtime Store 的 nmem 状态中，Runtime 与 Life Recorder 不依赖外部服务。
- Completed: [20 — Project Conversation Activities to nmem Threads](issues/20-project-conversation-activities-to-nmem-threads.md)。每份 Frozen Activity 独立、幂等投影为 nmem Conversation Thread，保留真实 human input、delivered reply 和简洁 private activity；thinking、raw tool result 与未送达正文保持在外部投影之外，且不等待 Life Recorder。
- Completed: [21 — Read nmem Working Memory Evidence](issues/21-read-nmem-working-memory-evidence.md)。nmem Working Memory 通过 REST 成为 Integration-owned derived evidence；最近成功内容按连接隔离缓存在 Runtime Store，读取失败时明确返回 stale 或 unavailable，不进入 Agent Workspace，也不阻断 Runtime。
- Completed: [22 — Apply Instance Time Policy to Runtime](issues/22-apply-instance-time-policy.md)。可选 `instance.yaml` 的时间分支现在形成 DST-safe Time Policy；缺省使用机器 IANA 时区与 03:00 logical-day boundary，Runtime 的 Orientation local time 与 Activity recording day 使用同一政策。
- Completed: [23 — Close Logical-Day Context and Transcript Continuity](issues/23-close-logical-day-context-and-transcript.md)。Runtime 在 Turn 准入时固定 transcript day；Primary Transcript 按日写入 `agent.jsonl`，source-aware Anchor 支持跨日 Context、Activity 与工具证据；两日 Daily 正文作为完整的 window-frozen material 进入 Main Agent Context。
- Completed: [24 — Maintain Core Memory and Behavior](issues/24-maintain-core-memory-and-behavior.md)。Memory Reflector 已通过索引式 evidence、受限工具、五类核心材料整份替换、持久备份和整轮回滚闭合；prompt 已完成 Xi/Loom 横向审视，并保护 candidate 语义、材料门槛、完整基线读取与写作品味。
- Completed: [25 — Schedule Runtime Lifecycle](issues/25-schedule-runtime-lifecycle.md)。Scheduler 以单一 `runOnce` Interface 推进 Runtime pending work、idle Activity close 与 Recorder retry；Active Segment 的单调活动时间和 guarded close 保持在 Runtime Store 权威内。
- Completed: [26 — Revise Model Runtime Between Turns](issues/26-revise-model-runtime-between-turns.md)。Instance model policy 与 `ModelRuntimeRevisions` 已闭合：Pi `0.81.1` 候选 runtime 先验证全部 role model/auth 后原子切换，旧 revision 支持当前运行，坏 source 明确 degraded / blocked 且不读取凭据正文。
- Completed: [27 — Assemble a Runtime Instance](issues/27-assemble-runtime-instance.md)。`openLoomInstance` 以小型 Interface 装配首条真实纵切；Instance Root、默认 Behavior、源码 System Guidance、route、Pi revision、Main Agent、Orientation、Activity closure、Life Recorder、Scheduler 和 failure-soft recall 已接线，blocked 时保留 agent work 且继续 delivery / 无模型 closure。

## Context Follow-ups

Ticket 03 已闭合 per-Turn session、committed branch、active window projection 与材料选择。以下后续项属于同一 Context 路线，不能因离开首个 Context 实现而丢失：

| Follow-up | Current handling |
| --- | --- |
| Window Closure and Recent Activity Bridge | Tickets 11-12 completed：durable freeze、successor Context、FIFO Life Recorder 与 Receipt 已闭合；bridge 独立选择最近四段、固定于 Segment，并提供受限可展开的工具证据。 |
| Tool Trace Compaction and Evidence Expansion | Ticket 06 completed：真实 compactor、失败 gate、Runtime 原子替换、稳定引用分页展开与机械收回已闭合。 |
| Logical Day and Cross-day Context Recovery | Ticket 23 completed：Turn 固定 transcript day、每日 `agent.jsonl`、跨来源 Anchor / branch / Activity / tool evidence 与两日 Daily snapshot 已闭合。 |
| Workspace Material Sources | Tickets 04-05 已接入 Identity、Memory、Behavior、Current Attention 与统一 skills catalog。 |
| Configuration and Model Revision Input | Tickets 26-27 已让每个 Main Agent Turn 和已装配器官固定有效 revision；Context budget 继续使用 Harness 默认，等真实 provider / 模型需求出现再决定是否配置化。 |

具体边界与进入条件由 [ticket 03](issues/03-materialize-context-windows-per-turn.md#deferred-context-work) 维护；关闭一项后再为下一项建立实际 ticket，不提前创建空文件。

## Remaining First-Phase Closure

nmem 范围闭合后的全局审视确认，以下不是未来扩展，而是首阶段仍缺少的闭环：

1. Instance Assembly 已闭合首条可运行纵切；process driver、soft split、Orientation pulse、Attention / Thread / Memory maintenance、nmem reconcile 和真实 outbound 后的 after-chat continuation 尚未接线。
2. channel endpoint / credential Adapter、其余 Integration 装配与节律配置仍需随真实消费者进入，不在 Assembly 中预建通用 loader。
3. 通用化最终还需一个不同于现有参考个体的虚拟 Individual 做结构验收，并以真实模型评估主动、沉默、私人工作、关系连续性与表达空间。机械测试不能替代这一层。

当前依赖顺序：其余 cadence 接线 -> 结构与行为验收。workspace init、生产迁移和 Git backup 继续后置。

Current work item: none。Ticket 27 已闭合 Instance Assembly；下一步先审视尚未接线的 cadence、现有 Scheduler 与各 Cognitive Organ / nmem Module 的触发事实，选择下一条有真实消费者的纵向切片，再建立对应 ticket。

### Memory Reflector Completion Checkpoint

- Xi 的有效职责不是每日摘要，而是把跨时间 evidence 慎重写回 Identity、Long-term Memory 与两份 Behavior Material，并在最高证据门槛下允许 Identity 演化；Current Attention 与 Harness System Guidance 均不归它维护。
- Xi 的实际运行先完整读取既有核心材料，再读 Daily、Episodes、Threads，并用原始 session / outbox 核验关键原话和已送达内容；`recall` 是按需证据，不是每轮必用。Loom 不应让器官直接解析 Primary Transcript 或 Runtime Store，因此需要由 Activity lifecycle 提供可索引、按需展开的等价第一手证据。
- Xi 当前把 nmem nightly marker 和新鲜 Working Memory 当作触发前置。Loom 已确认 nmem 是可降级 Integration evidence，不能成为本地认知连续性的 gate；未来 scheduler 可以优先等待新证据，但 nmem 不可用时仍要允许 Reflector 基于 Workspace 与 Frozen Activity 运行。
- 需要保留运行前备份、受保护目标、写后验证与整轮回滚，但不能照搬 Xi 的具体标题、四域结构、文件名扫描或缩水比例。Loom 的保护应围绕 Workspace Material role 和最小结构合同，模型写作质量留给 prompt 与真实模型评估。
- Ticket 24 已确认模型可见语义：Stable Facts 与 Identity 分离，五类可写材料各自有不同证据门槛，Activity / nmem evidence 按需进入，器官在不暴露 Harness 机制的前提下保持材料原语言和 Individual 自身声线。
- 最终 prompt 横向审视没有把项目哲学机械复制给每个器官：事实记录与压缩器保持中性，Orientation / Attention / Thread 通过职责内方法保护主体空间，Memory Reflector 因直接演化核心材料而显式承担哲学边界与写作品味。
- Pi `read` 的 2000 行 / 50KB 截断已纳入核心基线完整读取保护；模型必须按连续 offset 读完后才能形成更新或 `NO_CHANGE`。

## Source References

- Xi [Harness Generalization Map](../../../Xi/.scratch/harness-generalization/map.md)
- Xi [03 — Runtime Kernel Contract](../../../Xi/.scratch/harness-generalization/issues/03-identify-the-runtime-kernel-contract.md)
- Xi [04 — Runtime Instance, Workspace, and Individual](../../../Xi/.scratch/harness-generalization/issues/04-define-workspace-and-instance-semantics.md)
- Xi [05 — Harness Capability Composition](../../../Xi/.scratch/harness-generalization/issues/05-define-harness-capability-composition.md)
- Xi [07 — Interaction Route and Message Contract](../../../Xi/.scratch/harness-generalization/issues/07-define-interaction-route-and-message-contract.md)
- Xi [08 — nmem Cognitive Integration Boundary](../../../Xi/.scratch/harness-generalization/issues/08-define-nmem-cognitive-integration-boundary.md)
- Xi [09 — Runtime Store and Recovery](../../../Xi/.scratch/harness-generalization/issues/09-set-runtime-store-storage-and-recovery-boundaries.md)
- Xi [10 — Primary Agent Transcript](../../../Xi/.scratch/harness-generalization/issues/10-define-primary-agent-transcript-protocol.md)
