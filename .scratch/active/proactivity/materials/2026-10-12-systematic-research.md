# Loom 主动性：系统调研、实验与设计判断

**日期**：2026-10-12
**性质**：研究材料，不是最终设计，不授权实现。
**范围**：当前 Loom、已有讨论与 nmem、`origin/legacy` 分支、当前 DSH 运行时、外部一手资料。

## 1. 结论摘要

Loom 现在缺的不是“再加一个主动 Agent”，而是三件基础条件：

1. **独立于人类输入的活动时间线**：当前 after-interaction 只在人类输入之后启动一次本地计时器；人不说话，主体没有自己的检查时刻。
2. **唤醒原因与事实来源的分离**：当前 `agentRuntime.deliver()` 把所有外部输入都盖成 `source.kind = 'user'`。要支持 pulse、未来事件、订阅，必须让来源可区分，但不应先造一个脱离具体功能的“大 Inbox 插件”。
3. **低成本闸门与主体处置的分离**：Jev 适合回答“现在要不要把主体叫醒”，不适合替主体决定具体说什么、做什么，也不能替代召回、时间源或持久状态。

`origin/legacy` 已经验证了持久 Pulse、Input、活动生命周期、真人抢占和独立 Orientation 的工程形状；但它把这些形状扩成了多个认知器官、多个模型角色和一套大型 SQLite Runtime。Loom 应该借它的**时序与恢复不变量**，不应把整套认知器官搬回来。

当前最稳的推进顺序不是直接实现完整订阅或 C 层，而是：

1. 用真实日志继续标注 after-interaction 的“判断—主体处置—人类反应”；
2. 在不唤醒主体的 shadow 模式中验证“活动时间线 + pulse state + Jev 二元门控”；
3. 只有 shadow 证明触发事实有信息量，才落一个最小真实 pulse；
4. 外部订阅和未来托付放到第二条输入来源出现后，沿同一套来源、持久性、时效和恢复契约接入。

这仍是推荐路径，不是已经拍板的实现合同。

## 2. 研究范围与证据等级

### 2.1 已检查

- Loom 当前源码与测试：`src/after-interaction/`、`src/agent-runtime/`、`src/channels/`、`src/time-context/`、`src/workspace-history/`、`src/resident-context/`、`src/runtime-state/`。
- Loom 当前 `cordis.patch.yml`、`package.json`、`package-lock.json`。当前依赖树实际为 DSH `0.2.0-rc.2`，Jev `0.1.1`；部分维护文档仍写着 DSH `0.1.7-rc.2`，不能把旧文档当当前版本事实。
- `origin/legacy`：`docs/architecture.md`、`docs/cognitive-organs.md`、主动性 tickets 14、17、28、33、35、50，以及 `src/runtime/runtime.ts`、`src/runtime/scheduler.ts`、`src/agents/orientation.ts`。
- nmem：Loom/Framework 与 Individual 的边界、Orientation 的职责、Orientation 越界事故、Xi 的自驱案例、Current Attention/Thread 的语义边界。
- 真实部署 journald、Session JSONL、workspace git 历史。
- 当前 DSH 的 `Agent` 类型、`runMaintenance`、`send`、`steer`、`inbox`，以及 `@deepseek-ai/dsh-schedule` README。
- 外部一手资料：OpenAI MCP Events、OpenClaw Heartbeat/Automation、Letta Memory & Dreaming/Sleep-time Compute、Generative Agents 与 MemGPT 论文摘要。

### 2.2 事实与判断的区分

- **事实**：源码、测试、当前 lockfile、legacy 源码、真实日志、官方文档或论文原文。
- **强判断**：多条独立证据一致支持，但仍需要真实部署验证。
- **开放问题**：当前证据不能决定，不能提前写成实现要求。

## 3. 当前 Loom：已经证明了什么，缺了什么

### 3.1 after-interaction 已经证明了“判断与交还主体”

当前实现已经具备一个很窄但完整的主动性闭环：

```text
人类输入
  -> completed turn
  -> random(3–14min) 一次性本地 alarm
  -> agent.runMaintenance()
  -> Jev choice {quiet, speak, act}
  -> P(quiet) < 0.4 才 steer
  -> 主体自己决定说、做或安静
```

源码证据：

