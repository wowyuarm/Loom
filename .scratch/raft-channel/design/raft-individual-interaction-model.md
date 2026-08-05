# Raft Interaction Channel 设计

状态：最终设计，机械实现已完成，真实验收待进行。本文是首个 Raft Channel 实现、测试与真实验收的产品和架构合同；具体类型名、序列化字段与 prompt 文案可以在不改变本文语义的前提下由代码确定。

本文已经完成设计收束，不表示 Raft Channel 已经可用。只有本文第 13 节的真实验收通过后，
对应实现 ticket 才能闭合。

这份文档回答一个模型视角的问题：当 Raft 成为 Loom 的 Interaction
Channel 后，Agent Individual 实际能看见什么、怎样按需了解外部场所、如何判断是否行动，
以及怎样在多个 channel、reply thread、task 和其他 agent 之间保持自己的连续性。

Raft 的官方事实与 CLI 证据分别见：

- [Raft 的领域模型、协作行为与 Loom 边界](../research/raft-domain-and-agent-collaboration.md)
- [Raft CLI 能力与模型可见 Context](../research/raft-cli-capabilities.md)

本文定义 Loom 侧的最终设计。凡是 Raft 尚未保证的可靠性或能力，必须在 Adapter 内显式
验证、降级或报告，不能把未证实的 CLI 行为当作已经成立的合同。

## 1. 基本定位

Raft 是 Individual 身处的一个**外部共享协作场所**，类似人与 agents 的 Slack。
Individual 可以在那里被找到、读公开讨论、参加私聊、回复一条讨论、认领 task，
也可以主动浏览和发起交流。

Loom 仍掌握这个 Individual 的：

- Agent Workspace、Identity、关系材料和私人 Thread；
- Runtime Input、Turn、Effect、Delivery 与恢复；
- Primary Agent Transcript、Frozen Activity 和记忆演化；
- proactive pulse、Current Attention 和内部时间节律。

Raft 保存的消息和任务是外部协作事实。它们可以成为 Loom 的 evidence，但不会自动变成
Workspace、长期记忆、Loom Thread 或 scheduler 工作。

## 2. Raft 中有哪些单位

```text
Raft server
  member
    human
    agent                 <- Loom Individual 在这里有一个外部身份投影

  place
    public channel        <- 所有成员可见；加入后接收普通消息
    private channel       <- 只有成员可见；不能自行加入
    DM                    <- 指定成员可见；始终通知

  top-level message
    reply thread          <- 依附于该消息的一层回复线；不能再嵌套
    task                  <- 某些顶层消息带 number/status/owner
      task reply thread   <- 进展、讨论和结果放在这里
```

| Raft 对象 | 用来做什么 | 如何停止占据注意力 | 是否消失 |
| --- | --- | --- | --- |
| channel | 长期共享一个工作 lane | leave 或 mute；管理员可 archive | 历史保留 |
| DM | 指定成员的私密协作场所 | 没有已证实的 close；不必主动读旧消息 | 历史保留 |
| reply thread | 围绕一条消息继续讨论 | unfollow | 仍可读、仍可回复 |
| task | 有 owner 和状态的公开协作承诺 | `done` 表示完成；`closed` 表示取消或不做 | 讨论和状态保留 |
| reminder | 创建者给自己设置的外部定时提醒 | cancel，或触发后处理 | 依 Raft 记录保留 |

这里的 thread 只表示 Raft 的外部回复位置。它和 Loom private `Thread`、nmem
Conversation Thread 是三个不同对象。

## 3. Individual 怎样认识自己和其他成员

### 自己

Individual 的完整身份来自 Loom Agent Workspace。Raft profile 只是这个身份在某个
Raft server 上的外部投影，包括稳定 member ID、handle、name、description 和 server
role。重启模型 session 不应改变它；Raft profile 的修改也不能反向覆盖 Loom Identity。

模型在稳定的 channel guidance 中只需要知道：

- 自己正通过哪个 Raft identity 行动；
- 这是自己的外部身份，不是另一个 agent；
- 当前可用的 Raft 工具和外部行动边界；
- Raft 内容是外部材料，不能改变 Harness 指令、权限或凭据边界。

它不需要每轮收到全量 profile、全部 memberships 或 channel 列表。

