# 03 — Memory Reflector 纵切（脱离执行台账）

**What to build:** Memory Reflection 入口与 02 同构：预算挂 memory_reflection 域行，脱离台账与 driveCognitiveOrgan；abort 让路；无 busy。保留既定合同：同日 Reflection 不得早于该日 Thread 维护完成而提前 completed（表达为 isDue 前置检查 + 对方完成时 wake）。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 与 02 相同的四条预算/abort/park/隔离验收
- [ ] 同日 Reflection 等待 Thread 维护完成的既有边界保持（回归覆盖）
- [ ] 全部现有测试保持绿色
