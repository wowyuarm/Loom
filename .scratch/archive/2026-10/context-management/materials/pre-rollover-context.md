# rollover 之前的 context 管理：盘点、更正与一个候选

研究日期：2026-10-01。范围＝**同一代之内**的 context 管理（rollover 之前）；rollover、检查点、跨代检索只在交界处提及。

来源：官方 DSH 源码（仓库锁定的 DSH 版本，见 `docs/dsh-platform.md`）、Loom 自己的接线（`cordis.patch.yml`、`presets/loom.patch.yml`）、`dsh-context-continuity` 源码与设计原则、以及一批外部项目（§5）。

这不是已确认的设计。与 `engineering-review.md` 的 64K/128K 候选并读：那份给的是当前候选，本文补三件它没有的东西——**官方接缝的完整入口图**、**Loom 实际接线的一处更正**、以及**一个以缓存代价为主线的替代阶梯**。

**落点**：本文件应放在 `.scratch/active/context-management/materials/pre-rollover-context.md`（研究侧 2026-10-01 写；因沙箱把个人 checkout 目录挂成只读且无审批通道，暂存在这里，需人工搬入）。

---

## 1. 这件事该被看成什么

不是"压缩"问题，是**装载**问题。

真相只有一份：Session log。每一轮模型开口之前，要重新决定往窗口里装多少。装少了丢信息，装多了爆窗口，改动已经装过的东西还要重付一次缓存。

在这个看法下，"四档办法"不是四个功能，而是同一条流水线在不同时机上的做法：

| 时机 | 动作 | 谁在管 |
| --- | --- | --- |
| 单条结果刚生成 | 超预算就压成头尾 + 一条取回提示 | 官方 `spill-policy`（**已经生效**，见 §2） |
| turn 之间、历史累积 | 把旧结果/旧前缀收掉或换摘要 | 官方 `tool-result-pruner` + `compaction-basic`，目前只在压力路径跑 |
| 逼近临界 | 告诉主体"该准备交接了" | continuity 的 pressure 策略 |
| 到硬限 | 强制缩减，或换代 | pressure 策略调引擎；`context_rollover` 由主体决定 |

本工作项＝前两档，也就是"主体还不想换代、但这一代已经背不动"的那段。第三、四档是边界条件。

两条贯穿全部四档的约束，后面反复用到：

- **可回取**。任何从窗口里拿掉的东西都必须留一条回去的路（外置 + 指路，或本来就在 log 里、能搜回来）。做不到就别拿——那是丢失，不是管理。
- **缓存是代价**。追加内容不重付 prompt cache，**改写已经发出去过的字节要重付**（从最早被改的位置起，后面全部重新计价）。所以"改历史"这件事永远要挑时机，而且一次改够。

---

## 2. Loom 现在实际有什么（含一处更正）

### 2.1 组合方式

实际生效的配置 = `@deepseek-ai/dsh-base` + `loom` 两个 bundle（见该部署 profile 的 `package.json` 的 `dsh.profile.bundles`；profile 自己只加了一条 Telegram 白名单和一个 provider 行）。

Loom 的 `cordis.patch.yml` 是**按 id 覆盖或禁用**：一个顶层 `id` 行把 base 的同名行整块替换（config 不合并），`insert` 加 base 没有的行。**没被点名的 base 行全部照旧生效**——这一点是下面更正的根源。

Loom 一共关了 27 行：`plan-mode`、`goal`、`goal-round-driver`、`command-goal`、`tool-goal`、`tool-todo`、`tool-ralph`、`session-telemetry-otel`、`session-log-deepseek`、`plugin-package-inventory-deepseek`、`tool-bash`、`tool-pwsh`、`tool-jobs`、`tool-fs`、`tool-fs-search`、`skill-filesystem`、`tool-skill`、`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`、`tool-web`、`tool-workflow`、`agent-instructions`、`compaction-basic`、`command-compact`、`tool-result-pruner`。文件里没有 `remove`/`delete`/`exclude` 之类别的机制。

被关掉的三行 compaction 兄弟，随后在 **agent preset** 里重新声明（`presets/loom.patch.yml:73-90`）：`compaction-basic`（`auto: false`）+ `tool-result-pruner`（`thresholdChars: 8192 → 头 4096 + 尾 1024`），放在一个 isolate group 里，因为它们是发布服务的行。