- `src/after-interaction/index.ts:63-98`：alarm 属于插件 fiber，重启会丢失；只有人类输入引发的 turn 才布防。
- `src/after-interaction/index.ts:108-123`：只在 agent 真正 idle 时运行 maintenance。
- `src/after-interaction/index.ts:148-182`：Jev 失败 fail-closed；交付前检查新的人类输入；只把自然语言 situation 交给主体，不暴露 raw 概率。
- `src/agent-runtime/runtime.ts:172-177`：目前 `deliver(text)` 固定写入 `source.kind = 'user'`。
- `src/contracts/index.ts:165-176`：外部输入统一作为下一 step 的 steering；idle agent 才开始 turn，运行中的 agent 等安全边界。

这个闭环的重要性质不是“Jev 很聪明”，而是：

- Jev 只提议，代码负责保守门控，主体拥有最终否决权；
- 真人输入在检查期间拥有优先级；
- 主动回合不会因为自己的结束再次布防；
- 主动结果是 session 中的 notice，不直接等价于真人消息。

这些性质值得沿用。

### 3.2 真实运行结果：当前机制能工作，但只验证了 B 类场景

对某部署的 journald 做了真实统计：

- 时间窗：2026-10-01 至 2026-10-12；
- 静默 alarm：161 次；
- 实际运行 Jev：43 次；
- `quiet`：34 次；
- 交给主体：9 次，其中 `speak` 6 次、`act` 3 次；
- `generation moved on`：4 次；
- Jev 失败或不可读：0 次；
- 同一窗口命中 该部署的 systemd 单元 的启动记录 33 次、停止记录 20 次，说明本地计时器随重启丢失不是理论风险。

9 次交给主体的 Session 结果中：

- 3 次完成且没有工具调用，说明“被叫醒后安静”是真实可达的结果；
- 5 次调用了 `message`，其中若干还做了 workspace 里的私人工作；
- 1 次因模型 429 失败，Jev 的成功不等于主体执行一定成功。

这证明了：**“Jev 过滤 + 主体自由处置”在 after-interaction 场景成立。**

它没有证明：

- 没有人类输入时，主体是否真的会形成有价值的主动线；
- 30 分钟或其他 pulse 窗口是否有理由；
- 当前 `P(quiet) < 0.4` 能否直接用于 pulse；
- 主体是否会在长期 pulse 中反复查看同一材料、变成定时播报。

### 3.3 当前真正的断点：时间来自人类，不来自主体

`time-context` 目前能记录 session 中最近的模型可见事件；`workspace-history` 能机械提交 workspace，并通过 `git blame` 派生条目年龄；`resident-context` 已能把年龄作为事实展示给主体。这些是“看见时间”的能力。

但它们没有提供“在没有人类输入时启动一次检查”的能力。当前 after-interaction 的计时器只附着在人类输入后的静默上。因此：

```text
过去：有 session log、attention、threads、workspace history
现在：有每轮 context 和时间事实
未来：没有独立的检查时刻
```

这正是主动性最小缺环。它不是“定时器不够多”，而是主体没有属于自己的活动时间线。

## 4. legacy 分支：值得借什么，不能带什么

### 4.1 值得借的工程骨架

`origin/legacy` 的主动性路径形成了几个可复用的不变量：

1. **Pulse 状态持久化**：`last_pulse_at`、`next_pulse_after`、失败计数和错误状态属于 Runtime Store，重启后继续推进。
2. **活动互斥**：一个 Active Segment 打开时，不并行创建 Orientation/background 活动；必要时先用同一 freeze 路径做 fair split。
3. **真人优先**：Ticket 50 规定，人类 Input 在 Orientation 运行期间到达时，立即使结果失效；仍可让只读 Orientation 自己结束，但结果不能再 admission。
4. **Opportunity 与 Input 分离**：Orientation 的结果不是行动本身；它最多形成一个待主体判断的 Input，`none` 不制造输入。
5. **stale admission**：结果形成后要再次检查 runtime transition、idle 状态和新 Input，避免把旧判断交给主体。
6. **活动证据冻结**：Pulse/Orientation 读取 Frozen Activity，而不是随意扫描正在变化的 transcript；Main Agent 的当前 Context 与过去证据不重复注入。
7. **空结果合法**：Orientation 可以返回 `none`，不会为了证明 pulse 有产出而捏造机会。

