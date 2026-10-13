# Session 记录、Runtime state 与 Workspace 材料各自只有一个事实所有者

- 日期：2026-10-13
- 状态：有效

## 背景

Loom 同时处理模型执行记录、恢复所需的机械状态，以及 Individual 自己维护的长期理解。三者都可能出现相似文字，但它们的可信度、写入者和恢复方式不同。把一份事实复制到多个地方，会让重启、换代和模型上下文之间出现无法判断的第二权威。

## 决定

Loom 固定三类事实的所有权：

- **DSH Session log** 是模型执行的 append-only 记录：收到过什么、模型请求过什么、工具调用和回合如何结束。
- **Loom Runtime state** 是实例运行所需的机械事实：当前 Session 指针、入站处理账本、所属 Session 集合，以及外部 Effect/Delivery 账本。
- **Agent Workspace** 是 Individual 自己维护的理解材料：identity、memory、threads、attention、skills 及收到的工作区文件。

Channel gateway 负责传输和授权，不成为第四份对话历史；多个 channel 可以同时作为同一个 Individual 的外部入口，不因此拆出多个身份、记忆或 Session owner。Session projection、status 和 prompt context 都是从这些所有者派生的读取面，不得反过来成为同一事实的可变权威。消费方通过所属能力的接缝读取事实，不在另一个平面维护一份可独立修改的副本。

## 理由与代价

- 重启时可以明确判断应该从哪一份事实恢复。
- 模型输出、系统运行状态和主体理解不会被混成同一种“记忆”。
- 需要跨平面理解一个事实时，调用方必须依赖 projection、query 或 service，而不能直接读另一个插件的内部文件。
- 某些查询会比复制一份缓存更慢；只有在有实际性能证据时，才增加明确标注为 derived 的缓存，并保留重建路径。

## 重审信号

- 出现多进程或多实例共同写入同一主体，当前 Runtime state 的单实例所有权不再成立。
- 某类事实无法从其所有者可靠恢复，且重复写入已经成为实际性能瓶颈。
- 外部系统成为事实的真正权威，而不是当前 Loom 的本地账本或 Workspace。