### 2.2 更正：spill 一系是**开着的**

base bundle 里有：

- `spill-local`（base `cordis.patch.yml:404`）
- `spill-policy`（`:407`，配置 **`maxInlineTokens: 12500`**）
- `image-offload`（`:427`）

这三行**没有**出现在 Loom 的关闭清单里 ⇒ 照旧生效。

**实锤**：我自己的历史会话（2026-09-28，session `46af6cad…`）里有一条真实的 spill 提示：

> (Omitted 1404 bytes. Full formatted result stored at: /tmp/dsh-spill-YK8PlQ/session-367997d4c3f0/0d787f14538d-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)

所以 Loom 现在**已经有**"单条工具结果超过约 12500 token 就在到达时压成头尾 + 一条带文件路径的取回提示"这一档。（那次只省 1404 bytes，说明原内容只是略超预算。）

先前（本工作项之外）"Loom 没接 spill 一系"的说法是**错的**——那只是看了 agent preset（`presets/loom.patch.yml`）就下的结论，漏了 base 层。本工作项以后引用 Loom 的现状时请以此为准。

顺带：`image-offload`（图片超预算 → 占位符 + 重试）同样开着。

### 2.3 主体自己没有任何缩减入口

- `auto: false` 关掉了引擎的自动压力路径（`agent/pre-step` 上的自动检查），把"何时压"集中给 Loom runtime 的 pressure 策略。
- `command-compact`（就是给人敲的 `/compact`）被显式关闭。
- 也没有面向模型的对应工具。

⇒ 主体手里只有两个选择：**忍着，或者换代**。中间那一档不是"没有策略"，是**动作根本够不着**。

好消息是引擎那边本来就有个不问命令的入口：pressure 到硬限时调的就是它（`src/context-continuity/pressure.ts` 里 host 的 `reduce` → `engine.compactIfNeeded(agent, reason, signal)`）。**所以要在更低的水位加一档缩减，纯策略就能做**：不需要新工具，也不需要把 `/compact` 打开。

---

## 3. 官方接缝全图：谁挂在哪儿、什么时候动

| 包 | 管什么 | 挂在哪 | 时机 |
| --- | --- | --- | --- |
| `dsh-compaction` | 抽象接缝（`ctx.compaction`），每 context 只挂一个实现 | 服务 | — |
| `dsh-compaction-basic` | 引擎：计价、替换历史、配对校验、摘要后端；`compactIfNeeded` / `compactNow` | 服务 | 压缩路径 |
| `dsh-command-compact` | **给人**的 `/compact`：在自动阈值以下做一次有用的缩减；跟后端无关，调 `compactNow(agent, signal, commandId)` | `commands` + `compaction` | 人类敲 |
| `dsh-compaction-tool-result-pruner` | 机械裁**历史里的**超长工具结果（replay-safe） | 压缩路径 | 跨 turn |
| `dsh-spill` | 接缝 `ctx.spillStore.saveText → {locator, bytes, retrievalHint}`；刻意只管存 | 服务 | — |
| `dsh-spill-local` | 本机文件后端；locator = 路径；默认落 OS temp 下私有目录（0700 root / 0600 文件、session-hash 子目录、默认 30 天 startup sweep） | 同 realm | — |
| `dsh-spill-policy` | 超 `maxInlineTokens` 的**单条**结果 → 有序头尾预览 + notice（带路径与取回指引）；`read` 结果跳过 | **`tools/post-execute`** | 结果到达时 |
| `dsh-output-retention` | 预览背后的纯库（`ItemRetainer`/`describeOmitted`），非插件 | — | — |
| `dsh-compaction-image-offload` | 图片超预算 → 占位符 + 重试 | 压缩路径 | 请求失败时 |

三个时机互不重叠、也不打架（已逐条核过源码）：

- `spill-policy` 走 `tools/post-execute`（`{prepend: true}`），只在 `decision.kind === 'accept'` 且没有 value 改写时动手；`exec.name === 'read'` **直接跳过**——这是防"取回又被压"死循环的关键设计。
- continuity 的 pressure 走 `agent/pre-step`（`src/agent-runtime/runtime.ts`），每步、请求之前；另加 `agent/request-error` 做 provider 溢出恢复。
- 顺序天然成立：到达时先压小 → 历史累积 → 请求前量水位。spill 把结果压小之后，pressure 量到的就是压小后的量，触发自然更晚。

