# 渠道收发与交付可靠性

渠道网关负责传输与授权，Loom 的 `channels` 消费已规范化的输入并把它交给主主体。对外发送必须调用 `message`；普通 assistant 文本不会自动送到渠道。这是单一会话焦点的实现，不是多会话消息路由器。

## 配置与依赖

Loom 消费方只接 `workspace`，需要网关的 `channels` 服务以及 `runtimeState`、`agentRuntime`、`clock`、`tools`、`systemPrompt`。网关和 Telegram 适配器由 [Bundle](<../../cordis.patch.yml>)挂载；授权名单、token 与适配器配置归各提供方。Bundle 的 `allow: []` 默认不接纳任何 actor。准确配置见[部署指南](<../cookbook/deployment.md>)及对应版本的网关说明。

## 输入接受与焦点

`channel/inbound` 到来时先查 `(channel, providerMessageId)` 去重，在工作区完成附件处理并构造规范化正文，然后把正文和来源元数据持久写成 `pending`，最后调用 `agentRuntime.deliver`。模型看到渠道、场所类别、发送者、正文及附件标记；传输 route 不作为工具参数暴露。

`pending` 只有在**当前主 Session** 的匹配 `user/message` 事件提交后才变为 `delivered`；别的 Session 提交同 id 的消息不是本次交接的确认。没有活 Agent、换代窗口或进程重启时，带正文的 pending 输入会在 Agent ready 或插件重新挂载后重投；交接确认前崩溃允许产生重复，但不会静默丢失。旧版本只有 accepted 标记而没有正文的记录仍可去重，不能伪造重放内容。当前进程用小型 handoff ledger 避免同一输入在 drain 期间反复尝试；这不是跨进程 exactly-once，也不是消息 broker。准确路径见[输入消费实现](<../../src/channels/index.ts>)。

`message` 发到最近一次成功交给 Agent 的输入设置的内存焦点，模型不能指定 channel/route；重启后焦点为空，须有新输入或 pending 重投才可发消息。多渠道并发输入时焦点会变，不能把“答某条旧消息”当作绑定了其 route 的保证；多 channel 仍只是同一 Individual 的入口，本轮没有引入独立 Agent 或 per-channel 路由。

## 附件与路径限制

收到的附件尽可能保存到工作区内的渠道 media 目录，模型看到相对路径后自行 read/read_image；网关不能下载或下载失败时仍给无路径标记，不丢弃正文。没有自动清理，附件属于普通工作区文件。

发送时工具接收工作区相对或绝对文件路径，目标渠道须声明附件能力。消费方以 `resolve` 后的路径做工作区范围检查；路径越出则拒绝发送。它没有对 symlink 目标另做 realpath 检查，因此这是词法路径限制，不是抵御工作区符号链接的文件沙箱。一般文件工具的权限见[运行时](<runtime.md>)。

## 出站状态与不确定性

附件读取成功后，先持久记录 `pending`，再调用网关；返回确认则回填 `delivered`，抛错则回填 `unknown` 并让工具失败。回填后发 `loom/delivery` 事件。字段与含义见[contracts](<../../src/contracts/index.ts>)；记录不是完整的附件重发描述。

- `pending`：尝试未完成记录，可能在发送或回填前中断。
- `unknown`：请求抛错，但不能据此断言远端没收到。
- `delivered`：网关返回投递结果，不等于收件人读过。

不确定记录以动态 context `loom:undelivered`（order 45）进入后续请求，提醒先核实、不要盲目重发。相同 `(channel, route)` 上较晚的成功发送会让旧不确定记录退出提醒集合，但不把旧记录改成已送达。Loom 没有自动重发或自动切 provider。

提醒集合每次组装请求时对整张 effect 表读一遍算出（`uncertainDeliveries()`），且 delivered 记录不清理——表随部署寿命单调增长。单会话一次一条的量级下无影响；长期高频部署会随记录数线性变慢，这是已知未优化项，不是保证的吞吐。

## 未发送文本的提醒

一个已交付输入对应的 Turn 写了 assistant 文本却没有调用 `message` 时，`agent/turn-stopping` 会 steer 一次 notice，让主体决定发送或保持沉默；不会强制发送，也不会形成重复提醒循环。调用过 `message` 即使发送失败，也不再次催发，因为不确定投递上下文已负责说明风险。

## 失败可见性

`turn-failures` 消费 `turn/end`，由 `log` 输出 stderr 并在需要时写入 attention：

| 结束原因 | 运维日志 | 主体材料 |
| --- | --- | --- |
| `error` / `interrupted` | 告警与摘要 | 追加一条失败事实 |
| `max-tokens` / `blocked` | 告警 | 不声称整个 Turn 失败 |
| `completed` / `aborted` / `forked` | 不额外报告 | 不追加 |
| 未认识的扩展原因 | 只报告原因名 | 不猜测失败 |

上游文本压成有界单行；写材料失败只记告警，不重试 Turn、不发送用户通知。监听器只处理当前主 Session 的 `turn/end`，辅助 Session 的失败不写入这份 attention。异步写入只串行化该插件自己的追加，不与主体文件工具组成共同事务。失败材料立即落盘，但工作区留版等下次成功 Turn，时间归属可能偏后。准确规则见[失败实现](<../../src/turn-failures/index.ts>)。

## 验证入口

[渠道测试](<../../tests/channels.spec.ts>)覆盖交付、焦点、附件、发送三态和提醒；[入站交接测试](<../../tests/inbound-handoff.spec.ts>)覆盖无 Agent、重启重投、Session 确认和并发重复；[runtime-state 测试](<../../tests/runtime-state.spec.ts>)覆盖持久记录与不确定性筛选；[turn-failures 测试](<../../tests/turn-failures.spec.ts>)和[日志测试](<../../tests/log.spec.ts>)覆盖故障可见性。这些使用测试网关，不证明真实 Telegram token、授权或远端投递成功。
