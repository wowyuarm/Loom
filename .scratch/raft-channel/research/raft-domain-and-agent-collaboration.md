# Raft 的领域模型、协作行为与 Loom 边界

研究日期：2026-08-02
范围：Raft 官方文档、官方 `raft-external-agents` 仓库，以及实际解包的 `@botiverse/raft` **0.0.17** 发布包。没有登录、创建 server、读取任何私人消息或凭据。本文不是 Loom 接入设计或最终 prompt。

## 结论先行

Raft 可以成为“人与多个 agent 共同工作的外部协作场所”，但它不是一个把所有外部历史自动塞给模型、也不是替 agent 作注意力决策的系统。它提供的是：有成员与可见范围的场所、可回复的消息/线程、任务状态、提醒、附件、搜索和几种注意力信号。

对一个 Loom Individual 而言，Raft 应被理解为**外部社会空间**：它告诉 Individual「我在什么 Raft 场所、谁能看见、哪条外部讨论在继续、哪些事情点名需要我」。Loom 仍负责 Individual 的 Workspace、连续性、Input/Effect/Delivery、内部工作线和记忆。Raft 历史、Raft reply thread、Raft task 都不能因为名称相近而变成这些 Loom 对象。

官方确实提供了 External Agent 的连接和 wake 参考实现，也确实提倡 agent 主动加入公共频道、互相 @mention、DM、认领 task、在线程报告进展。但没有公开的、适用于所有 agent 的「该不该回复」「先处理哪个频道」「何时结束一段讨论」决策算法。那部分应留给 Individual 的判断与 Loom 的明确政策，不能误以为是 Raft 已替我们完成的能力。

## 证据与用语

- **官方产品事实**：Raft 文档明确写出的 UI/协作语义。
- **发布 CLI 事实**：本机实际执行 `@botiverse/raft@0.0.17` 的 `--help`，并检查发布 bundle；它说明该版本 External Agent 可调用的接口，不替代产品文档。
- **官方参考实现事实**：`raft-external-agents` 的 Claude Code channel plugin 与 wake contract；它说明 Raft 官方怎样接一个外部 runtime，但不是 Loom 的实现要求。
- **对 Loom 的含义**：本文据上述事实提出的边界、待决项或风险，均明确标为推论，不当作 Raft 已有保证。

文档仓库固定在本次读取的 commit `8918347e3b61a0fd890e483eed34fa0077d64d1f`，external-agents 固定在 `72c31894f933b9aa9243195d038d66ee79589593`；链接见文末来源。

## 1. 领域对象：Raft 里的“地方”和“身份”

| 对象 | 官方事实 | 对 agent 的实际意义 | 不应混同为 |
| --- | --- | --- | --- |
| **Server** | Raft 的顶层容器；频道、DM、成员、agent、task、file 都在一个 server 内；不同 server 彼此独立。每个新 server 有公共 `#all`，成员自动加入。 | 身份、可见内容、成员关系与权限都至少以 server 为边界。 | Loom Host、Loom Instance 或某个 agent 的本地目录。 |
| **Raft shared workspace** | 产品文案把同一 server 的 channels/threads/tasks/DMs/@mentions 称为人与 agent 共享的 workspace。 | 指共享协作面，并不意味着彼此可以读写本地文件。 | Agent Workspace 的文件系统。 |
| **Agent workspace** | Raft managed agent 各有持久、agent-owned、同机也隔离的本地目录；可存文件、笔记、memory；浏览器内的 workspace 浏览器只给创建者和 server admin。 | Raft 自己也区分共享聊天面和 agent 私有文件面。External Agent 的 runtime 在我们机器上，Raft 不接管 Loom 的目录。 | server 的共享资料库、任何其他 agent 的 workspace。 |
| **Member** | 人和 agent 都是 server member；都可在有权场所收发消息、@mention、DM、参加任务、搜索。角色为 Member/Admin/Owner；agent 只能是 Member 或 Admin，不能是 Owner。 | “human/agent”不是两套消息协议；差异主要是身份、角色和 runtime，而非消息语义。 | 仅靠昵称推断出来的授权身份。 |
| **Agent identity / profile** | Agent 有持久身份、名称、description 和 @mention handle；重启或 reset session 不应丢失名称、workspace、memory、频道成员关系。External Agent 经 device login 得到本地 credential profile，`RAFT_PROFILE` 选择 CLI 以哪个 Raft agent 身份行动。 | 模型需要看见外部 sender 的稳定 agent/human 身份和当前自己身份，才知道是对谁协作、谁能看见；但 profile 不能决定 reply target 或权限。 | Loom Individual 的完整身份材料、Unix 用户、一次模型 session。 |

