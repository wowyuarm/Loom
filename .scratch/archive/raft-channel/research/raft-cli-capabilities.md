# Raft CLI 能力与模型可见 Context

检索日期：2026-08-02

查验版本：`@botiverse/raft@0.0.17`（2026-07-09 发布）

范围：Raft External Agent 可实际调用的 CLI；不含任何具体 Individual 的私人对话、账号或凭据。

## 结论先行

- `raft` 是**给 agent 进程调用的命令行客户端**，不是自动把 Raft 对话注入模型的 channel。CLI 读取后的 stdout，或 bridge 送到本机 endpoint 的 wake notice，才可能进入模型可见范围。
- External Agent 的 bridge 是无正文的唤醒器：它只报告「有某个 message，需要检查」，不报告 DM、作者、线程或正文。完整 context 要由 CLI 再取。
- 0.0.17 的消息主路径并非 JSON API：`message check`、`read`、`search`、`resolve`、`send` 都没有 `--json`。它们为模型阅读设计了稳定的文本格式，但 Loom 适配器若要机械解析，必须把此视为版本绑定的外部协议，而非已承诺的结构化 API。
- 最重要的恢复事实：`raft message check` 的帮助和实现都表明，它会在返回前确认已投递的 seq。它没有等 Loom 把来信写为 durable Input，更不会等 Main Agent 实际读到。因此不能把一次 `message check` 的成功直接当作 Loom 入站已安全落盘。
- Raft reply thread、Loom private `Thread`、nmem Conversation Thread 是三种不同对象。Raft CLI 可以告诉模型外部回复的位置，却不产生或选择 Loom/nmem 的内部 thread。

## 证据与状态

| 标记 | 含义 |
| --- | --- |
| 已验证 | 用 0.0.17 解包后的实际 `raft --help` / 子命令 `--help`，或该版本 bundle 的执行代码确认。 |
| 官方展示 | 官方文档或官方 wake contract 的能力；未以任何真实 Instance 凭据实跑。 |
| 未证实 | 公开材料和 CLI 都不能证明，不能作为 Integration 合同。 |

本次未登录、未建 server、未发送消息；这避免了产生 Raft 数据或触碰任何 Instance 私有材料。npm 包的 repository 指向 `botiverse/slock` 的 `packages/cli`；本机公开 GitHub API 在检索日对该 repository 返回 404，故版本事实以实际发布 tarball 为准，而不是以可能漂移的 GitHub head 替代它。（来源 1）

## 执行身份与边界

### 认证、profile、bridge

| 命令 | 必要输入与输出 | 副作用 / 权限 |
| --- | --- | --- |
| `raft agent list --server URL` | 已验证：先走 device-code 人工浏览器授权，再以 JSON 输出可 mint credential 的 agent 列表和原因。 | 需要用户在浏览器授权；源码明确要求 server 的 `manageAgents` capability 才会列出可管理 agent。 |
| `raft agent login --server URL --agent ID [--profile-slug SLUG]` | 外层命令会等待浏览器批准；也可 `login start` 取得 device code，再 `login wait --device-code CODE`。`login status` 输出 `usable` / `expired` / `missing` 等文本状态。 | mint 一个 `sk_agent_*` 凭据，并在本机 profile 目录写入 `credential.json`。此为外部 agent 的必要人工授权步骤。 |
| `raft --profile SLUG auth whoami` | 已验证：打印当前由 env/profile 解出的 agent context，token 被脱敏。无 `--json`。 | 只读。用于排查身份，不是模型身份 prompt。 |
| `raft --profile <slug> profile show [@handle] [--json]` | 查看自己或可见 profile；JSON 时为 `{ ok, data }`。`profile update` 也支持 `--json`。 | `update` 可改自己的 display name、description、avatar；不应由 Loom 日常沟通行为调用。 |
| `raft --profile SLUG agent bridge [--json]` | 仅 External Agent profile 可运行。`--json` 输出 newline-delimited protocol events；`--once` 做一轮收取/重放。 | 常驻网络连接与本机 bridge state。它不替代 Loom Host/systemd，也不读取/发送正文。 |

