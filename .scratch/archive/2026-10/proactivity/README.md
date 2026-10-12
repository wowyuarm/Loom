# Proactivity：活动锚定的自主检查

- **状态**：已归档。`pulse` 已实现并随本工作项提交，**保留 after-interaction**；默认 dry-run，仅记录判断、不唤醒。没有部署、重启活体或关闭 dry-run。
- **最后核验**：2026-10-12。锁定 DSH `0.2.0-rc.2`、Jev 插件 `0.1.1`；研究调用模型 `jev-1.13.0`。源码与测试定义当前行为，最终设计见 [DESIGN §9.12](DESIGN.md)。较早 §9 的“未授权实现”“替换 after-interaction”及按开启者判断等文字已由该节覆盖，不能作为实施合同。
- **当前前沿**：[实施票 06](issues/06-activity-pulse.md)完成代码和离线验收。下一项是另行授权后的真实 dry-run 观察：核对判断完整输入、旧线重复、私人入口与两轨接力，再决定是否启用真正自主回合。没有将 shadow 记录当作主体行动效果。
- **完成条件**：实现阶段完成；长期主动性尚未验收。上下文必须具备工作方式说明、当前材料、时间、历史以及按需读取细节的入口；quiet、shadow、失败与混合回合不能伪装为主体放弃、完成或纯主动效果。真实观察需要另行授权部署和材料传输边界。
- **正式文档出口**：当前配置、行为、上下文与限制已写入 [pulse 能力页](../../../../docs/subsystems/pulse.md)，对话后检查能力页同步取消行为。本工作项已脱敏归档。归档只代表当时的设计上下文，不覆盖落地行为。

## 验证

- `npm run typecheck`、`npm run build` 通过；构建后的 `loom/pulse` 在隔离工作区挂载本地 DSH，默认 dry-run 判断一次，没有额外主体请求。
- `npm test` 最终通过：seeded skills 3 项、docs 60 文件、文档测试 7 项、完整套件 181 passed / 1 skipped（22 文件通过、1 文件 skipped）。一次全套运行中既有 turn-failures 测试的异步提交计数未就绪；该文件单独重跑 12 项通过，全套重跑也通过。失败原因未进一步查明，没有修改该测试或生产能力。
- pulse 的 13 个真实循环/mock 测试覆盖：检查间隔、dry-run、持久重启、换代与 checkpoint return、取消、旧 notice、两轨接力、真人加入工具回合、更新材料、身份/记忆索引/工作索引/时间/既有 transcript，以及执行结果反馈。
- 测试中的 Jev 和主模型均为 mock。它们证明执行与上下文，不证明真实主体的长期语义判断。

## 研究与历史

- [系统研究](materials/2026-10-12-systematic-research.md)：源码、Git legacy、已有讨论与第三方资料。
- [Jev 离线与真实服务实验](materials/2026-10-12-jev-shadow-experiment.md)：259 次成功请求、1 次 transport 失败原因未查明；仅合成中文输入，真实历史仅在本地处理。
- [pulse 与来源讨论](materials/2026-10-08-pulse-and-kind-discussion.md)、[主动性发散](materials/2026-10-08-systematic-divergence.md)、[订阅讨论](materials/2026-10-07-subscription-discussion.md)：历史意图，不替代当前合同。
- [第一片](issues/01-after-chat-in-place.md)、[留版](issues/03-workspace-git-snapshot.md)、[条目年龄](issues/04-entry-age-visible.md)、[读时提醒](issues/05-read-shape-reminders.md)：既有能力与实施背景，当前状态须核源码。

脚本、逐次请求、私人历史结果与构建挂载实验在 gitignored 的 `.scratch/local/proactivity-20261012/`。其中真实材料或凭据不得复制到公开报告；本轮实现验证未调用真实模型或生产服务。
