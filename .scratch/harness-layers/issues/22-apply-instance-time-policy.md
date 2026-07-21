# 22 - Apply Instance Time Policy to Runtime

Status: completed
Type: implementation

## Problem

Runtime 当前直接使用宿主进程的本地日期和午夜边界来生成 `recordingDay` 与 Orientation 的 `localTime`。这与已经确认的 Instance Configuration 边界不一致，也会在显式时区、03:00 一类 logical-day boundary 和 DST 切换日产生错误归属。

完整 Model Runtime Revision、scheduler 和 assembly 尚无真实消费者闭环。本票不提前实现它们，只让首个必要的 Instance Configuration 分支真正控制已有 Runtime 行为。

## Decisions

- Instance Configuration 使用人类可编辑的 YAML；缺少文件时使用 Harness defaults，不自动创建文件。
- 本票只接受 `version: 1` 与 `time` 分支。有效时区默认取宿主机器的 IANA time zone，显式 `timeZone` 可以覆盖。
- logical day 是 Harness 内置政策，默认从当地时间 `03:00` 开始；`logicalDayStart` 可配置为 `HH:MM`。
- Runtime Store 继续只保存 UTC instant 与已经计算出的 `recordingDay`。时区和日历计算不进入 SQLite schema。
- Time Policy 负责把一个 UTC instant 映射为当地时间标签与 logical recording day。Runtime 不再自己调用 `Date#getHours` 或用固定 24 小时倒推日期。
- 使用 `@js-temporal/polyfill` 处理 IANA time zone、DST 和当地日期；不引入 cron、workflow engine 或通用 date provider。
- quiet hours、pulse cadence、maintenance slots、Model Runtime Revision、route 与热加载属于后续真实消费者，不进入本票配置 schema。

## Interface And Test Seam

- Configuration Interface：给定可选 `instance.yaml` 与宿主时区，返回经过验证、可直接使用的 Time Policy；调用方不接触 YAML 结构或 Temporal。
- Runtime Interface：传入 Time Policy 后，Orientation 看到正确当地时间，Frozen Activity 获得正确 logical `recordingDay`。

测试穿过以上两个公开 Interface；不测试 YAML parser、Temporal 内部对象或 Runtime SQLite 行。

## Acceptance

- 缺少配置文件时使用宿主时区与 03:00 默认边界。
- 显式时区与 logical-day boundary 在 DST 切换日仍得到正确当地时间和 recording day。
- 无效 YAML、未知字段、无效 IANA time zone 或无效 `HH:MM` 在 Runtime 启动前明确失败。
- Runtime 的 Opportunity snapshot 与 Activity closure 使用同一 Time Policy。
- 全量 typecheck、build、tests 与 `git diff --check` 通过。

## Out Of Scope

- Model / provider / thinking policy、candidate fallback 与 Model Runtime Revision。
- config watcher、热加载、degraded / blocked revision 状态。
- scheduler、quiet hours、pulse、maintenance slots、logical-day close job。
- Daily Context、每日 `agent.jsonl` 轮换、Instance Root assembly、workspace init 或迁移。

## Source References

- Xi source ticket 06: Instance Configuration Boundary
- Xi dependency research 06: time, timezone and calendar
- Loom tickets 01, 03, 11 and 14

## Implementation

- `src/configuration/instance.ts` reads the optional YAML file, rejects unknown or invalid time configuration, and applies host defaults without creating a file.
- `src/configuration/time-policy.ts` owns IANA time-zone, DST-safe local labels and logical recording-day calculation through `@js-temporal/polyfill`.
- Runtime accepts one Time Policy and uses it for both Orientation snapshots and Activity closure; its previous direct local-date helpers were removed.
- No prompt, tool description or model-visible Context changed.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` (124 tests passed)
- `git diff --check`