External Agent 的命令可通过根选项 `--profile <slug>` 或环境变量 `RAFT_PROFILE=<slug>` 选身份。（来源 1） `agent login` 完成时 CLI 明确提示 agent 运行 `raft manual get raft-cli-overview`；这是操作建议，不是 CLI 自动注入的 system prompt。（来源 1）

### Bridge wake 的确切内容

官方 wake endpoint contract 规定 bridge 对本机 loopback endpoint 的 POST 为下列 metadata（无正文，也不包含 channel name 或 sender identity）：（来源 3）

```json
{
  "schema": "raft-channel-wake.v1",
  "attemptId": "attempt_<uuid>",
  "eventId": "event_<uuid>",
  "messageId": "<message uuid>",
  "agentId": "<agent uuid>",
  "profile": "<profile slug>",
  "coreSessionId": "core_<uuid>",
  "adapterInstance": "default",
  "occurredAt": "<ISO-8601>"
}
```

已验证的 0.0.17 bridge 实现构造同一组字段，并在 runtime 成功响应 `{ "ok": true, "runtimeSession": "..." }` 后记录 `wake_injected` proof；响应成功的意思只到「wake notice 已进入或排队进入 agent-visible context」。（来源 1、3）

- bridge 负责 SSE/poll、seq 去重、失败退避、重放与「直到被消费」的 wake reconciliation；runtime endpoint 负责注入短、固定的 wake notice。（来源 3）
- wake 通道**不能携带消息正文**。contract 还建议 runtime 拒绝带 `text`、`content`、`body`、`preview`、`snippet` 等字段的 payload。（来源 3）
- bridge 不会自行运行 `raft message check`，也不产生 Loom Input。收到 wake 后，调用方才需要用 profile 下的 CLI 拉取消息。（来源 1、3）
- `--activity-channel-endpoint` 是另一条可选 telemetry drain；其官方保证是 at-most-once，且可含截断的工具 input/output。它不是沟通入站，不应承担 Loom 回复或恢复语义。（来源 3）

## 实际可调用的命令面

下表省略显然的 `--help`。`target` 的已验证形式是普通频道 `#channel`、DM `dm:@peer`、频道回复 thread `#channel:<short-thread-id>`、DM 回复 thread `dm:@peer:<short-thread-id>`。（来源 1）

### 消息、DM 与 reply thread

| 命令 | 已验证输入与模型可见输出 | 副作用与限制 |
| --- | --- | --- |
| `message check` | 无参数。非阻塞地 drain agent inbox，文本逐条形如 `[target=dm:@peer:threadId msg=shortId time=... type=human] @sender - description: content`；附件显示 filename 与 attachment id，task 消息会显示 task number/status/assignee。 | **会在返回前 ack delivered seqs**，并把每个 target 的最高 seq 写到本机临时 consumed-seq state。无 `--json`、无 target filter，且会 drain 所有 pending inbox。 |
| `message read --target TARGET [--after ID] [--before ID] [--around ID] [--limit N]` | 历史文本含 `seq`、完整 `msg` ID、time、sender type、`threadId`、`replyCount`，必要时给出 `replyTarget`；能按 cursor 继续读。 | 只读 server history，但客户端同样记录本地 consumed seq。没有 `--json`。历史是否受 plan 限制由返回文本提示。 |
| `message resolve ID` | 精确解析 full 或短 message ID 并打印 canonical message。 | 只读；无 `--json`。短 ID 可歧义，调用方应保留/再取 full ID。 |
| `message search [--query QUERY] [--target TARGET] [--sender @HANDLE] [--before ISO] [--after ISO]` | 搜索可见消息。输出 XML-like 结果块：message ref、来源（channel/DM/thread）、sender/type、time 和截断 preview；CLI 提醒发现相关结果后要 `read` 周边。 | 只读；无 `--json`。搜索结果不能代替 thread/history context。 |
| `message send --target TARGET [--attachment-id ID...]` | 正文必须经 stdin/heredoc 传入；成功文本给 Message ID，并给后续回复该消息 thread 的 target hint。 | 创建外部消息。若 server 发现未读更新，可把新文本存为本机 draft 并返回 held，而不是发送；之后要先重新阅读再 `--send-draft`，`--anyway` 是明确绕过。**没有 `--json`、没有请求 idempotency key。** |
| `message react --message-id ID --emoji EMOJI [--remove]` | 文本结果。CLI 自带指导：仅在明确请求或明显确认时使用。 | 创建/删除自己的 reaction。 |
| `channel info TARGET` / `channel members TARGET` | 前者给可见 existence、joined、description、member count；后者列 channel、DM 或 thread 内可见 human/agent 成员。 | 只读、文本输出。DM 没有单独的 `dm create` 命令；已验证 CLI 是直接以 `dm:@peer` target 读/发。 |
| `thread unfollow --target THREAD_TARGET [--reason TEXT]` | 文本确认并说明 personal @mention 仍会穿透；在 thread 发送会自动重新 follow。 | 改变 Raft 对普通 Activity 的投递，不是删除 thread，也不影响 Loom Thread。 |

