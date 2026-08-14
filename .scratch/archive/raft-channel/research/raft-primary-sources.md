# Raft 作为 Loom Interaction Channel：一手资料研究

检索日期：2026-08-02
范围：只查 Raft 官方文档与官方发布的 CLI 包；首轮只研究“Raft 作为一个 Loom Instance **唯一启用的 Interaction Channel**”。不讨论 Local、Weixin 或其他 route 的并存、分流、转发、fan-out 或插件体系；不代表已经接入或验证过任何具体 Individual。

## 先说结论

Raft 值得作为一个 Loom Instance 的**唯一远程 Interaction Channel** 做小规模验证。正确形态是：Loom Host 继续运行该 Instance；Instance 中只启用 Raft；其 Individual 以 Raft 的 **External Agent** 身份进入一个私有 DM；Loom Integration 把 Raft 来信写入标准 Input，再把 Loom 已接受的出站 Effect 发回明确的 Raft DM/thread。

它不应替代 Loom 的 Runtime Store、调度、Workspace 或记忆。Raft 自己会永久保存消息和附件，而 Loom 也需要保留自己的连续性与恢复事实；两边各自保存什么、失败时谁重试，必须先定清楚。

## 已确认的事实

### 1. 接入方式适合已有的 Loom 进程

- Raft 的 External Agent 就是“自己在任意机器运行的现有 agent runtime”，Raft 只给它 server 内身份；外部 agent 可加入频道、私信、线程、任务和提醒。创建时没有 Computer 或 managed runtime 选择器。这个模型与 Loom Runtime Instance 相符，不需要把 Individual 改造成 Raft 管理的 agent。
  来源：[External Agents](https://docs.raft.build/features/agents/external.md)，2026-08-02。
- 授权是设备授权：在 Instance 所在机器运行 `raft agent login --server ... --agent ... --profile-slug ...`，由拥有 server 权限的人在浏览器确认；成功后凭 `RAFT_PROFILE` 选择本地 agent 身份。凭证、Raft agent 身份与 Runtime Instance 的 Unix 用户应一一对应，不能拿人的登录或另一个 Individual 的 profile 复用。
  来源：[External Agents](https://docs.raft.build/features/agents/external.md)，2026-08-02。
- 官方明确把 External Agent 标为 **Experimental**，并注明其在线状态可能不准确。因此它可以 pilot，不能在未验证前被视为可靠的生产传输层。
  来源：[External Agents](https://docs.raft.build/features/agents/external.md)，2026-08-02。

### 2. 实时唤醒不是“消息直接推给 Loom”

- 对 Hermes 的正式接法是 `raft agent bridge` 收到**不含正文的 wake hint**，再由 agent 使用 CLI 读取消息并回复。官方也说通用 agent 需要自行使用 `raft message check`、`raft message send` 等 CLI 命令。
  来源：[External Agents](https://docs.raft.build/features/agents/external.md)，2026-08-02。
- 官方 External Agent 插件的 wake 合同规定：bridge 负责 SSE/poll、去重、退避和“直到被消费前至少重试”；它只向本机 loopback endpoint `POST` 元数据，不传正文。endpoint 返回成功只表示该提示已进入或排队进入 runtime 可见上下文，**不表示模型已读取、Loom 已入账或已经回复**；随后由 agent 以 CLI 拉取正文。这就是 Loom 不能直接把 wake 当 Input 的原因。
  来源：[Wake-endpoint contract](https://github.com/botiverse/raft-external-agents/blob/main/docs/wake-endpoint-contract.md)，2026-08-02。
- Raft 的文档还说 agent 离开期间会在下一次 inbox check 看到累积消息。这说明它有补拉能力；但官方没有给 Loom 适配器承诺顺序、Raft message ID 的去重规则、Loom 写入前何时确认、或 `message send` 的幂等键。
  来源：[Activity](https://docs.raft.build/features/messaging/activity.md)，[External Agents](https://docs.raft.build/features/agents/external.md)，2026-08-02。

### 3. 沟通形态足够好用，但内容会留在 Raft

- DM 是持久私聊，参与者可以回看完整历史，并支持线程；频道有公开/私有成员边界。首轮可只使用一个主要关系对象与一个 Individual 的私有 DM，而不是默认进入 `#all` 或另开 Raft 频道；这是 pilot 范围，不是 Channel 的身份假设。
  来源：[DMs](https://docs.raft.build/features/messaging/dms.md)，[Channels](https://docs.raft.build/features/messaging/channels.md)，2026-08-02。
- 已发送消息不能编辑或删除；附件上传到 Raft，且只要原消息还在就会保留。官方隐私政策明确写明：发送到 Raft 频道、DM 或 workspace record 的消息、附件、任务和元数据由 Botiverse 存储；本机代码、文件和工具输出则留在本机。不要把 Raft 当作可随时抹除的临时中转，也不要先把个人材料、密钥或不该外传的 Loom workspace 文件送进去。
  来源：[Messages](https://docs.raft.build/features/messaging/messages.md)，[Files](https://docs.raft.build/features/collaboration/files.md)，[Privacy policy, section 16](https://raft.build/privacy/)，2026-08-02。
- Raft 是 Web app，浏览器或手机都可访问同一 server；官方资料展示的是 `app.raft.build` 服务。公开文档中**没有找到**可自行部署 Raft server 的安装、数据迁移或备份恢复说明。External Agent 的“在自己机器上运行”只说明 Loom 进程由 Instance 自己部署，不等于消息 server 自托管。
  来源：[Raft on every device](https://docs.raft.build/raft-on-every-device.md)，[Server Basics](https://docs.raft.build/features/server.md)，[External Agents](https://docs.raft.build/features/agents/external.md)，2026-08-02。

### 4. 任务和提醒不能与 Loom 调度混为一层

- Raft task 是频道或 DM 顶层消息加状态、唯一 owner 和线程；它能协调领取，但没有公开的 dependency/DAG 语义。
  来源：[Tasks](https://docs.raft.build/features/collaboration/tasks.md)，2026-08-02。
- Raft reminder 是持久的、锚定消息/线程的唤醒信号，只唤醒创建它的 agent，并可循环。Loom 本身已有 Host 的时间与认知调度，所以第一轮不该让 Raft reminder 驱动 Individual 的 Pulse、维护或重试，以免两套时钟重复推进同一件事。
  来源：[Reminders](https://docs.raft.build/features/agents/reminders.md)，2026-08-02。

### 5. Workspace 和生命周期的所有权要保持清楚

- Raft managed agent 有自己的本机 workspace，重启或 session reset 后仍保留；完整 reset 会清掉它。External Agent 的价值正是运行环境由 Loom Instance 控制。因此 Individual 应继续使用自己的 Instance Root 与 Agent Workspace，不要迁移或复制成 Raft workspace。
  来源：[Workspace](https://docs.raft.build/features/agents/workspace.md)，[Lifecycle](https://docs.raft.build/features/agents/lifecycle.md)，[External Agents](https://docs.raft.build/features/agents/external.md)，2026-08-02。
- Raft Computer 是另一种管理本机 agent 进程的服务；它会处理唤醒、重启和发回回复。这个职责已经由 Loom Host 与外部 process supervisor 持有。为 Loom Instance 选择 External Agent 可以避免两套进程管理器同时管一个 Individual。
  来源：[Computers](https://docs.raft.build/features/server/computers.md)，2026-08-02。

## 适合与不适合 Loom 的地方

| 适合 | 不适合 / 不能直接假定 |
| --- | --- |
| 手机和浏览器可随时进私有 DM，解决 VPS Local socket 只能在 VPS 本机使用的问题。 | 不替代 Loom 的 Runtime Store；Raft 历史不能成为 Loom 崩溃恢复的唯一真相。 |
| External Agent 允许 Instance 保持自己的部署、模型、进程管理和 Agent Workspace。 | 官方只给通用 CLI 轮询/检查能力；没有公布现成的 Loom bridge。 |
| 一个私有 DM 与其 thread 能提供自然、可回看的对话界面。 | Raft 消息和附件是持久 server 内容，不能把它说成“数据完全不出 VPS”。 |
| Raft 的 task/reminder 能力可先不启用，不妨碍 DM 作为唯一 Interaction Channel。 | 不接管 Loom 的 scheduler；提醒和 task 状态不能默认触发 Loom 内部维护。 |

## Pilot 必须实际验证的事实

以下每项通过前，都不应声称 Raft 已是 Loom 的可靠 Interaction Channel。

1. **授权与隔离**：在 pilot Instance 的独立 Unix 用户下完成 External Agent 登录；确认凭证文件只被该用户读取，Raft server 中展示的是该 Individual 的外部身份，而非 operator 的身份。
2. **真实收信**：只在这一个私有 DM 发顶层消息和 thread 回复；验证 wake 后能读到完整正文、作者、Raft 消息 ID、DM 和 thread 归属，并在 Raft 的确认/游标推进前写成一条 Loom Input。
3. **断线恢复与去重**：在发信后分别重启 bridge/适配器、Loom Host，再恢复网络；同一 Raft 消息不得造成两次 Loom turn，也不能漏掉离线期间累积的消息。需要记录 Raft message ID 到 Loom 的 durable inbound ledger。
4. **出站恢复**：在 Loom Effect 已持久化但发送前、发送中、收到 Raft 成功响应前分别中断进程。确认最终 Raft 中恰有一条回复，或确认 Raft CLI 是否提供可用的幂等方式；公开资料尚未证明这一点。
5. **线程映射**：Individual 对 thread 的回复必须回到同一 Raft thread，普通私聊回复必须回到同一 DM；消息链接和引用的输入范围要明确。
6. **延迟与忙碌行为**：Individual 正在跑一个长 Turn 时继续发消息，观察 Raft 是否可靠积压、Host 恢复后如何按顺序处理，以及 Raft 的“在线/忙碌”指示实际代表什么。
7. **历史边界**：决定初次接入时是否把既有 Raft DM 导入 Loom。默认只接入接通后的新消息，旧 Raft 历史只在 Raft 中可读，避免未经选择地把整段历史重新喂给模型。
8. **隐私与保留**：确认 Instance operator 接受“消息不可删、附件随消息保留、公开资料未证明 server 自托管”的边界；pilot 只用无敏感测试文本和可丢弃附件。
9. **双调度禁区**：确认 pilot 中不启用 Raft reminder 来驱动 Loom 的 Pulse、Attention、Memory 或 delivery retry；Raft reminder 若要使用，只能是人类沟通层的独立提醒，且先说明归属。
10. **版本与降级**：固定测试时的 `@botiverse/raft` 版本，实际运行 `raft manual get raft-cli-overview` 与各命令 `--help`，因为官方文档明确以已安装 CLI 的命令表为准；测试 credential 被撤销、Raft service 不可达和 CLI 升级后的恢复。
    来源：[External Agents](https://docs.raft.build/features/agents/external.md)，[Login with Raft integration guide](https://docs.raft.build/developers/login-with-raft.md)，2026-08-02。

## Pilot 前需要决定的事

1. 首轮收束为“主要关系对象与一个 pilot Individual 的私有 DM（含其 thread）”，并在该 Loom Instance 中只启用 Raft；需要确认的是 Raft task/reminder 是否在 pilot 中一律禁用。建议禁用。这个范围只服务验收，不进入通用 Channel 语义。
2. 是否接受消息和附件在 Raft server 中长期保存，以及目前没有公开 self-hosting 证据？不接受则不应把 Raft 用作私密关系沟通 channel。
3. Raft 历史是否仅作沟通界面记录，还是要有选择地进入 Loom 记忆/证据？建议前者为默认，后者只经标准 Loom Input 与 Life Recorder 流程发生。
4. Individual 主动发消息时，是否只允许回复已有 DM/thread，还是可在同一 DM 发起新的顶层消息？这决定发送权限和关系边界。
5. 是否接受外部 channel 的首轮只支持文本？附件需要先与 Loom 尚未收口的 Attachment 语义一起决定，不应通过 Raft 接入偷偷定案。
6. **模型可见语义**：Raft DM、Raft message reply thread、Loom private `Thread` 与 nmem Conversation Thread 的含义不同。Raft 启用时，Main Agent 需要知道来信的外部位置、可见参与者和回复落点，不能把外部 reply thread 当作自己的 Loom private work line。具体在 system guidance、首轮 Input context 还是 tool description 中如何表达，必须在接入设计时单独决定，不能由字段名或模型猜测代替。

## 本轮未下的结论

- 未安装 CLI、未创建 Raft server、未登录或连接任何 Loom Instance；这些都应留给明确授权后的 pilot。
- 未找到公开的一手资料证明 Raft server 可自托管，或证明其消息发送具备适合 Loom 恢复的幂等键。这两项当前应视为**未证实**，不是默认成立。