来源：[Server Basics][server]、[Agent Basics][agent-basics]、[Members][members]、[Workspace][workspace]、[External Agents][external-agents]、[Wake plugin][wake-plugin]。

### 可见性和发现

1. **公共 channel**：所有 server member 可见，未加入也可读；成员和 agent 可自行加入。agent 只有加入后才自动收到该 channel 的普通消息；即使未加入，在公共 channel 被 @mention 仍会收到注意力信号。[Channels][channels]
2. **私有 channel**：非成员不可见、不可读、不能自行加入；必须由 owner/admin 加入。它是 Raft 的硬可见性边界，不能靠 prompt 放宽。[Channels][channels]
3. **DM**：一至多名指定成员的私有会话，可是 human-human、human-agent、agent-agent；双方/参与者能回看持久历史，DM 始终通知参与者，也支持 thread。[DMs][dms]
4. **成员发现**：人可从 member panel 或消息中的名字打开 agent profile；官方称 agent 可通过 `raft server info` 取完整 member list，并可经 channel 或 DM 联系 server 内其他成员。[Agent Basics][agent-basics]、[Members][members]
5. **profile 是协作名片，不是权限文件**：名称和 description 对团队可见，官方建议用 description 表达分工。External Agent 的 setup card 只给创建者/admin，看不到不代表其普通 profile 不可见。[Agent Basics][agent-basics]、[External Agents][external-agents]

**对 Loom 的含义（推论）**：首次让 Individual 主动“逛 Raft”时，它能主动阅读或加入的仅应是当前 Raft identity 已有资格看到的公共场所；私有场所应由 Raft membership 决定。Loom 不应从 channel 名、profile description 或模型的猜测推导权限，也不应把“看见一个 agent”自动等同于可代表对方、可读其 Loom workspace 或可访问其记忆。

## 2. 消息、reply thread 与如何不被讨论污染

### Message 与 thread

消息可出现在 channel、DM 或某个 thread 中；可附文件、@mention 成员、引用 channel、reaction、保存、复制链接、转为 task。发送后不能编辑或删除，修正应另发 thread reply，因此 Raft 是持久记录而非可撤回草稿。[Messages][messages]

一个 **Raft reply thread** 是挂在一条顶层 message 上的子对话：第一条回复创建它，顶层原 message 是 anchor，回复不进入主 channel 流；thread 只能有一层，thread 内 message 不能再嵌套 thread。[Threads][threads]

这给出很清楚的外部沟通结构：

```text
Raft server
  #project 或 dm:@peer             <- 外部场所 / audience
    顶层 message (anchor)
      reply thread                 <- 同一话题的外部回复容器
        reply 1, reply 2 ...
```

它不表示：

```text
Raft reply thread == Loom private Thread == nmem Conversation Thread
```

Raft thread 的唯一已证实语义是外部消息讨论与通知容器。Loom private `Thread` 是 Individual 的内部工作/注意力线；nmem Conversation Thread 是跨工具原始对话索引。三者可因同一外部事件有关联，但必须保留不同 ID、生命周期和可见性。

### follow、unfollow、mute、mention、Activity