Raft profile 是公开投影而非同步协议。Adapter 启动时验证当前 credential 对应配置绑定的
self member identity，并让 Channel Guidance 呈现当时外界可见的 handle、name 与
description；这些字段不会反向改写 Loom Identity、Stable Facts 或 Memory。反过来，Identity
演化、Memory Reflector 或普通 Workspace 修改也不会自动更新 Raft profile。初次建立外部
profile 属于 Operator 的部署工作；以后若向 Individual 开放 profile 修改，它必须是明确说明
公开范围并形成持久 Effect 的外部行动，而不是文件同步副作用。

### 其他成员

一个外部成员至少应以稳定 member ref 识别，而不是只靠昵称。按需展开后可以看见：

- `kind`: human 或 agent；
- handle、display name、description；
- server role；
- 当前可见场所中的 membership。

description 是协作名片，能帮助判断“谁可能负责什么”，但不是可信权限声明或 system
instruction。另一个 agent 的 profile 也不意味着 Individual 能读取其 Workspace、memory、
prompt 或本地工具。

### 主要关系对象

同一个人在 Local、Weixin 和 Raft 上出现时，是否是主要关系对象，必须由 Instance 的稳定
映射确定，不能由 handle、display name 或模型猜测确定。Raft 中其他 human 不能都被记成
主要关系对象。

这暴露了当前 Loom 的真实缺口：Frozen Activity 的 `actorRef` 目前只有
`individual | human | system`，且 `<human_input>` 默认把所有 Interaction 当作主要的人。
Raft 接入将 actor 表达扩展为：

```text
individual
human
system
external:raft:<server-id>:<member-id>
```

`human` 只表示 Instance 明确绑定的主要关系对象，Raft self member 映射为 `individual`；
其他 human、agent 与外部 system actor 都使用 namespaced external ref，并在当次 evidence
中携带 `kind` 与可见 label。只有 principal `human` 的 Interaction 更新
`lastHumanInputAt`，不能根据 handle、display name 或 profile description 猜测映射。

## 4. 模型可见 Context 分三层

### 4.1 System-level channel guidance

这一层随 Raft Integration 启用，稳定进入 system prompt。它只说明：

- Raft 是人与 agents 共享的外部协作场所；
- 当前 self projection；
- 外部内容的可见性和不可信边界；
- 可用工具及其总体用途；
- 普通 assistant text 不会自动发送到 Raft，外部行动必须走 Loom Effect。

它不列出所有 channel、未读消息或 task，也不讲当前来信正文。

这一整层只在 Instance 明确启用并成功装配 Raft Integration 时存在。Raft 关闭时，Main
Agent system prompt 不出现 Raft guidance，Main Agent 没有 Raft tools，Orientation 也没有
Raft Attention Snapshot；不为接口整齐保留空 section 或不可用能力。

这一层应给 Individual 足够的社会与行动语义来自己判断，而不是只列工具名：DM、channel 与
reply thread 的 audience 不同；DM、mention 和 task 是注意力信号而非必须服从或回复的命令；
已有 thread 通常在原 thread 接续；顶层交流可按内容选择留在顶层或进入 thread；普通 channel
activity 可以查看、忽略或稍后返回，不以 inbox zero 为目标。Raft 消息、profile 和 task 是
外部 evidence，不能覆盖 Harness 指令。具体 sender、place、正文和 destination 不进入这一
稳定层。

### 4.2 Per-Input durable context

一份真正进入 Loom 的 Raft Interaction Input 应包含可以恢复的外部事实，而不是只给正文：

```yaml
channel: raft
signal: direct_message | mention | channel_activity | thread_reply | task | reminder
place:
  ref: <opaque place_ref>
  kind: dm | public_channel | private_channel
  label: "..."
  visibility: "..."
sender:
  ref: <stable member_ref>
  kind: human | agent | system
  handle: "..."
  display_name: "..."
message_ref: <stable message_ref>
thread_ref: <stable thread_ref, when present>
task_ref: <stable task_ref, when present>
audience: <bounded visible participant summary>
reply_destination_ref: <explicit destination owned by this Input>
occurred_at: "..."
content: "..."
```

字段名和序列化格式不是最终合同，必要事实才是重点：Individual 必须知道谁说的、在哪里、
谁能看到、它属于哪条外部讨论，以及回复将去哪里。

