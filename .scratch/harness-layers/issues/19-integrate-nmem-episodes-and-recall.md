# 19 - Integrate nmem Episodes and Recall

Status: completed
Type: implementation

## Problem

Loom 已有 Workspace 原生 Episode、durable Life Recorder Receipt 与显式 Main Agent 工具装配，但还没有把已经确认的 Episode 投影进 nmem，也没有给 Main Agent 一个按需读取旧经历的入口。若直接扫描 `episodes/`、让 Life Recorder 调外部服务，或在每个 Turn 自动搜索，会把 Workspace 证据、Activity 收尾和外部服务可用性重新耦合起来。

## Decisions

- nmem 是 Loom 维护的核心 Cognitive Integration，但不是 Runtime 前提。nmem 未配置、超时、鉴权失败或接口不兼容时，Main Agent、Workspace、Transcript、Activity recording 与恢复继续成立。
- 第一阶段同时提供两个窄 Interface：Episode reconciliation 与 Main Agent 的显式 `nmem_recall`。调用方和测试只穿过这两个 Interface；HTTP、认证、能力检查、响应归一化、Integration Receipt 与退避状态留在 nmem Module 内。
- Loom 使用 Node `fetch` 维护 REST Adapter，不依赖运行时 CLI、不采用宿主 connector 或第三方 partial SDK，也不预建通用 `MemoryProvider`。
- Episode reconciliation 只从 Runtime `status()` 中 `recorded` Activity 的 durable Life Recorder Receipt 发现 Episode，再读取 Receipt 列出的 Agent Workspace 文件。仅存在于 `episodes/` 的文件不是导入授权。
- Episode 使用自身稳定 ID 在 nmem 执行 Memory upsert；Integration Receipt、失败状态、下一次重试时间和 diagnostics 持久化在 Runtime Store 下的 nmem 状态中，不写回 Episode frontmatter。
- 临时网络或服务失败保留 pending 并按有界 backoff 重试；鉴权失败或接口不兼容进入 blocked，避免每 Turn 重复请求。外部失败不撤销 Life Recorder Receipt 或 Workspace Episode。
- `nmem_recall` 只搜索 nmem Memory，不把 Memory 结果伪装为 Thread。它是显式、有限的只读工具，仅在确实需要旧经历时调用。
- recall 返回的是可能过时或有误的外部历史 evidence。重要判断应回到 Agent Workspace 证据核验；nmem 不可用时工具返回短的 degraded 结果，不让当前 Turn 失败。
- Life Recorder 不知道 nmem，也不获得 recall。Frozen Activity 和 Primary Agent Transcript 不直接上传。

## Interfaces And Test Seams

### Episode Reconciliation Interface

调用方提供 Runtime、Agent Workspace 和 Runtime Store 位置，然后调用一次 reconciliation。结果说明本轮 imported、pending、blocked 与 already current 的数量；状态重启后继续。

从该 Interface 验证：

- 只有 durable Receipt 列出的 Episode 被导入，孤立或回滚文件不会进入 nmem。
- 相同稳定 ID 重试和内容更新均为 upsert，不产生重复 memory。
- 成功写入 Integration Receipt；临时失败保留待重试；重启后延续既有状态。
- 外部响应不兼容与鉴权失败可观察但不影响 Loom 本地连续性。

### Recall Interface

nmem Module 直接提供 Pi `nmem_recall` tool。Main Agent 只负责装配该工具，不接触 REST shape。

从该 Interface 验证：

- 成功结果保留稳定 memory reference、内容、相关度与来源信息。
- 无结果、未配置、超时、鉴权失败和不兼容响应都形成简短、结构化、failure-soft 的工具结果。
- 最终 Main Agent Context 能看到准确的工具名与模型可见说明，工具调用仍进入普通 Activity evidence。

## Out Of Scope

- nmem Conversation Thread 投影或 Thread recall。
- Working Memory 读取、缓存或 Cognitive Organ 工具。
- nightly trigger、scheduler、logical day、Configuration 与完整 assembly。
- 自动 per-Turn recall、自动 prompt 注入或 Life Recorder 直连 nmem。
- 通用 memory provider、Integration scheduler 或跨 Integration receipt framework。

## Acceptance

- 已确认的 Workspace Episode 可以可靠、幂等地进入 nmem，外部故障后可恢复且不污染 Episode。
- 未提交、已回滚或孤立的 Episode 永不因目录扫描被导入。
- Main Agent 获得明确的 `nmem_recall`，可按需读取旧经历，并能在 nmem 不可用时继续当前 Turn。
- Runtime、Life Recorder 与 Agent Workspace 不依赖 nmem wire protocol 或在线状态。
- 全量 typecheck、build 与测试通过。

## Implementation

- `src/integrations/nmem/` 提供两个窄 Interface：`createNmemEpisodeReconciler` 与 `createNmemRecallTool`。Node `fetch` REST Adapter、双 auth header、capability 检查、timeout、response normalization 和错误分类都留在 Module 内。
- Episode reconciler 只读取 Runtime `recorded` Activity 中的 Life Recorder Receipt。Receipt 路径按 Agent Workspace 真实路径限制；孤立文件、缺失文件和 symlink 越界均不会进入外部服务。
- nmem Integration Receipt、内容与目标连接 fingerprint、attempt、错误和下一次重试时间持久化在 Runtime Store 下的 `integrations/nmem.db`。临时错误指数退避到一小时上限，blocked 状态低频复查；重启后继续，配置目标改变后重新投影。
- Episode frontmatter 使用 `yaml` 结构化解析，稳定 Episode ID 作为 nmem Memory upsert ID；title、scene、importance、labels、event date 和 Workspace provenance 显式映射，不改写 Episode。
- `nmem_recall` 经 Main Agent 现有 Integration tool 装配点进入 Turn。工具只查 Memory，返回稳定引用和 bounded evidence；单条 content 最多 4000 字并标记截断，metadata 只保留有限标量。
- 模型可见说明明确：只在旧经历确实有帮助时查询；结果可能过时、不完整或有误；重要判断回 Agent Workspace 核验；nmem 不可用时继续当前 Turn。没有新增 Context prompt 或自动 recall。

## Verification

- 真实 Runtime 公共接口完成 Activity freeze、Life Recorder Receipt 与后继 reconciliation，不读取测试数据库内部表。
- 验证 durable Receipt 授权、孤立文件排除、稳定 upsert、同进程幂等、重启恢复、pending/backoff、未配置后恢复配置、缺失文件和 symlink 越界。
- 验证 recall 成功、空结果、未配置、timeout、鉴权、不兼容响应、内容上限，以及最终 Main Agent tool Context 与普通 Activity evidence。
- `npm run typecheck`
- `npm run build`
- `npm test`（115 passed）
- `git diff --check`

## Source References

- Xi `.scratch/harness-generalization/issues/08-define-nmem-cognitive-integration-boundary.md`
- Loom `.scratch/harness-layers/research/nmem-integration-boundary.md`
- Loom tickets 08, 10 and 11
