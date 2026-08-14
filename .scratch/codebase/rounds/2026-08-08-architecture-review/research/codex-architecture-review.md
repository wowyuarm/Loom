# Loom 源码架构与测试审视

审查基线：`4c65508`。本轮不改生产代码。

`npm run typecheck`、`npm test` 和 `git diff --check` 均通过。问题不是当前代码失效，而是几个文件已同时容纳太多互不相同的职责，测试的运行入口也没有反映测试成本。

## 结论

不做一次性大重构，也不为少数边界情况增加新框架。先只做能让代码更容易看、改和测的文件包整理；每一步保留现有对外接口和行为。

## 建议清单

| 优先级 | 范围 | 建议 | 不做什么 |
| --- | --- | --- | --- |
| P1 | `src/runtime/runtime.ts`（4,964 行） | 先把只读状态组装移到 `runtime/status-reader.ts`。它集中读取 Input、Turn、Effect、Delivery、Activity 并映射为 `RuntimeStatus`，与写入状态机不同。`SqliteRuntime` 仍持有数据库与事务。 | 不抽 Store/Repository；不同时迁移 Input、Turn、Delivery 等写入生命周期。 |
| P1 | `src/main-agent/pi-execution.ts`（1,240 行） | 按已有函数边界移动三个无状态部分：Input/attachment 展示、Pi session/skill 装配、tool activity extension。`PerTurnPiAgentExecution` 留在原处，继续负责一个 Turn 的开始、steer、abort、结束。 | 不改 `AgentExecution`/`RunningExecution`；不新增 Context 或执行框架。 |
| P1 | `src/channels/raft/raft-cli-remote.ts`（1,298 行） | 先提取 CLI 文本解析和 target/证据映射为纯模块；进程启动、bridge 和 remote 方法仍留在 `DefaultRaftCliRemote`。 | 不改变 Raft CLI 合同；不设计通用远端协议层。 |
| P2 | `src/channels/raft/raft-channel.ts`（1,706 行） | 在完成 remote 解析拆分后，再把 model-facing tools/evidence 组织到单独文件；wake spool、重试和 Delivery 继续由 Channel 主类统一协调。 | 不把 ingress、Delivery、attention 拆成多个独立状态机。 |
| P2 | `src/runtime/types.ts`（754 行） | 仅随着上述模块移动相应类型；保留 `runtime/index.ts` 的聚合导出。 | 不先按类型名拆文件，也不制造新的运行时抽象。 |
| P3 | schema、nmem、低危 helpers | 维持现状，等真实模块改动时再随改动移动。 | 不做 generic utils、通用 Job Runner、批量 schema 重排。 |

## Runtime 的拆分顺序

`runtime.ts` 最大，但它承担的是同一个 SQLite Runtime 的一致性。拆分顺序必须保守：

1. 先移动只读 `status()` 投影；它不改变事务和恢复。
2. 然后在一次实际需求中选择 **一个**完整生命周期（Activity 或 Delivery）迁移，保留其 SQL、lease 与恢复逻辑在同一内部模块。
3. Input/Wave/Reply Gate 与 Turn/Effect 不分开；它们共享接纳和首次 Effect commit 的原子边界。

这会减少 `SqliteRuntime` 的阅读负担，但不会制造多个数据库拥有者。

## 测试整理

当前测试不应按数量直接删除。`npm test` 只有一个入口：完整 build 后运行所有测试；而目录已自然分为 `runtime`、`main-agent`、`channels`、`instance`、`host` 等层。

先增加三个不改变测试内容的运行入口：

1. 快速逻辑测试：configuration、workspace、纯解析和展示。
2. Runtime 测试：SQLite 状态、恢复、调度。
3. Host 测试：真实 Instance、Channel 与跨进程行为。

迁移生产模块时，只把对应测试文件按同一职责移动。只有两个测试以相同故障输入、同一外部行为重复证明同一件事时，才删其中一个；恢复、lease、unknown Delivery 和跨 Host 测试保留。

## 本轮不建议处理

- 不因为 `runtime.ts` 行数而拆数据库抽象。
- 不为 Context、nmem 或诊断路径新建调度/执行框架；这些可在出现明确需求时单独讨论。
- 不为了“减少测试”删掉尚未证明重复的边界测试。
- 不做全仓 package/命名/utility 清扫。

## 推荐落地次序

1. `RuntimeStatusReader` 文件迁移，并把相关 status 测试一起整理。
2. Pi 的展示、session 装配、tool activity 三个文件移动。
3. Raft CLI 解析文件移动。
4. 根据前三步实际收益，再决定是否迁移一个 Runtime 写入生命周期或整理测试入口。

每一步应是一个小提交：typecheck、相关测试、全量测试通过；不部署。
