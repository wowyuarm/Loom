# Codebase Review Findings (Evidence)

Status: evidence for `../issues/01-codebase-review-refactor-candidates.md`
Captured: 2026-08-06, against the working-tree state at that time.

> 路径与行号会随重构过期；本文件只作为 triage verify 的证据快照。issue 正文用域概念与模块/符号名描述，不依赖此处行号。

## 审查方法

- 主路径人工通读：`src/runtime`（runtime.ts、schema.ts、types.ts、scheduler.ts）、`src/host`、`src/instance`、`src/configuration`、`src/workspace`、`src/cli`。
- 两个子代理并行扫 `src/agents` + `src/main-agent` 与 `src/integrations`，带行号证据返回；主路径已对子代理的 medium 发现逐条回读源码复核。
- 判断基准：防御对应真实场景（lease 恢复、ENOENT、fencing token、fail-fast）的不算过度防御；为不可能分支、已校验不变量重复检查、吞错掩盖问题的才算。

## 候选 1 - withoutImagePixels 双实现且行为分歧

`src/main-agent/tool-trace.ts:494-503`（不递归）：

```ts
function withoutImagePixels(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.type !== "image") return value;
  return { type: "image", ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}), pixelContentOmitted: true };
}
```

`src/main-agent/pi-execution.ts:1075-1088`（递归）：

```ts
function withoutImagePixels(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutImagePixels);
  if (!value || typeof value !== "object") return value;
  if (value.type === "image") {
    return { type: "image", ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}), pixelContentOmitted: true };
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, withoutImagePixels(nested)]));
}
```

tool-trace 版数组原样返回、不递归对象；pi-execution 版递归两者。`expand_tool_result` 走 tool-trace 路径，嵌套在数组里的 image block 不会被剥离像素。

## 候选 2 - 共享 util 缺失，helper 散落重抄

`src/` 无 shared/util 目录。重复定义统计（按函数名 grep）：

| 函数 | 份数 | 位置（节选） |
| --- | --- | --- |
| `isObject` | 12 | nmem/episodes.ts:346、nmem/client.ts:262、nmem/threads.ts:429、local/local-channel.ts:356、configuration/instance.ts:342、workspace/agent-workspace.ts:133、workspace/workspace-mutation.ts:602、attachments/reference.ts:50、agents/orientation.ts:410、agents/thread-maintainer/evidence.ts:173、agents/memory-reflector.ts:692、agents/thread-maintainer/observations.ts:74（签名变体） |
| `isMissing` / `isMissingFile` | 9 | nmem/configuration.ts:89、configuration/instance.ts:346、workspace/agent-workspace.ts:137、workspace/workspace-mutation.ts:606、host/loom-host.ts:486、instance/initialization.ts:93、agents/thread-maintainer/{evidence.ts:169,workspace.ts:125,index.ts:610} |
| `errorMessage` | 7 定义 + 23 内联 | weixin/weixin-http.ts:499、weixin/weixin-adapter.ts:500、raft/raft-cli-remote.ts:1208、raft/raft-channel.ts:1367、attachments/attachment-store.ts:347、local/local-channel.ts:360、host/status-socket.ts:236 |
| `validateIso` / `isIsoTimestamp` | 6 | raft/raft-channel.ts:1363、cli.ts:185、runtime/runtime.ts:3900、agents/orientation.ts:406、agents/thread-maintainer/index.ts:596、agents/life-recorder.ts:528 |
| `nonEmpty` / `nonEmptyString` | 5 | weixin/weixin-adapter.ts:475、raft/raft-channel.ts:1397、nmem/configuration.ts:84、attachments/attachment-store.ts:332、workspace/workspace-mutation.ts:596 |
| `fileExists`（stat 探测） | 3 | raft/raft-channel.ts、weixin/weixin-adapter.ts、attachments/attachment-store.ts |

## 候选 3 - 三器官 finalAssistantText 末行解析废弃路径

`src/agents/memory-reflector.ts:625-634`：

```ts
function finalAssistantText(messages: AgentMessage[]): string {
  const message = [...messages].reverse().find(candidate => candidate.role === "assistant");
  if (!message) throw new Error("Memory Reflector did not return an assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `Memory Reflector stopped with ${message.stopReason}`);
  }
  const text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").trim();
  const terminalLine = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  return terminalLine === "UPDATED" || terminalLine === "NO_CHANGE" ? terminalLine : text;
}
```

调用点 `src/agents/memory-reflector.ts:331` 丢弃返回值：

```ts
await this.#runSession(request, runId, baseline.get("facts.json")!, tools);
```

结果由 `changedMaterials.length > 0` 决定。同模式见 `src/agents/attention-maintainer.ts:364-373`（调用点 :220）、`src/agents/thread-maintainer/index.ts:578-587`（调用点 :307）。

`stopReason` 检查有用；末行 `UPDATED`/`NO_CHANGE` 解析被丢弃。已被 [前一轮 design simplification](../../2026-08-05-design-simplification/decisions.md) Technical closure 1 决策移除。

## 候选 4 - raft-channel 旧 state 兼容迁移

`src/integrations/raft/raft-channel.ts:286-289`：

```ts
const wakeColumns = this.#database.prepare("PRAGMA table_info(wakes)").all() as unknown as Array<{ name: string }>;
if (!wakeColumns.some(column => column.name === "delivery_order")) {
  this.#database.exec("ALTER TABLE wakes ADD COLUMN delivery_order INTEGER");
}
```

