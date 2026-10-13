# 单主体运行与持久状态

这个能力让部署持有一个主 Agent，并在重启后继续指针所指的 Session。`agent-runtime` 负责活句柄，`runtime-state` 负责少量机械持久事实；它们不持有 Individual 的身份或记忆。整体协作见[架构](<../architecture.md>)。

## 配置与服务

- `agent-runtime`：`workspace` 指定 Session cwd；`agentOptions` 可显式给出模型选项，否则读取 DSH `agentDefaultModel`；`agentPreset` 可指定 Preset，否则使用注册表默认值。准确字段见[声明](<../../src/agent-runtime/index.ts>)。
- `runtime-state`：不另接数据库配置，通过 `storageDomain` 打开域；[Bundle](<../../cordis.patch.yml>)把该域路由到 SQLite。域布局见[域声明](<../../src/runtime-state/domain.ts>)。
- 服务：`ctx.agentRuntime` 提供当前 Agent、文本交付和可关联到 Session `user/message` 的 tracked handoff；`ctx.runtimeState` 提供指针、入站接受/交接状态、所属会话、投递记录。签名与字段含义见[contracts](<../../src/contracts/index.ts>)。

运行时还依赖 DSH agents、Presets、Session persistence/query/projections、tools 和 llm。所需服务缺失时不能把“插件行存在”当作“主主体已启动”。

## 启动与交付

[启动实现](<../../src/agent-runtime/boot.ts>)先查当前指针：有指针则 resume；没有则创建 Session、挂载 Preset，然后写指针和所属会话记录。创建先于指针，避免持久指针指向尚不存在的 Session；中间故障可能留下未被指向的 Session，不承诺启动的多个写入构成一个事务。channels 自己在挂载时 drain 带正文的 pending 入站，不能把启动事件当作可回放事件。

DSH 对被创建或恢复的 Session 持有跨进程写租约；同一 Session 被另一进程占有时拒绝写入。这个保证不等于“两个同时空指针启动必然被部署级锁挡住”，Loom 没有另建 Instance Root 锁。

`deliver(text)` 把独立 user message steer 到当前主 Agent：idle 时开始处理，运行中在最近的 Step 边界消费，不截断在飞的工具调用。它返回创建的 message id，调用方据此等待对应的 Session `user/message` 提交；没有活句柄时返回 `undefined`。返回 id 只代表消息进入进程内 inbox，不代表任何 Turn 提交了它。runtime 本身不保存外部输入队列，持久 pending 与恢复由[渠道](<channels.md>)负责。

## 存储与权限边界

指针只保存 Session id，祖先关系取自 Session header；所属会话记录用于历史搜索授权，不能用来决定哪个祖先可返回。入站 pending/交接记录与出站投递记录由渠道消费方写入；入站允许恢复重投，出站仍不自动重发。各记录用途见[架构的数据归属表](<../architecture.md#持久事实由谁持有>)。

换代先创建 successor、记录所属 Session 并提交 current pointer，再退休旧 Agent；successor 创建失败时旧句柄仍在。主 Session 在启动和换代激活时被写入 `danger-full-access` 文件策略；准确行为见[运行时](<../../src/agent-runtime/runtime.ts>)。工作区是默认 cwd，不是权限围栏。主体可经文件或 shell 工具访问同 uid 能访问的部署侧文件，不能在文档中声称它物理上无法修改配置。插件仍然区分配置归属和材料归属。

## 模型看到什么

运行时挂载 Preset 与连续性工具，外部文本以 user message 到达模型；它不注入工程 agent 的身份、Team Claims 或仓库规则。生成时的材料由[材料能力](<materials.md>)贡献，换代 handoff 和压力通知由[连续性](<continuity.md>)负责。文件策略通过 DSH 的 Session 事件和沙箱上下文表达。

## 验证入口

[agent-runtime 测试](<../../tests/agent-runtime.spec.ts>)覆盖创建/恢复、交付、换代顺序与文件策略；[boot-smoke](<../../tests/boot-smoke.spec.ts>)用实际 DSH 插件和 mock 模型验证启动到一轮生成。两者都不证明部署配置、真实模型或真实渠道可用；验证选择见[开发指南](<../development.md>)。