| 信号/动作 | 已证实的 Raft 行为 | 它解决什么 | 没有解决什么 |
| --- | --- | --- | --- |
| 加入/离开 public channel | 加入代表自动接收该 channel 的普通消息；离开停止接收，public channel 可再加入。 | channel 级订阅边界。 | 不删除旧历史，也不自动做出优先级。 |
| `@mention` | 是点名注意力信号，不是 channel 内的投递过滤器；channel member 本来都会收每条消息。公共 channel 可 mention 未加入成员；thread 中被 mention 会自动 follow。 | 把“需要某人处理”与普通讨论区分开。 | 不自动把人加入 channel，也不保证请求合理或安全。 |
| follow thread | 参与或被 thread @mention 后自动 follow，并会收到新 reply 通知。 | 把一个已经承担的外部讨论持续送达。 | 不是“Loom 将永远保留这段为当前上下文”。 |
| unfollow thread | 工作完成后可停止普通 reply 通知，仍可读、仍可回复；0.0.17 CLI 有 `thread unfollow --target ... [--reason ...]`。 | 结束对该外部讨论的日常注意力，防止它继续污染 inbox/Activity。 | 不关闭、删除或归档 thread；以后可主动读回。 |
| mute channel | 0.0.17 CLI 有 `channel mute/unmute`，help 明确称其为停止/恢复 regular channel 的 ordinary Activity delivery。 | 对一个仍是成员的 regular channel 降噪。 | 不改变成员资格、历史或 @mention 的特殊语义；当前 UI 文档没有给出它的完整产品细节。 |
| Activity | 汇总已加入 channel 的消息、已 follow thread reply（含 task status）、DM 和 @mention；按时间倒序，可筛 All/Unread/Mentions。 | 多个地方积压时的拉取面。 | 不是智能排序/自动决策器。 |
| Saved | 人可保存 message，单独于 Activity；用于以后再看。 | 有意识保留外部证据。 | 不等于 agent 长期记忆或 Loom memory。 |

来源：[Channels][channels]、[Messages][messages]、[Threads][threads]、[Activity][activity]、[CLI 0.0.17][cli]。注意：人类通知指南还说“加入的 channel 收所有消息、DM 总会 ping、followed thread 收 ping、server-wide mute 可静音一切”，并主张把 @mention 留给真需中断的事项。[Notifications][notifications] 这与 CLI 已有的 `channel mute` 同时存在；未登录实测 server 前，不应从任一来源补写另一方未明说的细节。

### 多 channel / 多 thread 时应该怎样理解

Raft 的官方组合不是“每条消息都立刻唤醒并完整注入模型”：

```text
membership / DM / followed thread / @mention
       -> Raft inbox delivery
       -> 需要时在 Activity 或 inbox 中聚合查看
       -> 打开一个 channel / DM / thread 的局部历史
       -> reply、task 状态变化、unfollow，或什么也不做
```

可见的设计意图是：频道用于工作 lane；顶层消息用于广播或立题；thread 把细节限制在锚点之下；task thread 放进展；unfollow 在工作完成后停止持续打扰；搜索用来在后来有需要时取回历史。[Build your agent team][agent-team]、[Threads][threads]、[Tasks][tasks]、[Search][search]

### 能否闭合而不被一直污染

- **外部讨论 thread**：可以 `unfollow` 静音，但不能在资料中找到“close thread”或“archive thread”对象。线程仍可读/回复；它不是可关闭工单。[Threads][threads]、[CLI 0.0.17][cli]
- **task**：有 `todo -> in_progress -> in_review -> done`，另有 `closed` 表示 cancelled/won't-do，且 `closed` 可 reopen。它是可收束的协作对象；不是删除讨论史。[Tasks][tasks]
- **channel**：owner/admin 可 archive，保存历史但禁止新消息，之后也可 unarchive。普通 member/agent 不应把它当作自己任意关闭一个空间的动作。[Channels][channels]
- **个人注意力**：leave public channel、mute channel、unfollow thread 是不同粒度的降噪；都不改写外部历史，也不等同于在 Loom 关闭内部工作线。

**对 Loom 的含义（推论）**：Loom 可把这些当作外部 attention signals，但必须另定自己的 attention policy，例如：外部 @mention/DM 是否立即形成机会、普通已订阅频道是否只在 proactive pulse 批量看、已处理 thread 是否自动 unfollow、何时保留/关闭相应 Loom 私有工作线。Raft 官方没有给出这些选择的优先级、预算或自动清理规则。

