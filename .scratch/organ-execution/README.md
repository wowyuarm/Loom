# Organ Execution Model

本主题审查 Cognitive Organ 的执行模型：持久化执行状态机（`cognitive_work` / `cognitive_attempts`、intervention_required、requeue 语义、scheduler 的 busy 兜底）是否应该以当前形态存在，以及"有界自治"合同的正确实现层级。

## 为什么开这个题

2026-08-21/22 生产事故链（busy 空转约 10 小时、429 被错误分类、provider stream 失败烧掉 attempt 预算、graceful stop 连锁启动后台任务）显示：事故反复发生在同一层——organ 执行状态机——而域层 durable queue（activities / deliveries / raft ingress）一直正常。

对照旧 Xi（无持久执行状态，fire-and-forget 维护任务）与仓库内健康先例（nmem episodes 重试、raft-channel ingress），初步怀疑是**执行状态被错误地持久化**，导致崩溃窗口对账、假 running、预算误耗等一系列补丁需求。

## 当前状态

- Status: 已形成决策。2026-08-29 评审确认"域行预算 + lane 循环"重构方向，8 项语义决策由 YuCreate 拍板；实施合同见 `spec.md`（ready-for-agent）。
- 立意层证据与初步论点见 `rounds/2026-08-22-initial/`；已落地的四个小修与本主题方向一致但不构成结论，见该轮 `summary.md`。
- 下一步：按 `spec.md` 拆实施票（to-tickets），按 organ 分批落地；实现、合并、部署分开授权。

## Rounds

- `2026-08-22-initial`：证据采集（生产 journal、代码审计、Xi 对照、pi 能力调研）与初步论点。
