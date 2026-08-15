# Conventions Lens Findings (2026-08-14)

Captured: 2026-08-14, baseline `01a3f8a`（继承本轮 summary）。
方法：以 docs/agents/typescript-conventions.md、testing-policy.md、defensive-patterns.md 三个文档为合同，三个并行扫描（TS 约定 / 测试策略 / 防御性工程），主代理逐条复核。与前两轮的重复项已去重。

## 裁剪/修正清单（已并入 spec.md 第二轮）

1. `delete:` memory-reflector `validateCurrentMaterials` 的冗余非空复核循环——`loadBaseline` 对每个 BASELINE_PATHS 已抛错，MATERIAL_PATHS ⊂ BASELINE_PATHS，循环不可能触发。[src/agents/memory-reflector.ts:770-775]
2. `shrink:` orientation 对 `find` 谓词已收窄值的重复校验（role 已由谓词保证、outcome 已由第二谓词保证）。[src/agents/orientation.ts:356-367]
3. `shrink:` tool-trace `replaceExpandedInteraction` 在静态不可能状态上静默 return——索引来自与 replacement 同一 structuredClone 的数组；兄弟函数 `replaceRawInteraction` 对同样条件 throw。统一为 throw（或删分支）。[src/main-agent/tool-trace.ts:377-393]
4. `shrink:` activity `bridgeMessage` 不可达 fallback `?? new Date(0).toISOString()`——bridgeActivities 总是 push 最新 activity，`at(-1)` 永不为 undefined。改 `.at(-1)!.closedAt`。[src/main-agent/activity.ts:277]
5. `delete:` tool-trace-compactor 冗余终检 `details.size !== expectedIds.length`——前置 check 与 dedup 循环已抛完所有异常。[src/agents/tool-trace-compactor.ts:191-193]
6. `shrink:` channels/collection `markPresented` 的 `catch { return; }` 补注释：说明吞掉的具体失败与为何不影响权威状态（其余 168 处 catch 均已达标，仅此处缺）。[src/channels/collection.ts:253-255]
7. `shrink:` weixin `toRuntimeInput` 的静默丢弃条件补注释：明确「非 peer / 非 user / 非 finished / 无文本无附件」是 wire 边界过滤策略而非缺陷，丢弃的是什么消息。[src/channels/weixin/weixin-adapter.ts:421-447]
8. `shrink:` 测试 system-guidance.test.ts 的 8 个自引用断言（断言导出常量包含自己的文本，不经过任何装配）删除；若保留指引覆盖，改为经真实装配断言一次（器官测试已示范正确模式：对 assembled systemPrompt 断言）。[test/main-agent/system-guidance.test.ts:7-14]
9. `shrink:` 测试 cognitive-organ-runtime.test.ts 的 DB 复读与 `status().cognitiveOrganWork` 重复——只保留 DB 特有的 model_revision 断言。[test/runtime/cognitive-organ-runtime.test.ts:350-367]

## 判断为保留（附理由，避免下轮重提）

- **Scheduler 的 `?? DEFAULT_*_RETRY_MS`（构造 81-82 / 逐 run 115-438）——保留**：Scheduler 是装配所有者；activity 参数构造时一次性解析进 readonly 字段；retryDelay 是 Scheduler 拥有的协议常量（TS 约定第 8 条允许「协议常量可固定在其所有者内」），且无配置入口会被隐藏默认值改变。
- **器官 tool 参数的 `?? 0` / `?? DEFAULT_*_PAGE_SIZE`——保留**：模型/tool JSON 是边界（第 2 条），tool-contract 默认值属于器官自己的 tool 合同，不是部署默认值。
- **raft-cli-remote `#profileFor` 大小写回退——保留**：2026-08-06 triage 已决定「生产验收证明 identity 行为真实，保留 Raft profile casing fallback」，本次复核维持该决定。
- **weixin 静默丢弃——保留语义、补注释（见清单 7）**：是边界过滤策略不是不可能输入检查。
- **pi-execution 死 guard——已不存在**：当前工作区已无「return 后死代码」，上轮观察已过期。

## Correctness 观察（不是清理项，另行决定）

以下按 defensive-patterns.md 是「缺失的必需防御」，属于行为缺口而非表面积裁剪：

1. raft-cli-remote 超时只 SIGTERM 不 await child close；`#finishStop` 等 close 无超时上界——卡住的子进程会挂住 stop()；timeout/signal/exit 未分别记录。[src/channels/raft/raft-cli-remote.ts:182-185,798-834]
2. memory-reflector 备份文件写入用默认权限（0o644）且无独占创建，备份目录非 0o700。[src/agents/memory-reflector.ts:685,757-768,884-893]（对照：thread-maintainer/evidence.ts:161 已正确用 0o600。）
3. attachment-store 保留清理按 digest 路径删除，无 lstat 证明（与写入/校验路径不一致；`rm force:true` 不会跟随 symlink 越出，低风险）。[src/attachments/attachment-store.ts:204]
4. raft-cli-remote 的 inbox spool 临时文件用 0o600 但无独占 `wx` 创建。[src/channels/raft/raft-cli-remote.ts:550-556]
5. weixin-adapter `stop()` / `#run` finally 里 `remote.stop(...).catch(()=>{})` 是 fire-and-forget，stop() 返回前不等 remote 停止。[src/channels/weixin/weixin-adapter.ts:210-217,278-317]

按 AGENTS.md「不过度防御」规则裁决（只处理已存在、边界上合理可预见、或发生会造成明显损失的问题）：

- 观察 1 **值得处理（待定）**：stop() 被卡住的子进程挂住是 ops 可见失败，合理可预见且造成明显损失；但它是行为修复，不属于本 spec 的删除面，单独决定。
- 观察 5 **与观察 1 同类（待定）**：teardown 纪律缺口——stop() 不等待 remote 停止，迟到回调可能重发状态；与观察 1 一起作为 teardown 修复票评估，不进本 spec。
- 观察 2 **不修**：Agent Workspace 是工作边界不是宿主机级安全隔离承诺（CONTEXT.md），单实例账号下 0o644 备份没有新增损失场景；加权限/独占创建属于按文档预判的防御，与当前边界不符。
- 观察 4 **不修**：spool 临时文件已有 0o600，且目录为 Loom 自有状态面；无独占创建不改变损失场景。
- 观察 3 **不修**：Attachment Store 目录本为 Loom 自有；能写入该目录的攻击者已具备等价破坏力，lstat 防御不改变损失面。

## 已核对干净的规则（一行结论）

- 相对导入 .js：0 违例；`any`：0 违例（Model<any> 之外）；空 catch：0 处。
- 关闭联合 switch 的 default 全部 throw / assertNever / 带注释 / tool 边界 schema——干净。
- 168 处 catch 除 collection.ts 一处外全部带解释或边界重抛——干净。
- 限制执行位置（workspace write limits / web paging / tool-trace expansion page）——干净。
- 模型可见内容可从 Transcript 证据重建——干净。
- 测试 SQLite 直连 7 文件全部判为合法（公开 seam 构造 / schema 合同 / 恢复种子），无一越过接口断言私有行。

## 汇总

第二轮新增净约 -27 行（src 约 -14 + 注释 +2、test 约 -16），加上第一轮清单 net 约 **-240 行**。
