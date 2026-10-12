# DESIGN：连续性 agent 的 session 与 memory

**Status:** 设计收敛快照——只定语义和决策（what/why）。DSH 落法（how）见各 module 文档。源码落地后以代码为准。
**last-checked:** 2026-09-21

本文覆盖一个持续运行的 agent 如何跨 session 连续存在：记忆怎么分层、每轮醒来看到什么、怎么写、怎么召回。不覆盖主动性（下一个工作项）。落地映射见 [materials-module.md](materials-module.md) 与 [continuity-module.md](continuity-module.md)。

---

## 0. 一句话

一个 agent 的记忆分两层：**记录层**（session log，自动写下、靠搜索召回）和**理解层**（少量常驻材料，agent 自己维护、引用记录层）。Harness 只提供机械保障（投影、预算、来源盖戳、一致写入、崩溃恢复），从不决定"什么值得记、什么该忘"——那是 agent 的判断。

---

## 1. 两层心智

```
  记录层（自写，零 agent 成本）
    └─ session log ── 每个 turn / 工具调用 / 消息都在，逐字、append-only
                      via context_search（按内容）+ context_read（按引用）

  理解层（agent 维护，少量，引用记录层）
    ├─ identity.md      我是谁              （根，最高门槛，极少改）
    ├─ attention.md     此刻带着什么        （当下，带 horizon，易失，会冲掉）
    ├─ memory.md        长期理解核心 + 索引  （沉淀，跨主题，随学习变）
    │    └─ notes/       按需 grep，引用 session 当证据
    └─ threads/         活线导航 + 各线全貌  （活，可再进入）
```

**关键**：记录层由 `dsh-session` 自动产生。旧 Loom 的 daily（手写"今天发生了什么"）**砍掉**——那是在把 session log 誊写一遍。session log 就是那一天，搜索就是翻日记。

### 每块答一个不同的问题（所以都常驻、谁也不冗余）

| 材料 | 回答 | 时间性 | 门槛 |
| --- | --- | --- | --- |
| identity | 我是谁 | 最稳，极少改 | 最高 |
| memory 核心 | 我始终得记着什么（跨主题） | 沉淀，随学习变 | 高于 attention/threads |
| threads/index | 哪些线还开着 | 活、话题性 | — |
| attention | 此刻带着什么 | 当下、带 horizon、会冲掉 | — |

两条轴放一起看：

```
                话题性                跨主题·始终
   活·当下      attention 项           attention 的"底色"部分
                threads/index
   已沉淀       notes（按需）          memory 核心
                memory 索引（常驻）
```

---

## 2. 记录层：session log 与 search 双通道

- session log 是 append-only 事件日志（DSH `dsh-session`），agent 不用手写，干活自然留下。
- 召回走 `@wowyuarm/dsh-context-continuity` 的两个工具，**两者同等一等公民**：
  - **有引用 → `context_read`（按 ref 精确展开）**：note 里存了来源戳，要原文时直接展开，准，不用搜。
  - **无引用 → `context_search`（按内容发现）**：没戳或跨话题探索时按内容搜。
- 未来 jev 可在 search 候选上做相关性重排（见 §7），接口按"候选 + 可插入重排器"设计。

---

## 3. 理解层：每个文件的形状

原则贯穿全部：**Harness 给机械骨架（文件布局、预算、来源戳），agent 拥有内容（形状与意义）。** 不给内容 schema 的地方，是因为给了会把活的东西压成一个模子。

### 3.1 identity.md —— 不给结构，只在 prompt 里讲清它是什么

不给模板。prompt 心智里这样描述：

> identity 是你对"自己是谁"的当前理解。它是所有材料里改动门槛最高的——它是你判断"其它一切什么重要"的根。它不是简历、不是 profile 表格，是你自己的自我感，极少、且慎重地改。日常的判断和关切从它长出来，但它本身不随几天的事波动。

给格式就是替 agent 规定它是谁，所以不给。给一个空锚点文件即可。

### 3.2 attention.md —— 给结构（要跨多次 handoff 还能被读懂）

每项三字段 + 可选 thread 指针。**horizon 是 attention 独有的**——agent 写时声明"这事大概带多久"：

```markdown
# Attention

## 在设计 Loom 的 memory 层
- horizon: 这几天
- 现在: 三轴模型定了，在敲 attention/threads 的结构
- → thread: loom-memory

## 等 X 的回复
- horizon: 到本周末
- 现在: 已发出，等回音
```

