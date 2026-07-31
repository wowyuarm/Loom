# Local Interaction Channel

Local 是 Loom 内置的本机 interaction channel。`loom init` 会在新 Instance
Configuration 中明确启用它，并把 `local` 设为默认 Interaction Route。

```yaml
version: 1
integrations:
  local:
    enabled: true
  weixin:
    enabled: false
  nmem:
    enabled: false
interaction:
  defaultRoute: local
```

启动唯一的 Instance Host：

```bash
loom run
```

另一个终端通过 Host 交互或查看最近的统一互动记录：

```bash
loom chat "你好"
loom history
```

CLI 默认使用 `~/.loom`。测试、临时 Instance 或其他明确部署位置可以通过
`--root <instance-root>` 覆盖。

在 Loom 尚未发布为正式 package 的开发期，本机命令通过仓库 build 安装：

```bash
cd /home/yu/projects/Loom
npm run build
npm link
```

`loom` 随后指向这个仓库的 `dist/src/cli.js`。源码更新后必须先通过验证并重新
build，运行中的 Host 仍需正常重启；当前不把开发 checkout 伪装成版本化发布包。

Local 使用 `runtime/integrations/local.sock`。CLI 是客户端，不会直接打开
Runtime Store，也不保存自己的 inbox。`history` 从 Runtime 的 human Input、
message Effect 和 confirmed Delivery 重建 Interaction View，因此未来从 Weixin
切换到 Local 时仍属于同一个 Runtime Instance、Context 和 Agent Workspace 演化。

Local Delivery 的确认含义是 message Effect 已经可以从这个持久视图重新读取，
不是某个终端进程当时正在显示它。thinking、工具轨迹、内部维护和未确认投递的
输出不进入 Interaction View。

当前一个 Instance 只启用一个 interaction channel。Local 与 Weixin 同时启用会
阻止 Host 打开；多 route 选择和 fan-out 不属于当前本机部署。
