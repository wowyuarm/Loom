# 外部效果以 Delivery ledger 为事实，不把模型输出当作已发送

- 日期：2026-10-13
- 状态：有效

## 背景

模型的 assistant text 只是模型输出，`message` tool call 也只能证明主体发起了一次发送尝试。网络请求抛错时，远端可能从未收到，也可能已经收到但确认丢失。若把 tool call 或普通 assistant text 当作“主体已经说过”，主动性判断、历史摘要和重启后的恢复都会制造错误事实。

## 决定

外部世界中的出站效果由 Runtime state 的 Effect/Delivery ledger 负责记录，具体状态遵循三态语义：`pending` 表示已记录但尝试未完成，`delivered` 表示渠道返回了投递结果，`unknown` 表示无法判断远端结果。只有 `delivered` 可以作为“已向渠道投递”的事实；`pending` 和 `unknown` 是需要核实的不确定性，不能自动解释成失败或成功。

Session 中的 tool call 可以保留意图和尝试证据，但不能单独驱动“主体已经对外说了什么”的投影。需要这项事实的能力统一消费 Effect/Delivery 的 contract、事件或派生 projection，不各自解析 tool call。Loom 不因 `unknown` 自动盲目重发。依赖 Session 事件的纯 projection 可以保守省略这类未确认结果；完整不确定性仍由 Delivery ledger 和 reconciliation context 保留。

这条决定约束后续实现；当前 ledger 与渠道路径已有大部分基础，但 after-interaction 对失败 `message` 调用的投影仍需与本决定对齐。

## 理由与代价

- 外部世界事实与模型内部行为分开，重启后可以保守地恢复不确定性。
- 不会因为一次超时就把远端可能已经收到的消息再发一遍。
- 主动性和历史读取需要额外依赖 delivery 事实，而不能只读 Session 的局部事件。
- “已投递”不等于“对方已读”；当前 ledger 不承担阅读回执。

## 重审信号

- 某个渠道提供稳定的幂等 key、远端状态查询或可验证的阅读回执，并且 Loom 需要表达比三态更细的生命周期。
- 真实运行显示不确定状态长期无法由 Individual 或 operator 核实，需要引入显式 reconcile 流程，而不是改变 `unknown` 的含义。