这些是主动性系统真正需要的机械骨架，和具体的 Orientation prompt 无关。

### 4.2 不应带回来的部分

legacy 的成本和故障也很清楚：

- 五个以上独立 Cognitive Organ，各自拥有模型调用、prompt、工具和持久队列；
- main-interaction / main-background 等多模型角色，把“主体自己判断”拆成大量外部器官；
- 约 30 分钟 pulse、quiet hours、2 小时 Activity max age、组织化的 organ budget 和复杂 SQLite 状态机；
- Orientation 工具面过大、prompt 过度约束，曾从“取景”滑成“替主体探索、分析、下结论”。nmem 中已有对应事故记录：工具过多、`不要空手回来`、retry 深挖，最终挤占 Main Agent 的行动空间；
- legacy 发生过队列阻塞导致 after-chat 卡住、Segment 长时间不关闭、Orientation 全天被 `skipped_segment_open` 跳过的故障。主动性依赖一套大状态机时，局部堵塞会级联成“主体没有自己的时刻”。

因此，legacy 的可借鉴单位是：**持久时刻、活动互斥、真人抢占、stale admission、可观测的 none**；不是“把所有认知维护器官恢复”。

## 5. nmem 与已有讨论提供的主体性约束

nmem 与已有材料反复出现的稳定结论：

- Framework 提供时间、事实、工作空间、唤醒和恢复条件；Individual 自己决定关注什么、是否行动、是否靠近人、是否沉默。
- Orientation 的正确边界是“看见可能的入口”，不是完成解释、安排任务或替主体执行。
- `none` 是正常结果，不是失败。
- Current Attention 不是任务表；Thread 是未来可重新进入的连续性，不等于“现在必须推进”。
- 主动性的成功不是消息数量，而是有没有不依赖人类当前输入、主体自己回去碰一件有连续性依据的事；空手而归也可以是正确结果。
- Xi 的真实案例表明，真正有价值的自驱行为通常有一个“自己的线”：无人输入时阅读、探索、写下东西，之后可以选择分享，也可以不分享。单纯按时提醒人，不能产生这类行为。

这组约束否定两种简单方案：

1. **固定钟点 + “有什么要做的吗？”**：没有事实来源，最终是定时播报。
2. **Harness 直接规定每次 pulse 做 attention/thread maintenance**：把框架设计成道路，而不是给主体提供框架。

## 6. DSH 与外部设计的交叉验证

### 6.1 DSH Agent：现成的安全边界够用

当前 DSH `Agent` 已提供：

- `runMaintenance()`：只从真正 idle 阶段运行非-turn 任务，期间新输入留在 inbox；
- `send(message, target, wakeup)`：可明确选择 `next-turn` 或 `next-step`；
- `steer(message)`：idle 时开 turn，运行中在下一 step 边界消费；被拒的 step 可能让 steering 留在 inbox；
- `inbox.nextTurn` / `inbox.nextStep`：这是 Session 级执行队列，不等于 Loom 的产品级“逻辑 Inbox”。

这说明第一片不需要先建新的 turn queue。需要的是在具体 pulse/外部事件能力中正确使用现有 seam，并记录来源、优先级和 stale 条件。

### 6.2 DSH Schedule：适合明确提醒，不是 Loom 的完整主动性

当前安装的 `@deepseek-ai/dsh-schedule@0.2.0-rc.2` 支持 `after_seconds`、`at`、`every_seconds`、`daily`、`weekly`、`cron`，并把 reminder 绑定到创建它的 Session。它要求 Session Controller 和 `session/flush`，而 Loom 当前是自己的 single-agent `agent-runtime`，因此不能直接作为 Loom 的履行能力。

它最值得借的是契约纪律：

- 任务有稳定 id、标题、原始 Session 归属；
- 修改使用完整 record compare-and-set；
- 重启可恢复；
- delivery receipt 只证明进入 inbox，不证明主体已经执行或完成；
- recurring 只补最新 missed occurrence，而不是无限补跑。

它不能直接回答：什么是主体自己真正想回来的线、什么时候应该叫醒、叫醒后是否行动。

### 6.3 OpenAI MCP Events：外部订阅的边界很清楚