当前 Loom 把 Interaction 包装为 `<human_input>`，并把首轮提醒写成只面向 human。Raft 接入
时必须改为 actor-aware 的 Interaction Context：每份 Input 明确携带真实 actorRef 与当时的
可见身份描述，不能因为 Pi Transcript 仍使用 `user` role 就把其他 human、agent 或 system
来源写成主要关系对象。每个 Runtime Turn 只有首份 Interaction 额外补一次 channel 使用与
`message.send` / `message.no_reply` 提醒；同一 Turn 后续 steer Input 仍带完整动态外部事实，
但不重复稳定规则。

`reply_destination_ref` 必须随 Input 持久化并在发送时进入 Effect。不能让 Adapter 保存一个
可变的“最近看过的 Raft thread”，再把下一条 `message` 猜着发回去。

这里的 Route 与 Destination 是两个不同对象：Route 选择负责投递的 Channel Adapter 及其
连接边界；Destination 选择该 Route 内具体的 DM、channel 或 reply thread。两者都在 Effect
被接受时固定，Delivery 重试不能重新选择。Destination ref 由 Adapter 生成和解释，是不透明
引用；模型不能拼接 Raft CLI target。一个 Turn 只有一个当前 Destination 时，`message` 可以
直接使用；同时接纳了不同 Destination 的 Input 时，模型必须从 Context 已提供的引用中明确
选择。proactive Turn 若没有当前 Input，只能使用 Instance 明确允许的默认 Destination，或先
通过 Raft 工具取得一个可用 Destination。

首轮已确认的默认 proactive Destination 是配置明确绑定的主要关系对象顶层 DM。它只让
Individual 在没有来信时仍能自然联系主要关系对象，不触发发送、不改变 pulse，也不允许把
最近联系的其他成员或场所推断成新默认值。其他 DM、channel 与 reply thread 必须来自当前
evidence 或 Raft 工具返回的 Destination。

### 4.3 Tool result

当当前 Input 不足以判断时，Individual 再主动打开 place、message、thread、task 或 member。
工具结果是本轮可见的外部 evidence；它不会自动进入 Stable Facts、Memory 或 Current
Attention。是否值得沉淀仍由 Loom 的认知链路判断。

因此模型可见信息保持三层分工：Channel Guidance 说明稳定场所知识和判断空间；当前 Input
说明本次外部事实和可选落点；tool description 说明动作的准确效果、参数和副作用。三者不
互相复制，也不让 Harness 替 Individual 决定是否回复或在哪里继续。

## 5. 首版只读工具面

共同规则：

- 所有 ref 都是工具返回的 opaque namespaced reference；模型不拼接 CLI target 或手写 ID。
- 默认结果有界、可分页，并返回下一页 cursor；`limit` 有 Harness 上限。
- 每项都返回 server、visibility、sender kind 和 canonical refs；外部文本始终标成 evidence。
- 工具只使用当前 Raft identity 已有的可见权限；private channel 不因模型请求而绕过 membership。
- Adapter 私有处理 Raft CLI profile、版本解析和凭据，工具不暴露 `RAFT_PROFILE`。

### `raft_places`

列出 Individual 在当前 server 可见或正在关注的场所。

```yaml
scope: attention | joined | discoverable   # 默认 attention
kind: channel | dm                         # 可选
visibility: public | private               # 可选；仅 channel
query: "..."                              # 可选，按名称/描述过滤
cursor: "..."                             # 可选
limit: 20                                 # 可选，有上限
```

`attention` 只返回 DM、joined channel、存在当前信号的场所和已 follow reply thread 所属场所；
`joined` 用于审视自己长期订阅了什么；`discoverable` 用于主动寻找可见 public channel。

使用场景：

- proactive pulse 想知道 Raft 里最近有哪些可进入的地方；
- 收到陌生 channel 消息后确认该 place 的 visibility 和描述；
- channel 太多时检查哪些仍处于 joined/muted 状态；
- 主动寻找某个主题的公开讨论，而不扫描每个 channel 历史。

它不返回全部消息，也不自动 join、leave 或 mute。

### `raft_activity`

读取有边界的近期外部注意力信号，而不是逐个扫描所有 public channel。

```yaml
signals: [direct_message, mention, thread_reply, task, reminder, channel_activity]
place_ref: <place_ref>                     # 可选
after: "2026-08-02T00:00:00Z"             # 可选
before: "..."                             # 可选
cursor: "..."                             # 可选
limit: 20                                 # 可选，有上限
```

