# Workspace Mirror Integration

Workspace Mirror 是实例级运维 Integration：把 Agent Workspace 定期镜像到配置的
私有 Git remote，作为**人类可读的运维观测面**。它不是备份——备份是完整的
Instance Root 一致性副本（见
[Backup, Restore And Migration](../operations/reference/backup-and-restore.md)），
mirror 只反映 Workspace 内容的历史演进，不承诺一致性、不包含 Runtime 状态、
也不能用于恢复。

## 定位

- **观测面**：human 或 operator 通过私有 repo 直接查看 agent 的工作演进
  （daily、threads、episodes、记忆材料的变化历史）。
- **不是备份**：不包含 Runtime、Channel、Integration、Transcript、配置或凭据；
  不以任何方式替代完整 Instance 备份。
- **不是恢复源**：git 历史不是 Loom 的恢复事实来源；恢复请走备份流程。

## 配置

在 `configuration/instance.yaml` 配置（装配层声明，与 nmem/web 的
`config.json` 组件配置不同——mirror 是实例级行为，配置随实例装配）：

```yaml
version: 1
workspaceMirror:
  enabled: true
  remote: git@github.com:wowyuarm/loom-xi-workspace.git
  branch: main            # 可选，默认 main
```

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | — | 是否启用镜像。 |
| `remote` | string | — | 私有 remote URL（SSH 形式，如 `git@github.com:...`）。启用时必须提供。 |
| `branch` | string | `main` | 镜像推送的目标分支。 |

配置解析是白名单校验：`workspaceMirror` 只接受上述三个字段，未知字段或非法值
会在配置加载时报错。配置变更在下次镜像轮询时生效（脚本每轮重新读取配置）。
轮询节奏由 systemd timer 决定，不由配置控制。

### 凭据：实例账号的 SSH deploy key

镜像使用**实例 Unix 账号自己的 SSH deploy key** 访问 remote，配置只放 remote
不放密钥：

1. 以实例账号生成 SSH key：`sudo -u loom-<name> ssh-keygen -t ed25519 -f /home/loom-<name>/.ssh/id_ed25519 -N ""`
2. 把公钥添加为 GitHub 目标私有 repo 的 deploy key（只读或读写，取决于运维需要）。
   repo 与 deploy key 由 operator 通过 `gh` 或 GitHub 界面创建，Loom 不管理它们。
3. 确认实例账号能访问 remote：`sudo -u loom-<name> ssh -T git@github.com`

凭据不进入 Loom 配置、Workspace 或本镜像仓库。

## 运行时行为

脚本由 systemd timer 驱动，与 Loom Host 进程生命周期无关——Host 宕机时镜像
至少停在最后一次成功状态：

- **轮询**：`loom-workspace-mirror@<name>.timer` 每 30 分钟触发一次
  （`OnCalendar=*:0/30`），运行 `loom-workspace-mirror@<name>.service`。
- **幂等 init**：首次运行时在 Workspace 内 `git init`（无 `.git` 时），
  之后跳过。
- **有变化才提交**：`git status --porcelain` 为空则本轮不产生提交；
  remote 变更会跟随（`remote set-url`）。
- **push 失败下轮重试**：push 失败退出非零，timer 下轮自动重试；本地领先
  remote 但无新变化时也会重试 push（保证首次 init 后能推上初始提交）。
- **commit message**：`workspace mirror: <YYYY-MM-DD HH:mm:ss> (<时区>)`。
  时区取 `instance.yaml` 的 `time.timeZone`，未配置时回退机器时区——与
  Loom 自己的时间策略一致，使 git 历史与 daily/threads 的日期对齐。
- **安全兜底**：仓库应配合 `.gitignore` 排除敏感与临时文件
  （`*token*`、`*auth*`、`*.env`、`*.bak` 等）。mirror 本身不写入
  `.gitignore`，由 operator 在启用镜像时配置。Workspace 默认不包含凭据
  （凭据在 `configuration/` 下），但备份文件（如 `*.bak`）可能被镜像进
  repo，应显式排除。

## 启用步骤

1. 创建私有 repo（`gh repo create <owner>/<name> --private`）。
2. 实例账号生成 SSH key，公钥添加为 deploy key。
3. `instance.yaml` 配置 `workspaceMirror`（见上）。
4. 启用 timer：
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now loom-workspace-mirror@<name>.timer
   ```
5. 验证：`systemctl status loom-workspace-mirror@<name>.timer`；
   手动跑一次 `sudo -u loom-<name> /usr/bin/node /opt/loom/src/integrations/workspace-mirror/mirror.mjs --root /home/loom-<name>/.loom`；
   检查 repo 上出现初始提交。

## 状态判断

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `not configured, no action` | 未配置 `workspaceMirror` | 无需处理 |
| `disabled, no action` | `enabled: false` | 无需处理 |
| `no changes, nothing to commit` | 工作树无变化且无未推送提交 | 正常 |
| `push failed (will retry next cycle)` | push 失败（网络/凭据/remote） | 检查 deploy key、remote 可达性；timer 下轮自动重试 |
| `missing workspace` / `cannot read instance configuration` | 实例根或配置异常 | 检查实例根路径与 instance.yaml 可读性 |
