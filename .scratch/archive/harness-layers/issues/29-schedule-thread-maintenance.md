# 29 - Schedule Thread Maintenance from Frozen Activity

Status: resolved
Type: implementation

## Problem

Loom 已有完整的 Thread Maintainer，但它仍只能由调用方手工提供 observations 并运行。已关闭的 Frozen Activity 已经保存 Main Agent 的结构化工具证据，因此 Runtime 可以从真实的 Thread 文件变化形成一次持久待办，而不依赖文件时间、进程内 watcher 或固定 cadence。

本票只闭合 Frozen Activity -> pending maintenance -> Thread Maintainer -> durable completion。它不建立通用 Cognitive Organ job runner，也不改变 Thread Maintainer 的 prompt、tool description 或首轮 Context。

## Confirmed Interface

- 一份 Frozen Activity 最多形成一次 Thread maintenance；完成后不重复运行。
- 只有成功的结构化 `write` / `edit` 工具证据指向某条 `threads/` 私人工作线时才触发。`read` / `grep` / `find` / `ls` 可以为同一次维护补充 `observed` reference，但单纯查看不触发维护。
- 不解析 `bash` 命令文本，也不使用 `mtime` 猜测变化。纯 `bash` 或只改全局 `threads/index.md` 暂不形成触发，等未来有可靠的 Workspace change evidence 再扩展。
- Activity 先冻结并完成 Life Recorder，再异步维护 Thread；Main Agent Turn 不等待器官运行。
- Maintainer 的 `UPDATED` 与 `NO_CHANGE` 都完成该 Activity 的 maintenance。
- 失败保留 pending、错误与次数；后续 `runOnce` 或 restart 重试。同一 Activity 按 FIFO 处理。
- Model Runtime blocked 时不 claim maintenance，也不消费 pending work。
- Runtime Store 保存待办、尝试和完成事实；Thread Maintainer 继续只负责一次基于 Frozen Activity 的结构维护。

## Test Seam

测试只穿过 Runtime / Scheduler 与 `LoomInstance.runOnce/status`：

- 无 Thread 变化时不请求 Maintainer。
- Thread 文件变化在 Activity 关闭并记录后触发一次维护，`NO_CHANGE` 也完成。
- 失败后保持 pending，restart 后重试且不重复已完成 Activity。
- Model Runtime blocked 时保持 pending，恢复后继续。

测试验证触发、顺序、持久状态和 provider 调用，不断言 prompt 文案或模型判断质量。

## Out of Scope

- Thread Maintainer prompt、工具面和 Context 语义调整。
- Attention / Memory maintenance cadence。
- nmem projection 或 reconcile。
- 通用 job/workflow engine、daemon 或 process driver。
- 从任意 shell 命令推断文件副作用。

## Source References

- Loom Ticket 18 and Ticket 25
- Xi `src/runtime/cognitive-maintenance.ts`
- Xi `docs/daemon-scheduling.md`

## Result

- Frozen Activity 关闭时会从成功的结构化 Main Agent 工具证据提取 Thread observations。`write` / `edit` 形成 changed，相关 `read` / `grep` / `find` / `ls` 可补充 observed；完全没有 changed 时不建立待办。
- Thread maintenance 在 Runtime Store 中具有独立的 pending / running / completed 状态、尝试次数、lease、错误和结果。它只在对应 Activity 已完成 Life Recorder 后按 FIFO claim，`UPDATED` 与 `NO_CHANGE` 都完成一次消费。
- Scheduler 继续只通过 `Runtime.advance()` 推进；失败明确 deferred，restart 后从 pending 重试。Model Runtime blocked 时不 claim，也不增加尝试次数。
- Instance Assembly 已按当前 Model Runtime Revision 创建 Thread Maintainer，并让它通过 Runtime 的只读 `frozenActivity()` Interface 按引用展开旧 Turn；器官 transcript 与 evidence index 均位于 Instance Root 的 Harness-owned 区域。
- 真实 Instance 纵切已验证 Main Agent 写 Thread、Activity closure、Life Recorder、Thread Maintainer 完整读取和一次性完成。未修改任何 prompt、tool description 或首轮 Context 文案。
- `bash` 命令文本、文件 `mtime` 和只改全局 `threads/index.md` 均不被猜测为某条 Thread 的真实变化；未来若增加可靠 Workspace change evidence，再扩展这一输入。

## Verification

- `npm run typecheck`
- `npm test` - 175 tests passed
- `git diff --check`
