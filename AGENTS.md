# Repository Guidelines

## 工程目标与权威

Loom 在 DSH / Cordis 上提供长期 Individual 的存在条件：一个 Runtime Instance 承载一个主主体，不内置身份、关系或判断；everything-is-a-plugin，没有不可替换的特权 core。

先读 [docs/README.md](<docs/README.md>) 按任务路由，改跨模块行为前读[架构](<docs/architecture.md>)。不通读整个仓库；从任务明确引用的源码、测试和工作材料出发，按缺口展开。

当前行为以源码和测试为准。Maintained docs 是可核对的当前说明，已有文字也可能过期；DSH 行为须对照仓库锁定版本的契约。未实现的设计与历史留在 [.scratch](<.scratch/README.md>)，不能覆盖落地行为。

## DSH 与运行边界

设计或实现能力前，先读[DSH 底座](<docs/dsh-platform.md>)和对应上游源码、已有插件，复用它的组合、服务、事件、工具、存储和测试惯例，不自创相同机制。

运行与部署只用[仓库启动器](<bin/loom.mjs>)所指的本地 DSH 依赖，不依赖全局 dsh。版本取自[依赖声明](<package.json>)和[lockfile](<package-lock.json>)；升级是单独工作项，不能顺手漂移运行栈。

仓库是工程工作区，不是 Individual 的 Agent Workspace；个人 Instance Root、运行数据和凭据不提交。部署目录、服务管理器和账号是环境配置，不写成仓库固定事实。

## 插件组合与开发纪律

- **组合用清单。** Bundle/Profile/patch 经 DSH loader 挂载，不写统一 import 所有模块的接线函数，不自建注册表、DI 或热替换机制。
- **能力只经接缝协作。** 提供与消费 ctx service、event、tool 和 prompt；跨插件依赖只用 [contracts](<src/contracts/index.ts>) 的接口，不 import 对方实现。注册由 effect 管理并释放。
- **替换用现成接缝。** 清单替换同接口提供方；wrapper、waterfall 和 profile patch 改行为。只在独立发布有实际收益时拆包，不预建空包。
- **从端到端行为验收。** 范围、依赖或完成证据不清时指出缺口，不把猜测写成代码。不为假设的新需求加抽象、防御、兼容层或回退。
- **判别联合按 tag 分支。** `kind` / `type` 分支穷尽已声明的成员；DSH 的事件与原因 map 可合并扩展，未识别的成员走写明理由的 default，不静默当成失败或成功。
- **waterfall 监听器必须调用 `next()` 并交回其结果。** 不调用会截断链上其它监听器；顺序敏感的监听靠注册顺序排位。
- **校验只在边界。** 同进程内类型化的值信任 TypeScript，不为它加运行时校验或回退；parser、配置、模型传入的 JSON、持久文件、外部进程输出才校验（见 `parseSwitchFile`、runtime-state 的 zod schema）。`src` 不新增 `as unknown`，现有几处只出现在测试桩里。
- **空 `catch` 写明吸收了什么。** 注释说明吞掉的是哪种失败、为什么不影响结果，`try` 只包一个语句。
- **部署会变的是 Config 字段，固定量写明为什么固定。** 阈值、路径、区间走插件 Config（如 `ResidentContextConfig.caps`）；协议常量与外部规格保持固定并注明理由，不用 `DEFAULT_*` 或测试钩子冒充可配置。
- **文档随行为落地。** 改公开行为、模型上下文、恢复或工作流时同步更新其维护落点，执行受影响检查，报告实际证据和未验证部分；选择见[开发指南](<docs/development.md>)。

## 写作与提交

术语见 [CONTEXT](<CONTEXT.md>)；文档纪律见 [docs/AGENTS](<docs/AGENTS.md>)，研究纪律见 [.scratch/AGENTS](<.scratch/AGENTS.md>)。注释写不明显的约束、原因和安全条件，不复述实现过程。

命名贴合实际职责，沿用 DSH 惯例。一个提交对应一个闭合工作单元，不夹带他人的未提交工作。

**commit message 只有一行。** 格式为 `type(scope): description`，subject 行之外不写正文；说不清的必要背景放进文档或提交所改的文件，不堆在 message 里。已有提交要补内容用 `git commit --amend` 改同一个提交，不新增一条"修正说明"提交。
