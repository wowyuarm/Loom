# 05 — 读时结构提醒：attention 每条带三样、threads 只留活线

**What to build:** 主体每次用 `read` 工具打开自己的 attention（或 threads 下任何文件），读取结果后面多跟一句结构建议——attention 是"每条三样：带多久、现在什么样、连着哪条线（可选），带多久到期就放下、重要的开成线"，并带一个一行例子；threads 是"索引只留还开着的线、每条一句话；线内文件写当前全貌、不记流水账"。其余文件一个字不加。**不拦、不查格式、不挡错误结果**——写错了也不拒绝，只是每次打开时看得见这句话。

**What this answers:** 票 04 给了它"每条放了多久"这个机械维度，但**它自己从没写过"打算带多久"**——scaffold 与 AGENTS.md 里的 horizon 要求在 17 次改写中 0 次被照做（2026-10-09 会话记录全量核过）。常驻说明催不动，因为写的那一刻它手边没有这句话；把同一句话挪到"读它要写的那个文件"的结果里，正好落在动笔前（实测：几乎每次改写前都有同分钟的 read）。这一片回答：**提醒出现在该出现的位置之后，horizon 会不会开始出现**。

**Blocked by:** None — can start immediately（但观察期依赖 03+04+本票一起重启生效）

**Status:** complete — 收敛侧 亲自实现（Human 指定不派发），`main` `b545b54`，typecheck 0 错、全量 124/1、lib 已建。落点 `src/resident-context/shape-reminders.ts`，挂 `tools/post-execute`（与 write-budget 同口、同"feedback over rejection"原则），`resident-context` 插件内，无新工具、无装配变更。

## 为什么是这个形状

- **为什么挂读不挂写**：Human 定的——"写之前必须要读"。实测成立：17 次写几乎都有紧邻的 read；edit/write 的 fs 观察策略也要求先读。挂读一处即覆盖写前时刻，且不必碰写路径。
- **为什么在 resident-context 里**：布局常量（`residentFiles`）、材料语义、write-budget 反馈面都已在其中，不加新插件、不改 `cordis.patch.yml`；这正是"resident 材料的养护反馈"能力的第三张脸（投影截断、写入预算、读取提醒）。
- **为什么 attention 给例子、threads 不给模板**（continuity-and-memory DESIGN §3.2/§3.5 的原取舍，该件已归档至 .scratch/archive/2026-10/）：attention 的三样本来就定过形，0/17 说明只有名字没有样子等于空话；threads 明确"给布局不给内容形状"——一条关系、一项研究、一件创作该长得不一样，给模板就把活的东西压死了。
- **threads 全目录命中**（不只 index.md）：读线内文件的时刻同样适用"当前全貌、不流水账"那半句。
- **计数不计成本**：一次读多约两行文本；attention 日均读四五次，threads 几天一次。工具结果有既有 8 KiB 剪枝管线兜着。

## 观测方式（真正的交付物）

重启生效后看一两周的真实记录里 attention 条目的"带多久"出现率（基线 0/17）。三种结果都有效：

- **开始出现并配合年龄标记使用**（到期放下/降级/转线）→ 结构闭环成立，观测继续。
- **提醒看得见但 horizon 仍 0** → 轻提醒不够，再议是否升级为硬约束（写错拦下）——那是独立决策，本票不含。
- **threads 索引依旧荒** → 归票 04 的年龄标记治（索引 10-01 未动，重启后每条线会一直显示"八天未动"），不归本票。

结论写回 `../README.md` 前沿。

## Acceptance criteria

- [x] 读 attention/attention.md 成功返回时，结果末尾跟 attention 结构提醒（三样 + 例子 + 到期处置）。
- [x] 读 threads/ 下任何文件跟 threads 提醒（索引只留活线 + 当前全貌）；读 memory、library 等其他文件不加任何字。
- [x] `write`/`edit` 调用不触发；上游已拦截（block）的结果不追加；错误结果不追加。
- [x] 不拦截、不校验格式：任何主体写法都能正常落盘，提醒只是可见建议。
- [x] 无新工具、无装配清单变更、无新配置项；lib 构建通过。
- [x] 本票**不包含**任何唤醒、任何 jev 调用、任何行为变更——负例检查：不新增触发源、不改 `deliver`。
