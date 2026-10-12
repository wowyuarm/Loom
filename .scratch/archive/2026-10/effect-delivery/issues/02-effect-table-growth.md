# 02 — effect 表增长与每-turn 全表扫

**What to build:** 让"未确认投递"提示在长期运行下不退化：effect 表不再无上限堆积 delivered 记录，
且组装每个 turn 的 prompt 时不再全表扫描整张 effect 表。对模型可见行为不变——未确认投递照常被点名、
delivered 照常清除，只是底层不再随部署寿命线性变慢。

**Blocked by:** None（01 已落地；此为其性能/存储后续，非阻塞）

**Status:** ready

- [ ] `uncertainDeliveries()` 不再每次全表扫：要么只查未 delivered 的行（按状态建索引/分表），要么
      维护一份"当前未确认"小集合。
- [ ] delivered 且已被后续同 route 投递覆盖的 effect 可归档/清理，effect 表不随部署寿命线性增长。
- [ ] 保持现有语义：未确认（pending/unknown 且未被同 route 更晚 delivered 覆盖）仍被点名；跨重启仍恢复。

## 背景

01 的 `uncertainDeliveries()` 通过 `systemPrompt.context()` 在每个 turn 组装时调用，实现是把整张
effect 表读出来算一遍未确认集合。v1 一次回复一条、量小，短期没问题；但这是**无上限增长（delivered
永不删）+ 每-turn 全表扫**，长期运行的 agent 迟早变慢。何时做取决于实际消息量，不预先优化。
