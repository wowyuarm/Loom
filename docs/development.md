# 开发指南

第一次参与 Loom 从这里开始：环境、验证入口、完成证据的选择。纪律见[根指令](<../AGENTS.md>)，文档分工见[导航](<README.md>)，操作类任务见 [cookbook](<cookbook/deployment.md>)。

## 环境

仓库自带运行时：[package.json](<../package.json>) 与 [package-lock.json](<../package-lock.json>) 确定依赖，[bin/loom.mjs](<../bin/loom.mjs>) 从 `node_modules` 启动本地 DSH，不依赖全局安装。Node 版本要求见各依赖的 `engines`（当前栈要求 ≥22，开发使用 Node 24 验证过）。

```sh
npm ci                 # 按 lockfile 安装
npm run typecheck      # tsc，严格模式，覆盖 src 与 tests
npm test               # 种子技能检查 + 文档检查 + vitest 离线套件
npm run test:docs      # 只跑文档门（链接/锚点/行尾 + 其契约测试）
npm run build          # 清理 lib/ 后按 tsconfig.build 产出发布物
```

用 npm，不用 pnpm——lockfile 是 `package-lock.json`，pnpm 会把 npm 装的包挪进 `.ignored` 并改写布局。需要真实模型的 [boot-live](<../tests/boot-live.spec.ts>) 在有 `DEEPSEEK_API_KEY` 时才运行；默认套件完全离线确定，不要为了“测全”把 key 挂进日常环境。

## 验证选择

按改动面选证据，不是每次都全跑：

| 改动 | 至少 | 追加 |
| --- | --- | --- |
| 插件行为（src/） | `npm run typecheck` + 对应能力测试 | 跨插件协作 → `npm test`（含 [boot-smoke](<../tests/boot-smoke.spec.ts>) 组装验证） |
| 组合清单（cordis.patch.yml / presets/） | [bundle-manifest 测试](<../tests/bundle-manifest.spec.ts>) | 真 Profile 组合 → `DSH_HOME=<隔离 home> node bin/loom.mjs --profile <名> --dump-config`，见[部署指南](<cookbook/deployment.md>) |
| 文档（docs/、README、AGENTS、CONTEXT） | `npm run test:docs` | 其中引用的命令逐个实际执行过 |
| 发布物（exports/files/bin） | `npm run build` | 在隔离 home 以产物挂载验证 |

**证据写进报告时只说做过的。** 单元测试证明编排逻辑，组装冒烟证明插件接得上，dump-config 只证明清单组合，真实渠道/provider/部署操作各是独立的验证，不能互相冒充。

## 完成一项工作

1. 行为改动随带对应文档更新（落点见[维护规则](<AGENTS.md>)）与受影响检查。
2. 报告写：改了什么、跑了哪些验证、各自的结论与边界。没验证的明确说，并指出谁能补。
3. 提交一个闭合工作单元，message 为简短英语 `type(scope): description`；不夹带他人未提交的工作。`.scratch/` 下的研究记录遵循[其自身规则](<../.scratch/AGENTS.md>)，默认不进工程提交。

## 常见陷阱

- **不要用全局 dsh 验证本仓库。** 版本独立漂移，验证的是另一套栈。
- **`config` 是整份替换。** patch 一行时先 dump 出该行的完整配置再改。
- **隔离 home 做实验。** `DSH_HOME=<临时目录>` 让组合、session、凭据都落在临时处；永远不对真实部署做文档验证。
- **不承诺源码没有的行为。** 尤其是并发、崩溃恢复、权限隔离——验证过的写验证过的，没验证的写“未验证”。
