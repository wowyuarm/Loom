# 01 — after-chat 就地接续（第一片端到端）

**What to build:** 主体刚回完话进入 idle 后，插件在一段随机静默后判断"这段对话是否真的停了"，用一次 jev 判断此刻该 quiet / speak / act，仅当 `P(quiet) < 0.4` 时把整理好的一小段自然语言情境交给主体，主体自由处置（接一句 / 私下做事 / 放过）。真人消息在任何阶段都压过这次主动检查。上线后能在真实中文对话里观察到：该安静时安静、有活线时自然地提一句，且不打断正在进行的对话。

**Blocked by:** 已发布包 `@wowyuarm/dsh-jev`（dsh-plugins 仓；需求见 [../DESIGN.md](../DESIGN.md) §4b，实现由 该包实现方 认领）。它发布并钉进 Loom 依赖后本票才开工；该包只声明真正 import 的 peer，**故不卡 dsh 版本线**。其余前置均已存在（DSH 底座、time-context lastEventTime、continuity isEphemeralNotice 钩子、已加载的 `ctx.timeout`）。

**Status:** ready

参考：[../DESIGN.md](../DESIGN.md)（收敛设计快照）。真实 jev 调用证据与被推翻的备选见 [../materials/design-notes.md](../materials/design-notes.md)。

## 决策要点（内联，避免翻史）

- **判断**：一次 jev 调用、一个 Choice、三档 `quiet / speak / act`。唤醒判据锚 `P(quiet)`：`< 0.4` 唤醒并取 speak/act 高者定姿态，`≥ 0.4` 安静。jev 只提议、绝不改状态、raw 分绝不进主体上下文。
- **触发**：进 idle 后挂一个 `random(3–14min)` 一次性静默闹钟；纯插件本地、不跨重启、响过不自动重挂。
- **闸门**：在 jev 前、jev 看不到。第一片**不设冷却、不设次数上限**，只保留结构性"一次对话停顿至多一次检查"。
- **state 三块**：最近对话（剥 `[channel · … · from …]` 前缀、滤 `source.kind='runtime-context'` 快照、按 1–3 轮往返截、人类侧整条 / Loom `message.text` 首 ~150 字）+ attention.md + threads/index.md。
- **并发**：jev 检查走 `agent.runMaintenance`；主动内容与被抢占时的真人消息走 steer / 下个 step 边界插入（现状 channels 用 `agent.followup` 开新回合，需改）。落地时对着 DSH 语义定 `steer` vs `send(msg,target,wakeup)`。
- **连续性**：主动回合发出的内容标自有 `source`，让 `isEphemeralNotice` 在换代时重新推导而非重读。
- **语气**：情境自然说"可能可以去……"，不刻意补"也可以什么都不做"。

## Acceptance criteria

- [ ] 主体回完话进 idle 后挂一次性 `random(3–14min)` 静默闹钟；真人消息在闹钟响前到达则取消该闹钟、走正常反应式回合，下次 idle 才重挂。
- [ ] 闹钟响后组装 state：最近对话（已剥来源前缀、已滤 runtime-context 快照、按轮截断）+ attention + threads index；单元测试覆盖前缀剥离与快照过滤。
- [ ] 一次 jev Choice 调用（`criteria` = quiet/speak/act），跑在 `runMaintenance` 里；`P(quiet) ≥ 0.4` 时不唤醒、无主模型调用。
- [ ] `P(quiet) < 0.4` 时取 speak/act 高者，按姿态塑形出一小段自然语言情境（无 raw 分），经 steer / 下个 step 边界交给主体；主体可自由处置且不被强制开口。
- [ ] 检查进行中或主动回合组话中到达的真人消息压过主动：runMaintenance 期间进 inbox 的输入不丢，检查后发现有新消息则放弃主动让位；已在组话则真人消息在下个 step 边界插入、模型转去回他。
- [ ] 主动回合发出的内容带自有 `source`，`isEphemeralNotice` 对其返回 true（换代重新推导）。
- [ ] 结构性"一次停顿一次"成立，**且挂钟前因必须是人类输入**：主动回合自己结束产生的 idle **绝不挂闹钟**（否则自触发死循环）；闹钟响过（无论 quiet 还是唤醒）不自动重挂；同时最多一个闹钟、重挂先取消旧的。有专门测试盯"主动回合的 idle 不产生下一次检查"。
- [ ] 到点先验 idle：不在 idle（长 tool call / 后台任务 / 他的新回合刚起）则放弃本次检查且不重挂——`runMaintenance` 在占用时会同步抛出，实现须先判状态而非靠捕获。
- [ ] 交付前时效复核：若最新人类输入晚于 state 快照时刻，放弃本次主动、不插入。
- [ ] jev 失败 fail-closed：网络/5xx/SSL 中断或概率字段缺失非法 → 当作 quiet、不唤醒；有界重试带退避、不无限重试、不阻塞。
- [ ] 源缺失降级：attention/threads 缺失或为空时仅用最近对话照跑；全新会话无对话可续时直接跳过检查。
- [ ] 主动结果发往这次停顿所在会话/路由（channels focus），不漂到其它通道。
- [ ] 计时用 `ctx.timeout`（dsh-base 已加载的 timer 行），不用裸 `setTimeout`；闹钟随 fiber 释放（重启即丢，可接受，不补跑）。
- [ ] 真实中文对话冒烟观察（非纯单元）：收尾场景安静、有明确活线场景自然提一句、进行中对话不被打断。作为上线后首轮效果记录进 validation/。
