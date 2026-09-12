# 32 - Schedule Memory Reflection by Logical Day

Status: resolved
Type: implementation

## Problem

Memory Reflector 已经能够基于 Workspace、Frozen Activity 和可降级 nmem evidence 慎重演化核心材料，但 Runtime 没有为它提供按 logical day 消费证据的生命周期。直接依赖 nmem nightly 或增加通用 job runner 都会把外部 Integration 误作本地认知连续性的 gate。

## Confirmed Interface

- Runtime Store 持久保存一个 Memory Reflection lane：`nextDay`、下一次可运行时间、attempt、最后完成日、结果和错误。
- 首次建立 lane 时，`nextDay` 是当前 Instance 的 recording day；运行时间是该日 logical-day boundary 之后的可配置 delay，默认 15 分钟。
- 一次运行只消费一个完整 logical day。完成后 cursor 推进到下一日；没有该日 Activity 时直接完成，不调用模型。
- 目标日必须没有仍在 Active Segment、未完成 Activity recording 或未完成 Thread maintenance 的证据。跨 logical day 的 Activity 按 Turn 的 recording day 切出，不能把整段错误归到某一天。
- Memory Reflector 只在 model revision 已允许 agent work 时领取；blocked 或被其他 Runtime 工作占用时保留目标日和证据窗口。
- 模型或器官失败保留同一目标日，记录 attempt / error，并从 observed time 起按 retry delay 再试；成功的 `UPDATED` / `NO_CHANGE` 都推进 cursor。
- nmem Working Memory 与 recall 继续由 Memory Reflector 按需读取；nmem 不可用不阻断本地反思。

## Scheduler Ordering

Scheduler 仍是一个已有的 `runOnce` interface：在 ordinary Runtime work、Activity closure、Life Recorder、Thread maintenance 和 Attention maintenance 闭环后才领取 Memory Reflection。它与 Proactive Pulse、Attention 使用独立持久 lane，不建立可注册任意任务的通用调度框架。

## Failure and Evidence Semantics

- `status()` 暴露 pending Activity ids、attempt、next run、last result 和 last error，失败不是静默丢弃。
- 可选的 Daily / Episode / Thread 等 Workspace 材料不存在时，Workspace read / ls 返回结构化 `missing` 结果，不把合理的缺失变成整轮失败，也不把缺失计为 supporting evidence。
- required core material、路径越界、权限或其他 I/O 错误仍失败；Memory Reflector 仍必须完整读取六份 core baseline，并检查至少一份真实 supporting evidence 后才能 `NO_CHANGE` 或写入。

## Test Seam

- logical-day boundary、delay 和 DST-safe Time Policy。
- 完整日 Activity 的一次消费、跨日 Activity 的 Turn 切片、空日推进。
- failure / restart 后相同目标日和相同 evidence 窗口重试。
- model blocked 时不领取工作，Activity / Thread 未闭环时不反思。
- Assembled Instance 通过真实 revision-bound Memory Reflector 运行一次完整日。
- Memory Reflector 对缺失可选 Workspace 材料的非阻断处理，以及 supporting evidence 仍需真实读取。

## Result

- Runtime schema 新增持久 `memory_reflection` lane；Time Policy 提供下一 logical day 和 boundary 计算。
- Scheduler 和 `openLoomInstance` 已接线，Memory Reflector 使用当前有效 Model Runtime Revision、Workspace、Frozen Activity、Working Memory reader 和 `nmem_recall`。
- 可选材料缺失的处理保持在器官 Workspace tool seam；不改变核心材料保护、模型 prompt 或 nmem Integration 的职责。

## Verification

- `npm run typecheck`
- `npm test` - 187 tests passed
- `git diff --check`

## Source References

- Loom Tickets 21, 23, 24, 25, 27, 29, 30 and 31
- Xi `docs/daemon-scheduling.md`
- Xi `docs/memory-cognitive-architecture.md`
