# 部署一个 Loom 实例

从零跑起一个 Loom 部署：Profile、授权、模型、渠道。组合机制见[DSH 底座](<../dsh-platform.md>)，加插件见[扩展指南](<extending.md>)，渠道行为与限制见[渠道参考](<../subsystems/channels.md>)。

## 落点

一个部署 = 一个 DSH home。Session、存储、凭据、主体的工作区都在 `$DSH_HOME` 下，由 Loom 的 [Bundle 清单](<../../cordis.patch.yml>)落在 `loom/` 子目录。命令一律用仓库启动器 `node bin/loom.mjs`（使用本仓库锁定的运行时），不用全局 `dsh`。

Profile 目录（`$DSH_HOME/profiles/<名>/`）= `package.json`（声明有序 Bundle 列表）+ 可选 `cordis.patch.yml`（部署自己的覆盖层）。Profile 的 package.json 写非空 `name` 和 `version`：stock DSH 的 `plugin-package-inventory` 请求扩展在**同时满足两个条件**时会拒绝缺 version 的 Profile——该行启用，且清单里有模块指向该 Profile 目录内（相对或绝对路径；向上找到的最近 manifest 就是 Profile 的 package.json）；Loom 的 Bundle 已禁用该行且清单无此类模块，两个条件都不满足，所以在 Loom 部署里 name+version 是与 stock 行为一致的好习惯而非硬性要求。裸 npm 包行与指向别处有 version 的包的绝对路径不受影响。

覆盖顺序：Bundle 列表 → Profile patch → home patch（`$DSH_HOME/cordis.patch.yml`，整机所有 Profile 共享）→ `--patch` overlay。同 id 后写的赢；`config` 整份替换。改清单对**新进程**生效；对已在运行的部署要重启。

## 最小 Profile

在隔离的 home 里（实验永远用隔离 home）：

```sh
export DSH_HOME=/tmp/loom-try        # 示例；真实部署选自己的持久路径
mkdir -p "$DSH_HOME/profiles/loom/node_modules"
cat > "$DSH_HOME/profiles/loom/package.json" <<'JSON'
{
  "name": "loom-deployment",
  "version": "0.1.0",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "loom"] } }
}
JSON
ln -s /path/to/Loom "$DSH_HOME/profiles/loom/node_modules/loom"
```

`@deepseek-ai/dsh-base` 从启动器的安装解析，`loom` 从 Profile 的 node_modules 解析（开发中用软链指向源码 checkout；发布时正常安装包）。Bundle 列表不需要 headless 等 app Bundle——Loom 的常驻入口是渠道，`agent-runtime` 自己启动主主体。

验证组合（离线，不挂载插件、不发请求）：

```sh
node bin/loom.mjs --profile loom --dump-config
```

输出带来源标注；确认 Loom 的行都在、`skippedBundles` 没有静默吞掉什么。这只证明清单组合，不证明能跑。

## 授权渠道

Loom 默认 `allow: []`，谁都不能说话。把允许的人写进 Profile 的 `cordis.patch.yml`：

```yaml
- id: channel-gateway
  config:
    allow:
      - telegram:<user-id>     # channel:actorId；channel:* 整渠道；* 所有人
```

`config` 整份替换，授权名单要一次写全。Telegram bot token 由环境变量 `DSH_TELEGRAM_TOKEN` 提供（或该适配器行自己的 `config.token`）；token 不进仓库、不进 patch 文件，用部署的 env 管理（权限 600）。没有 token 时适配器不注册渠道，其余照常。

收到的附件落在工作区 `media/<channel>/`，是普通工作区文件，主体自己整理；发送路径限制与投递语义见[渠道参考](<../subsystems/channels.md>)。

## 模型

两层：**路由可用**（provider 插件已挂载、凭据可用）与**实际选择**（默认模型或热切换文件）。

- 默认路由来自 base 的 `agent-default-model` 行（当前官方 DeepSeek 路由，`DEEPSEEK_API_KEY` 提供凭据）。要换默认，在 Profile patch 整行重写 `provider` + `model`（`config` 整份替换），模型 id 用 provider 真正认的形式。
- 不重启换路由：写 `$DSH_HOME/loom/model-switch.json`。格式、生效时机、拒绝与恢复行为见[模型切换](<../subsystems/model-switch.md>)。删除控制文件**不是**撤销——运行中的路由保持到重启。
- 换路由失败（provider 不可达、模型 id 不存在）没有自动回退；操作前留好恢复手段，验证看 `turn/end` 的 `reason` 是不是 `completed`，不能只看“回合结束了”。

## 启动与验证

1. `--dump-config` 组合无误。
2. 环境变量齐（`DEEPSEEK_API_KEY`，用渠道再加 `DSH_TELEGRAM_TOKEN`）。
3. 启动：`node bin/loom.mjs --profile loom`（作为服务主进程安全，信号会转发）。首次启动创建工作区初始材料（见[材料参考](<../subsystems/materials.md>)）。
4. 发一条已授权消息，确认：主体回答、`turn/end` 为 `completed`、投递记录为 `delivered`。失败先看 stderr 日志与[失败可见性](<../subsystems/channels.md#失败可见性>)。

真实部署的重启、服务管理器与账号凭据属于运维操作，本文不替具体环境写死；不要把某台机器的服务名、路径、账号写进仓库。