`inbox check` 虽然看似较轻，只显示 pending target 而不 drain/read 内容，但源码明确限制它只能在 managed daemon runner 内使用；External Agent profile 不能依赖它，应使用 `message check`。（来源 1）

### 频道、成员与 presence

| 命令 | 能力 | 权限 / 状态边界 |
| --- | --- | --- |
| `channel create/update/add-member/remove-member` | 新建、编辑 regular channel，或改成员。 | 帮助明确要求 server admin authority。首个私有 DM pilot 不需要，也不应给此类管理权限。 |
| `channel join/leave` | 加入可见 public channel、退出已加入 regular channel。 | 会变更成员关系。DM/thread 不是此命令支持的 target。 |
| `channel mute/unmute` | 关闭/恢复一个 regular channel 的 ordinary Activity delivery。 | 会变更 agent 注意力；personal mentions 和已 follow thread 仍可到达。仅 regular channel，不支持 DM/thread。 |
| `user info NAME [--limit N] [--offset N]` | 显示可见的 human/agent 窄信息与可见 channel membership。 | 快照式文本查询。 |
| `profile show` / `server info` | profile 的 agent `status`、role/runtime/model 等；server 可列 visible channels/agents/humans，`--full` 是 legacy inventory。 | 这些是读取时的 snapshot。0.0.17 CLI 没有名为 `presence` 的订阅、watch 或 callback command，不能把 profile status 当可靠 online/busy signal。 |

### 任务、提醒、附件与检索

| group | 已验证命令 | 作用与边界 |
| --- | --- | --- |
| `task` | `list --target #channel [--status]`；`create --target #channel --title ...`；`claim` / `unclaim` / `update` | task target 只接受 `#channel`，状态是 `todo`、`in_progress`、`in_review`、`done`、`closed`。CLI 未展示 dependency、DAG、自动调度或将 task 变 Loom Pulse 的能力。 |
| `reminder` | `schedule --title TITLE --message-id ID` 加 `--delay-seconds` / `--fire-at` / `--repeat`；`list`、`cancel`、`snooze`、`update`、`log` | agent 创建必须锚定已有 message ID；可选向 channel/DM 贴 receipt。它是 Raft 自己的提醒生命周期，不应驱动 Loom scheduler 或 delivery retry。所有输出为文本。 |
| `attachment` | `upload --path ABSOLUTE_PATH --target TARGET [--mime-type TYPE]`；`view ID --output PATH`；`comments --id ID` | upload 上限 50 MB，写入 Raft；view 将外部文件写入本机指定路径。CLI group 叫 `attachment`，**没有** `file` / `files` command，也没有从 Loom Attachment Store 自动同步的能力。 |
| `manual`（`knowledge` 是 alias） | `get TOPIC [--reason TEXT]`；`search KEYWORDS [--scope recipes] [--reason TEXT]` | 从**当前 server**获取 Manual for Agents；`get index` 列 topic。它提供 Raft 操作资料，不等同于 Codex/Loom skill 系统，也不自动装载到模型 prompt。内容在未登录的本轮不可验证，属于 server 动态文档。 |
| `message search` | 见上表 | 唯一消息搜索 surface；不等于 Workspace、文件或本机 shell 搜索。 |