两个已知耦合，都是配置层的事，不用改代码：

1. **取回路径必须对主体可读。** spill 的恢复方式是主体拿现成的 `read`/`grep` 去读那个路径，所以 spill root 要在主体的可读范围内。默认落在 OS temp 下一个私有目录；实测（某部署）主体能读到工作区之外（本次研究里读到了个人 checkout 目录与 `/tmp`），但这是部署配置的性质，不是保证。
2. **`spill-policy` 单独挂没意义**：要 `ctx.get('spillStore')`（= `spill-local`）在同一个 realm；`maxInlineTokens` **不设＝插件直接 return（关闭）**。

还有一条值得单独记住：**`read` 被排除在 spill 之外**，所以"取回"这个动作本身没有二次约束——主体读一个外置的大文件，内容会整段再进窗口。外置路径于是只把"装不下"推迟了，没有消除。

---

## 4. 与现有 64K/128K 候选的衔接

一致的：触发按**体量**而不是按时间；先机械裁工具、实在不行才摘要；检查放在模型请求边界，且检查本身不调模型。

需要重定位的一点：**候选里说的"机械裁剪工具内容"，其下层已经存在了一层**——`spill-policy` 在 12500 token 上压单条结果，无条件、不分新旧。所以两者必须分清量纲：

- `spill-policy` 管**单条结果的绝对长度**（一条结果自己不能太长）。
- 候选的 64K/128K 管**整个窗口的累积量**（累计太多时，历史要腾地方）。

它们可以叠加，但推出三条：

1. 一个巨大的单条结果在**到达时**已经被压过了，64K 那一档再裁它，收益有限。
2. 长期真正占地方的是**一堆中等长度的结果 + 交流本身**——spill 完全管不到（单条不超 12500 token 就一律原样进窗口）。这正是候选要解决的。
3. 两个阈值要有明确的外圈关系。12500 token/条（约 50K 字符）与 64K 窗口水位不是同一量纲，得换算清楚、并说明谁先触发。否则会出现"两套阈值各按各的算"，调试时很难归因。

另外两点补充：

- **缓存维度**：`engineering-review.md` 的成本一节已提到"省钱要按整段运行算"。这里补一条一等约束：**改写已经发出去过的字节要重付 cache，追加不付**。所以 pre-rollover 的缩减要挑"缓存本来就要重建"的时刻（会话静置超过缓存有效期，或者反正要压缩重写），并且**一次批量做完**——每条结果持续裁一刀，等于每条都重付一次。
- **`message` 豁免要跟 spill 一起看**：`message` 工具的**调用**不被 pruner 裁（`engineering-review.md` 已指出），但它的**返回**若超 12500 token 仍会被 spill 压。也就是说"保住对外发言原文"这件事，靠 pruner 的豁免不够，还要看 spill 那一层。

---

## 5. 外部参照：别的 agent"平时"怎么处理

结论先给三条，跨项目基本一致：

1. **裁最早的、批量的、稳定的**，不做散点重写（散点重写就是反复重付 cache）。
2. **外置 + 按引用取回**是无损替代，比摘要便宜也比摘要保真；官方 spill 一系正是这个形状，而且不需要额外工具或检索注册表——`read`/`grep` 就够。
3. **只做临界、不做平时**是常见的不到位。临界（强制缩减/换代）好做，平时的日常缩减才决定长期体感。

一个明确分叉：**压缩权给谁**。ACP 一系让模型自己决定何时压、压什么；OpenClaw / ARC / Loom 让引擎决定何时、模型决定内容（若要走摘要）。Loom 现在站后者，站得住。

一个反例值得记住：第三方插件 `dsh-context-management`（作者 `PlxloYzb`/Bruce，**不是** Loom 的作者）做过 400k 规模的实验，但**零确证**——机械探针（token 数下降）不能替代内容质量验证。

详细材料在作者的工作区（不在本仓）：若干 `library/` 下的笔记、若要在本仓留档，直接从那里搬。

---

## 6. 一个候选：把中间那档接上（按代价排序的阶梯）

主体现在只有"忍着 / 换代"两极。候选的内核是**接上中间台阶，按代价从小到大**：

