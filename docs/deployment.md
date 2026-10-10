# 管理一个 Loom 部署

`cordis.patch.yml` 的角色，和运维一个已部署 Loom 的常见操作：授权、换模型/provider。加 plugin 的具体做法见 [`extending.md`](extending.md)；组合机制见 [`dsh-platform.md`](dsh-platform.md)。

## cordis.patch.yml 是什么

这个部署的组合清单——决定这台机器上的 Loom 由哪些插件、按什么配置拼起来。一个部署 = base 底座 + loom 包 + 这份 patch，启动时按层叠加。它管三类事：装什么插件（挂/禁）、每个插件的 config、谁替换谁（后面的层盖前面的同名行）。

它不管 agent 的身份和记忆。那些是 agent 在 `workspace/` 里自己写的材料，agent 的文件工具锁在 `workspace/`、够不到 `cordis.patch.yml`：

```
  cordis.patch.yml + loom.env   部署组合与密钥，改完重启生效
  workspace/ 里的 identity/memory   agent 自己维护
```

## 三层落点

后面的层盖前面的，一个部署自己的东西放 **profile 层**：

```
  bundle 层   package.json 的 dsh.profile.bundles（改这层 = 改 loom 包）
  profile 层  $DSH_HOME/profiles/<名字>/cordis.patch.yml   ← 放这
  home 层     $DSH_HOME/cordis.patch.yml（整机所有 profile 通用）
  --patch     启动时临时叠加（试验用）
```

改完都要**重启部署**才生效——patch 只在启动时组合一次。

## 加授权

Loom 默认 `allow: []`（谁都不能说话）。把授权写进 `channel-gateway`：

```yaml
- id: channel-gateway
  config:
    allow:
      - telegram:<user-id>
```

## 渠道文件

收到的附件落在 agent 工作区的 `media/<channel>/` 下（如 `workspace/media/telegram/`），消息里以 `[image: media/telegram/…]` 这样的标记告诉 agent，agent 用自己的读文件工具打开、整理或删除。发文件时 agent 把 workspace 里的路径交给 `message` 工具；路径不能越出 workspace。没有自动清理，附件就是普通工作区文件，由 agent 自己管。

## 换模型 / provider

分两步，因为“有哪些模型可选”和“实际用哪个”是两层。

第一步，装一个 provider 插件并注册路由（装法见 [`extending.md`](extending.md)）：

```yaml
- insert:
    - id: llm-provider
      name: "dsh-...-provider"   # 完整包名要加引号（@ 开头的 YAML 标量会被当指令）
      config:
        apiKeyEnv: API_KEY               # 从哪个环境变量读密钥
```

密钥写进部署的 env 文件（跟 `DEEPSEEK_API_KEY` 一起，权限 600）。加这行只让路由可用，不改 agent 用哪个模型。

第二步，把默认模型指过去：

```yaml
- id: agent-default-model
  config:
    provider: provider
    model: deepseek/deepseek-v4.1-flash
```

- `config` 是整行替换不是合并，`provider`+`model` 一起写全。
- 模型 id 用接口真正认的形式：显示名 `deepseek-v4.1-flash`，但端点只认带前缀的 `deepseek/deepseek-v4.1-flash`，填错回合里报 `400 unsupported_model`。
- 验证看 `turn/end` 的 `reason` 是不是 `completed`，不能只看“回合结束了”。切回原模型只改这一行，provider 留着不影响。

**不重启换模型。** 上面这条改完要重启才生效。要在**进程不动**的前提下换，写部署侧的控制文件
`$DSH_HOME/loom/model-switch.json`——放哪、什么格式、怎么确认、被拒时什么行为，见
[`subsystems/model-switch.md`](subsystems/model-switch.md)。

## profile 硬要求

部署 profile 的 `package.json` 必须有非空的 `name` 和 `version`。漏 `version` 不会启动失败，而是**每个模型请求都失败**（`REQUEST_EXTENSION`）——插件清单上报器要求每个活跃包都声明 name+version。
