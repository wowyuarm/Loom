# 持久接纳后的入站消息采用可恢复的至少一次交付

- 日期：2026-10-13
- 状态：有效

## 背景

渠道输入可能落在换代窗口、Agent 暂时不可用或进程重启附近。只记录一个 accepted 标记再尝试交给 Agent，会把“已接受”和“Agent 已看到”混成一个事实，导致输入永久丢失。另一方面，外部渠道、Loom 和 Session 很难共同提供全链路恰好一次处理；为此引入重型消息基础设施会超过当前需求。

## 决定

当 Loom 成功持久保存一份完整、可恢复的规范化入站输入后，这份输入进入 pending 状态。它必须能在 Agent 恢复、换代完成或进程重启后再次尝试交给同一个 Individual 的主 Agent；交接结果不确定时允许重复处理。一次输入是否已被接受，以 `(channel, providerMessageId)` 为去重身份，provider id 不跨 channel 假定全局唯一。

输入在 Session 的 `user/message` 事件持久提交后才从 pending 变为已交接。没有活 Agent、投递失败或进程在交接前退出时，输入继续留在 pending；恢复逻辑只重投入站输入，不自动重发任何出站 Effect。

多个 channel 仍是同一个 Individual 的沟通入口。入站记录保留 actor、place、visibility、channel 和规范化内容；channel 不拥有 Identity、Memory、Session lineage 或独立恢复状态。

## 理由与代价

- 优先保证“不丢消息”，符合当前运行规模和用户选择。
- 只使用现有 runtime-state、Session event 和 Agent 生命周期，不引入 broker 或 exactly-once 协议。
- 崩溃发生在投递确认前会留下重复，这是有意接受的代价；调用方和模型必须能承受重复输入。
- 旧版本已经写入的 accepted 记录可能没有可重放内容，只能作为历史去重记录；升级不伪造缺失的输入正文。

## 重审信号

- 渠道能够提供稳定幂等键，并且 Loom 需要把副作用执行也纳入可验证的幂等协议。
- 多进程共同消费同一 Individual，单个 Agent writer lease 不再是唯一的并发边界。
- 重复输入已经造成可观测的业务损害，且无法通过模型侧或 Effect ledger 的幂等约束解决。
