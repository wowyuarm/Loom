# Deepening Candidates (2026-08-14 Architecture Review)

Captured: 2026-08-14, baseline `01a3f8a` (继承本轮 summary)。
来源：本轮早些时候的 codebase-design 架构审查（三个 Explore 子代理并行扫描，证据逐条回读源码复核；HTML 报告在 /tmp，本文件是仓库内的固化版）。

这不是删除/裁剪清单——那是 ponytail-audit 的职责。这里记录 shallow module → deep module 的深化机会，供后续选单做 spec。

## Strong

### R1 — 四个 Cognitive Organ 的 domain 生命周期循环逐字复制了四份

- 位置：`src/runtime/runtime.ts`（4,949 行）。
- 证据：Life Recorder（#advanceActivityRecording 3394 / #claimPendingActivity 3504 / #finishActivityRecording 3558 / #failActivityRecording 3599 / #releaseActivityRecording 3465）与 Thread Maintainer（#advanceThreadMaintenance 3104 / #claim 3222 / #finish 3285 / #fail 3321 / #release 3190）lease 解除 SQL 逐字相同，只差表名与域列；Attention / Memory Reflector 同构。已有一半 seam：#beginCognitiveOrganAttempt 1636 / #runCognitiveOrgan 1693。
- 方向：一个参数化 driver（claim→lease→run→heartbeat→settle），器官只留 readiness 查询、schedule math、adapter run。driver 是 SqliteRuntime 私有的行为 seam，不碰 ADR-0001。
- 附带吸收：双生 idle guard（#isMaintenanceIdle 2195 / #isCognitiveOrganIdle 2210）与六个 #reconcile* 循环（见 R3）。

### R2 — Scheduler 每轮把完整 status() 当廉价快照消费

- 位置：`src/runtime/scheduler.ts` + `src/runtime/status-reader.ts`。
- 证据：scheduler.ts:153/154（同轮双调）、197、231 调 `this.#runtime.status()`；readStatus()（status-reader.ts:183）发 8+ 全表 SELECT 并解析全部 payload 与 frozen_activity_json；调度只消费 pending ambient input、activeSegment.openedAt、pending effect 的 nextDeliveryAt。
- 方向：有界 schedulingSnapshot（或三个窄 SELECT），无 JSON 解析；宽 status() 保留给运营面。

### A1 — 六个器官各写一遍 ~45 行 Pi session 引导

- 位置：`src/agents/{attention-maintainer,life-recorder,memory-reflector,orientation,thread-maintainer/index,tool-trace-compactor}.ts`。
- 证据：SessionManager.open → SettingsManager.create → DefaultResourceLoader → createAgentSession → setAutoCompactionEnabled(false) 六份逐字重复；thread-maintainer 已出现 appendSystemPromptOverride 漂移变体。
- 方向：`src/agents/session/` 内一个 openOrganSession helper（参数只留 systemPrompt）；顺带收敛五个器官的请求校验 helper（ISO/dedup/path-normalize）。

### A2 — Thread Maintainer 走第二条无 fsync 的写路径

- 位置：`src/agents/thread-maintainer/workspace.ts:132-142` vs `src/workspace/workspace-mutation.ts:609-615`。
- 证据：其他写入器官走 WorkspaceMutation.write（writeFile → handle.sync() → rename）；Thread Maintainer 用 writeFile+rename 无 fsync，rollback 却用 beginWorkspaceTreeMutation。
- 方向：让 Thread Maintainer 的写走 durable handle。不是新 atomic-write util（triage 已拒绝），是改用已存在的 handle。

### M4 — withoutImagePixels 两份，行为已分叉

- 位置：`src/main-agent/pi/tool-activity.ts:86`（递归）vs `src/main-agent/tool-trace.ts:555`（非递归）。
- 证据：expand_tool_result 路径的嵌套 image block 像素不被剥离；activity 记录路径剥离。triage 说过“下次改这区域时收敛”——就是现在。
- 方向：一份递归实现 + 嵌套剥离单测。

### M1 — tool-trace.ts 一个 module 背五份职责，无专属测试

- 位置：`src/main-agent/tool-trace.ts`（593 行）。
- 证据：10 个 export，caller 必须学压缩判定阈值、引用授权集、metadata schema 版本、deep-equality 匹配规则；无专属测试文件。
- 方向：deep compaction module（detect→batch→validate→rewrite 藏在一个入口后）+ expansion module，各配专属测试。

## Worth exploring

- **R3** 六个 #reconcileExpired*（runtime.ts 2906-3060）同构 → 参数化 #reconcileExpiredLeases(now)。
- **A4** 四个器官的 validateAndCommit「written? → updated/no_change」→ 共享 accumulate→outcome→commit；grounding 留器官。
- **A3** Memory Reflector 绕过 AgentWorkspace 类型化读取（raw readFile facts.json + 自写 validateStableFacts）→ 走 AgentWorkspace.loadStableFacts。
- **M2** raft-channel 65 处直接触达 refs/known_destinations/ambient_activity/attention_state → RaftRefStore 深模块。
- **M3** raft 持久表无 DELETE/保留策略 → channel 内部保留维护方法。

## Speculative

- **M5** pi-execution 纯变换（composeSystemPrompt 等）提升为导出 helper + 单测。

## 已核对并排除（不再建议）

status-reader 已抽出 · Pi helper 已拆 · raft CLI 解析已拆 · nmem connection 已统一 · 器官 session 已统一 · 配置缺失已报错 · 共享 generic utils / atomic-write util / Store 抽象维持 triage 拒绝。
