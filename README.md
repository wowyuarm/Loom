# Loom

Loom 是面向长期关系主体的 Agent Harness，在 DeepSeek Harness（DSH / Cordis）的插件体系上提供持续存在的条件。一个 Runtime Instance 承载一个 Individual；身份、关系和判断由主体自己形成，不由 Harness 内置。

Loom 是一个可叠加、可替换的 DSH Bundle，不另建特权 core。仓库已包含单主体启动与恢复、会话连续性、工作区材料、技能、渠道收发、对话后检查、失败可见性和模型热切换。当前行为和限制见[架构](<docs/architecture.md>)及其能力参考；未决研究见[工作索引](<.scratch/README.md>)。

## 参与建设

工程 agents 先读[仓库指令](<AGENTS.md>)，再从[文档导航](<docs/README.md>)按任务选读。新接手者从[开发指南](<docs/development.md>)开始；插件协作与数据归属见[架构](<docs/architecture.md>)。

```sh
npm ci
npm run typecheck
npm run test:docs
```

仓库由[依赖声明](<package.json>)与[npm lockfile](<package-lock.json>)携带运行时；命令的验证范围见[开发指南](<docs/development.md>)，不要用全局 dsh 代替本仓库运行时。

## 配置一个部署

[部署指南](<docs/cookbook/deployment.md>)说明 Bundle/Profile、授权与模型配置；[扩展指南](<docs/cookbook/extending.md>)说明安装或替换插件。个人数据、部署路径和凭据不进入仓库。

上游：[DSH 文档](<https://deepseek-harness.github.io/deepseek-harness/>)。核对其与 Loom 的版本关系时，先看[DSH 底座说明](<docs/dsh-platform.md>)，不能把上游最新能力当作本部署已实现的行为。