- attention 可以更像流水（易失、会覆盖，随手记没负担）。
- horizon 到期是"该掉出或提升"的触发信号（见 §5 生命周期）。
- 用**裸 fs 工具**写（就地重写，无"note+索引"配对问题）。

### 3.3 memory.md —— 核心段 + 索引段

唯一"既是索引、又有常驻正文"的文件。核心段的判断标准一条：

> **核心 = "不是每轮都在，就会判断出错"——跨主题、始终适用的长期结论和规矩。**
> **note = "只有涉及那个话题时才需要"——话题性、按需取。**

```markdown
# Memory

## 核心（每轮都在，always binds）
少量。跨主题的长期结论、原则、关系相关的稳定事实。不是话题事实。目标很小。

## 索引（路由，不是正文）
- <主题簇> → notes/<簇>/
- <概念>   → notes/<概念>.md
```

- **核心段与索引段的写入路径不同**：核心段是常驻正文，就地重写，走**裸 fs**（和 attention 一样，单文件无配对问题）；索引段由 memory 工具写 note 时顺手 upsert（见 §4）。memory 工具不碰核心正文。
- 东西会"毕业"出核心：曾经跨主题的结论，久了沉成具体话题知识 → 降级进 note。

### 3.4 notes/ —— 不给结构，一个概念一个文件

沉淀单元。按需 grep（Instinct 的别名手法提命中率）。每个 note 含意义正文 + 来源戳（工具自动盖）。放开，无硬预算。

### 3.5 threads/ —— 给文件布局，不给内容形状

布局（机械骨架）：

```
  threads/
    index.md                    ← 常驻，精简，只列 active 的线（标题即内容，无日期）
                                  "- loom-memory [active] 设计记忆层"
    loom-memory/
      index.md                  ← 这条线的可进入全貌 + 本线文件导航（就地重写，活的）
      三轴模型.md                 ← 一份 Thread Note（普通标题，不带日期）
      attention结构.md            ← 又一份
```

**内容形状不给 schema**——给了会把每条 thread 压成一个模子的 handoff 文档，活性就死了。一条研究线、一段关系、一个创作本该长得不一样。防"流水账"不靠 schema，靠两点：

1. prompt 心智引导（thread 是"仍在展开、值得再进入"的连续，不是活动日志）。
2. `<id>/index.md` 是**就地重写**的"当前可进入全貌"，不是按时间追加。

Thread Note（`<id>/` 下的文件）：**有实质才写一份**（值得独立重读的探索/转折），不是每次活动强制记。标题普通、不带日期；顺序由 index.md 策展决定，不由文件名时间戳决定。用**裸 fs 工具**写。

> thread 与 note 的区别是**状态**：note 已沉淀（再进入是"查到旧事实"），thread 仍展开（再进入是"接着感受、探索、行动"）。主动机会扫的是 threads（还开着的线），不是 notes。

---

## 4. 薄 memory 工具

**一个 memory 单元 = 一个 note 文件 + memory.md 里一条索引行。** 工具把这两个一起写（正好补上"改 note + 改索引"中途崩溃的一致性缺口——裸 fs 做不到原子配对）：

```
  memory_write(concept, body)
     ├─ notes/<concept>.md   ← 写正文（agent 给的意义）
     ├─ memory.md 索引段      ← 加/更新一条路由行
     └─ 自动盖来源戳          ← 当前 session/seq，agent 不用手写
```

**保持薄**（避开旧 Loom 的过度工程/过度校验）：

- 工具**做**：写 note、更新索引行、盖来源戳、检查常驻文件预算。
- 工具**不做**：强制正文 schema、格式校验、内容结构验证、拒绝"不规范"写入。
- 只有 memory 单元需要这个工具（因为有配对一致性）。attention / threads / 自由编辑走**裸 fs**。

---

## 5. 生命周期：三轴怎么咬合

agent 做判断，Harness 只给**软提示**（提示，不自动改状态）：

```
  短 horizon 事（attention 项）
     · horizon 到期、结了          → 直接掉出 attention，不留 thread
     · horizon 到期、没结但仍重要  → 提升为 thread（进 threads/index.md）

  active thread
     · 一阵没进入                  → Harness 软提示"还 active 吗？"，agent 判断
     · agent 判断不再推进          → dormant（移出 index.md，文件夹保留，可再进入）
     · 真的结束/被替代/合并        → archived（完整保留来源，不占导航前景）
```

