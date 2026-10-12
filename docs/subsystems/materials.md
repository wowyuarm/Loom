# 工作区材料与模型上下文

Individual 用普通文件维护身份、记忆、线索与关注。`resident-context` 创建缺失的初始文件并在模型请求组装时读取，`workspace-history` 尝试保留材料版本，`time-context` 提供当前时刻。Harness 提供这些条件，不替主体整理记忆或决定关注内容。

## 文件与读取位置

`resident-context` 配置 `workspace` 和可选的分项 `caps`。实际路径定义见[layout](<../../src/resident-context/layout.ts>)，默认字节预算见[projection](<../../src/resident-context/projection.ts>)；下面的角色和顺序是模型体验，不是文件格式 schema。

| 材料 | 在模型中的位置 | 读取语义 |
| --- | --- | --- |
| 首次唤醒文本 | 系统 section，order 90 | 文件仍在时读取；主体完成初始化后可删除 |
| orientation | 系统 section，order 100 | Harness 的机械说明，非身份 |
| identity | 系统 section，order 120 | 每次组装现读，禁用模板插值 |
| memory core / index | user-role 动态快照，order 20 / 25 | 同一记忆文件按 `## Notes` 分段 |
| threads index | user-role 动态快照，order 30 | 现读，可附派生条目年龄 |
| attention | user-role 动态快照，order 40 | 现读，靠近当前输入，可附条目年龄 |

系统 section 与动态 context 的 order 是两条独立排序轴，不能放在一张数值表里比较前后。DSH loop 负责记录并重注入改变或被压缩遮蔽的快照；读取一次不意味着每个 Step 都重复追加相同文本。精确注入行为见相应版本的 DSH system-prompt / agent-loop。

## 初始工作区与写入反馈

[scaffold](<../../src/resident-context/scaffold.ts>)只补缺失文件，不覆盖已有材料。身份为空或缺失时补首次唤醒文本；已有非空身份不重新进入初始化。技能的补种与删除语义见[技能](<skills.md>)。

记忆 notes 和技能正文不自动全量注入，主体通过索引与工具按需读取。普通文件工具负责写入；Loom 没有单独的 memory_write 工具，也不在该 Preset 加载工程 `agent-instructions`，所以放一个 AGENTS 文件不会使它自动成为 Individual 的规则。

预算限制的是注入文本，不拒绝文件保存。内容超预算时截取并加可见 marker；UTF-8 尾部被截断的多字节字符可能显示替代字符。接近预算时快照和成功 write/edit 的结果给出使用量提示，准确阈值见[预算实现](<../../src/resident-context/budget.ts>)。提示与 marker 本身仍占额外字节，不能把 cap 当作最终请求的精确硬上限。attention/threads 的 read 结果另有结构提醒，见[提醒实现](<../../src/resident-context/shape-reminders.ts>)。

## 留版与条目年龄

`workspace-history` 提供 `ctx.workspaceHistory`；成功完成 Turn 后串行尝试提交工作区变化。工作区必须已经是 Git 仓库，插件不初始化仓库；无变化不提交，Git 错误只报告不阻止主体。缺少 ignore 文件时补文本材料规则，已有 ignore 不覆盖；精确规则见[Git 实现](<../../src/workspace-history/git.ts>)。文件保存与 Git 留版是两件事，不能依赖每个失败 Turn 都有版本。

attention 与 threads 的非空、非标题行可以附最后修改至今的整天年龄。时间固定在当前 Turn 的开始，避免同一 Turn 内年龄变动导致无意义快照变化；无时钟或无 Git 信息时保留原文本，不猜年龄。[年龄实现](<../../src/resident-context/entry-ages.ts>)只改投影，不把标记写回文件。

[失败记录](<channels.md#失败可见性>)在失败 Turn 后写入 attention，但留版等下一次成功 Turn，因此 Git 的写入归属与派生年龄可能偏后。

## 时间与请求影响

`clock` 提供 Loom 自己的当前时间；DSH 内部事件时间仍由 DSH 管理。`time-context` 在主主体成功接纳的首 Step 末尾追加一条 UTC+8 快照，包含当前时刻和距前一条模型可见事件的间隔；长 Turn 才按[采样规则](<../../src/time-context/snapshot.ts>)刷新。辅助 subagent 不使用主主体的这条时钟。没有历史基线时明确显示未知，不把上一 generation 的时刻猜成当前。

材料越大，请求工作集越大；改变 identity 影响系统提示，改变动态材料触发快照更新，条目年龄只按 Turn 更新。是否复用 provider 的 KV cache 取决于 DSH 请求构造和 provider 能力，本插件不保证缓存命中率。上下文压缩与换代见[连续性](<continuity.md>)。

## 验证入口

[resident-context 测试](<../../tests/resident-context.spec.ts>)检查系统身份、user-role 快照、预算与现读；[layout 测试](<../../tests/resident-context-layout.spec.ts>)和[write-budget 测试](<../../tests/write-budget.spec.ts>)检查格式及反馈；[workspace-history 测试](<../../tests/workspace-history.spec.ts>)用真实 Git 检查留版和年龄；[time-context 测试](<../../tests/time-context.spec.ts>)用可控时间验证采样。模型可见内容改变时还要用 [boot-smoke](<../../tests/boot-smoke.spec.ts>)核对整栈请求，不只测试字符串生成函数。
