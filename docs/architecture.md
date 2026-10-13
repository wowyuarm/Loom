# Loom 当前架构

Loom 把 DSH 的可替换插件栈组合成一个长期存在的 Individual。它复用模型、循环、Session、工具、沙箱、存储和技能机制，自身只提供单主体生命周期、材料、渠道与相应的上下文条件。概念定义见[术语](<../CONTEXT.md>)；改能力前还要查[DSH 对应接缝](<dsh-platform.md>)。

## 组合与替换

[包声明](<../package.json>)发布两份有序清单：[Host patch](<../cordis.patch.yml>)与[Agent preset](<../presets/loom.patch.yml>)。部署 Profile 叠加 DSH Bundle、Loom Bundle 和自己的配置，loader 负责挂载；没有统一 import 所有模块的接线函数。

- **Host 保留共享设施。** 模型路由、工具与技能注册表、沙箱、Session 持久化与投影等来自 DSH。Loom 的时钟、runtime state、主体运行、材料和渠道插件经这些接缝工作。
- **Preset 决定主主体的模型可见能力。** Bundle 禁用 base 对应的全局工具行，Preset 显式挂载文件、shell、jobs、web、skills 和压缩能力。`agent-runtime` 在创建窗口挂载同一 Preset，后继 generation 也走这条路。
- **服务通过接口替换。** [contracts](<../src/contracts/index.ts>)承载共享接口与 Context 增强；消费方 inject 服务，不能 import 提供方的具体实现。新增服务在 Preset 内提供时，需要 DSH 的独立 realm，不能偷偷变成所有 agent 的全局服务。

组合测试见 [bundle-manifest](<../tests/bundle-manifest.spec.ts>)。配置预览只证明清单组合，不证明插件已激活或模型已回答。

## 一条输入如何成为一次对外行动

```text
外部渠道
  → 网关与适配器：规范输入、授权
  → Loom channels：规范输入、附件落盘、持久记录 pending、更新当前会话焦点
  → agentRuntime.deliver：steer 到主主体最近的 step 边界，Session 提交前保持 pending
  → DSH loop：组装提示与工具，接纳输入，调用模型与工具
      ├─ resident-context：身份、记忆、线索与关注
      ├─ time-context：当前时刻与间隔
      └─ channels：未确认投递上下文
  → message 工具：先持久记录 pending，再请求网关发送
  → runtime state：delivered 或 unknown；通知 loom/delivery
  → Turn 结束：工作区留版、失败记录或对话后检查
```

每个输入保持一个独立 user message；运行中到达的输入不截断工具调用。持久接纳但尚未出现 Session `user/message` 的输入会在 Agent 恢复、换代完成或重启后重投，因此可能重复；这不是恰好一次处理。一次投递尝试本身不构成交接：只要输入仍是 pending，下一轮恢复就重新交给 Agent。只有 `message` 工具向当前焦点投递，普通 assistant 文本不会自动发到渠道。发送与 Turn 结束是不同事实。限制及失败路径见[渠道](<subsystems/channels.md>)。

## 主主体如何跨重启与换代继续

`agent-runtime` 持有主主体的活句柄。启动时读 runtime-state 指针：存在就 resume 指向的 Session，否则创建第一份 Session 后记录指针。DSH 提供被恢复 Session 的写租约，Loom 不自建锁。

连续性适配复用 `dsh-context-continuity` 的投影、工具与协调器。换代意图来自持久工具结果，在 idle 边界驱动；运行时先准备确定身份的后继并提交指针，再退休旧 Agent，随后送 handoff 和携带输入。后继创建失败时旧 Agent 保持可用。Checkpoint return 可以保留指定祖先的已完成前缀，但不会撤销文件或发送的消息。

启动与边界限制见[运行时](<subsystems/runtime.md>)；换代、历史访问和上下文压力见[连续性](<subsystems/continuity.md>)。本仓库没有给 Individual 贡献自动话题锚点或 Team ledger。

## 持久事实由谁持有

| 事实 | 所有者与消费者 | 不承诺什么 |
| --- | --- | --- |
| 模型历史与生命周期事件 | DSH Session / persistence；Loom 经投影和历史读方消费 | 不是主体记忆，也不是工作区备份 |
| 当前主 Session 指针 | runtime-state 保存；agent-runtime 在启动和换代写入 | 不复制 lineage；祖先关系来自 Session header |
| 入站接纳与交接状态 | runtime-state 保存；channels 写入规范化 pending，Session `user/message` 提交后确认 | 允许恢复重投和重复，一次尝试不等于已交接，不是恰好一次队列 |
| 所属 Session 集合 | runtime-state 保存；runtime 写、历史搜索读 | 搜索范围不等于可返回的当前祖先链 |
| 出站尝试与结果 | runtime-state 保存；channels 写入和渲染不确定性 | 无自动重发，无端到端恰好一次投递 |
| 身份、记忆、线索、关注、技能 | Individual 的工作区；resident-context 读取，技能提供方发现 | 不由工程文档规定其人格或判断 |
| 工作区版本与行修改时间 | 工作区 Git；workspace-history 尝试提交和读取 | 没有仓库时不自动初始化，也不阻止 Turn |
| 模型路由控制文件 | 部署侧文件；model-switch 每 Step 读取 | 路径归属不是文件访问隔离 |
| 对话后定时检查 | after-interaction 插件生命周期内的内存 | 不持久、不跨重启恢复，不是未来任务调度器 |
| 活动时间线与 pulse 账本 | pulse 插件：Session 投影恢复回合事实，storage-domain 保存跨重启/换代的时刻与记录 | 不补跑漏掉的心跳，quiet 检查不算活动，不是未来任务调度器 |

## 能力参考与验证入口

| 能力 | 当前职责 | 文档 |
| --- | --- | --- |
| agent-runtime / runtime-state | 主句柄、指针与机械持久事实 | [运行时](<subsystems/runtime.md>) |
| context-continuity | 主体换代、历史检索、压缩与压力适配 | [连续性](<subsystems/continuity.md>) |
| resident-context / workspace-history / time-context | 材料进入模型、预算、留版、条目年龄与时间 | [材料](<subsystems/materials.md>) |
| channels / turn-failures / log | 渠道收发、投递不确定性、失败可见 | [渠道](<subsystems/channels.md>) |
| skills | 单工作区的技能发现与初始技能 | [技能](<subsystems/skills.md>) |
| after-interaction | 人开启的对话停顿后做一次判断 | [对话后检查](<subsystems/after-interaction.md>) |
| pulse | 任何活动冷却约 30 分钟后做一次二元判断，必要时唤醒主体 | [pulse](<subsystems/pulse.md>) |
| model-switch | 请求边界切换部署声明的模型路由 | [模型切换](<subsystems/model-switch.md>) |

改动应沿上述职责定位，不按“底层/上层”拆出半条工作路径。最小整栈验证入口是 [boot-smoke](<../tests/boot-smoke.spec.ts>)；它使用脚本化 mock 模型和临时工作区，不证明真实渠道或真实 provider 的可用性。验证选择见[开发指南](<development.md>)。