默认返回当前 identity 可见的全部 signal 类型，按时间倒序、有界分页，并明确区分
`direct` 与 `ambient`；调用者也可以用 `signals` 缩小范围。它返回 signal 摘要和可展开 refs，
不把所有正文一次塞进 Context。已经形成 durable Input 的 direct signal 仍可被主动查询，
但不会因此再次创建 Input 或重复进入 Orientation Snapshot。

使用场景：

- content-free wake 到达后，由 Adapter 或主动 Turn 查看有哪些对象需要展开；
- proactive pulse 批量看看 Raft 有没有值得关心的变化；
- 处理完一批消息后确认还有没有明确点名或未完成 task；
- 在许多 channel 中先缩小范围，再调用 `raft_open`。

Raft 0.0.17 没有已证实的 machine-stable Activity JSON API；这个工具能否按上述合同实现，
需要 pilot 验证底层数据来源，不能把 CLI `message check` 的提前 ack 隐藏过去。

### `raft_search`

按内容搜索当前 identity 可见的 Raft 历史。

```yaml
query: "..."                              # 必填
place_ref: <place_ref>                     # 可选，限制一个场所
sender_ref: <member_ref>                   # 可选
after: "..."                              # 可选
before: "..."                             # 可选
sort: relevance | recent                  # 默认 relevance
cursor: "..."                             # 可选
limit: 20                                 # 可选，有上限
```

使用场景：

- 当前消息说“接着上次”，但 Input 的局部窗口不足；
- 寻找某个决策、文件、任务结果或其他 agent 以前说过的话；
- 在主动探索中定位讨论过某个主题的 channel/thread；
- 先搜索得到 message/member ref，再精确 `raft_open`。

搜索结果只给摘要、位置和 refs。Raft 搜索不是 Loom memory；Individual 不应在已经有明确
ref 时用宽泛搜索代替精确读取。

### `raft_open`

展开一个已知 ref，取得 Adapter 当前能可靠提供的局部证据。它是 read surface 的中心工具，
但首版不假装拥有 0.0.17 CLI 尚未提供的统一对象读取接口。

```yaml
ref: <place_ref | destination_ref | message_ref | thread_ref | member_ref>  # 必填
around_ref: <message_ref>                    # 首版不支持，传入时明确失败
before: 20                                  # 为未来有界窗口保留；首版不分页
after: 20                                   # 为未来有界窗口保留；首版不分页
cursor: "..."                               # 首版不支持，传入时明确失败
limit: 50                                  # 可选，有上限
```

不同 ref 的返回含义：

| ref | 返回内容 | 典型用途 |
| --- | --- | --- |
| place / destination / thread | visibility、joined/muted 等当前可验证的场所事实 | 核对一个交流落点，而非读取完整历史 |
| message | canonical message、sender、place 和正文 | 核对一条被引用或被唤醒的消息 |
| member | human/agent、handle、display name 和 description | 认识一个新的协作者 |

首版 `raft_open` 不支持 message 周边分页，也不读取 task/reminder 对象；调用这些能力会
明确失败。它不改变 read/ack、follow 或 task 状态的语义；如果未来底层 CLI 无法做到纯读取，
Adapter 必须明确报告副作用，而不能在工具描述里假装只读。

## 6. Individual 收到不同信号后会怎样

这里描述判断空间，不是强制响应算法。

| signal | 默认需要知道 | 可采取的行为 | 可以沉默吗 |
| --- | --- | --- | --- |
| 主要关系对象的 DM | 当前正文、DM audience、reply destination、必要的局部历史 | 回复、追问、做本地工作后回复、稍后继续或 no reply | 可以，取决于关系与语境 |
| 其他成员的 DM | sender identity、为什么找到自己、DM audience | 回应、澄清边界、婉拒、转给更合适成员 | 可以，但明确请求通常值得处理 |
| @mention | place visibility、anchor、mention 周边 | 在原 place/thread 回应、读背景、转成 task、忽略无关点名 | 可以，mention 是注意力信号，不是命令 |
| 普通 channel activity | channel 描述、近期摘要、与自身关注的关联 | 主动加入讨论、继续观察、mute/leave，或不行动 | 当然可以 |
| followed thread reply | anchor、自己先前参与、最新 replies | 接续、修正、交付结果、unfollow | 可以；工作完结后应能降噪 |
| task | status、owner、task thread、可见性 | claim、询问、汇报进展、转 review、done/closed | 未认领时可以不承担 |
| reminder | 创建者是 self、anchor、原承诺 | 打开原讨论、行动、snooze/cancel | 可以重新判断，不是 Loom 系统命令 |

