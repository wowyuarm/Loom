# Candidate Inventory

Status: decisions recorded

| Candidate | Original purpose | Evidence of value | Cost / failure | Xi comparison | Current disposition |
| --- | --- | --- | --- | --- | --- |
| Reflection terminal-Turn coverage gate | 防止目标日证据未收束时提前反思 | Ticket 32 只要求没有 active segment / pending recording / pending thread maintenance；这些已由 maintenance-idle gate 覆盖 | 合法 silent Opportunity 永久阻塞 reflection 和 Orientation | Xi 不让 Reflector 承担 segment 完整性检查 | simplify / separate integrity diagnosis |
| Scheduler stops on maintenance `busy` | Ticket 25 用于核心 Input/Delivery/Activity 恢复链，避免越过未知外部结果或失败 | 对核心事实链有价值 | 扩展到独立 maintenance lanes 后，一个 lane 阻断后续所有 lane | Xi 的维护触发不以一个函数的 false 阻断同 tick 其余维护 | redesign lane result/ordering |
| Global maintenance-idle gate | 避免多个器官同时读写不完整的 Workspace / Activity 证据 | 实际运行中的 Workspace 写入必须互斥；目标日材料必须完整 | 8/5 的无关 Thread pending 已复现会阻断 8/4 Reflection，目标日 Reflector 根本不会被调用 | Xi 的 Reflector 不以全局 Thread pending 为前提 | scope dependencies to the material actually consumed |
| Input retries without an exit | 一次短暂执行失败不能丢失人类 Input；有 Effect/tool coverage 的 Input 又不能重放 | 无覆盖 Input 回到 pending 的恢复方向正确 | 同一失败 Input 已复现连续四次立即重领；没有 terminal blocked，Driver 只提供统一 30 秒等待 | Xi 分类失败、退避，并让普通失败五次后 blocked | simplify: explicit failure -> existing blocked; interruption/unknown -> pending |
| Cognitive Organ run blocks later human Turn | 保持单模型执行、Workspace 材料和 Runtime progression 串行一致 | 避免器官写材料时 Main Agent 同时读取半套状态 | 生产一次器官运行 13m36s 后失败，期间后续交互无法开始；Process Driver 等整个 `runOnce` | Xi 的维护并行启动，因此不挡 chat，但可并发读写 Workspace | keep one writer; abort/rollback organ for human Input; no snapshot system |
| Activity close collapses blockers to `busy` | 防止运行中事实与冻结竞争 | Ticket 25/33 的事务内 guard 有价值；生产长 segment 期间未发现可安全并发的到期维护 | maximum age 只是 eligible cutoff，外部无法知道实际 blocker、持续时间或下次检查点 | Xi 分别记录 active lock、queue、recorder 等跳过原因 | retain active-segment gate; redesign result/observability and work budgets |
| Maintainer exact `UPDATED` / `NO_CHANGE` tail | 让模型声明是否完成结构更新 | Thread/Attention/Memory 已有 durable tool mutation facts、grounding 和写后检查 | 合法写入因尾词不匹配整轮回滚并重跑；生产已发生 | Xi Thread Maintainer 返回自然总结；没有同类尾词 gate | simplify: derive outcome from durable mutations |
| Two-hour split versus final Delivery evidence | 防止活跃 Segment 无限增长，同时让 Frozen Activity 不虚构送达 | 两边都有真实消费者：上下文收束与 Life Recorder 的事实证据 | `not_sent` 退避可让 Segment 无限延长 | Xi 把失败 outbound 当作已成立事实并允许 Segment 关闭；没有自动重投 | simplify ownership: Activity records current attempt; later Delivery becomes later evidence |

后续候选必须带真实消费者和证据；只凭代码复杂或个人偏好不进入清理范围。

## Removed Or Retained

- 不新增完整历史 Segment 状态表；当前没有消费者证明这层模型必要。
- 不重建 Xi 的 backlog batch；现有 Interaction Wave 与 Raft inbox 批量准入尚未复现错误拆轮。
- 保留 SQLite Runtime Store、lease/fencing、Effect/Delivery 分离、unknown reconciliation、Activity freeze 和各维护 cursor；它们都有明确恢复风险和测试消费者。
- 只保留正在 dispatch 或结果 unknown 的 Delivery close 保护；已确认 `not_sent` 不再让 Segment 等待未来重试，晚到 Delivery 进入后续生活证据。
- Scheduler 的两阶段 maintenance 调用只有入口重复证据，尚无可观察坏结果，不进入本轮决策。