OpenAI 的 MCP Events 文档把订阅拆成：事件发现、用户选择监视目标与处理方式、`events/subscribe`、签名 webhook 投递、异步处理。服务端必须持久化 owner、filter、callback、secret、expiration；订阅 id 要幂等；投递要有签名、重试、去重和可选 cursor/replay。文档还明确要求把用户文本当 data，不要把行为指令塞进 event payload。

对 Loom 的启发：

- 订阅不是一个 Markdown 自由文本解析问题，而是一个有 owner、授权、filter、生命周期和 delivery 语义的外部 Effect；
- 订阅必须对主体可见、可管理、跨 session 持久，否则它不是主体的主动行为；
- event 到达是事实 Input，不是“请立刻按这段文字做事”的隐藏 prompt；
- 没有 replay 的事件必须明确承认中断期间会丢，不能假装可靠；
- 未来可以复用统一的输入信封，但不必现在预建一个通用 Inbox 插件。

### 6.4 OpenClaw：Heartbeat 与 Automation 必须分开

OpenClaw 官方文档把 Heartbeat 定义为 system-owned ambient monitor，把具体的一次性、周期性任务放到独立 Automations。它还提供了几条重要边界：

- 空 scratch 可以直接跳过，节省模型调用；
- scheduled heartbeat 在主队列或目标 session 忙时延后；
- `target: none` 支持只做内部状态、不向外发消息；
- 事件唤醒保留来源和原始路由，不用 monitor 的默认目标重定向；
- 已删除“从对话推断 commitments”这条路径，明确要求用户创建显式 automation；
- heartbeat 不延长 session freshness，静默结果不应污染正常交互。

这与 Loom 的方向高度一致：

- ambient pulse、明确托付、外部事件是三个不同的来源；
- 共享调度基础设施可以存在，但不应把三种语义混成一个“定时任务”；
- “没有需要注意的事”必须是低成本正常结果；
- 来源、路由、忙碌延迟和静默结果必须可观察。

### 6.5 Letta、Generative Agents、MemGPT：支持“连续性重要”，不直接提供触发方案

- Letta 的 Memory & Dreaming / Sleep-time Compute 用后台 agent 把 raw context 转成 learned context，并采用 git-backed MemFS；主 agent 和 sleep-time agent 分工。它证明后台计算可以改善未来 context，但不等于后台计算应该频繁唤醒主体或替主体决定行动。
- Generative Agents 论文的 observation、memory stream、reflection、planning 证明“连续记忆 + 反思 + 规划”可以产生持续行为，但它依赖一个可模拟的世界和明确的环境变化，不能直接作为 Loom 的关系主体运行时合同。
- MemGPT 证明跨层 context 管理和 interrupts 是长期 agent 的核心系统问题；它支持 Loom 继续把 context/continuity 当基础能力，但不决定 pulse 的时机和价值。

## 7. 综合判断：Loom 需要的不是一个模块，而是一条最小闭环

主动性至少有五个环：

```text
有连续性账
  -> 有自己的活动时刻
  -> 看到有来源的事实
  -> 低成本判断是否值得唤醒
  -> 主体自己处置并产生可见后果
  -> 结果回到连续性账
```

缺环时的退化是可预测的：

| 缺少 | 退化结果 |
|---|---|
| 连续性账 | 定时播报 |
| 独立活动时刻 | 永远只在人类的影子里行动；当前 Loom 的状态 |
| 低成本判断 | 主体被频繁叫醒，或者靠硬配额压制 |
| 主体处置权 | Harness 变成任务分配器 |
| 后果与回写 | 重复检查、重复骚扰、无法学习什么有用 |
| 来源与恢复事实 | 外部事件伪装成人类消息，重启/重试时丢失或重复 |

因此，pulse 的正确问题不是“每隔多久叫醒一次”，而是：

> 活动已经冷却到什么程度；有哪些新事实或持续未解决的线；一次便宜判断是否值得把主体叫醒；主体醒来后有没有自由选择安静。

“固定 30 分钟”只能是实现参数，不能是主动性的理由。

## 8. 需要保留与暂时拒绝的设计边界

### 建议保留

