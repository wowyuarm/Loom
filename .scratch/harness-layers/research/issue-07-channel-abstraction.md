# Issue #7 调研报告：Interaction Channel 抽象与多 channel 并行

## 1. 现状

### 1.1 单 channel 硬限制

`src/host/loom-host.ts` 的 `openLoomHost()` 中：

```typescript
const enabledInteractionChannels = [
  configuration.integrations.local,
  configuration.integrations.weixin,
  configuration.integrations.raft,
].filter(Boolean).length;
if (enabledInteractionChannels > 1) {
  throw new Error("Loom Host currently accepts one enabled interaction channel");
}
```

这是唯一的硬限制点。去掉这段校验后，`openLoomHost` 会分别创建 local/weixin/raft 实例，但后续装配逻辑不支持多 channel。

### 1.2 InteractionChannelAgentSurface 接口

`src/main-agent/channel-surface.ts`：

```typescript
export interface InteractionChannelAgentSurface {
  guidance: string;
  tools: InteractionChannelTools;
  defaultDestination?: InteractionDestination;
  attentionSource?: InteractionChannelAttentionSource;
}
```

这是 channel 暴露给 Main Agent 的唯一面。协议、ingress、delivery 和恢复留在 channel adapter 内部。

### 1.3 各 channel 实现现状

| Channel | OutboundDelivery | AgentSurface | Ingress | Attention | Destinations |
| --- | --- | --- | --- | --- | --- |
| **Raft** | ✅ deliver (message/task/attention) | ✅ agentSurface() | wake + inbox drain | ✅ ambient activity → attentionSource | ✅ known_destinations 表 |
| **Weixin** | ✅ deliver (message only) | ❌ | HTTP polling | ❌ | ❌ (单 peerId，无 destination 概念) |
| **Local** | ✅ deliver (message only) | ❌ | Unix socket | ❌ | ❌ (同步 chat，无 destination) |

### 1.4 装配链路

当前装配是单值穿透：

```
openLoomHost
  → outboundDelivery: local ?? weixin ?? raft ?? outboundDelivery  (单值)
  → channelAgentSurface: raft?.agentSurface()  (单值，只有 raft)
  → openLoomInstance({ outboundDelivery, channelAgentSurface })
    → createRevisionBoundMainAgent({ channelAgentSurface })
      → createPiAgentExecution({ channelAgentSurface })
```

`channelAgentSurface` 在 `pi-execution.ts` 中被用于：
- `.guidance` → 拼入 system prompt
- `.tools` → 创建 channel 专属工具（raft_places, raft_activity 等）
- `.defaultDestination` → message 工具的默认 destination
- `.attentionSource` → Orientation 的外部注意力来源

### 1.5 Runtime 中的 Delivery

`src/runtime/runtime.ts`：Runtime 持有单个 `#outboundDelivery: OutboundDelivery | undefined`。Delivery 按 FIFO 串行执行，通过 `DeliveryAttemptRequest.routeRef` 路由到对应 channel。

`DeliveryAttemptRequest` 已包含 `routeRef`，`OutboundDelivery.deliver()` 实现里用 routeRef 做了归属校验（如 raft: `if (attempt.routeRef !== this.options.routeRef)`）。

### 1.6 Input 和 Destination 已有的跨 channel 基础

- `RuntimeInput.source`：已标识来源（"raft" / "weixin" / "local"）
- `InteractionContext.routeRef`：已标识来源 route
- `InteractionDestination.routeRef`：已标识目标 route
- `InteractionDestination.destinationRef`：opaque ref，指向具体落点

这些字段已经为多 channel 路由提供了基础，但目前只被单 channel 使用。

## 2. 核心问题：Channel 嵌在 Integration 里

当前架构中，channel 不是独立概念，而是嵌在具体 Integration 实现里：

- `RaftChannel` 同时是 Integration adapter + Interaction Channel + Agent Surface provider
- `WeixinAdapter` 是 Integration adapter + Interaction Channel，但不提供 Agent Surface
- `LocalInteractionChannel` 同上

这导致：
1. 想加新 channel 必须写一个完整 Integration
2. 多 channel 无法并行，因为装配链路只接受单值
3. Weixin/Local 没有 Agent Surface，Main Agent 看不到它们的 guidance 和 destinations

## 3. 实施方案建议

### 3.1 把 Channel 从 Integration 中抽出来