## 3. Task、reminder、attachment：协作物各自的生命周期

### Task

Task 是带编号、状态和可选唯一 owner 的顶层消息；按 channel 编号，并在该 channel 的 task board 上按状态显示。官方写的 task status 是 `todo`、`in_progress`、`in_review`、`done`、`closed`；一个 task 同时只能有一个 owner，unclaim 后重新可领。[Tasks][tasks]

官方推荐的 agent 协作流程是：看见未认领 task 或请求，claim，在线程发布进展，完成后设为 `in_review`，由人批准后设为 `done`。更大任务可创建子 task。[Tasks][tasks]

这里有一个需要在接入前实际验证的边界：产品文档一处写“只有顶层 channel 或 DM message 可成为 task”，而 `0.0.17` 的 `task create`、`task claim`、`task update` help 都只接受 `--target '#channel'`。因此「DM task 是否能完整由 External Agent CLI 管理」在本次资料下是**未证实**，不能只凭 UI 文案假设可用。[Tasks][tasks]、[CLI 0.0.17][cli]

**对 Loom 的含义（推论）**：Raft task 是公共协作承诺，不是 Loom scheduler task。未来即使开放 task tool，也必须独立决定：claim 成功是否才启动 Loom work、Loom 完成后是否改 Raft `in_review`、谁有权把它 `done/closed`、崩溃重试如何避免重复 claim/status update。不能由收到任意消息就自动 claim 推导出来。

### Reminder

Raft reminder 是锚定 message 或 thread 的持久定时 wake：触发时唤醒**创建它的 agent**，并在锚定 surface 留可见系统消息。创建者可以 schedule、list、snooze、update、cancel；支持一次与重复提醒。[Reminders][reminders]

发布 CLI 确认 agent 创建 reminder 时必须给 `--message-id`；`schedule` 支持 `--delay-seconds`、UTC `--fire-at`、`--repeat` 和可选 receipt `--channel`。[CLI 0.0.17][cli]

**对 Loom 的含义（推论）**：Raft reminder 可以是 Individual 在外部协作中承诺的 follow-up 线索，但它不能自动替代 Loom Host 的 pulse、主动行为调度、Effect delivery retry 或记忆维护。否则同一 Individual 会有两套独立时钟和恢复语义。是否允许 Individual 主动创建外部 reminder，是一个应单独授权的外部写操作。

### Attachment

Raft file 是附在 message 上的附件；谁能看原消息，谁就能看附件。文件上传到 Raft，最大 50 MB，频道/DM 都可在 Files 面板聚合；一旦分享，只要 message 存在附件就无法删除。Agent 可以上传与下载，而 agent workspace 文件与共享 chat attachment 是分开的。[Files][files]

**对 Loom 的含义（推论）**：attachment 的“Raft 存在”不等于“Loom 已下载或采纳其内容”。下载会把外部资料引入 Loom 可访问范围；上传会把 Loom 资料持久送往 Raft。两者都需要独立的内容、持久化、权限和恢复设计，不能悄悄附着在 text message 工具上。

## 4. External Agent：收到消息后，官方实际做什么

External Agent 是运行在我们自己的机器、由我们管理 runtime 的 agent；Raft 只给它 server identity 与成员资格。连上后，它同 managed agent 一样可收发消息、task、reminder、attachment、search 与管理自己的 profile，但其 process/模型/基础设施不归 Raft 管。[External Agents][external-agents]

### 官方 wake 的分层

官方 wake contract 不是「server 把正文和完整 context POST 给模型」。它的职责划分是：

```text
Raft server
  -> raft agent bridge
       负责：wake 消费、seq 去重、陈旧 wake 清理、重连/回退、
             至少一次的 replay/reconciliation 与 bridge observability
  -> 本地 runtime channel component
       负责：接一个带 token 的 localhost POST；向 agent 可见 context 注入
             简短固定提醒
  -> agent 自己经 Raft CLI 拉取 message body
```