1. **活动时间线**：interactivity 与 proactivity 共用 `time-since-activity`；人类输入和主体自己做事都刷新活动时间。
2. **Jev 二元门控**：pulse 只问 `{quiet, attend}`；姿态和具体行动交给主体。
3. **事实直通与心跳分轨**：明确外部变化可以直接形成候选；没有事实时，才由心跳 + Jev 判断是否值得看。
4. **真人优先与 stale admission**：所有来源都要在交付前重新验证，不能让旧 pulse 抢在新真人消息前。
5. **`none` / 空手而归**：没有值得注意的事实时，低成本结束；主体醒来后也可以什么都不做。
6. **可见账**：记录唤醒来源、检查时刻、主体是否行动、是否对外发送、workspace 是否变化、后续人类反应。不要先用配额替代这些反馈。
7. **持久性按来源拥有**：pulse 的时刻、外部订阅的注册、事件 delivery、主体材料各自由对应 owner 持有，不强行统一成一张表。

### 暂时拒绝

1. 现在就建通用 Inbox 插件。
2. 现在就实现 `ahead.md` + 一套固定托付字段表。
3. 把所有 Attention/Thread/Memory 维护器恢复成 legacy 的独立 agent 群。
4. 让 Jev 做召回、搜索或具体行动排序。
5. 给所有主动唤醒预置冷却、每日配额和静默时段；除非真实数据证明结构性约束不够。
6. 从普通自然语言材料中自动猜出可唤醒承诺或订阅。
7. 用主模型每次 heartbeat 都回答“有什么事”，再用规则压制它。

## 9. 还不能提前拍板的三个问题

### 9.1 `source=self` 是否开放

支持 self-source 能让主体拥有不朝向人类的自驱线；禁止它则先只验证“活动时间线 + 既有材料”的最低风险形态。

这是主体性边界，不是技术细节。判断依据应是：

- 是否有足够的可见后果，能让主体知道一个自挂检查是否长期无效；
- 是否允许主体撤销、删除和修改自己的检查；
- 是否有资源上限和失败停用，而不是让 Harness 替它管理一堆永远运行的 watcher。

### 9.2 “检查”与“订阅”用什么表达

当前证据倾向于：

- Harness 不应解析任意 Markdown 里的调度语句；
- agent 可以通过工具或 workspace 中的可执行脚本表达自己的观察者；
- 但脚本不是天然安全或可恢复的订阅系统，仍需要超时、输出上限、失败停用、来源和生命周期账；
- 外部 webhook/MCP Events 需要 connector 持有订阅和 delivery 语义，不能由一个 bash 文件伪装完成。

这还不足以决定 v1 的表达形式。

### 9.3 Pulse 的 state 到底放什么

已经有证据支持的字段：

- 当前本地时间；
- 距上次活动、距上次人类互动；
- 当前是否有运行中的 turn/maintenance；
- 最近有限的对话或活动证据；
- attention、threads 及其派生年龄；
- 自上次检查后是否有新事实、workspace 是否变化；
- 最近若干次 pulse 的处置结果与人类反应。

尚无证据支持直接加入的字段：

- “今天主动了几次”作为主要判断依据；
- 固定静默时段；
- 大量聚合评分或“价值”字段；
- Jev 直接读取完整 workspace 或自动搜索历史。

## 10. 下一轮实验，不先改产品代码

### 实验 A：把当前 after-interaction 做成可标注基线

对已有 43 次 Jev 判断逐条记录：

- state 摘要；
- `P(quiet)` 与姿态；
- 主体是否调用工具；
- 是否调用 `message`；
- workspace 是否发生有意义变化；
- 后续人类是否回应，以及回应是否推动了同一条线。

目标不是拟合一个漂亮阈值，而是区分三种错误：

1. Jev 判 quiet，但主体本来会产生有价值的私人行动；
2. Jev 判 attend，但主体看到后正确选择安静；
3. Jev 判 attend，主体产生了重复、无依据或扰民行为。

### 实验 B：shadow pulse

不向主体 steer，只在后台按候选活动时间线运行：

```text
活动冷却
  -> 组装 pulse state
  -> Jev {quiet, attend}
  -> 记录结果，不唤醒
```

至少覆盖：

- 人类连续交互后冷却；
- 长时间无人输入但 attention 有旧线；
- attention/threads 没变化；
- workspace 有主体自己刚做出的变化；
- 深夜；
- 服务重启后首次检查；
- Jev state 缺失或材料截断。

