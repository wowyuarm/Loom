# 07 — 驱动循环替换（busy 消失）

**What to build:** 用扁平循环替换 Scheduler runOnce 的多处置状态机与 Process Driver 的 busy 1s 轮询：逐 lane 跑 due 工作 → sleep 到所有 lane 最早 retryAt 或 wake 事件；wake 源固定五个（Input 到达 / Turn 结束 / Delivery 完成 / Activity 落库 / Segment 关闭）。任何路径不得返回无截止时间的重试指令；SIGTERM 经 AbortSignal 收敛退出。现有多处置返回值与 deferredLane 特判整体删除。

**Blocked by:** 02, 03, 04, 05, 06

**Status:** resolved

## Result

完成于 organ-lanes 分支提交 `2f5876d`。scheduler 不再产生 busy；driver 删除 1s 轮询；所有路径带截止时间。

- [x] 循环对任意输入序列不产生秒级轮询（测试断言每次唤醒都有 deadline 或 wake 依据）
- [x] 五个 wake 源各自触发提前唤醒（行为测试）
- [x] foreground Input 优先语义保持（pending input 时 organ defer、在跑 organ abort）
- [x] SIGTERM 收敛：在跑 run 被中止后进程退出，无连锁启动
- [x] scheduler 测试由新循环测试替换；全部现有其余测试绿色
