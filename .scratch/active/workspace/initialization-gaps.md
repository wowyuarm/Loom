# Loom 初始化：现状与缺口

**Status:** workspace 层已实现；Instance Root provisioning 层是缺口（本轮探索过 `loom init`/`loom status`，暂缓）。

**last-checked:** 2026-09-26

一个新 Loom 实例从零到"活着"的全链路，分两层。workspace 层这轮已落地；Instance Root 层仍靠手工。

## 全链路与责任归属

```
  [operator]  provision Instance Root：
                $DSH_HOME/profiles/<name>/package.json  声明 dsh.profile.bundles: [@deepseek-ai/dsh-base, loom]
                profile 的 node_modules 软链：loom / @deepseek-ai / @wowyuarm → 本仓库
                （让 profile 从仓库携带的运行时解析，绝不用全局 dsh）
                一份空的 loom.env                                              ← 缺口：无 primitive/recipe
  [operator]  填 loom.env 密钥：DEEPSEEK_API_KEY / DSH_TELEGRAM_TOKEN / 代理    ← 缺口：无 scaffold、无检查
  [first boot] harness 自动：workspace scaffold（材料文件+目录+AGENTS.md+bootstrap.md）  ← 已实现
  [first boot] bootstrap.md 存在 → loom:bootstrap 段主导首轮 → 与 user 对话确立"我是谁"  ← 已实现
  [agent]     写 identity/identity.md → 删 bootstrap.md → context_rollover               ← 已实现
              → 再醒来：born，正常连续运行
```

三个所有权桶：

```
  harness-owned   workspace 文件骨架  → 已实现（ensureWorkspaceScaffold，挂载即铺，create-if-absent）
                  Instance Root profile/symlinks → 缺口（当前手工，某个真实 Instance Root 就是手搭的）
  operator-owned  loom.env 密钥       → 缺口（无空 env scaffold、无就绪检查）
  agent-owned     identity（靠诞生对话）→ 已实现（bootstrap 流程）
```

## 缺口清单

1. **Instance Root provisioning 没有 primitive**：profile 清单 + node_modules 软链 + 空 loom.env，现在全靠手搭。新开一个实例无可复用步骤。
2. **就绪度不可见**：没有只读的 `loom status` 报告"profile 有没有 / 密钥缺不缺 / 诞生到哪步（fresh / awaiting-birth / born）"。
3. **DSH profile 默认不含 loom**：缺失 profile 会以 `DEFAULT_PROFILE_BUNDLES = [dsh-base]` 自动初始化，不带 loom；`--from-default-profile` 只认出厂模板（web/tui/headless），loom 不是。所以 profile 清单必须显式写 `[dsh-base, loom]` + 软链，不能指望 DSH 默认。
4. **启动顺序依赖**：workspace scaffold 跑在 resident-context 挂载时，而挂载的前提是 profile 已 provision。所以第 1 步（provision）必须先于首次 boot，scaffold/birth 才谈得上。

## 已探索但暂缓的方案

本轮在一个分支里建过 `loom init [--root]`（provision profile + dev 软链 + 空 loom.env，幂等、只补缺、绝不写身份或填密钥）和 `loom status [--root]`（只读就绪报告），端到端验证过（`loom init` → `--dump-config` 挂全栈、exit 0）。判断"暂时没太必要"，已取消（`src/instance/`、`tests/instance-*`、`bin/loom.mjs` 的 init/status 分支、docs 初始化段都还原）。要再拾起时，从这里接。

## 定调（沿用旧 Loom ADR 0002）

不做部署向导 / 控制面；harness 只提供小而可复用的 primitive + 一份文档化的 operator recipe。就绪类 primitive 永远只读或 create-if-absent，绝不代建身份、不代填密钥。
