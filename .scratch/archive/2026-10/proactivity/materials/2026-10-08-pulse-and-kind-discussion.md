# 主动性讨论记录：基于 Jev 的 Proactive Pulse 与非 user 唤醒机制（2026-10-08 晚）

**性质**：讨论记录与收敛设计沉淀。保留完整原始输入、讨论过程中的关键思想转折、现有代码事实与边界情况防线，供后续方案收敛与 ticket 编写依据。

---

## 0. Human 本次原始输入（按时间序逐字保留）

### 0.1 开场
> 我们来讨论Loom的proactivity怎么去做吧。

### 0.2 视角追问（要求站位自身与主体）
> 你怎么思考？你怎么想的？我先不说我的回答。如果让你站在自己去思考主动性呢？你是loom agent呢

### 0.3 引导对照历史实现
> 很理想化的思考。可以先看看legacy loom怎么做的吧

### 0.4 指出过度工程与追问下一步
> 过去loom很多也是过度工程的设计。只是让你看看。关于input抽象不就是一个inbox模型？如果现在让你拍下下一点该做的，有什么想法？

### 0.5 否决预建 Inbox 插件，指出当前核心缺口
> 不行，这样也是过度设计，如果我们后续不走这个inbox而有其他的呢？我觉得现在当务之急的主动性是需要让agent有能力不被user_input唤醒，而可以是其他kind？

### 0.6 肯定 kind 分流方向，回归核心场景
> 你这个kind挺不错的，尤其是“周边插件的行为分流” ，如当前的不是user kind就不触发after-chat interaction，同时也让input我们可以在prompt层做一些如[system-reminder]等给模型agent看的引导文本；kind是一个方向，但不是单独设计kind，而应该是在实现功能过程中去做。我们回到你最开始提出的问题吧，我在让你看legacy loom前的那些

### 0.7 明确核心目标、Jev Pulse 路线与兜底退路
> 1. 问题一我认为是这样的，“账的衰老与超时提醒” 你说得很抽象，但核心我认为是让agent被唤醒并且去推进attention与threads其他其workspace自己的内容；我们不定义任何事清，让agent自己去做。可能考虑做的是pulse？但是基于jev的pulse，可以做得很频繁。如何定义jev的state输入至关重要。后续在这个基础上让agent主动订阅再去扩展吧；2. 问题二是后续扩展主动性，先不考虑太多；3. 让agent自己决定，本来就不是定义的主动，而是jev根据state的可能的决定。甚至如果jev效果不好的话，我们考虑会回到orientation 单独organ agent那种过去的机制

### 0.8 肯定 State 中的客观状态设计
> 你对于state的发散设计很不错，尤其是如git状态（尽管当前没有）

### 0.9 尖锐质询：为什么需要 Pulse？避免盲目定时器
> 以及是文件变更等，都很不错。关于jev判断状态以及是否使用如choice等其他输出，这需要我们再将为什么需要这个pulse来说清楚？但是如果这个pulse只是固定一段时间就pulse让jev来，其实还不如直接去通知？因此其实这里的pulse可能也要依托于一些状态（不过当前没有什么来使其达成？

### 0.10 提出“客观状态直通”与“Jev 极粗二元门控”
> 有意思。“客观状态变化”可以直接pulse，否则让jev进行判断，且jev判断应该粗粒度再大，甚至不是当前的这三种（这里我也没想好），agent自己决定做什么才是更进一步细一些。

### 0.11 指出 edge cases 与要求整体梳理
> 是好一些。但可能还有一些edge case没考虑清楚。我们当前这里是去将让agent管理好其自己来做好。其实有些偏向pulse 可以整体回顾梳理下这一套设计

### 0.12 沉淀文档要求
> 先收一份文档吧。重点保留我们的原始inputs，不要太过压缩信息量

---

## 1. 讨论过程与核心思想转折脉络

本次讨论经历了四个关键的认知转折，直接决定了当前设计的形态：

### 1.1 从“第一人称理想化设想”到“对照 Legacy Loom”
- **起初发散**：助理站在 Loom Agent 视角提出“不要闹钟、不要配额、给我一个静默工作的回合、给我工作区里的 watcher”。
- **批评与锚定**：Human 指出这“很理想化”，要求查阅 Legacy Loom（`Loom-old-archive`）的实际做法。
- **查阅发现**：
  - Legacy Loom 拥有统一的 SQLite `inputs` 表，所有触发（真人 channel、`orientation` 的 `opportunity`、`after-chat` 的 `continuation`）都作为 Input 行排队推进；
  - 拥有 `supersede` 抢占机制（真人输入立刻打断后台运行的 Orientation）；
  - 拥有独立的 Cognitive Organ `Orientation`（作为 Framer，只读证据，只产出 1~3 句 narrative，不给人类发消息，不分配具体任务）；
  - 拥有独立的 `Attention Maintainer`（每 6 小时大模型运行一次，根据“是否改变个体表达”修剪 attention.md，解释了为何 Legacy 的 attention 不堆积）。
  - **代价**：每个器官都是独立的 Pi coding agent session，跑一次 LLM，成本高、延迟高、且捆绑了 4500 行的单体 SQLite 状态机引擎，过度工程严重。