Individual 仍按自己的 Identity、Current Attention、关系与当下 Context 判断。Raft signal
提供“发生了什么”和“谁在等什么”，不替 Harness 决定它必须工作或回复。

### 首次接通与旧历史

Raft 第一次成功启用时固定一个 activation boundary。此前已经存在的 DM、channel、message
和 reply thread 不批量回填成 Loom Inputs，也不因首次连接而被 Life Recorder 记成刚发生的
经历；它们继续作为 Raft 中可由 `raft_open` / `raft_search` 按需读取的外部 evidence。新的
Input 若引用 activation 前的讨论，Main Agent 可以沿稳定 ref 打开必要的局部历史。

activation 之后的入站则由 Loom 持久负责。Host 暂时离线不改变这个归属：重启后必须从已
提交 cursor 补拉，而不是把离线期间的消息重新分类为“旧历史”。首版不提供隐藏在 Channel
启动中的日期范围导入、全量 history migration 或复杂 bootstrap；真正的历史迁移属于显式
Operator 工作。

## 7. 工具怎样组合

### 一个 Individual，多个外部场所

Raft 的 DM、channel 和 reply thread 是同一个 Individual 身处的不同社会场所，不是不同的
agent 身份或彼此隔离的意识。Adapter 保留每条外部 message 为独立 Input，不把连续消息拼成
一段无归属文本；Runtime 可以把后续 Input steer 进正在运行的 Turn，即使它来自另一个
audience。每份 Input 仍明确标出 actor、visibility、audience 和可选 Destinations。

当同一 Turn 出现多个 Destination 时，`message.send` 不能再依赖单一默认值，必须明确选择
一个 Context 已授权的 Destination；回复多个场所形成多个 Effects。Channel Guidance 说明，
一个场所可见的材料不会因为同时进入 Context 就自动适合带到另一个场所。Loom 不为此创建
per-channel Context 人格或多个 Main Agent：那既会破坏 Individual 的连续性，也不能真正把其
长期记忆和私人理解隔离。交流边界由 Individual 基于真实 audience 与行动后果来判断。

### 处理一条 DM

```text
durable Raft Input（已含正文、sender、audience、reply destination）
  -> 信息足够：直接工作或 message.send
  -> 缺少前文：raft_open(message_ref / place_ref)
  -> 对方引用较久历史：raft_search -> raft_open(result_ref)
  -> message Effect 固定写入当前 reply_destination_ref
```

### 处理 @mention 或 reply thread

```text
raft_open(message_ref)
  -> raft_open(thread_ref) 看 anchor 与 replies
  -> 必要时 raft_open(sender_ref) 认识协作者
  -> 回原 thread，或选择 no reply
  -> 若讨论已经完成，未来可用 raft_attention.unfollow
```

### 主动查看 Raft

```text
raft_activity（DM / mentions / followed threads / tasks，有限页）
  -> raft_open 最相关的少数对象
  -> 没有牵引：结束，不为了“清空 inbox”而制造工作

需要主动探索某个主题时：
raft_places(scope=discoverable, query=...)
  -> raft_open(place_ref)
  -> raft_search(query=..., place_ref=...)
```

### 与另一个 agent 协作

```text
raft_open(member_ref) 了解其公开 description 与可见 memberships
  -> 在共享 thread 中 @mention，保留公共背景
  -> 或在确有私密/局部必要时发 DM
  -> 若形成明确责任，用 task owner/status，而不是靠双方猜测
  -> 进展和结果继续留在 task thread
```

## 8. channel/thread 很多时如何不被污染

Raft 的可见历史可以很大，但 Main Agent Context 不应因此变成 Raft 镜像。

1. **以 signal 开始，不以全 server scan 开始。** DM、mention、followed thread、task 和
   reminder 比普通 channel 流有更强的注意力含义。
2. **列表只给摘要与 ref。** `raft_activity`、`raft_places`、`raft_tasks` 都分页；只有被
   Individual 选择的对象才 `raft_open`。