- **dormant 由 agent 判断，不由时间自动踢**（时间只提示，不单独证明一条线失活）。
- attention 是"现在"（活跃的一小撮 + 不成线的短事），active threads 是"还开着的全部"。attention ⊃ 短 horizon 事，attention ⊄ 全部 active thread。连接点是 attention 项里的 `→ thread:` 指针。

---

## 6. 醒来 bundle

分两处，因为落点不同（放置判定见 [materials-module.md](materials-module.md) 与本轮结论）：

- **稳定系统段** 用 `SystemPrompt.section()`：identity（agent 自己写的权威根）+ bootstrap（诞生引导，只在 `bootstrap.md` 存在时渲染）。每步都渲染、consolidate 到系统节点头部，**从不被 compaction 丢，rollover 后继照样渲染**——"始终在"是白得的。identity 用 `interpolate:false` 读文件，正文里的 `{{}}` 不会炸 assembly。心智引导不再入系统段（搬去 workspace/AGENTS.md，见 §8）；orientation 只留极简机制 + 指针 + “不外露机制”约束。
- **动态材料快照** 用 `SystemPrompt.context()`：memory 核心/索引、threads、attention。作为 user-role 历史快照，**变了才重注、可被压缩、贴近 recency**。它们是 agent 自己维护、会过时的参考，不该有系统提示的指令权威（对齐 dsh-agent-team：memory 显式框成"可能过时的参考，不是指令"）。

注入的可靠性由 DSH 的 `RuntimeContextProjection`（agent-loop）保证，不用自己写：

```
  新 session（rollover 后，session 空）
     → provider 对当前 workspace 文件求值；空 session 无旧快照 → 首次组装自然注入 + handoff
  compaction 盖掉某快照（replacement 事件的 sourceEventSeqs 含它）
     → retained 置 null → 下一步 project() 发现内容 ≠ 空 → 自动重注
  同一 session 内没变、且还在 surface
     → 不重进历史
     → 当前 Input 每轮追加末尾
```

不需要单独的 baseline/resume 触发机制：`context()` 每次组装都反映当前文件状态，section 每步重渲染。不采用 `dsh-agent-instructions` 的逐文件 delta（它的 instruction 语义与树发现与我们的材料结构不合）；delta 只在某材料日后被证明又大又频繁变时才作为优化加入。

顺序（从先读到后读，越往下越贴"现在"）：

```
  ── 稳定系统段（SystemPrompt.section()，每步都在）──
  [bootstrap]         ★ 诞生引导，只诞生时有（loom:bootstrap, 90；读 bootstrap.md，删后消失）
  [harness 机制]     你运行在什么里 + 召回=搜索 + 不外露机制 + 指向 workspace/AGENTS.md（orientation, 100）
  [identity]          我是谁（loom:identity, 120，读 identity.md，interpolate:false）
  [工具说明]           工具 schema

  ── 动态材料快照（SystemPrompt.context()，变了才重注 / 压缩后自动补回，升序拼接）──
  [memory 核心]       始终约束我的理解    （背景）
  [memory 索引]       路由到 notes       （背景）
  [threads/index]     还开着的线         （中景）
  [attention]         此刻带着什么(horizon)（前景，最贴现在）

  ── rollover 时才有 ──
  [handoff]           上一段带进来的在途状态

  ── 每轮 ──
  [current input]     当前输入（最末，recency 最高）
```

三个判断：

1. **identity 进系统提示**（当权威根，DESIGN §3.1 的"最高门槛、判断的根"）：它是框架不是易失参考，且 section 天然抗 compaction/换代。原设计把它放动态块，本轮修正。
2. **“怎么管理”不进常驻 prompt**：memory/attention/threads/rollover 的纪律搬进 workspace/AGENTS.md（on-touch 注入），prompt 只点名指向；并约束 agent 不向 user 外露这些机制（藏管道、不藏回忆内容）。原设将心智引导当常驻系统段，本轮修正。
3. **attention 排材料最末**（最贴当前 Input，salience 最高），且**必须留历史**——section 钉在最顶，离输入最远，搬过去就废了它。memory/threads 同为可过时参考，留历史。

bundle 是从 workspace 文件投影的**只读投影**，随时能从文件重建，不是第二事实源。

### attention 与 handoff 的关系

