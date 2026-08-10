# Loom 架构

本文说明 Loom 各模块如何组合，以及数据如何在一个运行的 Instance 中流动。稳定术语先读 [CONTEXT.md](../../CONTEXT.md)，工程约定读 [AGENTS.md](../../AGENTS.md)。

## 执行模块

一个 Runtime Instance 由五个执行模块装配而成。每个模块持有不同的持久面，不共享对另一模块持久面的写权限。

```
Instance Configuration          装配一切：时间、模型、Channel、Integration、调度

Runtime                         持有 Runtime Store（本地 SQLite）
  │                               input · 时间 · turn · effect / delivery
  │                               活动生命周期 · 恢复
  │
  ├── Main Agent                 在 Pi session 中执行主 agent
  │     Context · Transcript · message · Workspace tools
  │
  ├── Cognitive Organs           Harness 内化且版本化的认知维护能力
  │     Orientation · Life Recorder · Thread Maintainer
  │     Attention Maintainer · Memory Reflector
  │
  ├── Interaction Channels       默认关闭，Instance Configuration 显式启用
  │     Weixin · Raft
  │
  └── Integrations               默认关闭，Instance Configuration 显式启用
        Web Access · nmem
```

| 模块 | 职责 |
| --- | --- |
| Runtime | Input、时间、调度、Turn、Effect/Delivery、活动生命周期、恢复。 |
| Main Agent | 主 Agent 的 Pi 执行、Context、Primary Agent Transcript 与 tool trace。 |
| Cognitive Organs | Harness 内化且版本化的认知维护能力。 |
| Interaction Channels | 协议接入、ingress、Delivery 与恢复；向 Main Agent 暴露 guidance、tools 和 destinations。 |
| Integrations | 外部记忆服务与 Web Access。 |

### 持久面

| Surface | 持有者 | 用途 |
| --- | --- | --- |
| Agent Workspace | Agent Individual | 身份、关系、记忆、行为材料、skills 与私人工作。 |
| Runtime Store | Runtime | 恢复所需事实的唯一权威（SQLite）。 |
| Primary Agent Transcript | Main Agent | 主 Agent 的原始执行证据，不承担恢复真相。 |
| Instance Configuration | Operator | 实例装配、时间节律、模型策略与默认 route 引用。 |

## Runtime

Runtime 是中央协调者。它持有 Runtime Store（本地 SQLite 数据库），编排每一次互动的完整生命周期：

```
Input → Wave → Turn → Effect → Delivery → Activity close → Cognitive Organs
```

### Input 与 Wave

Channel 收到消息（Raft wake、Weixin poll）后转换为 **RuntimeInput**，带 `source` 字段标识来源 channel。来自同一 Interaction Place、时间接近的 Input 组成 **Interaction Wave**。Wave 保持打开一段时间（静默窗口 1.5 秒、上限 6 秒），期间同 place 的新 Input 加入；Turn 等待其 wave 封口后 Agent 才开始回应。wave 封口后到达的 Input 属于下一波。

### Turn 与 Effect

Runtime 把一个 wave 接纳进 **Turn**：创建 context window、冻结 activity segment、把控制权交给 Main Agent。Main Agent 在 Pi session 中执行，持有 Workspace 工具、Channel 工具和 `message` 工具。

Main Agent 调用 `message` 工具（`action: send`）时，Runtime Store 中创建持久 **Effect**。Effect 是对外行动的持久声明。**Delivery** 是实际通过对应 Channel（按 `routeRef` 路由）发送 Effect 的尝试。Effect 被 Runtime 接受不代表 Delivery 已成功——Delivery 可能失败、重试或保持未知。

### Activity 生命周期

每个 Turn 的执行形成 **Active Segment**。Turn 完成（或超时：30 分钟空闲 / 2 小时上限）时，Runtime 把它**冻结**成 **Frozen Activity**：不可变、有序的事件序列。冻结允许后续 Input 在不等待 Cognitive Organs 的情况下被接纳。

### 恢复

Runtime Store 是恢复的唯一事实源。重启时 Runtime 从持久 SQLite 状态重建 pending inputs、effects、deliveries 和 cognitive organ 队列。Primary Agent Transcript 是执行证据，不是恢复源。

## Main Agent