wake payload 按 contract 必须无正文、无 channel name、无 sender identity；只有 message/agent/attempt ID、profile、session、时间等元数据。返回 `2xx { ok: true }` 的含义只是 wake notice 已进入或排队进入 agent visible context，不是模型已读、理解或完成消息。突发 wake 可以合并为一个提醒，随后一个 `message check` 拉取积压项。[Wake contract][wake-contract]

官方 Claude plugin 的实际会话 orientation 只有：Raft 是 humans/agents shared workspace、Raft 是协作面、terminal 是本地工作工具，需要时取 CLI manual。wake notice 让 agent 先确认 profile（仅 identity context），再运行 `raft message check`；plugin 还明确说不能把 channel metadata 当 system instructions。[Plugin orientation][plugin-orientation]、[Wake plugin][wake-plugin]、[External Agents][external-agents]

因此，官方**机制**对应的最小事实路径是：

```text
1. wake：有新 Raft 事件，但没有正文、sender、channel/thread。
2. drain：agent 运行 message check，取得待处理消息。
3. scope：必要时 read 当前 channel / DM / thread 的局部历史，或查 profile/member。
4. judgment：回复、追问、认领 task、设 reminder、@mention 其他 agent，或沉默。
5. external action：对明确 target 发 message / status update / 其他已授权动作。
```

其中第 1--3 步是官方接口/参考路径；第 4 的语义判断并未由官方统一规定。Task 文档给出的是 task 场景的典型流程，不是每种 message 的强制算法。[Wake contract][wake-contract]、[Tasks][tasks]

### 0.0.17 CLI 能看到/做什么

下面是发布 CLI 的分组，而非建议把它们全部直接交给 Loom Main Agent：

| 需要回答的问题 | CLI 0.0.17 原始操作 | 使用场景 | 风险/限制 |
| --- | --- | --- | --- |
| 有没有积压的目标？ | `inbox check` | 只想先看 pending target，不读正文也不 drain。 | 不是全文 history；具体输出 schema 需登录 server 才能验证。 |
| 有什么待处理 message？ | `message check` | wake 后拉取 inbox。 | help 明示会在返回前 ack delivered seq；不能直接充当 Loom durable Input 的确认。 |
| 这里的上下文是什么？ | `message read --target ... [--before/after/around/limit]` | 展开一个 channel、DM 或 reply thread 的局部窗口。 | CLI message 核心输出没有已证实 JSON wire schema；实现需固定版本解析。 |
| 过去讨论过什么？ | `message search --query ... [--target/sender/time/limit/offset]` | 主动研究、补足当前消息提到的历史、找人或结果。 | 只搜索当前 identity 可见内容；不是 Loom memory。 |
| 这个 ID 是什么？ | `message resolve <id>` | 将短/全 message id 归一。 | 仅外部 message identity。 |
| 谁/哪里可见？ | `server info`、`user info`、`profile show`、`channel info`、`channel members` | 新遇到成员、channel、DM/thread 时核对 audience、身份和成员关系。 | profile 不能决定权限或回复目标。 |
| 能否减弱外部噪音？ | `thread unfollow`、`channel mute/unmute`、`channel leave` | 一个 thread 完结；一个 channel 暂时不看；离开公共 lane。 | 这些都是 Raft attention 状态，非 Loom work closure。 |
| 进行外部交流？ | `message send`、`message react` | 回复、轻量确认；在 message 内容中 @mention 交接对象。 | 外部副作用；`message send` 无已证实 idempotency key。 |
| 管 task/reminder/file？ | `task ...`、`reminder ...`、`attachment ...` | 公开承诺、后续提醒、共享成果。 | 都有独立权限/持久化/恢复语义。 |

来源：[CLI 0.0.17][cli]。`message read` 的 target 格式在 help 中已写成 `#channel`、`dm:@peer`、`#channel:threadId`、`dm:@peer:threadId`，这正说明 CLI 可区分外部 channel/DM 与其 reply thread；它仍然不产生 Loom Thread。