attention ≈ 持久化的最新 handoff，但**不等同**：handoff 是 rollover 时"带进下个 context 的全部"，不分时长；attention 每项自带 horizon、会自己老化。rollover 写 handoff 时顺便刷新 attention。同一 context 内全在窗口里，attention 主要在跨 context 边界才发挥作用。

---

## 7. 预算

约束不是 context window（现在 100K-200K tokens，常驻 40KB 也就 ~10K tokens，占不到 5%），而是**信号稀释**与**agent 能否醒来就进入状态**之间的平衡。参照 Instinct profile（~17KB）、dsh-agent-team memory.md 硬顶（16 KiB）：

```
  identity        2-4 KB
  attention       2-4 KB
  memory 核心     4-8 KB      ← Instinct profile 的类比，给够
  memory 索引     可到 8-16 KB（会随 notes 增长，单独一档）
  threads/index   2-4 KB
  ──────────────────────
  常驻合计        ~20-40 KB（~5-10K tokens）
  按需文件（notes / threads 正文）  不设硬限
```

- 数字是起点，跑起来看真实行为再校准。
- **只给常驻件预算 + 注入块显示当前用量**（"memory.md 6.2/16 KiB"，给 agent 信号让它自己压缩）。硬拒绝只在"再大撑爆注入"处才触发。
- 这一条避开旧 Loom"处处校验"的坑：反馈优于拒绝。

---

## 8. 怎么用放哪 vs skill 手法

> 本轮修正："怎么用"已从常驻 prompt 移到 workspace/AGENTS.md（on-touch）；prompt 只留极简机制 + 指针 + "不外露机制"约束。下文写"进 prompt / system prompt = 心智"的地方已过时，按此理解。

按"频率 × 关键性"劈开：

```
  system prompt（每轮常驻）= 心智
    · 记录层 vs 理解层，两层怎么用
    · 5 种用法：醒来靠常驻 / 召回靠 search / 知识靠 grep notes / 结论写 note / 边界处 rollover
    · 三轴 + identity 各是什么、什么进哪
    · thread vs note 的写入判断（还展开的进 thread，已定的沉进 note）
    · 引用靠搜索、不靠手抄 id

  skill（按需加载）= 维护手法
    · 怎么压缩 memory.md、什么时候降级、怎么拆 note
    · 超预算了怎么重整理
```

**5 种用法**（现落在 workspace/AGENTS.md 与工具自述）：

```
  1. 醒来/接续   → 常驻理解就在（identity + attention + memory 核心），立刻进入状态，不用搜
  2. "我是不是…过？/那事怎么定的？" → context_search → context_read 展开   【情节召回】
  3. "关于 X 我知道啥？" → grep memory notes（别名提命中率）              【语义召回】
  4. 明白了个长期的事 → memory_write 一条 note（引用来源 session）
  5. context 快满 → rollover，写 handoff = 刷新 attention + 提炼进 memory
```

---

## 9. jev 接缝（System 1）

jev（typesafe.ai）是一个快、便宜的可泛化函数：给 input 判 1/0、分类、概率。用 Kahneman 的话：

```
  main agent = System 2   慢、贵、审慎、拥有意义
  jev        = System 1   快、便宜、反射、做即时判断
```

**硬约束**：jev 只"提议信号"，绝不"改状态"。输出是浮出来的建议，处置权永远在 agent 或受控后台。且 **main agent 只看到浮出的结果，看不到 jev 内部打分**（否则判断被操纵）。守住这条，它就是纯增益，不会变回被退役的"替 agent 决定意义的器官"。

本工作项（连续性）只留接缝，不实现：

- **search 重排**（最该先上、零风险）：`context_search` 候选交 jev 打相关性，只浮最相关的给 main agent。接口按"候选 + 可插入重排器"设计。

后续（主动性 / 后台工作项）：

- **写入路由**："这段值得记吗？进 memory 还是 thread？" → 信号，agent 确认。
- **陈旧/矛盾标记**：新事实 vs 旧 note 冲突概率 → 标出让 agent 调和（发现与处置分开；不做自动遗忘）。
- **主动性**："这条 thread 现在想被重新进入吗？" → 概率，给主动机会一个来源，不把好奇压成调度规则。pulse 因 jev 便宜可更密、更随机；chat 后的自主接续先用 jev 判路由再决定是否唤醒 main agent。

---

## 10. 与 DSH 的映射