### 1.2 破除“自建 Inbox 插件”的再过度设计陷阱
- **助理一度误判**：试图在当前 Loom 里新建一个轻量的持久 Inbox 插件，统一所有 inputs。
- **Human 及时叫停**：指出这同样是过度设计——如果我们后续不走这个独立的 Inbox，整套存储与调度就是无用功。
- **直击真实命门**：当前 Loom 最紧迫的卡点，不是缺一张队列表，而是 **Harness 缺乏能力让 Agent 被 `user_input` 以外的其它 `kind` 唤醒**。

### 1.3 确立非 `user` 唤醒与周边插件分流
- 现在的代码在 `src/agent-runtime/runtime.ts` 的 `deliver(text)` 里**硬编码**了 `source: { kind: 'user' }`。
- 只要输入进系统，所有周边插件（`channels`、`after-interaction`、`time-context`）和模型本身都以为“人类说话了”，强行要求回复闭环。
- **共识**：解开 `deliver` 的 `source.kind` 限制，不单独抽象一个虚无的 kind 机制，而是在实现具体功能时自然引入，并做好周边插件的分流。

### 1.4 为什么需要 Pulse，以及解决“盲目定时器”的矛盾
- **定位**：Pulse 的唯一意义，是让 Agent 在“人类缺席”时，能够醒来去**推进与管理自己的 `attention`、`threads` 和 `workspace` 内容**；Harness 不为它定义具体任务，交由 Agent 自己做。
- **矛盾**：如果 Pulse 只是每隔固定一段时间无脑去问 Jev，在材料没变时 Jev 会一直给出相同结果，纯属空转；如果总是问 Jev，为什么不直接通知主模型？
- **破局**：
  - 直接通知主模型太贵（每轮几万 token 进出），Jev 必须充当一厘钱的低成本守门人；
  - 提出**双轨触发机制**：
    - **客观硬状态变化（直通轨）**：有明确事实发生时（文件变化、外部事件），直接 Pulse，不需要 Jev 猜谜；
    - **背景心跳（Jev 门控轨）**：处于常规静默时，由 Jev 结合时间节律与材料衰老事实做低成本过滤。

### 1.5 Jev 粒度的大撤退：二元门控 vs 主体细粒度
- 在 `after-interaction` 中 Jev 选的是 `{ quiet, speak, act }`。
- 但在 Pulse 场景下，Jev 只有 2KB 极简上下文，在门外替主体猜测“去发消息还是去写代码”属于越俎代庖。
- **共识**：Jev 的粒度退到**超粗二元门控 `{ quiet, attend }`**。
  - Jev 只回答：此刻应不应该唤醒主体？
  - Agent 醒来后，自己决定是改文件、推进笔记、找人类，还是保持沉默。

---

## 2. 关键机制与代码对接事实

