# Ponytail Audit Findings (2026-08-14)

Captured: 2026-08-14, baseline `01a3f8a`（继承本轮 summary）。
方法：三个并行扫描（runtime / agents+workspace+main-agent / channels+integrations+infra），主代理逐条回读源码复核；复核结论标注在每条末尾。

## 裁剪清单（进入 spec.md）

按删减量排序，一行一条。`<tag> <裁什么>。<替代>。[位置]`

1. `delete:` `scripts/validate-instance.mjs`。仓库内零引用（无 package.json script、无 docs、无 CI）；单次提交引入的临时验证 harness。替代：无（如要保留验证能力，先归档进 .scratch，不入 spec）。[scripts/validate-instance.mjs:1]
2. `delete:` `CognitiveOrganExecution.nextDue()` 及其专属测试块。src/ 零调用（retry 由 failAttempt→beginNextAttempt 驱动），只有 test/runtime/cognitive-organ-execution.test.ts:358-367 在调。替代：无。[src/runtime/cognitive-organ-execution.ts:418]
3. `yagni:` workspaceMirror 的 TS 解析路径。`WorkspaceMirrorConfiguration` interface + `parseWorkspaceMirror` + assertOnlyKeys 条目 + spread 全链路在 TS 侧零消费；唯一消费者 mirror.mjs 自己 re-parse instance.yaml。替代：删除解析，instance.yaml 的 workspaceMirror 键保留给 mirror.mjs 使用。**注意（主代理补充复核）：** 文档承诺 workspaceMirror 是白名单校验、未知字段拒绝（docs/integrations/workspace-mirror.md:39），该校验目前在 TS parse 里，mirror.mjs 只内联校验 enabled/remote/branch——删除 TS 解析时必须把白名单校验移入 mirror.mjs，保持 fail-fast 合同不变。[src/configuration/instance.ts:124,144-146,161,184-206 · src/integrations/workspace-mirror/mirror.mjs:63-83]
4. `delete:` `DEFAULT_ORIENTATION` 常量。零 importer、未被 re-export。替代：无。[src/configuration/instance.ts:26-28]
5. `delete:` 孤儿类型导出（Attention 与 Memory 两器官各 4 个）。`AttentionMaintenanceRequest/Result/Maintainer/PiAttentionMaintainerOptions` 与 `MemoryReflectionRequest/Result/MemoryReflector/PiMemoryReflectorOptions` 除定义文件外零 importer（revision-bound-organs.ts 只导入 create* 工厂）；规范类型在 runtime/types.ts。替代：删除或 un-export。[src/agents/attention-maintainer.ts:120-139 · src/agents/memory-reflector.ts:226-247]
6. `yagni:` `PiExecutionResult extends ExecutionResult {}` 空 interface。替代：直接用 ExecutionResult。[src/main-agent/pi-execution.ts:118]
7. `yagni:` `PiContextMessage` 导出。除定义文件零 importer；类型内部仍用。替代：un-export。[src/main-agent/pi-execution.ts:72]
8. `yagni:` `PiOrientationOptions` 导出。除定义文件零 importer。替代：un-export。[src/agents/orientation.ts:122]
9. `delete:` `LifeRecorder = ActivityRecorder` 死别名。零 importer。替代：无。[src/agents/life-recorder.ts:142]
10. `yagni:` `OpenConfiguredWeixinAdapterOptions extends OpenWeixinAdapterOptions {}` 空 interface。替代：直接使用基类。（Raft 的同名 configured options 有真实差异字段，不动。）[src/channels/weixin/weixin-adapter.ts:119]
11. `shrink:` `currentWork()` 重编码了 `#workRecord()` 的完整行映射（同一 SELECT 列清单 + 同一 optionalStringField 展开）。替代：只查最新 id 后委托 `#workRecord(id)`。[src/runtime/cognitive-organ-execution.ts:428-449]
12. `shrink:` observeWorkspaceTool 里两个几乎相同的 missing-material 块（catch 分支与 isError 分支：requested 计算、isOptionalMissingMaterial 判定、readMemoryFiles/memoryNextOffsets 更新、toolResult 返回全部相同）。替代：抽一个局部 helper。[src/agents/memory-reflector.ts:491-526]
13. `shrink:` `errorMessage()` 单调用点三行函数。替代：内联 `error instanceof Error ? error.message : String(error)`。[src/agents/attention-maintainer.ts:453]
14. `shrink:` `#nmemEnabled` 判定（`Boolean(workingMemoryReader && nmemRecallTool)`）重复三处。替代：构造时计算一次存入字段。[src/agents/memory-reflector.ts:353,631,666]

**packaging 修正（不是裁剪）：** typebox 被 12 个 src 文件在运行时导入（tool parameter schemas），却列在 devDependencies。替代：移入 dependencies。[package.json]

## 已审查并拒绝（避免误报与反复重提）

- `stdlib:` jsonObjectsIn 状态机换 indexOf/lastIndexOf+JSON.parse —— **拒绝**：模型输出夹带散文，naive 定位不能处理字符串内花括号、转义与嵌套；现有状态机是正确实现的最小形式。[src/agents/orientation.ts:381-411]
- @js-temporal/polyfill —— **保留**：Node 24.15.0 实测 `typeof Temporal === "undefined"`，polyfill 是真实需求。
- Scheduler interface + createScheduler 工厂（一实现一生产调用方）—— **borderline，不盲裁**：它是 loom-instance 的装配 seam，测试也直接用工厂；留 grilling 决定。[src/runtime/scheduler.ts:67-69,559-561]
- nextRunId 选项（五器官，仅测试传入）—— **borderline，不盲裁**：6 个测试文件用它保证确定性 run id；与深化候选 A1（openOrganSession）一起 grilling。[五器官 options 接口]
- 10 个“单文件 leaf type”未被按名导入（RuntimeInputKind 等）—— **不动**：它们是 RuntimeStatus/RuntimeInput/FrozenActivity 的结构字段，去 export 是零收益的 churn。
- schema.ts 迁移（migrateVersion11..19 等）—— **保留**：真实历史版本步骤，各有 PRAGMA user_version 门。
- RaftRemote/collection/surface、openConfigured*、retryFailedIngress、raft-activity —— **保留**：核对为真实多消费者 seam。
- createWorkspaceReadTools —— **保留**：有意的路径收容 adapter（上轮已复核）。
- 通用 guard 重复（isObject/errorMessage 家族）—— **维持 triage 决定**：不做全仓 sweep；本轮只裁单点死副本（见清单 13）。

## 汇总

`net: -215 行, -0 依赖可裁`（typebox 是归类修正不是删除）。裁剪全部是删除/缩小行为表面积，不改变任何公开行为的语义；深化候选（R1/R2/A1/A2/M4/M1 等）另见 [deepening-candidates.md](deepening-candidates.md)。
