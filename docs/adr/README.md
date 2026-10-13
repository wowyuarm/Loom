# 关键决策记录

这里记录**仍有效的、跨能力的取舍**：当时做了什么决定、为什么、放弃了什么。只记真实做过的决定；实施状态在对应能力页，历史过程在[工作记录](<../../.scratch/README.md>)。

## 条目

| 记录 | 决定 | 状态 |
| --- | --- | --- |
| [0001 不建部署准备层](<0001-no-provisioning-primitive.md>) | 部署只给只读与 create-if-absent 的 primitive + 文档配方，不做向导或控制面 | 有效 |
| [0002 通过 DSH 接缝扩展](<0002-dsh-seams-over-loom-core.md>) | Loom 不建特权 core，跨插件协作走 DSH 接缝与 contracts | 有效 |
| [0003 事实平面各自单一所有者](<0003-single-owner-fact-planes.md>) | Session、Runtime state、Workspace 材料和渠道传输不互相复制为第二权威 | 有效 |
| [0004 Session 派生状态用 Projection](<0004-session-state-through-projections.md>) | 新的运行时派生状态通过 Projection 重建，不新增同步历史读取 | 有效 |
| [0005 Delivery 是外部事实](<0005-delivery-is-the-external-fact.md>) | 只有 Delivery ledger 的 delivered 能作为已向渠道投递的事实 | 有效 |
| [0006 入站采用可恢复的至少一次交付](<0006-at-least-once-inbound-acceptance.md>) | 持久接纳后的输入可恢复重投，允许重复，不引入 exactly-once 基础设施 | 有效 |

新条目按 `NNNN-<短标题>.md` 递增：

```markdown
# <决定本身的一句话>

- 日期：
- 状态：有效 / 被 <后续记录> 取代

## 背景
什么问题迫使必须取舍。

## 决定
选了什么。

## 理由与代价
为什么是它；放弃了什么；什么信号出现时应该重审。
```

规则：一页一个决定；写清反对面；被取代时改状态并互链，不删除；每次局部修改不新增记录——只记影响多个能力或长期方向的取舍。
