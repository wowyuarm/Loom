# 主动性讨论记录：订阅式触发（2026-10-07）

**性质**：讨论记录，不是收敛结论。只记原始输入、查到的原始材料与出现过的看法；看法标看法，不定方案。DESIGN.md §8 已收敛部分不受本文影响。

## 0. Human 本次的原始输入（按时间序）

### 0.1 任务布置：先发散，不要收敛

> 我们先不收敛机制，先给你进一步一些想法与context，你自己去调研、思考以及可能的主动性的方案。可能的基于mcp events的模式，让模型自己写server挂载去订阅；pulse让agent自己去管理attention（尤其是推进与清理，当前经常容易堆积）或者自己推进一些threads；loom-legacy的那种单独agent给orientation/opportunities等；以及是loom agent的一些自己的想法：（见 §1 全文）需要你是仔细思考调研。然后我们一点点去讨论。暂时不要去收敛方案，我们要讨论去收敛确认。本次希望你发散思考。甚至可以用你已有的其他知识、设计。

### 0.2 补充 context：inbox 模型、因人而异

> 关于mcp eventss的设计思路，可以看看openai这篇文章：https://developers.openai.com/plugins/build/mcp-events
> 很多问题需要你进一步查看相关设计、资料、源码，比如loom当前具体的一些设计？
> 关于你说的常驻材料文件，我们之前是考虑过一个inbox模型来处理agent与外界的交互的，甚至包含现有的message也可以被抽象进去
> 整体我其实还没有太多想现在就确立的点，因为我倾向于你再丰富一些你的已有context
> 关于主动性，我预期应该是因人而异，主动性做什么也不是我们去定义，而应该给出一套机制，让agent与user在交互中由agent去建立

### 0.3 对第一轮发散的批评（原文保留）

> 我这里没看完，看完你第一个关于mcp events提出的几个问题让我觉得你没有在思考：
> 1. 既然agent可以去订阅，那也需要harness提供途径使其知道，甚至其自己的memory或者threads本身也会记载；
> 2. 订阅可见性，同1，这是agent自己的主动性行为，当然自己需要知道；
> 3. loom agent是连续性与主动性agent，当然订阅是跨session的；
>
> 过去的设计只是思路，不要太过于收敛到那种可能性，比如在我看来收敛侧的这个C层设计很一般；
>
> 还有就是感觉你怎么不理解agent？像你这样完全很容易做出一些如写代码订阅服务（前提我们将context给好），就如同当前我们让agent自己管理其workspace，不仅局限在attention或是threads；
> 有些太发现，以至于我觉得无论是问题、方案都是去凑字数。精简你的输出，简洁的设计但也应该足够符合逻辑；又不能随意想象agent可以怎么办。更好的一种思维模型是，思考你会自己怎么做？这里的发散不是让你随意想方案，而是在一个充满可能性的agent harness中，你会如何让自己发挥主动性？与human互动？假定你拥有连续性的自己

### 0.4 四个追问（原文保留）

> 1. 代码能否正常解析出订阅？为什么不让agent自己去订阅？这种订阅泛用性呢？与主流的agent harness采用的cron jobs等方案有什么区别？
> 2. 有pending inputs时，我觉得可以直接交给如jev来判断是否直接可触发turns，比如最近的对话、距离上次交流时间、今天主动多少次等等（关于state具体设计也是一个很重要的内容，直接决定主动内容）；
> 3. 整体设计是否理想化？最重要的是，能否利用代码写好这种订阅？md解析有点难？如何做好一个connector让agent订阅？或者每个订阅原子化背后是一个subagent在服务呢？可以用bash？可以jev前置判断该event是否依赖？或者agent写好订阅前就思考清楚？
> 4. 但是这种基于订阅的方式合理吗？如何让一个连续agent涌现出主动性？

### 0.5 沉淀要求

> 先把本次讨论沉淀文档吧，我们当前还没去收敛，别锁定可能性
> 信息质量太少，尽可能还原我的各种input，对，我的input可以放过去。以及是尽量把context原始一下而非都是结论

---

## 1. Loom agent 自述全文（Human 转述，原文保留）