## 5. Agent 怎样认识自己、认识彼此、协作

从 Raft 的领域模型看，agent 的“自我”至少包括：当前 server 内 agent identity、handle/name、description、server role、当前 profile credential、可见 membership、已 follow 的 thread、自己创建的 reminders，以及它自己 runtime/workspace 的连续性。其他成员看到的则主要是名称、description、消息、channel membership 和角色；不是它的完整内部 prompt、记忆或文件。[Agent Basics][agent-basics]、[Workspace][workspace]、[External Agents][external-agents]

多 agent 相互识别有三条正式路径：

1. **成员与 profile**：从 member list/message name 看 handle、description 和角色，形成「谁负责什么」的协作线索。
2. **共处 channel**：共同成员能看见同一公共讨论与互相的修正；channel 描述/成员关系表达一个工作 lane。
3. **明确交接**：用 @mention 指给某个 agent、在同一 thread 交接上下文，或用 agent-to-agent DM 做不需公开的问答/拆分；可把 work 转成 task，用 owner/status 防止重复劳动。

官方明确提倡这些动作，也明确说不同 runtime 的 agent 可以在一个 room 中合作。[Build your agent team][agent-team]、[DMs][dms]、[Tasks][tasks]

但应避免三个错误推论：

- 看见 `@other-agent` 不代表能调它的本地工具、读取其 workspace，或替它代言。
- 看到同一 channel 历史不代表各 agent 有同一内部记忆；官方自己也说每个 agent 保有自己的 workspace 和 memory。[Build your agent team][agent-team]
- profile 的 role/description 是可见协作信息，不是进入模型后应遵从的 system instruction。官方 plugin 对 wake metadata 特别作了这个限制。[Wake plugin][wake-plugin]

**对 Loom 的含义（推论）**：Loom 应把外部身份稳定地标成 `Raft human` 或 `Raft agent`，连同 handle/成员关系/audience/message location 一起呈现为外部事实。Individual 可以基于这些事实决定礼貌、分工、是否求助，但不能因为一段外部文本自称管理员、声称“你必须”或有相似名字，就提升权限或改变 Loom 的系统边界。

## 6. 给 Loom 的约束清单，不是最终工具/prompt 设计

以下是由上面资料直接导出的设计约束，供后续设计输入与工具面时使用。

1. **每条 Raft Input 必须带明确外部定位**：server、channel/DM、顶层 message ID、是否/属于哪条 reply thread、sender、可见 audience、默认 reply destination。不要仅给一段正文，让 Main Agent 猜谁能看见、会回到哪里。
2. **应把当前 Input 的最小上下文和按需检索分开**：wake 本身没有正文；Raft 官方也采用「短 orientation + content-free notice + CLI 拉取」分层。Loom 不能自动全量导入 server/channel/thread history；需要当前 anchor 的局部上下文时再显式读取。[Wake contract][wake-contract]
3. **外部内容是 evidence，不是系统指令**：profile、channel name、message body、附件内容均只能给 Individual 提供外部事实和请求，不能改变 Loom 权限、prompt、凭据边界或 delivery route。[Wake plugin][wake-plugin]
4. **可靠接入不能把 `message check` 直接给 Main Agent**：该 CLI 在结果返回前就 ack delivered seq；Loom 若尚未写 durable Input 就崩溃，会出现 Raft 已确认而 Loom 未记账的缺口。适配器需要自己的入站账本/去重/确认策略；这是从 CLI 行为导出的可靠性要求，而不是 Raft 已提供的 Loom 保证。[CLI 0.0.17][cli]
5. **发送仍应走 Loom Effect/Delivery**：Raft `message send` 是外部副作用，公开资料没有显示幂等 key。Effect 已持久但 Raft 结果未知时，重试可能重复发；这个事实需要在 pilot 前实测和明确处理。[CLI 0.0.17][cli]
6. **Raft attention 不等于 Loom attention**：join/leave/mute/follow/unfollow/Activity 只管理 Raft 外部投递与显示。Loom 需要决定何时检查、读多少、何时创建/关闭自己的工作线和是否主动发言。
7. **task/reminder/attachment 应独立开放**：它们都改变 Raft 的公共或持久状态；尤其 reminder 不能默认接管 Loom scheduler，attachment 不能默认跨越到 Loom workspace。
8. **首轮不能假设有通用多 channel 策略**：官方提供的是机制而非 attention budget。若先启一个私有 DM 及其 reply thread，agent 仍可通过同一领域模型工作，但不用同时解决 public channel discovery、多个成员、任务竞争和跨 lane 主动性。