### 其他公开 group：可见但不属于 Loom Interaction Channel

| group | 已验证能力 | 处理建议 |
| --- | --- | --- |
| `integration` | `list/login/env/invoke`；其中 list/login/env/invoke 有 `--json`。invoke 可请求 login scope、向 channel/DM 发 human approval card，并调用 manifest-backed HTTP action。其 `app prepare register/update` 只准备 human owner/admin 要提交的注册卡；`app rotate-secret --client <key> --json` 会使旧 client secret 失效。 | 会扩展到第三方服务和权限，不能随 Raft DM 一并授权。 |
| `mention` | `pending`、`notify RESOLUTION_IDS`、`add RESOLUTION_IDS`，都可 `--json`。 | 外部通知/成员变更动作，不是 Loom `message` 的同义词。 |
| `action prepare` | 向 target post human-commit action card。 | 是人类待提交卡片的快捷入口，不是 agent 自动 commit。 |
| `server update` | 更改 server 名称/avatar，支持 `--json`。 | 要 server admin authority；与 channel pilot 无关。 |

## JSON 与机器可读性

不要将「CLI 传输层从 server 获得 JSON」误解为「agent 可得到 JSON stdout」。在 0.0.17：

- 直接确认的机器输出：`agent list` 恒为 JSON；`agent bridge --json` 为 NDJSON protocol events；`profile show/update`、`server update`、`integration list/login/env/invoke`、`mention pending/notify/add` 有 `--json`。（来源 1）
- 消息核心和多数协作命令只有面向 agent 的文本：`message check/read/search/resolve/send/react`、`channel`、`user`、`task`、`reminder`、`attachment`、`manual`、`auth whoami`。这不是可依赖的 JSON contract。（来源 1）
- bridge 的 JSON 也不能解决内容解析：它是 lifecycle/proof/wake event，不含 message body、sender、DM 或 thread。实际内容仍来自文本 `message check` / `read`。（来源 1、3）

因此，若 Loom 以进程方式调用 CLI，应明确选择并测试一个 version-pinned parser，或等待/请求 Raft 提供 message JSON mode；不能把 shell 文本当作已经稳定的 wire schema。这个结论不妨碍模型直接阅读文本，但会影响 durable ingest 的可靠性和测试面。

## External Agent 如何得到足以决策的 Context

### 官方 Claude channel 的实际注入方式

Raft 官方 External Agent 插件没有把整份 CLI manual 永久塞进 prompt，而是分三步给 context：（来源 5）

1. Claude Code `SessionStart` 时注入一段很短的 orientation：当前连接到 Raft，Raft 是人与 agent 的 shared workspace；本地终端用于本地工作；需要操作说明时运行 `raft manual get raft-cli-overview`。该 hook 在 resume/compaction 后会再次执行。
2. bridge wake 时只注入固定通知：收到一个或一批 wake hint、对应 `message_id` / `attempt_id`，需要时先读 manual 或确认 profile，然后运行 `raft message check`。通知不包含正文、sender 或 target。
3. agent 实际运行 CLI 后，`message check/read/search/...` 的 stdout 才提供消息、位置、参与者和下一步命令提示。

这证明“场所 orientation + 当前事件提示 + 工具结果”是 Raft 官方自己采用的模型可见分层，但官方那句通用 orientation 并不能直接成为 Loom prompt：它把 Raft 称作 primary collaboration surface，没有表达 Loom 的 Runtime、Workspace、`message` Effect，也没有区分 Raft reply thread 与 Loom private `Thread`。Loom 可以借鉴注入层次，不能照搬职责文字。

### 进程调用 CLI：事实链

```text
Raft server
  -> bridge: content-free wake metadata
  -> Loom local endpoint: durable wake signal / scheduling trigger
  -> Raft CLI message check: pending message text, target and short ID
  -> optional message read/resolve/members: full ID, history, reply location, participants
  -> Loom durable Input + Main Agent context
  -> Loom Effect
  -> Raft CLI message send to the explicit target
```

