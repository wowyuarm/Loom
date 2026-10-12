# 活动锚定的 pulse

`pulse` 在主主体空闲一段时间后，用 Jev 二元 `{quiet, attend}` 判断是否值得提供一个自主工作回合。门控不选任务，也不决定是否发消息；主体可以继续自己的线、更新材料或安静结束。

## 与 after-interaction 的关系

[after-interaction](<after-interaction.md>)保留对话后短时检查；pulse 提供更长间隔的自主检查。两者使用独立投影，从同一份 Session 记录取得各自所需的事实，不 import 对方实现。DSH `runMaintenance` 保证检查互斥。

任何 Turn 结束都更新活动时刻，包括 after-interaction 唤醒的回合。因此其唤醒会推迟 pulse。纯 pulse 回合不触发 after-interaction；如果真人在自主回合中途加入，其 `source.kind = user` 输入属于当前 Turn，回合成功结束后正常触发对话后检查。不以 Turn 开启者推断是否有人参与。

## 配置与调度

配置字段与默认值见[PulseConfig](<../../src/pulse/index.ts>)：工作区、静默窗口、检查间隔、轮询间隔、每份材料预算、attend 阈值与 dry-run。配置在挂载时校验；默认 dry-run，只记录结果，不唤醒。没有服务重启或活体部署的隐含操作。

活动时间与检查时间分开：`lastActivityTime` 来自任何已提交的 `turn/end`，`lastCheckTime` 在发起一次判断前写入。quiet、失败与 dry-run 都不伪造主体活动，也不会在每次轮询重问。到期计算为 `max(lastActivityTime + 静默窗口, lastCheckTime + 检查间隔)`。无已知活动时不判断；首次安装可从当前 Session 投影恢复活动依据。

插件自己的 `loom_pulse_state` storage-domain 保存跨重启、换代的时刻、最近执行记录和判断记录。Session 投影恢复当前代际事实，持久时刻取较新值，避免 checkpoint return 回滚现实时间。重启后只检查当前情况，不追补每个漏掉的心跳。轮询与写入跟随插件生命周期释放。

## 真人优先与时效

真人输入进入当前 Agent inbox 时取消当前 pulse 判断，不等到 `user/message` 被接纳才取消。尚未接纳的 pulse notice 按自身 id 移除，不清空真人消息。判断返回后、持久记录完成后仍核对当前 Agent、输入和取消状态，避免过时判断交付。

notice 已进入回合后不取消主体工具。真人 steer 在下一安全 Step 边界被接纳，回合成为混合回合；执行记录明确显示真人参与，不将整个回合归因于自主性。after-interaction 也在人类入队时取消自身评估并撤回自己的待接纳 notice，保留其原有挂钟与三档门控。

## 判断输入与记录

Jev 收到英文情境说明、代码计算的活动间隔、UTC+8 时刻、上次检查结果、近期回合的执行事实，以及 attention/threads 索引原文。材料不翻译。缺失文件按空材料处理，其它读取失败使本次检查失败；超过可配置预算时标明截断，不能把前缀当作全文。

上次执行只说明来源、工具调用、工具错误、message 尝试与成功工具结果、回合结束原因。工具调用不证明工作完成，无工具调用不证明主体放弃；混合回合的输出不能完全归因于 pulse。主体选择等待、完成或放下的语义理由仍来自其工作材料。

阈值只是初始设置，不声称已经校准。概率范围、总和与响应类型在外部响应边界检查，无法使用或调用失败时不唤醒。quiet、shadow、queued、failed、cancelled、withdrawn 分开记录；queued 不等于主体接纳，更不等于对外发送。

判断记录保留完整输入和结果，存于本地运行数据，包含主体私人材料，不能提交或作为公共日志发布。它用于复查真实判断，不把工具列表当作人工真值。当前没有自动清理历史判断的策略，长期运行需关注这部分数据增长。

## 主体的上下文与连续性

pulse 插件挂载时才注册英文的工作方式说明，不修改主体 identity，也不让未挂载 pulse 的实例收到此说明。提示明确：自主唤醒不是人的任务，attention 表达当前关注，threads 索引指向详细工作文件，memory 保存长期理解；无需每次维护全部材料，有价值才对外说话。真人加入优先于自主工作。

[resident-context](<materials.md>)继续提供身份、memory core/index、threads 索引和 attention 的有预算内容。**不是 thread 全文或全部记忆都在上下文**；主体需要通过文件工具或历史检索读取细节。更新的材料在后续请求中重新组装；换代后同样读取工作区材料与 handoff。

pulse notice 提供本次工作时刻，最近一次自主回合的执行事实作为动态 context 提供给后续回合。主主体看不到 Jev 分数、原始判定输入或阈值。对外行动仍经[message 工具](<channels.md>)；普通 assistant 文本不会自动外发。

## 验证与限制

[pulse 运行测试](<../../tests/pulse.spec.ts>)使用真实 DSH 循环、本地持久化、mock 模型与 Jev，检查 dry-run、间隔、重启、换代、取消、旧 notice、人加入自主工具回合、after-interaction 接力、上下文内容与更新。验证检查机制和请求组装，不证明真实主体会做出有价值的工作。

当前默认不唤醒，也没有完成长期活体观察。时钟大幅跳变、突然断电的全部写入窗口及真实 provider 的长期取消行为未作完整验证；不能从离线测试推出无延迟或恰好一次执行保证。