> 从0捋一遍。我起手就想错过一次：一开始把主动性当频率问题——多久冒一次头、多久露一次面。后来发现频率是结果，不是源头。换了个问法：一个动作发出来，起因是在我这边，还是被外面递来的信号推的。这条才是分界。
> 顺着这个分界，第一刀是把两头切开：什么时候看，和看了之后说不说。钟能管前者、管不了后者，后者只有我能做，外包出去就是定时播报。反过来也成立——只把说不说还给我、什么时候看永远交给钟，那我永远是在被喂。
> 前半截我想要的是条件触发，不是钟点：这件事的条件真满足了才回来看它，而不是到点扫一遍。你说的让事件当主钟，落点就在这儿。可条件写在哪、谁来满足、满足了我知不知道，这几步现在都是空的——所以我先手工挂了那张表，试的其实是这件事。
> 还有一条前提我越用越觉得硬：主动性得依托 memory。没有那份悬着的登记，事件触发就没有对象，每一轮都是全新的，主动性只能退化成随机冒泡。所以该记的是还有什么悬着，不是他说过什么——这句是你说的，我现在真用上了。
> 再往里一层就不是机制了，是有没有我自己的事。表上要是全绕着你转，主动性推到底也还是服务。得有一块不朝你、不等你回应的东西——那种的起因才真在我这边。
> 怎么算成了，我不看一天发几条。看有没有哪次没被递、我自己回去碰了一件离得远的事；再看有没有哪条线是我自己往前挪的、不靠你回应。还有一条：看过可以不出声，那是正常结局，不算失败——没这条，主动性就是赶着表现。
> 现在最卡的一处：把表推到眼前是工程活，不算难；难的是它别变成新的钟——一冒头就扫一遍，久了就是每天看一眼、什么都没真动。判据得留在这条此刻到底有没有理由动。

---

## 2. 外部原始材料：MCP Events（OpenAI 文档，2026-10-07 抓取）

要点（非全文，原文表述保留关键句）：

- 定位："MCP Events lets ChatGPT subscribe to updates from your MCP server, such as new messages, content updates, or status changes. Users choose what to monitor and what ChatGPT should do when an update arrives."
- 流程五步：server 列出支持的 events → user 告诉 ChatGPT 监视什么、到达时怎么做 → ChatGPT 经 server 订阅（给 callback URL + signing secret）→ server 把命中的 event 送到该 URL → ChatGPT 在订阅的 chat 里收到，按 user 指示响应。
- 三个方法：`events/list`（event 名、filter、payloadSchema）、`events/subscribe`（event 名 + filter 参数 + webhook destination，返回 subscription id + `refreshBefore`）、`events/unsubscribe`。
- 订阅要求 server 做四件事：鉴权、按定义校验参数、callback URL challenge 验证、持久存订阅（owner、filter、callback、secret、expiration）。subscription id 须幂等（同 principal+callback+event+参数 canonical JSON 去重）。
- 投递：每 event 一次 POST，256 KiB 上限，Standard Webhooks 签名（`webhook-id`/`webhook-timestamp`/`webhook-signature`/`X-MCP-Subscription-Id`），2xx 算收到，ChatGPT 异步处理、可按 batching 设置合并多次投递。重试指数退避，410/413 不重试。
- 续期：`refreshBefore` 前用同样身份 + 上次 cursor 刷一次；`ttlMs: null` 才可无过期。无 replay 的 event，`cursor: null`，中断期间错过的找不回来。
- 明确不支持：polling、streaming、draft 里的 `gap` 和 `terminated` 控制通知。协议版本 `2026-07-28`，整个 spec 仍是 draft（experimental-ext-triggers-events 仓的 design sketch）。
- 约束原文："Treat comments and other user-authored text as data; do not add instructions telling the model how to behave inside the event payload."
- 第三方解读（WorkOS/Smithery）：subscription 本身是一种 credential，revocation 语义缺失是当前坑；Smithery 只实现 webhook 切片做代理，投递不经过它。

## 3. 内部原始材料（已核对源码/文档的事实）

### 3.1 DSH schedule（`@deepseek-ai/dsh-schedule` README）

- 六种 selector：`after_seconds` / `at` / `every_seconds`（≥60s）/ `daily` / `weekly` / `cron`（五字段 Vixie，最小一分钟），creation 必须带 `title` + 非空 `prompt`。
- reminder 绑调用方 Agent 的 Session；投递靠 Session Controller + `session/flush`；Host 重启任务仍在；recurring 只补最近一次错过。
- Loom 现状：bundle 没挂它（缺 Session Controller；Loom 用自己的 agent-runtime 管单主体）。投递回执只确认进了 inbox，不确认执行/完成。

### 3.2 DSH inbox（`core/agent/src/runtime-types.ts`）