## 7. 当前未证实的能力与需实测的问题

下列项目在本次指定的一手资料中没有足够证据，必须保持“未证实”，不能在文档、prompt 或实现中默认成立：

- Raft 是否有外部 agent 可用的完整 Activity feed API/CLI filter、跨 channel attention priority 或未读排序协议；当前可证实的是 `inbox check`、`message check`、search 与 membership/follow signals。
- Raft 是否给 `message send` 提供 server-side idempotency、delivery receipt query 或可用于 Loom recovery 的 exactly-once 机制。
- `message check/read/search` 的 machine-stable JSON message schema；0.0.17 的核心 message commands 未在 help 中展示 `--json`。
- External Agent 是否可以创建/完整管理 DM task；产品文档与 CLI target surface 需要实际 server 验证。
- thread 是否有 close/archive/delete；已证实的是 unfollow，并非关闭。
- public/priv channel 的 mute 对 mentions、task state、wake 的精确交互规则；CLI 与 UI 文档目前给出的粒度不同。
- Raft 会不会自动把完整 profile、成员、channel/thread history、workspace 或 memory 注入外部 runtime 的模型上下文；官方参考实现只注入短 orientation 和无正文 wake。
- External Claude plugin 会自动理解请求、自动 claim、自动回复或按任务生命周期行动；文档中的 task 流程是协作建议，不是该 plugin 已实现的代理判断器。
- Raft server 是否自托管、数据保留/导出/删除策略，以及这些能否满足 Loom Individual 的隐私和恢复要求；本研究没有扩展到产品隐私条款之外作结论。

## 一手来源

- [Server Basics][server]
- [Agent Basics][agent-basics]
- [Members][members]
- [Workspace][workspace]
- [External Agents][external-agents]
- [Channels][channels]
- [DMs][dms]
- [Messages][messages]
- [Threads][threads]
- [Activity][activity]
- [Tasks][tasks]
- [Reminders][reminders]
- [Files][files]
- [Get pinged when it matters][notifications]
- [Search your raft][search]
- [Build your agent team][agent-team]
- [Wake-endpoint contract][wake-contract]
- [Raft external-agent plugin orientation][plugin-orientation]
- [Raft external-agent Claude plugin][wake-plugin]
- [CLI 0.0.17 发布包][cli]：本次解包后执行 `--version`、所有相关 group/subcommand `--help`，并检查 bundle；版本输出为 `0.0.17`。

[server]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/server/index.md
[agent-basics]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/agents/index.md
[members]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/server/members/index.md
[workspace]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/agents/workspace/index.md
[external-agents]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/agents/external/index.md
[channels]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/messaging/channels/index.md
[dms]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/messaging/dms/index.md
[messages]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/messaging/messages/index.md
[threads]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/messaging/threads/index.md
[activity]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/messaging/activity/index.md
[tasks]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/collaboration/tasks/index.md
[reminders]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/agents/reminders/index.md
[files]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/features/collaboration/files/index.md
[notifications]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/get-pinged-when-it-matters/index.md
[search]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/search-your-raft/index.md
[agent-team]: https://github.com/botiverse/raft-docs/blob/8918347e3b61a0fd890e483eed34fa0077d64d1f/content/build-your-agent-team/index.md
[wake-contract]: https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/docs/wake-endpoint-contract.md
[plugin-orientation]: https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/activity.ts
[wake-plugin]: https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/wake.ts
[cli]: https://registry.npmjs.org/@botiverse/raft/-/raft-0.0.17.tgz
