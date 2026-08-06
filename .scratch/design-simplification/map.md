# Loom Design Simplification Review

Status: completed

## Purpose

重新审视 Loom 从 Xi 通用化过程中形成的设计。每一项都从原始目的出发，核对真实使用和故障证据，区分必要复杂度、过度防御、过度工程与职责错位。

这不是一次按代码目录找清理项的普通 review，也不以“更少代码”为目标。只有当现有设计不能证明其必要性、重复承担别处职责、制造新的阻塞或让真实使用更差时，才进入简化或重设计候选。

## Review Questions

每个候选都回答同一组问题：

1. 当初为什么设计它？原始用户问题是什么？
2. 它现在保护了什么真实风险？证据在哪里？
3. 它带来了什么成本、阻塞或新的失败面？
4. Xi 的实际做法是什么？差异来自真实需求，还是通用化时的推演？
5. Loom 的当前消费者是谁？没有消费者的能力不因“未来可能需要”而保留。
6. 最终应保留、简化、删除，还是重新设计？

## Evidence Standard

- 事实优先来自生产运行、最小复现、源码、原始 ticket 和历史决定。
- transition、日志和状态只证明它们实际记录的事实，不替代权威状态。
- 不能只因为 Xi 更简单就照搬 Xi，也不能只因为 Loom 更通用就保留复杂度。
- 真正的设计决定留到 evidence gathering 完成后，通过一次一个问题的 grilling 与禹确认。
- 未确认前不改实现。

## Workstreams

| Workstream | Owner | Status | Output |
| --- | --- | --- | --- |
| 下午已发现问题与最小复现 | Terra | collected | `research/terra-findings.md` |
| 生产阻塞、重试和无效保护证据 | Sentinel | collected | `research/sentinel-runtime-evidence.md` |
| 原始动机、源码与 Xi 对照 | Codex | collected | `research/codex-source-and-xi-review.md` |
| 候选归并与优先级 | Codex | ready | `research/candidate-inventory.md` |
| 关键设计决策 grilling | Codex + YuCreate | confirmed | `decisions.md` |
| 实现与验证 | Codex | completed | Runtime / Cognitive Organ implementation and full verification |

## Implementation Result

Implemented and verified:

- Reflection no longer requires every terminal Turn to have an Activity.
- Explicit uncovered Input failure becomes `blocked`; interrupted work and after-chat continuation remain recoverable, with explicit Runtime and `loom requeue <input-id>` operator recovery.
- Thread, Attention, and Memory outcomes come from observed mutations rather than exact final tokens.
- Confirmed `not_sent` no longer blocks Activity closure; later Delivery attempts belong to a later Activity interval.
- Reflection dependencies are scoped to its target day; a later failed Thread maintenance does not block it.
- A durably accepted human Input cancels the running cognitive organ before the Main Agent continues; agent/system interactions do not cancel it, and cancellation gets a one-second grace period before Input handling proceeds.
- Status exposes the oldest pending organ timestamp and age, plus unexplained terminal Turn/Segment integrity warnings while legal silent discard remains clean.
- A failed maintenance lane no longer prevents an independent Orientation check in the same scheduler run.
- Runtime Store schema v18 assigns every Delivery attempt to the Segment where the attempt occurred; the v17 migration refuses to continue if it cannot preserve that ownership.
- A late Delivery retry opens or joins a later Activity while retaining the original Turn reference.

Verification:

- `npm run typecheck` passed.
- `npm test` passed: 349 tests, 0 failures.
- `npm run build` passed.
- `git diff --check` passed.
- Main Agent lifecycle coverage confirms a delivery-only later Activity keeps the original Turn reference.

## Initial Candidates

- Memory Reflection 把 Turn/Segment 完整性检查混入自己的运行门槛。
- 一个 maintenance lane 的 `busy` 让后续独立 lane 永久饥饿。
- Active Segment 超过最大时长后，多个不同阻塞原因都被压成同一个 `busy`。

这些只是已知入口，不是范围上限，也不是预定结论。