这一步验证“触发事实有没有信息量”，不让主体承担错误成本。

### 实验 C：内部-only real pulse

shadow 有稳定样本后，才让一次 pulse 唤醒主体，但：

- 只允许内部 workspace 行动；
- 默认 `target: none`，不允许外发；
- 记录 `quiet / private action / no-op / attempted outbound`；
- 真人输入在 Jev 调用和交付前都能使其失效；
- 不把 pulse 自己的结束重新当作活动触发源。

### 实验 D：第二个真实 Input 来源

只有实际出现一个外部事件或主体自挂检查后，才验证：

- source kind 是否能贯穿 channels、after-interaction、time-context、continuity；
- 事件是否可持久、去重、过期、重放或明确丢失；
- 输入进入现有 DSH inbox 的哪个边界；
- human、event、pulse 同时到达时谁拥有 admission；
- delivery receipt 与主体完成证据是否被分别表达。

## 11. 信心等级

- **高信心**：当前 after-interaction 的主体性边界、legacy 的真人抢占/stale admission/持久 pulse 状态、DSH `runMaintenance`/`steer` 语义、MCP Events 的订阅与 delivery 纪律、OpenClaw 的 heartbeat/automation 分离。
- **中高信心**：Loom 的第一缺环是独立活动时刻，而不是更多认知器官；pulse 需要低成本二元 gate；外部事件应作为事实 Input。
- **中等信心**：活动锚定比固定墙上时钟更适合 Loom；workspace 自写检查比固定字段表更符合当前主体工作方式。两者仍需 shadow/真实部署验证。
- **低信心/未验证**：Jev 在更广泛中文 pulse state 上的阈值；主体是否会使用材料年龄；self-source 是否会形成有价值的非服务型自驱；任何具体 cadence。

## 12. 主要来源

### Loom / DSH

- 当前：`src/after-interaction/index.ts`、`src/after-interaction/materials.ts`、`src/after-interaction/verdict.ts`、`src/agent-runtime/runtime.ts`、`src/contracts/index.ts`、`src/time-context/projection.ts`、`src/workspace-history/index.ts`、`src/resident-context/entry-ages.ts`。
- legacy：`origin/legacy` 的 `docs/architecture.md`、`docs/cognitive-organs.md`、`.scratch/archive/harness-layers/issues/14-form-proactive-opportunities.md`、`17-maintain-current-attention.md`、`28-schedule-proactive-pulse.md`、`33-soft-split-long-activity.md`、`35-schedule-after-chat-continuation.md`、`50-prioritize-human-input-over-orientation.md`。
- DSH：`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`、`node_modules/@deepseek-ai/dsh-schedule/README.md`、`node_modules/@wowyuarm/dsh-jev/README.md`。

### 外部一手资料

- OpenAI MCP Events：<https://developers.openai.com/plugins/build/mcp-events>
- OpenClaw Heartbeat：<https://docs.openclaw.ai/gateway/heartbeat>
- OpenClaw Automation：<https://docs.openclaw.ai/automation>
- Letta Memory & Dreaming：<https://docs.letta.com/configuration/memory>
- Letta Sleep-time Compute：<https://www.letta.com/blog/sleep-time-compute/>
- Generative Agents：<https://arxiv.org/abs/2304.03442>
- MemGPT：<https://arxiv.org/abs/2310.08560>

### nmem 检索到的相关长期记忆

这些是某个 Individual 私有记忆库的条目 id（**已脱敏为 `mem-1`…`mem-6`；原 id 指向私人材料，不属于工程仓库**）。保留它们只是为了说明结论来源可追溯：

- `mem-1`：Framework 提供时间、空间、事实与行动条件，Individual 保留主动性。
- `mem-2`：Orientation 可返回 `none`，不制造虚假方向。
- `mem-3`：Orientation 工具过大、反空转约束过强会越界成行动器官。
- `mem-4`：Orientation 只能递方向，不能模拟主体的人格层替它下结论。
- `mem-5`：Orientation 与 background 的“感知/行动”职责边界。
- `mem-6`：Loom 定位为面向长期关系主体的 agent runtime，主动性与私人连续性是架构约束。