bridge 的成功只证明到第二行；`message check` 的 ack 发生在第四行、也就是 Loom durable Input 之前。这是当前资料中最需要 pilot 验证/设计补足的边界，而不是可由 prompt 修复的问题。（来源 1、3）

一次成功的 `message check` 已确认会给模型/调用方：

- 消息正文；目标位置（普通 DM、普通 channel 或其 reply thread）；短 message ID；时间；sender handle、type 和可见 description。（来源 1）
- 附件的 filename/ID，以及 task 关联的 task number/status/assignee（若有）。正文附件须另调用 `attachment view` 写入本地文件。（来源 1）

如需决策所需的更细位置资料，已确认的补拉是：

- `message read --target <wake 提示后由 check 得到的 target>`：seq、完整 message ID、`threadId`、`replyCount`、可直接回复的 `replyTarget`、该 target 的局部历史和 pagination 提示。（来源 1）
- `message resolve <id>`：取得 canonical message，处理短 ID 或引用定位。（来源 1）
- `channel members <DM-or-thread-target>`：可见成员；`channel info`：joined/description/member count；`profile show @sender --json`：可见 profile 资料。（来源 1）

这些是 Raft 可提供给 Loom 的**外部会话事实**，不是对它们应以多长历史、何种人格指令、何时写入 Loom memory 的决定。

### 直接把 CLI 给 Main Agent shell：另一条路径

这条路径只有在 Loom 明确向 Main Agent 暴露 shell/专用 tool、安装 `raft`、提供受限 `RAFT_PROFILE`，并把 tool stdout 放入 transcript 时才成立。Raft CLI 自身不会让模型突然看见命令或 context。

- 优点：模型读 `message check/read/search/manual` 的自然语言 stdout，能临场选择读多少历史、是否 reply thread、是否看附件。
- 风险：模型一运行 `message check` 就已经确认 server seq；崩溃或工具结果没有进入 durable Input 时，会形成 Raft 已确认、Loom 未入账的缺口。并且 `message send` 没有幂等 key，模型重复调用可能发两条。
- 权限面：同一 shell 若给出全 CLI，就也给出了 attachment upload/download、本机路径写入、channel membership、profile 修改、task/reminder，以及可能经 `integration invoke` 调外部服务的能力。

所以「agent 能使用 raft CLI」至少有两个截然不同的含义：

1. **Integration-owned CLI**：Raft adapter 是唯一进程调用者，输出被转换为标准 Loom Input/Delivery；Main Agent 获得经过定位和边界标注的 context，仍只通过 Loom `message` 形成 Effect。
2. **Model-owned CLI tool**：Main Agent 自行调用具体 `raft` command，并负责理解 stdout、选择目标和外部副作用。

前者比较符合 Loom 的 Runtime/Input/Effect 所有权；后者可做探索工具，但不能被当作同一条可靠消息通道，除非另行解决 ack、credential scope、parser、outbox 和 duplicate-send 问题。这是能力边界说明，不是本研究替 Loom 选定的最终接口。

## 给 Loom 的 model-visible Context 事实清单

以下是 channel 层将来可构建/注入的事实材料，不是推荐的最终 system prompt 文案，也不替 prompt 定职责。

| 事实 | 来自 | 模型判断时的意义 |
| --- | --- | --- |
| `channel=raft`、该 profile/agent identity | Integration 配置、`auth whoami` / profile | 明确这是 Raft 外部场所，不是本机 Local 或 Weixin。 |
| 外部 target 的 canonical string | `message check` 或 `read` | 决定回复会落在 `dm:@peer`、`dm:@peer:<thread>`、`#channel` 或 `#channel:<thread>`。 |
| 外部 message ID、seq、time、sender type/handle/description | `check`；以 `read` 得完整 ID | 归因、去重、引用和审计；不要把 short ID 当 Loom Input ID。 |
| 外部 reply-thread 状态 | target、`threadId`、`replyCount`、`replyTarget` | 只表达 Raft 的消息回复位置，不创建 Loom 工作线。 |
| 外部可见参与者与 channel visibility | `channel members`、`channel info` | 让模型知道回复的 Raft audience；仍不可推断 Loom Workspace 或 nmem 的读者。 |
| 附件 ID/name 与是否实际下载 | `check/read`、`attachment view` 的结果 | 区分“附件存在于 Raft”与“内容已进入 Loom 可访问范围”。 |
| 任务/reminder metadata（若未来允许） | message/task/reminder commands | 仅 Raft collaboration object，不能自动成为 Loom scheduler task 或长期记忆。 |
| wake ID / bridge proof | bridge metadata | 供 Integration 恢复与观测；不应把无正文 wake 呈现为用户来信正文。 |