`src/integrations/raft/raft-channel.ts:972-987` `#backfillKnownDestinations` 从旧 `refs` 表回填 `known_destinations`：

```ts
const rows = this.#database.prepare(`SELECT ref, remote_value FROM refs WHERE kind = 'destination' ORDER BY rowid`).all() ...
for (const row of rows) { this.#upsertKnownDestination({ destinationRef: row.ref, ...identity, observedAt: activation.activated_at }); }
```

对比 `src/runtime/schema.ts` 的 `migrateVersion16` 等用 `PRAGMA user_version` 的结构化迁移（必须保留）。

## 候选 5 - nmem 退避双实现分歧

`src/integrations/nmem/threads.ts:425`：

```ts
function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}
```

`src/integrations/nmem/episodes.ts:326`：

```ts
function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 30_000 * (2 ** Math.min(attempt - 1, 7)));
}
```

`attempt=0`：threads → 30s（`2^0`），episodes → 15s（`2^-1=0.5`）。

## 候选 6 - atomicWrite / temp+rename 重复且语义分歧

五处：`src/agents/memory-reflector.ts:681`、`src/agents/attention-maintainer.ts:408`、`src/agents/thread-maintainer/workspace.ts:103`、`src/agents/thread-maintainer/evidence.ts:166`、`src/workspace/workspace-mutation.ts:514`（`durableWrite`）。

仅 `workspace-mutation.ts` 的 `durableWrite` 带 `handle.sync()` + `syncDirectory`（目录 fsync），其余四份无 fsync。

## 候选 7 - nmem client 构造 / connectionHash / classify 三份重复

`src/integrations/nmem/threads.ts`、`episodes.ts`、`working-memory.ts` 各自重复 `new NmemClient({ endpoint: options.endpoint, ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}), ... })`、`createHash("sha256").update(...)` connectionHash、`classify(error)`。

## 候选 8 - life-recorder 手写 YAML frontmatter

`src/agents/life-recorder.ts:481` 用模板字符串 + `JSON.stringify` 拼 episode frontmatter；`src/integrations/nmem/episodes.ts:6` 用 `yaml.parse` 读回。

## 候选 9 - 过度防御零散项

| 项 | 位置 | 问题 |
| --- | --- | --- |
| 9.1 | `src/main-agent/pi-execution.ts:754` | `if (!ordinaryToolNames.has(event.toolName)) return;` 是 `tool_execution_start` 处理器最后一条语句，return 后无代码，重构残留死守卫 |
| 9.2 | `src/main-agent/tool-trace.ts:317-331` | 对 structuredClone 的索引失配静默 `return`，结构上不可能；与同文件 `replaceRawInteraction`（失配 throw）不一致 |
| 9.3 | `src/agents/orientation.ts:324,330-332`、`src/agents/life-recorder.ts:398` | find 谓词已保证的条件循环体里又查一遍，只为 TS 类型收窄 |
| 9.4 | `src/agents/tool-trace-compactor.ts:177` | `details.size !== expectedIds.length` 终检已被前面 `results.length` 校验 + 逐项 `has` 查重蕴含 |
| 9.5 | `src/agents/memory-reflector.ts:589` | `validateCurrentMaterials` 写后重跑 `loadBaseline` 逐个查非空，同一不变量二次验证 |
| 9.6 | `src/main-agent/activity.ts:277` | `activities.at(-1)?.closedAt ?? new Date(0).toISOString()`，`[...request.recentActivities, activity]` 恒非空 |
| 9.7 | `src/integrations/raft/raft-channel.ts:702` | `this.#lastError ?? remote!.lastError` 的 `remote!` + `??` 防御已被外层 `||` 排除的空值 |
| 9.8 | `src/integrations/raft/raft-cli-remote.ts:540-557` | 首次 `profile show` 无论为何失败都立刻用小写变体盲目重试 |
| 9.9 | `src/integrations/weixin/weixin-adapter.ts:407` | `Number.isFinite(occurredAt.getTime())` 检查不会发生的输入，命中时静默 `return undefined` 丢消息 |

## 候选 10 - 配置缺失返回默认

`src/configuration/instance.ts` `loadInstanceConfiguration`：

```ts
} catch (error) {
  if (isMissingFile(error)) {
    return defaultConfiguration(machineTimeZone);
  }
  ...
}
```

## 值得肯定（不清理，复核依据）

- `src/configuration/model-runtime-revision.ts`：`#active`/`#status` 纯内存态，失败 degraded/blocked、重启不恢复旧快照（兑现"不持久化最后成功配置"决策）。
- `src/runtime/runtime.ts` 6 个 `#reconcile*`（:2233-2430）：崩溃后 running 状态恢复，fencing token 乐观锁。
- `src/runtime/runtime.ts:650` `advance`：busy 互斥 + lease reconcile + delivery/turn 调度。
- `src/workspace/workspace-mutation.ts`：before-image + journal manifest + fsync 目录同步。
- `src/configuration/instance.ts` `assertOnlyKeys`：fail-fast 拒绝未知字段。
- `src/host/status-socket.ts`：unavailable 处理（ECONNREFUSED/ENOENT）。
- 各 Integration 网络重试/降级、nmem stale/unavailable：边界合理处理。
