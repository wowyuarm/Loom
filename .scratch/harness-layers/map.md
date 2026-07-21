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

## Context Follow-ups

Ticket 03 已闭合 per-Turn session、committed branch、active window projection 与材料选择。以下后续项属于同一 Context 路线，不能因离开首个 Context 实现而丢失：

| Follow-up | Current handling |
| --- | --- |
| Window Closure and Recent Activity Bridge | Tickets 11-12 completed：durable freeze、successor Context、FIFO Life Recorder 与 Receipt 已闭合；bridge 独立选择最近四段、固定于 Segment，并提供受限可展开的工具证据。 |
| Tool Trace Compaction and Evidence Expansion | Ticket 06 completed：真实 compactor、失败 gate、Runtime 原子替换、稳定引用分页展开与机械收回已闭合。 |
| Logical Day and Cross-day Context Recovery | 等时间/节律配置与每日 transcript 归属明确后实现。 |
| Workspace Material Sources | Tickets 04-05 已接入 Identity、Memory、Behavior、Current Attention 与统一 skills catalog。 |
| Configuration and Model Revision Input | 等 Instance Configuration 层提供预算与每 Turn revision。 |

具体边界与进入条件由 [ticket 03](issues/03-materialize-context-windows-per-turn.md#deferred-context-work) 维护；关闭一项后再为下一项建立实际 ticket，不提前创建空文件。

## Remaining First-Phase Closure

nmem 范围闭合后的全局审视确认，以下不是未来扩展，而是首阶段仍缺少的闭环：

1. Daily Narrative 尚未成为 Main Agent 的正式 window-frozen Context source；它必须和 logical day、跨日 Context 与每日 Transcript 一起闭合。
2. Stable Facts 已有读取合同，权威维护者是未来的 Memory Reflector；Life Recorder 只读当前事实并留下 `[fact]` evidence lead。维护和受保护演化尚未实现。
3. Time Policy 已进入 Runtime，但 durable scheduler 尚未实现；idle close / split、Orientation pulse、Attention / Thread / Memory maintenance、nmem reconcile 和真实 outbound 后的 after-chat continuation 仍由外部手动触发或完全缺失。
4. Instance Configuration 的 model / route 分支、Model Runtime Revision、Instance Root assembly 与具体 Integration 装配尚未实现；当前各深 Module 主要通过测试和调用方分别组装。
5. 通用化最终还需一个不同于现有参考个体的虚拟 Individual 做结构验收，并以真实模型评估主动、沉默、私人工作、关系连续性与表达空间。机械测试不能替代这一层。

当前依赖顺序：Instance Configuration + Time Policy -> logical day / Daily Context / daily Transcript -> Memory Reflector -> durable scheduler / assembly -> 结构与行为验收。workspace init、生产迁移和 Git backup 继续后置。

Ticket 22 已完成。下一项进入 logical day / Daily Context / daily Transcript 的同一跨日闭环；在明确其共同 Interface 前不先拆成三个互不相连的票。

## Source References

- Xi [Harness Generalization Map](../../../Xi/.scratch/harness-generalization/map.md)
- Xi [03 — Runtime Kernel Contract](../../../Xi/.scratch/harness-generalization/issues/03-identify-the-runtime-kernel-contract.md)
- Xi [04 — Runtime Instance, Workspace, and Individual](../../../Xi/.scratch/harness-generalization/issues/04-define-workspace-and-instance-semantics.md)
- Xi [05 — Harness Capability Composition](../../../Xi/.scratch/harness-generalization/issues/05-define-harness-capability-composition.md)
- Xi [07 — Interaction Route and Message Contract](../../../Xi/.scratch/harness-generalization/issues/07-define-interaction-route-and-message-contract.md)
- Xi [08 — nmem Cognitive Integration Boundary](../../../Xi/.scratch/harness-generalization/issues/08-define-nmem-cognitive-integration-boundary.md)
- Xi [09 — Runtime Store and Recovery](../../../Xi/.scratch/harness-generalization/issues/09-set-runtime-store-storage-and-recovery-boundaries.md)
- Xi [10 — Primary Agent Transcript](../../../Xi/.scratch/harness-generalization/issues/10-define-primary-agent-transcript-protocol.md)