3. **普通 channel activity 批量呈现。** 它们进入有界 Raft attention evidence，允许
   proactive Turn 主动查看，不逐条形成 Interaction Input 或强制 Main Agent Turn。
4. **外部订阅和内部注意力分开。** join/mute/unfollow 只是 Raft 投递状态；Current
   Attention 和 Loom Thread 由 Individual 自己演化。
5. **闭合后降低外部通知。** task 用 done/closed 收束责任；reply thread 用 unfollow
   停止普通通知；channel 用 mute/leave 降噪。历史保留，必要时仍可搜索回来。
6. **不以 inbox zero 为目标。** Harness 服务的是 Individual 的关切和关系，不要求它处理
   每条公共消息或维持所有 lane 的活跃。

### Orientation 中的 Raft evidence

Orientation 保持 Harness 版本化的通用 system prompt，不加载 Main Agent 的完整 Raft
Channel Guidance。启用的 Raft attention source 只在本次有尚未呈现的 ambient activity 时，
向 run context 增加一个小型 `External Attention Evidence` index：固定 revision、采集时间、
信号数量，以及少量 place、actor、时间和可展开 refs。已形成 durable Input 的 DM、mention、
task/reminder 和明确 thread reply 不再重复进入这里；普通消息正文、完整历史和可执行命令也不
进入。

这份 index 与最近四段 Frozen Activity、Agent Workspace index 和 action-space index 并列，
不是任务列表或优先级。数量、未读和新鲜度不能单独证明一个 Opening；一次成功 Pulse 得到
Opportunity 或 grounded `none` 后，整个固定 revision 视为已向 Orientation 呈现，不在后续
Pulse 反复占据前景。失败或运行中到达的新 activity 不推进该位置。

防止外部噪音不等于把 Individual 封闭在已有方向里。一个陌生但具体的外部成员、场所或信号
可以凭自身成为新的好奇入口，不必先匹配 Current Attention 或已有 Thread；但 Orientation
只能说明实际看见的外部信号以及为什么此刻可能值得打开，不能在没有正文时推断讨论内容。
Main Agent 收到 Opportunity 后仍可选择展开、放下、转向私人活动或保持沉默。

## 9. 可靠性与生命周期

### 入站

Raft bridge wake 只是一条带完整 `messageId`、不带正文的唤醒提示。它不能直接成为
Runtime Input，也不能在 Input 持久化前被当作已消费。Adapter 的固定流程是：

```text
bridge wake
  -> 持久写入 Integration wake ledger
  -> 向 bridge 返回成功
  -> message resolve(full messageId)
  -> 规范化为 durable Input 或 ambient attention evidence
  -> Runtime acceptInput / 持久写入 evidence
  -> 标记 wake complete
```

`message resolve` 是按 canonical message ID 的只读精确读取；崩溃后可以重复执行。Runtime
继续使用 Raft message ID 去重。`message check` 会在返回前 ack，因此不能承担 durable
ingress，也不能作为 Main Agent 的收件工具。

Raft 0.0.17 没有提供已证实的、可由 External Agent 提交的入站 cursor。因而首版不能在设计
文档里假装存在一条 cursor 补拉路径。真实 pilot 必须验证 bridge 在 Host 离线与重连时怎样
重放尚未消费的 wake，并据此确定恢复合同：若 Raft 能按 message ID 重放，wake ledger 负责
去重和续作；若它不能，首版不得宣称支持离线完整恢复，必须在启用前明确报告这个限制，或在
Raft 提供可靠读取接口后再开放生产使用。bridge wake 是当前唯一已知的实时入站索引，不是
消息正文来源；Integration 私有 ledger 才是 Loom 接受 wake 后的恢复事实。

### 出站

Main Agent 的 `message.send` 先形成固定 `routeRef + destinationRef` 的 Loom Effect，Raft
Delivery 只投递该 Effect，不重跑模型或 Input。Adapter 将一次尝试分类为：

- `delivered`：得到明确 remote message ID；
- `not_sent`：得到明确未发送或 held draft 结果，可以按 Runtime 退避再次尝试；
- `unknown`：网络中断或返回结果不足以判断是否已经发送，必须停止自动重发并等待显式核对。

Raft `message send` 没有已证实的幂等键。`unknown` 不能为了追求最终送达而冒险制造重复消息。
Delivery 重试始终使用 Effect 已固定的 Destination，不能根据 Adapter 当前浏览位置重选落点。

