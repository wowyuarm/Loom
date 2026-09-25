# 为 Loom 部署加 plugin

给一个已部署的 Loom 装 plugin 的两种方式。plugin 装在部署的 profile 层，不改 loom 包本身。patch 条目语义见 [`dsh-platform.md`](dsh-platform.md)；部署的整体管理（换模型、授权、cordis.patch.yml 的角色）见 [`deployment.md`](deployment.md)。

## 两种形态

### 本地文件

写一个 `.mjs` 放进 profile 目录，在 profile 的 `cordis.patch.yml` 里 `insert`：

```yaml
- insert:
    - id: my-plugin
      name: './my-plugin.mjs'
```

相对路径的基准是**声明它的那个 patch 文件所在目录**：profile 自己的 `cordis.patch.yml` 里 `./` 就是 profile 目录；`--patch` overlay 里要用绝对路径或 `file://`，否则按 overlay 目录找。

### npm 包

```sh
DSH_HOME=<部署根> dsh plugin --profile <名字> add <包名>
```

用 pnpm 装进该 profile 的 `node_modules`，包自带的 `cordis.patch.yml` 会被带进来。两个坑：

- pnpm 11 默认 `minimumReleaseAge=1440` 分钟，24 小时内发布的版本会被**静默**跳过、`@latest` 解析到上一版。要新版就写死版本号。
- 不带 `DSH_HOME` 时 `dsh plugin` 按默认 `~/.dsh` 找 profile，找不到你的部署。

## plugin 最小形状

```js
export const name = 'my-plugin'   // 报错/日志里的名字
export const inject = ['tools']   // 需要的服务，不齐就不加载（最常见的"没反应"）
export function apply(ctx, config) { /* 用 ctx 注册能力 */ }
```

要接配置就导出 Schemastery schema（不能是普通对象）：`export const Config = Schema.object({...})`。

## 加之前核对

- **版本线**：包的 `peerDependencies` 要对上部署的 dsh 版本。小版本升级常改包名。
- **平台**：声明 `dsh.client.platform: web` 的插件，界面部分在无界面部署里不挂，核心仍可用。
- **服务**：`inject` 列的服务在你的组合里得有。

改完 `dsh --profile <名字> --dump-config | grep <包名>` 确认进了组合树，再重启部署。

## 排错

| 现象 | 先查 |
| --- | --- |
| plugin 没反应 | `--dump-config` 里在不在。在 → `inject` 的服务齐不齐（不齐会静默不加载） |
| `X did not activate` | 那条 patch 没挂上：不存在的行 id，或 `!!js` 求值失败 |
| `failed to import <路径>` | 路径解析错，overlay 里改用绝对路径 |
| 装了但 `cannot find package` | 装到别的 node_modules 了，要在这个 profile 的 node_modules 里 |
