# 不建部署准备层，只给只读与 create-if-absent 的 primitive

- 日期：2026-10-12
- 状态：有效

## 背景

把一个 Loom 实例从零带到"活着"要两层：Agent Workspace 层（材料文件与骨架）和 Instance Root
provisioning 层（Profile 目录、bundle 声明、各 root 路径、依赖软链）。前者已由 `resident-context`
的 scaffold 落地；后者仍然靠人手工搭——没有 `loom init`、没有 `src/instance/`、没有部署向导。

这不是遗漏，是两轮讨论后的取舍。问题在于要不要补一个"部署准备能力"：补了，新实例一条命令起；
不补，每次部署都是人照着配方做一遍。

## 决定

**不建部署准备层。** Loom 只提供只读（读取既有 Profile 状态）与 create-if-absent（缺了就按声明建一份）
的 primitive，不做向导、不做控制面、不做 `loom init` / `loom status` 这类命令式入口。部署步骤以
operator recipe 的形式写在[部署指南](../cookbook/deployment.md)。

## 理由与代价

- **配方已经够。** 部署是一次性的、低频的、人全程在场的操作。把一次性操作固化成命令，换来的是一套
  要长期维护的配置推导、交互流程和错误分支，而它服务的是一年跑不了几次的路径。
- **控制面会越界。** 一个能改部署的组件，天然会往"管理实例生命周期"长——起停、迁移、多实例。
  Loom 的定位是一个部署持有一个主主体，不内置身份与关系（见[架构](../architecture.md)）；自带控制面
  就是把运行环境的治理也包进来，偏离这个边界。
- **上游没有可挂的位置。** DSH 的 `DEFAULT_PROFILE_BUNDLES` 只含 `dsh-base`，不含 loom，
  `PROFILE_TEMPLATES` 只有 acp / web / headless / sdk。要建就得自己定义一套模板语义，等于新增一个
  与 loader 平行的概念。

放弃了什么：

- 新实例不能一条命令起，必须照文档做（当前真缺口，已确认 `src/instance/` 不存在）。
- 部署错误靠人读文档和 `dump-config` 发现，没有自动校验。
- 多实例部署没有任何harness 侧支持（一机多部署本来也是后续，不预建）。

## 重审信号

出现下列任一情况时应当重审本条：

- 部署次数多到配方开始被复制粘贴修改（说明一次性假设不成立）。
- 出现需要在无人参与时准备实例的场景（自动化、CI、托管）。
- 一机多部署成为实际需求——那时实例边界得先定清楚，本条是它的前置。

原始调研与缺口清单见[工作记录](../../.scratch/active/workspace/initialization-gaps.md)。
