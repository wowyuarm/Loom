# Loom 文档导航

这套文档服务于建设和维护 Loom 的工程 agents 与维护者。运行中的 Individual 通过插件的提示、工具说明和技能获得自己的工作上下文，不把仓库工程规范当作身份或记忆。

## 从任务出发

先读任务明确引用的材料，再按下表补足缺口；不必通读整个目录。当前行为以源码与测试为准，文档给出理解和验证入口。

| 你要做什么 | 先读 | 然后定位 |
| --- | --- | --- |
| 第一次参与 Loom | [开发指南](<development.md>)、[术语与边界](<../CONTEXT.md>) | [架构](<architecture.md>) |
| 改插件协作或数据所有权 | [架构](<architecture.md>) | 对应能力页与 [DSH 底座](<dsh-platform.md>) |
| 改启动、恢复或输入交付 | [运行时](<subsystems/runtime.md>) | [运行时实现](<../src/agent-runtime/index.ts>)与[测试](<../tests/agent-runtime.spec.ts>) |
| 改换代、压缩或历史访问 | [连续性](<subsystems/continuity.md>) | [连续性适配](<../src/context-continuity/host.ts>)与[组装测试](<../tests/boot-smoke.spec.ts>) |
| 改材料注入、预算或历史 | [材料与模型上下文](<subsystems/materials.md>) | [材料实现](<../src/resident-context/index.ts>)与[模型上下文测试](<../tests/resident-context.spec.ts>) |
| 改渠道、附件或交付可靠性 | [渠道](<subsystems/channels.md>) | [消费实现](<../src/channels/index.ts>)与[渠道测试](<../tests/channels.spec.ts>) |
| 改技能范围或初始技能 | [技能](<subsystems/skills.md>) | [技能提供方](<../src/skills/index.ts>)与[测试](<../tests/skills.spec.ts>) |
| 改对话后的唤醒判断 | [对话后检查](<subsystems/after-interaction.md>) | [实现](<../src/after-interaction/index.ts>)与[测试](<../tests/after-interaction.spec.ts>)；未决研究见[工作记录](<../.scratch/README.md>) |
| 改活体模型路由 | [模型切换](<subsystems/model-switch.md>) | [实现](<../src/model-switch/index.ts>)与[测试](<../tests/model-switch.spec.ts>) |
| 部署、授权或配置模型 | [部署指南](<cookbook/deployment.md>) | [组合声明](<../cordis.patch.yml>) |
| 安装或替换外部插件 | [扩展指南](<cookbook/extending.md>) | 对应插件的配置与版本声明 |
| 开发一个新能力 | [新增能力](<cookbook/adding-capability.md>) | DSH 对应子系统与已有插件 |
| 写文档、交接或收口工作记录 | [维护规则](<AGENTS.md>)、[文档与交接](<cookbook/documenting.md>) | [工作记录规则](<../.scratch/AGENTS.md>) |

## 每类事实的落点

| 落点 | 负责什么 |
| --- | --- |
| [根指令](<../AGENTS.md>) | 每次工程工作都适用的约束与阅读纪律 |
| [术语](<../CONTEXT.md>) | 稳定概念及边界定义 |
| [架构](<architecture.md>) | 当前插件协作、数据所有权与扩展位置 |
| [DSH 底座](<dsh-platform.md>) | Loom 对上游的依赖、组合方式与核对路径 |
| [开发指南](<development.md>) | 开发起点、验证选择和完成证据 |
| 能力页 | 当前配置、行为、失败、恢复与模型可见影响 |
| 操作指南 | 从一个明确起点完成一项任务的步骤与成功判据 |
| [关键决策](<adr/README.md>) | 仍有效的取舍及理由；不是实现清单 |
| [工作记录](<../.scratch/README.md>) | 已归档的设计、实验与历史证据，随版本库跟踪。注意：其中的结论可以被后来的源码推翻，不当当前行为的依据；链接由 `test:docs` 一并校验，可以正常引用。进行中的 `active/` 不进提交，完成后脱敏归档再 amend 进对应提交 |

文档结构与维护纪律由 [docs/AGENTS.md](<AGENTS.md>) 定义；同一事实不在导航、架构和能力页重复维护。
