# 会话连续性、历史访问与上下文管理

Individual 可以压缩当前上下文，也可以换到新 generation 后继续。Loom 复用 `dsh-context-continuity` 的机制，只适配单主体的活句柄、Session 祖先链、所属会话范围和材料来源。运行时所有权见[运行时](<runtime.md>)。

## 两种缩减，外部效果都不回滚

- **压缩**：`context_compact` 通过当前 Agent Preset 中的压缩引擎替换一段旧上下文，留在同一 Session。Loom 使用 continuity 包的引擎以支持主体提交的 summary；Preset 设置 `auto: false`，自动压力由一条独立 policy 入口管理。
- **换代**：`context_rollover` 成功结果成为持久意图，协调器在 idle 边界创建后继。省略 checkpoint 是新上下文加 handoff；指定可返回 checkpoint 时，后继继承来源 Session 到该锚点完成 Turn 的精确前缀，再接 handoff。

换代不是 Git reset，不撤销文件、进程、远程调用或已发送的话。旧 Agent 的 dispose 会清理其所属的 DSH jobs；Loom 没有“有 jobs 时拒绝换代”的前置保证，应先收集或停止仍需要的工作。

## 锚点与历史范围

`context_checkpoint` 记录主体自己选择的锚点；`context_status` 展示当前工作集、当前及祖先 generation 的可返回目标和可压缩部分。Loom 没有贡献自动话题或 Team 边界，列表为空可以只是主体还没记录 checkpoint。

返回前必须能定位已完成 Turn 的前缀、价格可知、工作集确实缩小并低于 handoff 预算。不满足则拒绝，不猜测来源。祖先遍历有界，精确规则见[检索适配](<../../src/context-continuity/retrieval.ts>)。

`context_search` 与 `context_read` 经 DSH Session query/persistence 查阅记录。搜索授权范围来自 runtime-state 的所属 Session 记录，包含 checkpoint return 后离开当前祖先链的分支；返回目标只沿当前祖先链查找。搜索某段历史和把它恢复为模型工作集是不同操作。

## 换代时序与恢复范围

持久的 rollover 结果出现后，旧 generation 的 admission gate 捕获仍欠后继的输入而非继续提交旧请求。运行时先解析返回前缀，再释放旧 Agent；创建确定 Session id 的后继，写当前指针与所属记录，激活后先送 handoff、后送携带输入。[运行时实现](<../../src/agent-runtime/runtime.ts>)是具体顺序的权威。

handoff/continuation 自身与标记为瞬时的 notice 不作为普通外部输入再次携带；当前瞬时来源见[共享声明](<../../src/contracts/index.ts>)。其中对话后检查描述的是过去的一次停顿，不应在后继中冒充新的机会。

启动时协调器会根据已恢复 Session 的投影重新驱动未完成的换代意图。确定身份支持重复驱动，但指针、所属记录、输入不是一个跨存储事务；不能从这套机制推断任意崩溃点都已有端到端验收。

## 上下文压力与模型体验

预算取当前 Session 记录的模型窗口，尚无记录时查询配置路由。handoff 与 hard limit 的公式见[预算实现](<../../src/context-continuity/retrieval.ts>)，不在指南中另维护固定数值。

Loom 的 pressure host 把 budget、测量、当前压缩引擎、正在接纳的输入与可选 jev 判断交给上游 policy：达到 handoff 预算时提供一次持久提示；达到 hard limit 时强制缩减，无法证明缩小则拒绝请求；provider 报上下文溢出时走有界缩减与重试。长间隔相关性判断在 judge 可用时参与，当前接口见[压力适配](<../../src/context-continuity/pressure.ts>)；缺少 judge 不使运行时停机。

模型看到工具说明、自己记录的锚点状态、必要的压力 notice 和换代 handoff。后继从工作区重新取得[材料](<materials.md>)，不必把身份与整份记忆重写进 handoff。提示文本及其来源身份见[Host 适配](<../../src/context-continuity/host.ts>)，不是工程文档的注入。

## 验证入口

[组装测试](<../../tests/boot-smoke.spec.ts>)验证实际 DSH 栈上的换代与返回前缀；[运行时测试](<../../tests/agent-runtime.spec.ts>)检查交接顺序；[压力测试](<../../tests/pressure.spec.ts>)检查 Host 的预算和判断适配；[Host 测试](<../../tests/context-continuity-host.spec.ts>)与[工具文本测试](<../../tests/continuity-tool-text.spec.ts>)检查来源及模型可见纪律。要改上游 policy 的行为，必须检查相应版本的上游源码与测试，不能只改 Loom 的说明。
