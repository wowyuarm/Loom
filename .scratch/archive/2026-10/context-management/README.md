# Loom context 管理研究

- **状态**：源码核验与首轮工程判断完成，处于讨论阶段；候选机制尚未确认、未派发。
- **最后核验**：2026-09-28（2026-10-12 补核运行时与裁剪现状，见下）。研究当时的 DSH 为 0.1.7-rc.2、context-continuity 为 0.1.5；**当前仓库锁定的是 DSH `0.2.0-rc.2`、context-continuity `^0.3.0`**（以 `package.json` / lockfile 为准）。外部 Memoh 源码固定版本见研究正文。

**"未实现"指的是什么（2026-10-12 限定）**：未实现的是本工作项要的那套**按 token 水位、主动触发**的裁剪（64K 起裁工具、128K 才摘要）。栈里**已经有**一层工具裁剪，不要误读成"根本没有工具裁剪"而重复造：

- `dsh-compaction-tool-result-pruner` 挂在 **agent 平面**（`presets/loom.patch.yml:111-116`），参数 `thresholdChars: 8192 / headChars: 4096 / tailChars: 1024`；host 平面那行是刻意关掉的（`cordis.patch.yml:130-131`），两个平面分工明确。
- 它是**按字符数、只在 overflow 恢复时**触发，不是按 token 水位主动触发。可达路径：provider 报超限时 `pressure.js:278` → `pressure.ts:84` → `compaction-basic:926` 调 `pruneSession()`。
- 活体证据（2026-10-12）：一个 session 里 28 条工具结果超过 8192 字符，但 `compaction/prune` 事件 0 次——挂着、代码可达、没见过实际触发；7 次压缩里 3 次是模型自己调的 `context_compact`。

现有硬水位是 `CONTEXT_HARD_LIMIT_CAP = 256_000` / `CONTEXT_HANDOFF_AT_CAP = 200_000`（`src/context-continuity/retrieval.ts:31-32`），pressure 的决策顺序是"低于 handoff 静默 / 到 handoff 发一次通知 / 到硬限强制缩减"。中间那档水位正是本工作项要补的。
- **当前前沿**：依据后续讨论，候选改为 64K 开始工具裁剪、128K 裁剪后仍超水位才做一次旧前缀摘要；工具裁剪豁免 `message`。收敛侧 建议第一版先裁工具返回正文、补近期保护，尚需落实具体保留预算与失败后的再尝试条件。handoff 取消任务式清单。真实模型的连续性与总成本尚无对照证据，未开始实现。
- **完成条件**：明确采用的方向及可保证的边界；若进入实现，再确认最小范围与验证标准。源码调查和机械探针不能替代内容质量验证。
- **正式文档出口**：只有落地后的公开行为才进入 `docs/subsystems/`；当前判断保留为研究材料。

续读：
- [未决三条的推演：够旧的线、spill 与 64K 的关系、agent 够得着的入口](materials/reasoning-01.md)（2026-10-02，研究侧）——接上文七条未决的 ①②④：spill 是内圈、64K 是外圈（阈值不动）；「够旧」＝话题已转＋缓存冷的交点，不是轮次线；够得着的最小入口＝低一档水位的提醒，纯策略。
- [rollover 之前的 context 管理：盘点、更正与一个候选](materials/pre-rollover-context.md)（2026-10-01，研究侧）——装载视角、Loom 现状（含 spill 一系其实开着的更正）、官方接缝全图、跟 64K/128K 候选的衔接、阶梯候选、未决、与 context-continuity 的边界。
- [工程判断、机制证据与验证边界](materials/engineering-review.md)（2026-09-28）。

讨论账本：2026-09 context 管理讨论。