其中的同名词必须保留命名空间：

| 对象 | 所有者与含义 | 不应误作 |
| --- | --- | --- |
| **Raft DM** | Raft server 的外部私聊位置与成员可见性。 | Loom workspace、Loom transcript 或 nmem conversation。 |
| **Raft reply thread** | 某条 Raft 消息下面的外部回复容器；发送 target 如 `dm:@peer:<thread-id>`。 | Loom private `Thread`。 |
| **Loom `Thread`** | Individual 的私人长期工作/注意力线，由 Loom Workspace/Runtime 维护。 | 外部聊天 reply container 或 Raft task。 |
| **nmem Conversation Thread** | Nowledge Mem 的跨工具对话/原始历史索引。 | Raft DM 的镜像，或 Loom agent 的工作线。 |

换句话说，Raft channel context 应能说清「**我现在在 Raft 的哪个外部位置、谁能看见、回复将落到哪里**」，但不能以字段名暗示「这就是我的 Loom Thread」或「这段外部历史已是 nmem conversation」。

## 未确认与不应假设的能力

- 未在 0.0.17 CLI 找到 message JSON output、message acknowledge-after-Loom-commit、入站 cursor handoff、或 outbound idempotency key。`message check` 的现有 ack 时机反而确认了需要专门处理的风险。（来源 1）
- 未找到 External Agent 专用的 `presence` stream、delivery receipt query、DM creation command、thread creation command、消息编辑/删除 command、任务依赖/DAG/scheduler command，或 Raft-to-Loom 自动 workspace/memory 同步。这里说的是**该版本公开 CLI**未展示，不能外推为 server/web API 绝对不存在。（来源 1）
- Manual 的真实 topic 列表、实际 server 返回的 profile/成员字段、history retention/plan limit，以及 `message send` 在网络中断「server 已写入但 CLI 未得响应」时的行为，均需在授权 pilot 以无敏感测试数据验证。
- 官方 External Agent 文档仍标记该功能为 Experimental，并提示在线状态可能不准确；profile status/presence 不应成为 Loom 调度或可靠性判断依据。（来源 2）

## Sources

1. [`@botiverse/raft` 0.0.17 npm tarball](https://registry.npmjs.org/@botiverse/raft/-/raft-0.0.17.tgz)，实际解包并执行 `raft --help` 及所有 group/关键 subcommand 的 `--help`；bundle 中核对 `message check`、`message read/send`、bridge、login 与 formatter 实现，2026-08-02。
2. [Raft External Agents](https://docs.raft.build/features/agents/external.md)，External Agent 定位、device login、CLI/bridge 路径与 Experimental 状态，2026-08-02。
3. [Raft External Agents wake-endpoint contract](https://github.com/botiverse/raft-external-agents/blob/main/docs/wake-endpoint-contract.md)，wake payload、content-free 约束、runtime success 语义、重试与 activity 区分，2026-08-02。
4. [Raft Messages](https://docs.raft.build/features/messaging/messages.md)、[DMs](https://docs.raft.build/features/messaging/dms.md)、[Tasks](https://docs.raft.build/features/collaboration/tasks.md)、[Reminders](https://docs.raft.build/features/agents/reminders.md)、[Files](https://docs.raft.build/features/collaboration/files.md)，作为 UI/产品语义交叉参照；具体 CLI 参数、输出与副作用以上述 0.0.17 实测 help/bundle 为准，2026-08-02。
5. [Raft External Agent Claude channel plugin](https://github.com/botiverse/raft-external-agents/tree/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel)，`SessionStart` orientation、content-free wake context、CLI 拉取正文的官方参考实现，2026-08-02。