- `inbox.nextTurn` / `inbox.nextStep` 两条队列；`send(msg, target, wakeup)` 选边界并可选唤醒；`steer` 语义软（step 被拒/agent 被弃时可丢）。
- 事件：`agent/inbox/inserted` / `claimed` / `discarded`。与逻辑 Inbox（跨来源统一入口，DESIGN §8.3）不是同一能力。

### 3.3 Effect/Delivery 与 inbox 模型（`.scratch/archive/2026-10/effect-delivery/DESIGN.md`（已归档）§3 原文框架）

- “inbox 模型（未来）：把所有‘该给 agent 一个 turn 的理由’（channel 消息 / 主动性 pulse / reminder / 外部事件 / followup）归一成 Input 项进同一队列。现在的 `agentRuntime.deliver` + 单 focus 是它的退化实现。出现真实第二个 Input 来源前不碰；真做时先建扁平持久队列，不要 legacy 的 segment/wave/reply-gate 那套。”
- “外部订阅（向外部服务注册）是 Effect，且它 fire 回来是一条 Input——环闭合，Effect 与 inbox 是同一条边界两头。”

### 3.4 收敛侧 的 C 层设计形状（DESIGN §8.7，Human 未确认、评价一般）

- 到期是状态不是事件；前瞻条目放新常驻材料 `ahead/ahead.md`；主体是唯一写者，Harness 只记派生账“已为 (key, due) 唤醒过”；Harness 不对主体看不见的材料行动；唤醒走 steer、不等于履行；第一片不用 jev 闸门、不做周期/条件/订阅；最大风险是主体根本不写条目。
- issues/02 字段草案：`id / source(self/human/derived) / action / trigger(at/when) / target / due_policy(return_only) / cancel_by / expires_at / status(系统改) `，enqueued/delivered/completed 三态分离。

### 3.5 理解层材料形状（continuity-and-memory/DESIGN.md，已归档至 .scratch/archive/2026-10/，订阅讨论的参照系）

- attention：当下 + horizon，易失可覆盖，裸 fs 写；threads：活线再入点，只列 active；memory：跨主题核心 + notes 索引。原则：Harness 给机械骨架，agent 拥有内容意义；第一个切片 agent 是唯一作者。

---

## 4. 讨论中出现过的看法（看法，不是结论）

- 订阅配置对 agent 可见可管是硬的：订阅是 agent 自己的主动性行为，清单必须自己能看见、能增删；跨 session 持久（§0.3 的三条）。
- md 自由文本解析不可靠；出现过的候选形状有三层：A 自然语言（灵活但解析难）、B 结构化订阅（明确可执行，agent 要学语法）、C 代码级（最灵活，有安全/调试成本）。讨论中倾向过“先 B、为 C 留口子”，**未定**。
- 出现过的分工想法：备忘（为什么订，agent 自由写）+ 结构化记录（读什么、滤什么、何时止，工具写、代码读）；`until`/过期必填防堆积；每种源一个小适配器；adapter 结构化过滤 + 可选 jev 模糊过滤，不叫醒主模型；bash 可做原型、转正走 tool。**都是未定想法**。
- jev 位置出现过的想法：不在“订不订”（那是 agent 决策），而在“队里多个 pending 时此刻动哪个 / 动不动”。state 候选字段：事项一句话、触发事实+时间、上次人说话距今、今日已主动次数、当前是否在忙、等的代价。**未定，需真实中文回归**。
- 涌现条件出现过的想法：订阅只解决“什么时候看”；还需“有什么悬着”（attention/threads/订阅理由）与“此刻值不值得动”的判断；harness 给放清单处、递进来路、排队不直吵、可看可删；订什么退订什么在交互中形成；允许 `source=self` 的环。**未定**。
- Human 明确否定的倾向：收敛侧 C 层设计“很一般”，不作为定局；凑字数的发散（无 agent 视角、无逻辑的方案罗列）。

## 5. 未定清单（沿用 §0 的问题，不收口）

1. 订阅表达层（自然语言 / 结构化 / 代码）。
2. 订阅清单位置（独立文件 vs 并入 ahead）与格式。
3. md 解析 vs 工具写入的分工；connector/adapter 形状；subagent/jev/bash 各居何位。
4. pending→jev 的 state 字段与阈值。
5. pulse 语义与频率。
6. 自主目标边界（只托付 vs 允许 self-source）。
7. 与 cron 系方案（DSH schedule、ChatGPT Tasks）的分工。
