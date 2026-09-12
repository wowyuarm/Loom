# Xi 对照与仓库内先例

## 旧 Xi 的执行模型（~/projects/Xi @ 70e1595）

核心是 daemon tick 循环（`src/runtime/daemon.ts`）：

```typescript
while (running) {
  await tick();                    // reconcile + segment close + 队列消息 + after-chat + 各 maintainer
  await sleep(SCHEDULER_TICK_MS);
}
```

每个维护任务（`src/runtime/cognitive-maintenance.ts`，共 281 行）形态一致：

```typescript
let lastRun = 0;
export async function maybeRunThreadMaintainer() {
  if (now - lastRun < 30_000) return;      // 内存去抖
  const changes = detectThreadChanges();    // mtime 扫描，无持久 claim
  if (!changes) return;
  try { await maintainThreads(changes); }
  catch (err) { await logEvent("thread_maintainer.error", ...); } // 失败只记日志
}
```

关键性质：

- **执行状态不持久化**：没有 work/attempt/budget/backoff 表；崩溃或重启后没有任何"正在跑"的记录需要清偿。
- **并发保护 = 进程内布尔量**（如 `nowMaintainerRunning`），生命周期与进程相同。
- **失败 = 日志 + 下个 tick 条件重估**。没有 requeue、没有 intervention_required、没有人工仲裁状态。
- foreground 消息处理（weixin `onInbound: chat`）与 tick 循环相互独立，维护任务不阻塞回复路径。

### Xi 的失败模式

- 优点：失败只表现为"这次没跑成"，可见、无害、自限。
- 代价 1：**饥饿**——tick 内一个 await 卡住会拖住整轮 tick。真实事故：blocked queue item 卡住 segment close，orientation 停约 20 小时（nmem 有记录）。
- 代价 2：**无界重试**——每 tick 重试在配额耗尽场景持续烧钱。
- 代价 3：mtime 扫描 / 时间槽等启发式比 durable queue 脆弱。

## Loom 仓库内的健康先例

### nmem episodes / threads 集成（src/integrations/nmem/episodes.ts, threads.ts)

```typescript
nextEligibleAt = now + (kind === "temporary" ? retryDelayMs(attempts + 1) : 6 * 60 * 60_000)
```

预算与退避挂在**域行**上（episodes/threads 的同步状态），执行进程内短暂。生产零同类事故。

### raft-channel ingress（src/channels/raft/raft-channel.ts）

`pending / retry_wait / failed` 状态机 + next_retry_at + 毒消息隔离（retryable 判定决定进 retry_wait 还是 failed）。生产运行正常：本轮观测 ingress pending/retrying/failed/spooled 全程为 0。

## 对照结论

1. **需要跨重启存活的只有域事实**："这条 activity 未记录""这条消息未投递""这个 day 未反思"。Loom 域层已正确持久化这些，且质量高于 Xi。
2. **不需要跨重启存活的是执行意图**："第 N 次尝试正在进行"。它被 Loom 持久化后，崩溃窗口、假 running、预算误耗、对账逻辑全部成为必然而非偶然。
3. Xi 与 nmem/raft 先例共同指向同一形态：**域行挂 `{attempts, eligible_at, last_error}`，执行短暂化**。这不是新发明，是把 organ 层降到仓库内已被验证的模式。
4. 不能照抄 Xi 的部分：域层 FIFO/依赖（recording → reflection）、投递防重、ingress 隔离必须保留 durable queue——Xi 恰恰在这些地方弱（20h 饥饿事故）。
