# 20 - Project Conversation Activities to nmem Threads

Status: completed
Type: implementation

## Problem

Loom 已能把 committed Episode 投影为 nmem Memory，但 nmem 仍看不到没有达到 Episode 门槛的日常互动和自主生活。若只导入双方消息，Individual 的私人活动会从外部记忆生态中消失；若直接上传 Primary Agent Transcript 或 Frozen Activity，又会暴露 thinking、原始工具结果和大量执行噪音。

这里的 nmem Conversation Thread 是外部记忆来源，不是 Agent Workspace 中由 Individual 维护的 Thread。

## Decisions

- 每份已经冻结的 Active Segment 独立投影为一个稳定的 nmem Conversation Thread。Frozen Activity 一旦进入 Runtime Store 就足以授权投影，不等待 Life Recorder Receipt，也不依赖 Episode 是否产生。
- Thread 保留真实 human input、确认 delivered 的 outbound message，以及有实际动作或结果的简洁 private activity document。
- Private activity 可以概括 Opportunity、非 message 工具动作、Individual 留下的可见输出、非消息 Effect 和失败事实；不上传 thinking 或 raw tool result。
- 未送达、not_sent 或 unknown 的 outbound Effect 不作为 assistant message。必要的失败事实只能进入 private activity document。
- 投影直接消费 Loom 的 Frozen Activity、Actor Reference、Effect 与 Delivery evidence，不读取 Primary Agent Transcript，也不复制 Xi 的 transcript parser。
- 一个 Segment 使用一个稳定 nmem Thread ID。Frozen Activity 是 immutable source；Integration Receipt、内容 hash、连接 fingerprint、失败状态和退避保存在 Runtime Store 的 nmem Integration 数据库。
- nmem 未配置或故障不阻塞 Runtime、Life Recorder、Workspace 或后继 Activity。temporary failure 保留 pending；authentication、incompatible source/API 进入 blocked 并低频复查。
- 本票不增加 Thread search tool。Main Agent 现有 `nmem_recall` 仍只搜索 Memory；nmem Conversation Thread 先作为外部记忆演化的来源。

## Interface And Test Seam

nmem Module 暴露一个 Thread reconciliation Interface。调用方只提供 Runtime、Runtime Store 位置和 nmem 连接配置并触发 `reconcile()`；Module 内部负责发现 Frozen Activity、确定性投影、HTTP、幂等、Receipt、退避和 diagnostics。

调用方和测试都通过该 Interface，不读取 nmem SQLite 表或调用内部 projector。测试使用真实 Runtime 公共接口形成 Frozen Activity，并以假的 nmem HTTP 端点观察最终 Thread payload。

## Acceptance

- Recorder 尚未完成的 Frozen Activity 也能独立投影；失败的外部服务不改变本地 Activity。
- human input、delivered reply 和 private activity 均保持正确归属与原始语言。
- thinking、raw tool result、未确认 outbound content 不进入 nmem Thread。
- 同一 Frozen Activity 重试、进程重启和“远端已创建但本地尚未记账”都不产生重复 Thread。
- 临时、鉴权、不兼容与未配置状态可观察并按既有 nmem failure-soft 语义恢复。
- 全量 typecheck、build 和测试通过。

## Out Of Scope

- nmem Working Memory、Memory Reflector、Attention Maintainer evidence tool。
- Thread search/fetch tool 或自动 Context 注入。
- logical day、通用 scheduler、manual nightly trigger、feed review 或完整 assembly。
- Agent Workspace Thread、Daily Narrative 或 Primary Agent Transcript 的批量同步。

## Implementation

- Runtime 增加只读 `frozenActivity(activityId)`，让 Integration 通过 Runtime Interface 取得 immutable evidence，不读取 Runtime SQLite。
- `createNmemThreadReconciler` 发现所有已冻结 Activity；Life Recorder 仍为 pending 时也可独立投影。
- 每个 Segment 形成 `loom-activity-<segmentId>`。human input 使用 `user` role，只有存在 delivered evidence 的 message Effect 才使用 `assistant` role；private activity 使用当前 nmem 正式支持的 `system` role。
- Private activity 只保留 Opportunity context、非 message 工具名与入口参数、Individual 可见输出、非消息 Effect 和失败状态。thinking、raw tool result、message tool 参数及未送达正文不会进入 payload。
- 纯自主 Activity 的 participants 只有 `individual`；只有真实互动或送达回复存在时才加入 `human`。
- Thread Integration Receipt、内容与连接 fingerprint、attempt、错误和下一次重试时间持久化在现有 `integrations/nmem.db`。
- 远端创建成功但本地未记账时，重试的 `422` 会通过 `GET /threads/{thread_id}` 核验同一稳定 Thread 并按幂等成功处理。

## Verification

- 使用真实 Runtime Interface 形成 interaction 与 autonomous Frozen Activity，不读取测试数据库。
- 验证 actor attribution、原始语言、delivered reply、private activity、纯自主 participants，以及 thinking/raw result/未送达正文排除。
- 验证同进程 current、temporary backoff、重启恢复和远端已存在 Thread。
- `npm run typecheck`
- `npm run build`
- `npm test`（118 passed）
- `git diff --check`

## Source References

- Xi `src/memory/nmem/thread-import.ts`
- Xi `src/runtime/daemon.ts`
- Loom `research/nmem-integration-boundary.md`
- Loom tickets 11, 12, 13 and 19
