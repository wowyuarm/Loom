# Cleanup Round 收敛记录

Captured: 2026-08-15

## 复核结果

以当前 `origin/main=e4d98a3` 复核后，第一轮死代码/重复映射清单和第二轮 conventions 清单大部分仍成立。器官 session helper 已由现有 `src/agents/session/` 统一，相关候选从本轮移除。Scheduler 窄快照、RaftRefStore、通用 Store/atomic-write、Scheduler 工厂与 `nextRunId` 没有当前故障或第二个真实 adapter，按不过度设计原则暂不处理。

当前串行验证为：`test:fast 219/219`、`test:runtime 180/180`、`test:host 191/191`、typecheck 和 diff-check 通过。三个分层测试不能并行启动，因为它们共享 `dist/` 构建目录；并行构建曾产生一次 skill-manager collision，串行重跑通过。

## 已确认的配置取舍

`workspaceMirror` 的 TS 解析结果没有 Loom Host 消费者，镜像脚本会独立读取并解析配置。`intervalMinutes` 不被镜像脚本读取，systemd timer 固定为 30 分钟，因此删除该字段及其文档、测试和解析校验；保留 `enabled`、`remote`、`branch` 的 fail-fast 白名单校验。

## 执行 tickets

- task #42：删除已确认死面、收缩重复实现、完成 conventions 修正，并执行上述 `workspaceMirror` 取舍。
- task #43：参数化四个 Cognitive Organ 的 Runtime 生命周期 driver；先给接口和迁移边界。
- task #44：让 Thread Maintainer 使用已有 WorkspaceMutation durable 写入路径，保持现有恢复边界。
- task #45：统一递归 `withoutImagePixels`，补嵌套 image 的最终可见行为测试。
- task #46：修复 Raft CLI 与 Weixin teardown 的等待、超时和错误优先级。

后四项不并入 cleanup。所有 tickets 均未授权部署；固定候选后按各自合同审查和验收。

## 边界决定

Memory backup 权限、Raft spool 的 `wx`、Attachment Store 删除前 `lstat` 暂不处理：当前均属于单实例自有边界，没有新增损失场景。R1、A2、M4 和 teardown 是独立行为/架构工作，不作为本轮删除型提交的隐式扩展。
