# 对话后的单次检查

`after-interaction` 在人开启的对话停顿后，做一次独立判断，必要时给主主体一条可行动的情境提示。它不是未来任务调度器，也不会因自身检查后的 Turn 无限重启定时器。研究中的其它主动性方案不属于本文的当前行为。

## 条件与生命周期

配置为 `workspace`，依赖 `agentRuntime`、`clock`、`jev`、`sessionProjections` 和 `timer`。缺少 jev 服务时本插件不激活，不妨碍主运行时。定时器由 Cordis effect 持有，只活在当前插件生命周期内，重启不会恢复未触发的检查。

真人输入进入主主体 inbox 时取消旧定时器与当前判断，并移除自身尚未接纳的 notice；包含该输入的 Turn（包括人中途加入自主回合）以 `completed` 结束后，随机等待一段时间再检查。等待窗口见[定时实现](<../../src/after-interaction/alarm.ts>)，不是部署配置字段。

触发时必须仍是原主 Agent、处于 idle 且没有待处理输入，再通过 `runMaintenance` 取得维护窗口。条件不满足就丢弃，不补排、不重试；换代后的主体不会接到旧 generation 的定时检查。判断前后都复查人的新输入与取消状态，避免把已经失效的停顿当成机会。与长期自主检查的配合见 [pulse](<pulse.md>)。

## 判断与模型看到什么

判断输入包括当前 UTC+8 时刻、距人上次输入的间隔、从 Session 投影取得的有界近期对话，以及工作区 attention/threads 的有界文本。材料读取失败按空处理，精确限制见[判断材料](<../../src/after-interaction/materials.ts>)。

jev 只返回 `quiet`、`speak`、`act` 的概率；Loom 按 quiet 阈值决定是否 wake，再选择 speak/act。概率必须是有限数，但当前代码不另校验概率区间或总和。阈值及提问是校准的一部分，权威在[verdict](<../../src/after-interaction/verdict.ts>)，不能从文档另加 quiet hours、冷却或次数限制。

调用失败、无法读取结果或 verdict 为 quiet 时保持沉默。非 quiet 时，主主体只看到一条 `@loom/after-interaction` notice；不看到概率，也不重复全部材料。notice 建议继续说话或推进未完成工作，主体仍可判断没有真实事项而结束。对外行动仍经[渠道 message](<channels.md>)，该插件自己不发消息。

独立判断会消费 jev 的请求；主模型只有收到 notice 才产生下一轮。notice 是一时情境，不在[换代](<continuity.md>)时作为普通输入再携带。概率在运维日志中用于观察，不能据此声称当前校准已经保证主体行动质量。

近期对话投影只把**成功完成**的 `message` tool call 当作 Loom 一侧的对话记录：`tool/call(message)` 先把 call id、文本、时间与 turn 记为一条待定发送，只有 matching 且未标 `isError` 的 `tool/result` 才把这条发送追加进近期对话。失败的结果、找不到 matching call 的结果、参数 malformed 的调用都不产生 Loom 发言；发送结果缺失时该 call 一直待定，进入下一个 turn 时作为被打断的孤儿丢弃。判断与模型因此只看到已经成功完成 `message` 的内容，与[Delivery 事实 ADR](<../adr/0005-delivery-is-the-external-fact.md>)一致。若进程在渠道返回后、Delivery ledger 写入前崩溃，远端可能已经收到但本投影会保守省略；`unknown` 仍由渠道的未确认投递上下文保留，不能据此自动重发。

## 验证入口

[after-interaction 测试](<../../tests/after-interaction.spec.ts>)使用可控 timer 与判断结果，覆盖只由人输入触发、idle 检查、判断失败、竞态让路与情况提示；unit 层另覆盖发送成功才进入近期对话、失败/未知/无匹配/malformed 的 fail-closed 行为与多 call 配对。它证明机械条件和文本，不证明真实 jev 在长期对话中的判断质量；行为评估需另外给出真实材料与观察证据。