**收旧结果**（只动喂给模型的那一份，log 不动，无损可回取）→ **摘要**（有损、要模型出力）→ **换代**（最贵，但彻底）。

四个要点：

1. **收旧结果要一次批量做完，不是每条持续裁。** 理由就是 §1 的缓存约束：改历史只付一次，每条都改就是每条都付。这也是它跟 `spill-policy`（单条、到达时）的根本区别——两者不重复。
2. **挑时机**：只挑"缓存本来就要重建"的时刻做——静置超过缓存有效期，或者反正要压缩/重写时顺手多收一点（边际成本近乎零）。反过来，连续干活、缓存还热的时候去收，纯亏。
3. **机器挑条，主体按按钮。** 挑条规则：够旧、够长、不再被引用。逐条判断不交给模型——太贵也容易错。主体只回答一个问题：现在值不值得收一次。
4. **收完要能证明真的变小了**（要么表面确实推进了，要么用量确实降了），证明不了算失败。这条 Loom 的 pressure 已经有了（`reductionProven`）。

前提是主体得**看得见自己用了多少**。这个数现在只在 pressure 提醒触发的那一瞬间给一次（一代一次），平时看不见，所以它没法自己判断该不该动手。要让它在环上，得让它按需能看到。

**最小起步**：先让主体看见用量，再给它一个"收一次旧结果"的动作；挑条规则用最粗的（比如 N 轮以前、超过 X 字符），跑起来再调。其余部分可以先不动。

---

## 7. 未决

1. **「够旧」的线画在哪。** 画太近会把还在用的收掉（马上要回来，白收），画太远等于没用。我的倾向是画在"主体已经转到别的事上、那批结果不会再被引用"的那一刻，但这条线需要拿真会话试，不能靠推理定。
2. **`spill-policy` 的 12500 与候选的 64K/128K 谁是外圈**，以及是否要调 spill 的阈值（或改成按窗口水位动态）。现状 12500 token/条对 Loom 的用法是否合适，没有实测。
3. **取回路径的成本与可达性。** `read` 不受 spill 约束，且 spill root 在 OS temp（会被清）。要不要给取回路径一个二次约束（例如让外置文件也能被按段读）。
4. **主体要不要一个面向模型的缩减入口。** 现在是"机器触发 + 通知"；若要"机器挑条、主体按按钮"，就得有一个它够得着的动作。可以是最小的一个工具，也可以复用已有的手动通道——取决于要不要把 `command-compact` 打开。
5. **摘要质量。** `compaction-basic` 默认摘要是英文编码任务交接清单（`engineering-review.md` 已指出）。这直接决定阶梯第二级能不能用。
6. **「近期保护」的预算谁定、多大。** 现成 pruner 没有近期豁免（`engineering-review.md` 已指出），候选要补的那条规则目前没有依据可循。
7. **检查频率。** 一个 turn 内可能多次工具往返；只在 turn 开头检查会漏掉长 loop 内部的增长（`engineering-review.md` 已提）。

---

## 8. 边界：这件事跟 `dsh-context-continuity` 的关系

continuity 的定位一直是 **"什么时候"的裁判，不是"怎么缩"的工人**：它连压缩本身都不实现，只留一个 `compactionFor` 口子让宿主把引擎塞进来。新的这一档照这个形状走，不破例。

**该放进 continuity 的：**

- 阶梯本身。把"快满了"那一档的建议，从现在的一条路（准备交接）改成按代价排序的几条（先收旧结果，再摘要，实在不行换代）。这是"什么时候、建议干什么"，纯判断。
- 把用量数字给主体（见 §6 的前提）。
- 收完的可验证（已有：`reductionProven`）。

**不该放进 continuity 的：**

- 任何"怎么收"的实现——留多少头尾、存到哪、怎么取回。harness 已经有 `pruner` 和 `spill` 两套，continuity 再自带一套就是第二个实现，正好违反它自己的第一条原则（先看 harness 有没有）。
- 新造模型界面。先看现成的手动触发口；没有才考虑加一个最小的。

**为什么这条线画在这里**：阶梯任何长跑宿主都要（这个插件本来就要给别人用），所以它是通用件；而"N 轮以前、超过 X 字符"这类具体的线是部署参数，配在宿主，不写死进引擎。