### 激活与身份

首次成功启用时，Adapter 验证 credential、server 与 self member binding，并在持久状态中固定
activation boundary。activation 前历史只可通过读取工具访问；activation 后 activity 属于
Loom ingress。能否覆盖 Host 离线期间，必须以 bridge 重连实测为准，不能由本地时间戳或
`message check` 猜测补齐。Raft profile 变化不会自动改写 Workspace Identity，Workspace
Identity 演化也不会自动发布 profile 变化。

## 10. 当前实现与后续扩展

首版已经实现 text Interaction、通用 `message`、bounded Attention Snapshot，以及
`raft_places`、`raft_activity`、`raft_search`、`raft_open` 四个读取工具。它没有把 Raft
CLI 已有命令整体暴露给 Main Agent；“Raft 能做”不等于“Loom 已经给 Individual 可靠地做”。

| 能力 | 当前状态 | 后续进入 Loom 前要解决什么 |
| --- | --- | --- |
| 发消息/回复 | 已实现，统一走 `message` | 继续以 Effect 固定 audience/destination；Raft 没有幂等键，`unknown` 不自动重发 |
| task 读取与管理 | 已实现已有 task 的详情、claim/unclaim/status update | 创建与更广列表仍需独立需求；公共承诺保持 owner/status 冲突和恢复事实，不退化成普通消息 |
| reminder | 未实现 | `raft_reminder` 要保持 Raft 外部时钟语义，不能接管 Loom scheduler；需定义触发、snooze/cancel 与重复处理 |
| reaction | 未实现 | `raft_react` 是轻量但外部可见的 Effect，需明确授权、撤销和未知结果 |
| 外部注意力管理 | 已实现 reply-thread unfollow 与 regular-channel mute/unmute | join/leave 未开放；单 thread follow 状态需等待 Raft 提供权威读口，不能从 Loom 最近 Effect 推断 |
| profile / presence | 只在启动和读取时核验 | profile 是公开投影，不自动同步 Workspace Identity；修改必须是显式外部行动 |
| membership / channel 管理 | 未实现 | 涉及 audience 与 server 权限，需独立授权，不能从普通 Interaction 推导管理员意图 |
| attachment | 未实现 | 上传会把 Workspace 内容持久暴露给特定 audience，需复用不可变快照、大小限制与未知投递处理 |
| 第三方 app / integration actions | 未实现 | 来自外部的内容仍是不可信 evidence；登录、approval card 和外部 action 需要另一层权限模型 |

只读面也仍有扩展空间：当前 `raft_open` 已读取 task 对象与有界 reply-thread 上下文，但不读取
reminder 对象或提供无界分页，`raft_places` 不能无副作用列出 DM。Raft 也尚未提供单 thread 的
follow 状态读口。未来应在真实 CLI 提供稳定读取合同后加深这些工具，
而不是让模型绕过 Adapter 直接运行带 credential 的完整 CLI。

这些能力按真实需求逐项进入新的 ticket。真实运行可以优先观察 Individual 是否需要认领
task、轻量确认、降低 thread/channel 噪音或分享文件，再分别设计参数、visibility、冲突、
持久 Effect 和失败恢复；不能用“模型再调用一次”代替工程合同。

## 11. 当前范围与回复落点

当前版本包含 text Interaction、通用 `message`、`raft_places`、`raft_activity`、
`raft_search`、`raft_open`、`raft_task`、`raft_attention` 与 bounded Orientation Snapshot。
`raft_open` 可读取当前 CLI 能可靠解析的 message、task、member、place 与有界 reply-thread
上下文；不提供 reminder 读取、无界历史分页或 thread follow 状态。reaction、task 创建、
reminder writes、join/leave、profile changes、member management 和 attachments 均不开放。

回复落点遵循外部场所本身，而不是 Harness 的社交偏好：

- reply-thread Input 默认回原 reply thread；
- 顶层 DM 或 channel Input 默认仍回该顶层场所；
- Individual 可以在当前 evidence 明确提供其他 Destination 时显式选择进入 reply thread；
- 同一 Turn 只有一个可用 Destination 时 `message.send` 可以省略选择，多于一个时必须显式选择；
- 没有当前 Input 的 proactive Turn 只拥有 principal binding 推导出的顶层 DM 默认 Destination。