**目标**：Channel 成为第一公民，Integration 是可选的 channel 实现 backend。

建议引入一个 `InteractionChannel` 接口，统一三个现有实现：

```typescript
interface InteractionChannel extends OutboundDelivery {
  start(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>): Promise<void>;
  stop(): Promise<void>;
  status(): InteractionChannelStatus;
  agentSurface?(): InteractionChannelAgentSurface;
}
```

这个接口比现有三个实现各自的接口更统一。`agentSurface()` 变为可选——Weixin 和 Local 可以先不提供，后续按需补。

### 3.2 去掉单 channel 硬限制，支持多 channel 生命周期

`openLoomHost()` 改为：
- 分别创建所有 enabled channel 实例
- 全部 `start()`，各自接收 Input
- `stop()` 时按逆序停止

关键变化：`outboundDelivery` 从单值变为多值。Runtime 需要按 `routeRef` 分发 delivery attempt 到对应 channel。

### 3.3 合并多 channel 的 Agent Surface

当多个 channel 都提供 `agentSurface()` 时，需要合并：

| 字段 | 合并策略 |
| --- | --- |
| `guidance` | 各 channel guidance 拼接 |
| `tools` | 工具名和实现去重合并（目前各 channel 工具名不冲突，前缀不同） |
| `defaultDestination` | 取第一个有默认 destination 的 channel，或按配置指定 |
| `attentionSource` | 多 channel 时需要聚合（目前只有 raft 有） |

建议引入一个 `CompositeAgentSurface` 或在装配层做合并，而不是改 `InteractionChannelAgentSurface` 接口本身。

### 3.4 Delivery 路由

Runtime 的 `#outboundDelivery` 从单个变为 `Map<routeRef, OutboundDelivery>` 或列表。Delivery attempt 已经带 `routeRef`，按 routeRef 找到对应 channel 的 delivery 实例即可。

这是改动量最小的部分，因为 routeRef 路由逻辑已经在各 channel 的 `deliver()` 里做了归属校验。

### 3.5 Weixin Agent Surface（可选，后续）

Weixin 要提供 Agent Surface，需要：
- **guidance**：描述 weixin 是关系型 channel，一对一对话
- **destinations**：目前 weixin 只有单 `peerId`，destination 概念需要简化为"weixin peer"
- **attentionSource**：weixin 目前没有 ambient activity，可以不提供

这是 issue 提到的"让 weixin 等实现 agent surface"，但可以作为第二步，先跑通多 channel 框架。

## 4. Local Channel 评估

### 4.1 当前作用

- Unix socket 本地 CLI 通道（`loom chat` / `loom history`）
- 测试链路依赖：`test/integrations/local.test.ts`（专用）、`test/host/loom-host.test.ts`（通过 local channel 测试 host 生命周期）
- 注意：很多 test 文件里的 `local-test` 是模型 provider 名称，不是 local interaction channel

### 4.2 删除前需迁移的测试

| 测试文件 | 依赖方式 | 迁移方案 |
| --- | --- | --- |
| `test/integrations/local.test.ts` | 直接测试 local channel | 整体删除或改为测试其他 channel |
| `test/host/loom-host.test.ts` | 用 local channel 测试 host 启停、Input 接收、interactionView | 改用 raft 或 weixin 的 test double，或保留一个最小 test-only channel |

### 4.3 建议

Local channel 的核心价值是本地调试（`loom chat`）。如果删除，需要替代方案（如直接用 raft channel 做本地测试）。建议：
1. 先完成多 channel 框架
2. 评估 `loom chat` 是否还有实际使用场景
3. 如果没有，迁移测试后删除

## 5. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Delivery 路由从单值变多值 | Runtime 核心路径改动 | routeRef 路由已有基础，改动集中在 `openLoomHost` 和 `openLoomInstance` |
| 合并 Agent Surface 的 guidance 过长 | system prompt 膨胀 | 各 channel guidance 控制长度；多 channel 时可以加 header 分段 |
| 多 channel Input 竞争 | 多 channel 同时收到消息时 Input 排序 | Runtime 已有 Input FIFO，按 occurredAt 排序，不依赖 channel 顺序 |
| Weixin 没有 destination 概念 | 多 channel 时 weixin 的回复落点不明确 | weixin 的 destination 简化为单 peer，routeRef 区分 |

