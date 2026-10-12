# Loom 术语与边界

本文定义工程讨论中的稳定概念。运行路径见[架构](<docs/architecture.md>)，精确接口见[共享声明](<src/contracts/index.ts>)；不要从术语推导源码未提供的保证。

| 概念 | 在 Loom 中的含义 |
| --- | --- |
| Individual | 跨会话与上下文换代继续存在的同一个主体。身份、关系和判断由它自己形成，不由 Harness 预设。 |
| Runtime Instance | 承载一个 Individual 的运行实例。主主体只有一个；委托出的辅助 agent 不成为第二个 Individual。 |
| Agent | DSH 当前执行中的活句柄。Individual 可以跨多个 Agent generation 继续，不能把活句柄当作持久身份。 |
| Session | DSH 的持久事件记录与模型历史来源。它记录发生过什么，不等于主体的全部理解或工作材料。 |
| Generation | 主主体当前运行的一段上下文。换代创建后继 Session 与 Agent，不是回滚外部世界。 |
| Turn / Step | Turn 是一次可继续的处理过程；Step 是其中一次模型请求及其工具执行。发送消息不是 Turn 的结束标志。 |
| Agent Workspace | 主体持有的文件：身份、记忆、线索、关注、技能及收到的附件。它不是 Loom 的工程 checkout。 |
| Runtime state | Session log 与工作区之外的机械持久事实：当前会话指针、接受去重、所属会话与出站投递记录。 |
| 材料 | Individual 自己维护、用于后续判断的文件。Harness 负责读取和提供条件，不替它决定内容。 |
| Channel | 与外部交流的传输入口。网关负责传输与授权，Loom 消费方把输入交给当前主体。 |
| Effect / Delivery | 一次出站尝试及其投递结果。`unknown` 表示无法确认，不表示“没发出去”。 |
| Plugin | 可独立挂载的 Cordis 能力，经服务、事件、工具或提示注册接入。 |
| Bundle / Profile | Bundle 发布有序 patch 清单；Profile 选择 Bundle 并加部署自己的 patch。两者都不是硬编码接线函数。 |
| Host / Agent plane | Host 保持共享运行设施；Agent plane 决定某个 agent 的工具和能力范围。具体装配见[架构](<docs/architecture.md>)。 |
| 工程 agent | 在仓库中建设、验证和维护 Loom 的协作者。本文档体系首先服务这一角色，不能把它的指令直接注入 Individual。 |

## 三个不能混用的边界

- **源码与设计记录。** 当前行为以源码和测试为准；尚未实现的设计留在工作记录，不写成现有能力。
- **配置归属与访问权限。** 部署配置、主体材料分开存放不等于权限隔离。当前文件策略见[运行时](<docs/subsystems/runtime.md>)；不能声称“工作区之外物理上不可达”。
- **记录与理解。** Session log、runtime state、工作区材料各有自己的事实，不应互相复制成第二份权威。上下文换代只改变模型工作集，已产生的文件、进程和远程效果不会撤销。