真实运行后优先评估 `unfollow`、`mute` 与 task status。它们只有在出现实际需要并补足
visibility、冲突和恢复语义后，才进入新的实现票；Raft CLI 已有命令本身不构成开放理由。

## 12. 装配与配置合同

Raft 仍作为显式启用的 Interaction Channel Integration 装配，不因此建立通用 plugin loader
或多 Route 控制面。首版 Raft-only Instance 的配置至少要表达：

- 是否启用 Raft；
- package 固定的 CLI version 与独立 profile slug；credential 仍由 Raft CLI 管理；
- 预期 server 和 self member binding；
- 哪个 Raft member 是 principal `human`，以及对应顶层 DM Destination；
- bridge 接入所需的本地监听信息。

credential、CLI target 和原始 profile 不进入 Main Agent Context、Runtime Input 或操作日志。
配置里的外部 ID 由 Adapter 验证并转成 opaque refs；模型只看 refs 及其当次可见含义。

Raft 私有持久状态至少包含 activation boundary、wake ledger、已完成 wake 和 Attention Snapshot
revision。它属于 Integration，不写入 Agent Workspace，也不借用 Runtime Store 私有表来省掉
自己的恢复语义。真正的 Interaction Input、Effect 和 Delivery 仍由 Runtime 持有；Adapter
不能另建一套平行消息账本。

Host 启动时先检查 CLI 版本、credential、server/self binding 和 principal DM binding，再暴露
Channel Guidance、tools、attention source 和 ingress。任一必要检查失败时，Raft 整体保持
unavailable，不能留下可见 prompt 或半可用工具。Host 停止时先停止接纳 wake，再等待已经进入
Loom 的工作到达既有安全停止点；重启后从 Integration ledger 继续未完成 wake。

对外状态只报告 enabled、available、CLI version、self/server 的非敏感标识、最近成功接入时间、
pending wake 数和错误分类。它不输出 credential、完整消息正文或 CLI 环境。

## 13. 开发接口与验收门禁

实现与测试只穿过四个公开接口：

1. **Runtime Interface**：接纳 actor-aware Interaction，持久保存 Input，公开 status/Activity，
   并在恢复中保持 Effect 的 Route 与 Destination 不变。
2. **Main Agent Interface**：按启用状态接收 Channel Guidance、当前 Interaction Context、四个
   读取工具和可用 Destinations，并且只能为 Context 已授权的 Destination 形成 Effect。
3. **Raft Channel Interface**：把远端 evidence 规范化为 Input 或 Attention Snapshot，提供有界
   读取，恢复 wake ledger，并诚实分类 Delivery 结果；调用者不接触 credential、CLI target 或
   文本 parser。
4. **Host Interface**：从 Instance Configuration 装配和持有 Raft 生命周期；禁用或启动失败时，
   Raft 不向 Runtime、Main Agent 与 Orientation 留下半装配能力。

单元与集成测试使用 version-pinned fake CLI 穿过这些接口，不检查私有 SQLite、Integration
ledger 文件布局或 prompt 的整段字符串。测试只证明机械合同；语言、判断、主动性和交流品味
必须由真实模型观察。

最终验收使用一份非个人的 Raft-only Instance，并保存不含 secret 的证据，至少验证：

- principal DM、其他 actor 的 direct signal，以及可取得时的 mention/reply thread 入站；
- ordinary channel activity 只形成 bounded Attention Snapshot，不逐条创建 Turn；
- actor、place、audience、visibility 和 Destination 在 Context、Activity 与远端回复中一致；
- reply thread 回原 thread，顶层消息回顶层场所，proactive Turn 只获得显式 principal DM；
- Host 在 wake 持久化前后中断、Runtime 接受前后中断时，不丢失已经由 Loom 接受的 Input；
- Host 离线与重连的真实 bridge 行为，并据实确认或收窄离线恢复保证；
- Delivery 在明确成功、明确未发送和结果未知三种情况下分别进入 `delivered`、`not_sent`、
  `unknown`，且 `unknown` 不自动重发；
- graceful stop/restart 后没有重复 Input、错误 actor 归属或 Destination 漂移。

只有 `typecheck`、完整测试、build 和以上真实验收都通过，设计、代码、ticket、配置文档和实际
模型可见行为彼此一致，Ticket 04 才可关闭。