Loom 是一个 DSH app（Cordis bundle），everything is a plugin，无特权 core。各部件 ↔ DSH plugin 的复用/自实现判定以 [FRAMEWORK §5](../../../active/loom-architecture/FRAMEWORK.md) 的模块表为单一权威；本模块相关部分的落法见 [materials-module.md](materials-module.md) 与 [continuity-module.md](continuity-module.md)。

---

## 11. 记忆分层的定位与边界（本轮收敛）

### session log 是 episodic 底座，理解层只补两样东西

和 Zep/Mem0/Letta 不同：它们从零造记录层，而 Loom 的记录层白得了（DSH session log + context-continuity 的 search）。**发生过的一切都在 log 里、可搜。** 所以理解层（identity/attention/memory/threads）不必再存"发生了什么"，它只补搜索给不了的两样：

1. **常驻定向**：搜不出来、必须每轮就在的——我是谁、在带什么、有哪些规矩 → identity + attention + memory 核心。
2. **策展的再入点**：log 是一条摊平的流，搜出来是原始事件，不是"这件事我到哪了" → threads（对还活着的线，人工策展的当前状态 + 怎么接上）。

### 不把一切做成 thread

"实体档案"（关于一个人/一个项目，累积型、参考性）和"还在展开的线"（会推进、会休眠）是两回事：

- **实体知识是 semantic，归 memory / notes**（带别名助 grep）。你不会去"继续"一个人，你是累积对他的理解。
- **thread 只留活线**（你定义的那种：再进入是"接着感受/探索/行动"，不是"查到旧事实"）。
- "提到某人就加载相关内容"是**检索问题，不是存储问题**：实体成为线索时去检索相关 notes/threads/sessions，不需要一个庞大的"实体-thread"。

记忆分层对上认知记忆的标准划分：

```
  working     = attention（当下 + horizon）
  episodic原始 = session log（全量、可搜）      ← 白得的
  episodic策展 = threads（活线的再入状态）        ← 只存活线
  semantic    = memory / notes（含实体知识，别名检索）
  procedural  = skills
  根          = identity
```

### thread 不会泛滥

thread 泛滥只在"一切都是 thread"时发生。若 thread = "还在展开、可能回去的线"，它天然有界：绝大多数经历不成线（在 log 里），产生长期结论的进 note。控制手段是**准入判断 + 生命周期（active/dormant/archived）**，都是 agent 带引导做的判断，不是硬机制。

### 跨多次 handoff 的连贯

```
  常驻 baseline（每代重注）  identity+attention+memory核心+threads/index —— 主力，把"持久的自己"带过墙
  session search（按需）       回到归档世代，按内容或引用 —— episodic 召回
  timeline（结构）             走世代谱系 —— 结构性连贯
```

连贯 = 常驻材料 + 按需搜索，handoff 只是过墙时那块在途补丁。

### handoff 引导 = 兵底，不是常规路径

所有这些都是**给 agent 的引导，不是强制机制**。正常情况下 agent 应在之前的恰当时刻就把材料维护好；rollover 前的更新是**最后一道网**。

rollover / 压力时刻是一个**按数据寿命**的动作，不是文件清单仪式：

1. context 滚走前：把改变了长期理解的落进 memory note；更新推进过的活 thread 状态。
   （plugin 的 rollover 工具描述已内建"先把值得留的记进 memory/notes"）
2. attention：刷新——清掉 horizon 过期项、留下还在带的。
3. handoff 本身：只写在途残留（没做完的、没验证的副作用、下一步），不复述会被重载的材料。

时机："落盘长期结论"的提醒放在**压力通知**里（context 还完整、来得及），不堆到 rollover 那一刻。`rolloverChecklist` 和 pressure notice 文案 plugin 都允许 host 定制。不做成"检查所有文件"的强制例程（那会重蹈过度工程和 recall-spam）。

### search 触发：先显式，后 jev proactive

第一个切片用**显式**（agent 自己决定搜），最简单、无 spam 风险。以后 jev 当**触发器 + 线索构造器**做 proactive 召回（jev 提议、不决定）。v1 不做自动召回。

### 后台维护是后面的层

reflection / consolidation 有先例（Generative Agents reflection、Letta sleep-time、Instinct 24h cron），但守纪律：**后台只做机械巩固（合并/降级/标陈旧），不决定意义；且是 jev/后台那一层，不进第一个切片。** 第一个切片里 agent 自己是唯一作者。