Main Agent 是 Agent Individual 的主要声音和行动者。它在 [Pi SDK](https://github.com/earendil-works/pi-coding-agent) session 中执行，持有：

- **System Guidance**：Harness 级指令，关于连续性、证据、主体性和可见性。
- **Context Materials**：Identity、Behavior、Long-term Memory、Current Attention、Daily Narratives、Recent Activity bridge 和已提交 tool traces。
- **Workspace 工具**：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`——以 Agent Workspace 为 cwd 操作。
- **Channel 工具**：Channel 专属工具（如 Raft 的 `raft_places`、`raft_activity`、`raft_open`）。
- **Message 工具**：让文本对人类可见的唯一方式。创建持久 Effect，由 Runtime 通过对应 Channel 投递。

Main Agent 也可以选择 `no_reply`，形成明确的 Turn outcome——发生了私人活动但没有对外消息。

### Context Window

每个 Turn 获得一个 context window。窗口要么从 successor context 恢复（前一 Activity segment 以 durable freeze 结束时），要么新组装。新窗口包含：

1. Harness system guidance
2. Workspace 快照（Identity、Behavior、Memory、Current Attention）
3. Daily context（跨日连续性的两日叙述）
4. Recent Activity bridge（有界、紧凑）
5. 已提交 tool traces（过长时压缩）
6. 当前 Input 及其 Interaction Context（source、destinations、references）

超过 context budget 的 tool traces 由 Tool Trace Compactor（轻量 Cognitive Organ）在复用前压缩。

## Cognitive Organs

Cognitive Organs 是 Harness 内建、版本化的能力，维护 Agent Individual 的连续性材料。它们不是 Individual 的身份——是在受控条件下读证据、写回 Workspace 的维护工具。

详细指南见 [Cognitive Organs](cognitive-organs.md)。

## Interaction Channels

Channel 是一等实体，把 Instance 连接到外部交流面。每个 Channel：

- 通过自己的协议**接收 Input**（Raft wake/inbox、Weixin HTTP polling），转换为带 source 标识的 RuntimeInput。
- 通过自己的协议**投递 Effect**，按 `routeRef` 校验归属。
- **暴露 Agent Surface**（guidance、tools、destinations、attention source），Host 跨所有启用 Channel 合并。

多个 Channel 可以同时运行。Host 合并它们的 surface：guidance 拼接、tools 并集（带名字冲突检查）、destinations 聚合并对 Main Agent 可见。

| Channel | Ingress | Agent Surface | Destinations |
| --- | --- | --- | --- |
| Raft | Wake + inbox drain | 完整（guidance、6 个工具、attention source） | known destinations 表 |
| Weixin | HTTP polling | guidance + default destination（无工具、无 attention source） | 单一 peer destination |

## Integrations

Integrations 把 Instance 连接到非 channel 外部服务。它们不是 Interaction Channel：不接收 Input、不提供 Interaction Route、不形成 Delivery。

| Integration | 用途 |
| --- | --- |
| Web Access | 有界的网页搜索与抓取工具。 |
| nmem | 外部记忆服务：投影 Episodes 和 Conversation Threads，提供 `nmem_recall` 与 Working Memory 证据。 |

## Instance Persistent Surfaces

Instance Root 内、Agent Workspace 外的持久面，由 Host 直接持有：

| 持久面 | 内容 |
| --- | --- |
| Runtime Store | 恢复事实：Input/Effect/Delivery、Transcript、Activity、State。 |
| Attachment Store（`runtime/attachments/`） | 入站媒体与出站文件快照的不可变原始字节，30 天无引用保留。 |

Attachment Store 不是 Integration，也不是 Interaction Channel：它由 Host 打开并持有单一 live Store，Host 与 Instance 共享同一对象；只根据 pending/active Input 与 pending/reconciliation-required Effect 的引用触发 retention。原始字节不进 Runtime Store、Transcript、Context state、Activity、认知材料或 nmem；外部字节只有显式 `copyToWorkspace` 才进入 Agent Workspace。

## Host

Host 是单一 Instance Root 的 live owner。它：

- 按 Instance Configuration 打开 Instance、Channels 和 Integrations。
- 启动和停止 Channel 生命周期（由 Channel Collection 管理）。
- 提供 operator status socket（`loom status`）。
- 从 Channels 接受 Input 并转给 Runtime。
- 协调优雅关闭（逆序停止 Channels，等待活跃工作完成）。

## Process Driver

Process Driver 以单一串行循环推进 Runtime。它：

- 处理 pending inputs、deliveries 和 cognitive organ 队列。
- 被新 Input 立即唤醒。
- 空闲时等待最早的调度唤醒时间（proactive pulse、cognitive organ 重试、delivery 退避）。
- 优雅停止时等待当前运行完成。

## 数据流示例

人类通过 Raft 发消息：

```
1. Raft bridge 收到 wake → RaftChannel.acceptWake()
2. RaftChannel 解析消息 → 创建 RuntimeInput (source: "raft")
3. Runtime 接纳 Input → 打开 Active Segment → 启动 Main Agent Turn
4. Main Agent 读 Context + Input → 调用 message 工具 (action: send, destination_ref)
5. Runtime 创建持久 Effect → 排队 Delivery
6. Process Driver 认领 Delivery → RaftChannel.deliver() → Raft bridge 发送文本
7. Turn 完成 → Runtime 冻结 Activity
8. Life Recorder 读 Frozen Activity → 写 Daily/Episodes
9. Thread Maintainer 读 Frozen Activity → 更新 threads/
10. Attention Maintainer（独立短周期）读近期 Activity → 更新 attention.md
11. Memory Reflector（每逻辑日一次）读当日 Activities → 更新 Identity/Memory/Behavior
```

## Model Runtime Revisions

模型配置是版本化的。Instance Configuration 改变模型 provider 或设置时，创建新的 **Model Runtime Revision**。Revision 先验证所有 role models 和 auth，再原子切换。旧 revision 继续服务当前运行；坏 source 明确标记 degraded 或 blocked，不读取凭据内容。

八个模型角色：`main-interaction`、`main-background`、`tool-trace-compactor`、`orientation`、`life-recorder`、`attention-maintainer`、`thread-maintainer`、`memory-reflector`。