## 6. 建议步骤

1. **引入 `InteractionChannel` 统一接口**，让三个现有实现适配（改动最小化，不改内部逻辑）
2. **去掉单 channel 硬限制**，`openLoomHost` 支持多 channel 生命周期管理
3. **Runtime delivery 从单值改为按 routeRef 路由**
4. **装配层合并多 channel Agent Surface**（guidance 拼接、tools 合并、defaultDestination 选择）
5. **验证**：同一实例同时启用 raft + weixin，确认 Input 来源标识、message 回复落点正确
6. **Local channel 评估**：迁移测试后决定删除/保留

步骤 1-3 是框架性改动，可以作为一个工作单元；步骤 4 是 agent 侧合并；步骤 5 是验收；步骤 6 独立。

## 7. 不建议做的事

- 不需要引入通用 plugin loader 或 channel registry——channel 数量少且固定
- 不需要改 `InteractionChannelAgentSurface` 接口本身——合并在装配层做
- 不需要预先给 weixin/local 补全 Agent Surface——先跑通多 channel 框架，再按需补
- 不需要改 `RuntimeInput` 或 `InteractionContext` 类型——已有的 source/routeRef 字段够用

## 8. Terra 复核补充（2026-08-06，源码逐一核对）

正文各节论断与源码全部对得上，另补充三个正文未覆盖的点：

### 8.1 routeRef 当前是实例级单值，多 channel 需要重新定义

`openLoomHost()` 打开每个 channel 时都传同一个 `expectedRouteRef: configuration.defaultInteractionRoute`（loom-host.ts），raft/weixin 各自的配置文件里自带 routeRef 并与该值比对（raft-channel.ts:1222、weixin-adapter.ts 的 configuration.routeRef）。多 channel 时实例级 `interaction.defaultRoute` 的语义必须重新定义，两个候选：

1. 去掉实例级 default，各 channel 以自己配置的 routeRef 为准；
2. 保留实例级 default，仅作为 message 工具的兜底 route（无 destination 时）。

另外 `pi-execution.ts:587-588` 校验 `channelAgentSurface.defaultDestination.routeRef === defaultInteractionRoute`，多 channel 后该校验需按 channel 拆分或移除。这是正文 3.2/3.4 之外的第三个单值点。

### 8.2 weixin/local 的 input 没有 interaction context，多 channel 时回复会落错 channel

当前 weixin adapter 构造的 `RuntimeInput` 只有 `source: "weixin"`，没有 `interaction` 字段（local 同理）。单 channel 时靠 message 工具固定 route 兜底（message.ts:118 `destination?.routeRef ?? options.routeRef`）能正确回复；多 channel 时若实例 default 是 raft，weixin 来的消息回复会落到 raft。`source` 目前只用于 wave 分桶（runtime.ts:384 `input.interaction?.routeRef ?? input.source`），不参与回复路由。

两个修法（二选一或组合）：

1. weixin input 补最小 interaction context（routeRef + 单 peer destination），与 raft 的做法对齐；
2. message 工具的兜底 route 改为按当前 turn 的 input 来源动态取，而非实例级固定值。

这与 issue 正文"input 的 source 字段标识来源"的设计想法直接相关：source 已存在，但要用它参与回复路由还差一步。注意第 7 节"不改 RuntimeInput 类型"仍然成立——补 interaction context 是改 weixin 的 input 构造内容，不是改类型。

### 8.3 其他验证结论

- 多 channel 生命周期基本现成：`DefaultLoomHost.start()` 已按 local → weixin → raft 顺序逐个 start（loom-host.ts:133-148），拆掉硬限制后剩余工作主要是装配单值变多值。
- tools 合并无冲突：`pi-execution.ts:580-581` 对 channel tools 名做重复校验，目前只有 raft 提供 tools，多 channel 初期安全。
- wave 分桶天然隔离：scope key 是 `[routeRef, placeRef]`（runtime.ts:384-386），多 channel 的 interaction wave 不会互相合并，无需改动。
- local 测试依赖确认：全仓只有 `test/integrations/local.test.ts` 和 `test/host/loom-host.test.ts` 直接依赖 local channel（`local-test` 是模型 provider 名，与 local channel 无关）。loom-host.test.ts 用 local 测 host 生命周期（启停、Input 接收、interactionView、status 显示），迁移时需换 raft 或最小 test double。
