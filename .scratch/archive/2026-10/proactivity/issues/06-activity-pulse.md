# 06 — 活动锚定的 pulse，与 after-interaction 并存

**What to build:** 主主体无新输入时仍能在活动冷却后检查自己的材料；默认 dry-run 不唤醒。保留对话后短时检查，真人中途加入自主回合可正常触发 after-interaction。上下文支持自主续线、按需读详细材料与安静结束。

**Blocked by:** None — Human 已授权实现

**Status:** complete

设计见 [DESIGN §9.12](../DESIGN.md)。不部署、不关闭 dry-run、不提交。

- [x] 两轨独立 projection；任何实际回合刷新 pulse 活动时刻；quiet/shadow/失败只推进检查时刻
- [x] 配置、英文 prompt、材料原文、截断与非缺失读取错误
- [x] DSH storage-domain 持久记录；重启不补 tick、换代不回滚时间
- [x] 两轨真人入队取消评估；旧 notice 只删自身；自主工具回合可接受真人 steer
- [x] pulse 工作方式说明、notice、执行反馈；原有身份、材料、时间和 transcript 正常组装
- [x] mock 整栈覆盖取消、重启、换代、两轨接力、混合回合与上下文更新
- [x] build、全套测试、文档门及发布物挂载验证
- [x] 完成情况与后续真实观察范围写回入口；维护记忆
