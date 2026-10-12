# Individual 的技能发现与初始技能

`loom/skills` 让主主体只发现自己工作区中的技能，而不是工程 checkout 或机器用户的技能。它包装 DSH 文件系统提供方，禁用默认 roots；发现、正文加载与 catalog 提供沿用平台机制。

## 挂载与发现范围

配置字段为 `workspace`，技能根是其下的 `skills` 目录。[Preset](<../../presets/loom.patch.yml>)用 `loom/skills` 替换 base 的 `skill-filesystem` 行，并挂载 DSH `tool-skill`。共享 `skills` 注册表仍由 Host 提供。

一个技能目录的主文件是 `SKILL.md`，front matter 的 `name` 和 `description` 供 catalog 路由；具体发现、校验和缓存行为以锁定版本的 DSH 文件系统提供方为准。Loom 不另建技能注册表，也不扫描工程 `.agents/skills` 或用户全局根。实现见[技能提供方](<../../src/skills/index.ts>)。

模型先看到技能名称与触发说明，调用 `skill` 才加载正文；它不是所有技能正文的常驻注入。增加正文会影响使用该技能时的工作集，不直接增长每轮的全部上下文。工具 schema 和 catalog 格式由 DSH 拥有。

## 初始技能如何交给主体

[工作区初始化](<../../src/resident-context/scaffold.ts>)把[种子技能](<../../src/resident-context/seeded-skills.ts>)写到工作区缺失的路径；没有只读 bundled root。已有文件不被更新覆盖，Individual 能修改自己的副本。

当前种子分别服务于技能维护、工作区整理和模型路由操作。准确名称、正文和所带 reference 以种子模块为准，文档不另复制正文。模型路由技能说明的权限风险见[模型切换](<model-switch.md>)。

删除种子后，当前运行的 catalog 不再看到该文件；但是下次 resident-context 重新挂载时，create-if-absent 会把缺失的种子重新补入。没有持久“已退役”标记，不能承诺种子删除后永不重种。升级源码中的种子也不会自动覆盖既有 Individual 的已存在副本。

## 工程与主体技能的区别

仓库文档讲怎样建设 Harness；Individual 的技能讲它自己的工作方法。不要把工程协作规则、Team ledger 或部署凭据写进主体技能。敏感文件不进入源码、测试 fixture 或工具示例；工作区是否 version 某类文件由其 Git ignore 管理，不等于权限隔离。

## 验证入口

[技能测试](<../../tests/skills.spec.ts>)验证工作区技能可见与默认 roots 隔离；[材料测试](<../../tests/resident-context.spec.ts>)覆盖初始文件；[种子检查脚本](<../../scripts/check-seeded-skills.mjs>)检查种子名称、description 与 reference 完整性。变更 catalog 或 tool 的平台行为时，检查同版本 DSH `skill`、`skill-filesystem` 与 `tool-skill`，不能只改本包装层。