### 2.1 现有代码中的硬编码缺陷
在 [`src/agent-runtime/runtime.ts`](../../../../../src/agent-runtime/runtime.ts#L172-L178)：
```ts
deliver(text: string): boolean {
  const agent = this.handle?.agent
  if (agent === undefined) return false
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  agent.steer(message)
  return true
}
```
`deliver` 无法传入来源类型，外部任何输入都被盖章为 `user`。

### 2.2 接口改造与非 user 唤醒
`deliver` 扩展支持传入 `MessageSource`：
```ts
deliver(text: string, source?: MessageSource): boolean
```
对于 Pulse 唤醒，递送 `source: { kind: '@loom/pulse' }`。

### 2.3 周边插件分流纪律（核心守则）
当且仅当输入的 `source.kind !== 'user'` 时：
1. **`channels` 旁路追问**：
   [`src/channels/index.ts`](../../../../../src/channels/index.ts) 中的 `UnansweredReplyWatch` 仅在 `source.kind === 'user'` 时标记 `inboundArrived()`。对 `@loom/pulse`，模型写了文本但未调用 `message` 工具是绝对合法的内部思考，严禁弹出 `unansweredReplyNotice`。
2. **`after-interaction` 严禁布防**：
   严格守住 §4a① 铁律。`src/after-interaction/index.ts`（后被 pulse 取代，见 `src/pulse/`）必须确认刚结束的 turn 是由 `source.kind === 'user'` 开启的。非 user 唤醒产生的 turn 结束后，**绝不挂静默闹钟**，杜绝自激死循环。
3. **`time-context` 防污染**：
   不更新 `lastHumanInputTime`，人类未开口的客观事实不被覆盖。
4. **`context-continuity` 标记临时通知**：
   在 [`src/contracts/index.ts`](../../../../../src/contracts/index.ts#L122) 中，将 `@loom/pulse` 登记进 `ephemeralNoticeSourceKinds`。Session rollover 换代时，此类引导通知不按历史文本机械继承，保持主线干净。

### 2.4 Prompt Framing 姿态引导
给主模型的输入带有明确的语义信封：
```text
[SYSTEM PULSE] It is a quiet moment. Your attention and workspace are present for you to attend to, advance, or maintain. You may take action in your workspace, or end the turn if you choose to remain quiet.
```

---

## 3. Jev Pulse State 的定义事实

State 是 Jev 能够做出准确判断的唯一依据。为了让 Jev 理解“Why Now”，State 由以下四维事实构造：

1. **时间与节奏事实（Temporal & Rhythm）**：
   - 当前本地时间（例如：`14:30 (workday afternoon)` vs `03:20 (midnight)`）；
   - 距上次真人交互过了多久（`last human input: 18 hours ago`）；
   - 距上次 Agent 活动过了多久（`last agent activity: 4 hours ago`）；
   - 今日已主动唤醒次数（`proactive wakes today: 2`）。
2. **材料客观状态与衰老（Workspace Lived Evidence & Staleness）**：
   - `attention.md` 原文（带 2000 字符保护）；
   - `threads/index.md` 活跃线；
   - **材料的时间标尺**：`attention.md (last modified: 3 days ago)`；
   - **工作区变动事实**：是否存在未提交的 git 改动或新产物（如适用）。
3. **人类最后交互基调（Last Human Stance）**：
   - 人类最后说的 1~2 句话（例如“去睡了”“你在看哪个”），给 Jev 提供人机关联坐标。
4. **解决“复读”的核心状态标志**：
   - `human_interacted_since_last_pulse: boolean`。
   - 若上次 Pulse 后人类没有新反应且工作区无变动，明确告知 Jev 这一事实，抑制重复唤醒。

---

## 4. 关键边界情况与防线（Edge Cases & Defenses）

### 4.1 真人消息绝对抢占（Preemption）
- **Jev 评估中 / 待投递时**：若 Agent inbox 中已有 `user` 消息，或最新人类消息时间晚于快照时间，Pulse 立即放弃（step aside），不向 Session 投递。
- **Turn 运行中**：人类消息走 DSH steer 在下一个 step 边界插入。模型 prompt 始终明确：真人现场输入拥有最高优先级。

### 4.2 自激死循环与冷却窗口（Runaway & Cooldown）
- Agent 醒来修改了 `attention.md`，导致文件 mtime 变动，容易误触下一次脉冲。
- **防线**：
  - 两次 Pulse 之间必须有**硬性最小冷却时间**（例如 30~60 分钟）；
  - 每天设置全局自主唤醒配额上限（例如 4~6 次），防止失控跑飞。

### 4.3 深夜与扰民边界（Quiet Hours & Outbound Danger）
- **风险**：Pulse 在凌晨唤醒 Agent，Agent 自行调用 `message` 工具把人类吵醒。
- **防线**：
  - Jev 的 State 注入本地时间，引导其在深夜倾向于 `quiet`；
  - **夜间 Prompt 约束**：若在静默时段（如 23:00~08:00）触发，Framing 加入强约束：
    `[SYSTEM PULSE (NIGHT)] It is late night. You may perform quiet workspace/memory maintenance, but DO NOT send outbound messages to the human unless there is a critical system emergency.`

### 4.4 “无效复读”死结（Stagnation Loop）
- **风险**：某条线挂了很久，Agent 每次醒来看了看又放回去，导致 Jev 每次都唤醒。
- **防线**：
  - 状态中显式注入 `human_interacted_since_last_pulse` 和 `workspace_changed_since_last_pulse`；
  - 若两者均为 false，Jev 指令明确要求保持 `quiet`。

### 4.5 会话上下文膨胀（Context Pollution）
- **风险**：多次静默回合导致 Session 历史充斥着无人接收的思考和引导文本。
- **防线**：
  - `@loom/pulse` 纳入 `ephemeralNoticeSourceKinds`；
  - 换代或压缩时重新推导，不作为真人对话历史污染上下文。

---

## 5. 兜底退路与未来扩展

1. **兜底退路（Fallback）**：
   若真实部署后发现 Jev 的二元判断能力无法胜任（例如对复杂 attention 的辨识度不足、漏判或误判严重），**整套交付与周边插件分流结构完全不变**，仅将 Jev 调用处无缝替换为类似 Legacy Loom 的独立轻量 `Orientation` subagent。
2. **未来扩展（Active Subscriptions）**：
   在 Pulse 骨架稳定之后，Agent 在 workspace 里自主设置的 Watcher 脚本、MCP Events 监听或外部 Webhook，其回调结果均作为“客观硬事实”，直接并入**轨道一（直通轨）**唤醒 Agent，不再需要重新发明调度框架。
