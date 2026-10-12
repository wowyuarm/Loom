# 验证与 eval

**Status:** 方法收敛，待实现验证。

**last-checked:** 2026-09-23

分两层，处理方式完全不同：第一层是 harness 机械保证的确定性测试；第二层是 agent 行为质量的评测（测量仪，不是 pass/fail 门）。

## 第一层：确定性测试（harness 的机械保证）

每条是非平凡不变量，值得测；不测字面量 / 显然控制流 / persona 是否中立这类内容质量。

```
  ② / ingress
    · 去重幂等：同 (channel, providerMessageId) 只处理一次，第二次投递 no-op
    · 接受屏障：Input 落库先于 followup；模型执行 throw/崩溃后 Input 记录仍在
    · 崩溃恢复：重启后 loadAll 拿回已接受，去重仍成立

  连续性 / rollover
    · 指针原子：setCurrentSession 在 executeTransition 内；transition reject 后指针仍指旧 session
    · 重启续上：boot 读指针 → resume 同一 session（不新建）
    · 单活：第二进程 resume 同一 session → SessionAlreadyOwnedError → boot 中止、不起 channels

  材料
    · 来源戳：memory_write 正确盖 exec.agent.id
    · 写一致：先 note 后索引；中途失败只留孤儿 note（无半截索引）
    · 投影跟文件：改材料文件 → 下次 assembly 反映新内容
    · 预算：常驻超预算 → 用量显示如实反映

  channels
    · send_message → gateway.send，route 用接受时固定值（不重新推断）
```

第一根切片就该有，普通行为测试。

## 第二层：连续性 / 主动性评测

**它是测量仪，不是 pass/fail 门。** 得到的是分维度回归信号，不是单一分数。方法：planted 场景 + 分档判分。

```
  剧本化场景（有 ground truth）
    setup 脚本注入 → 强制 rollover / 推进时间 → 探针 → 判分
  判分三档:
    能精确查的   查文件 / ② 状态（attention 老化、thread 续、指针对）
    要语义判的   LLM-as-judge 按 rubric（召回命中、醒来在状态）
    只能人判的   人抽查（取舍得体、主动是否受欢迎）
```

连续性维度（借 LongMemEval / Generative Agents 访谈式评测的做法）：

```
  持久/召回   埋事实→rollover→旁敲是否用上（不被提示）
  定向        埋 thread 进度→rollover→再进入是否从断点续
  非冗余      已定结论后续是否重问/重推
  恰当遗忘    带 horizon 的 attention 过期后是否老化出
  可检索      久远的事变相关时是否 search 得到
  知识更新    先 A 后改 B，之后是否用 B
  弃权        问没说过的事是否老实说不知道
```

主动性维度（更难，无输入触发）：

```
  机会 precision/recall   埋"该主动的"+"该忍住的"，看动/忍
  时机                    是否在合适窗口
  ★反打扰(最可测)          安静期是否保持安静 = 误报率。主动性头号失败是烦人，这条最该量
```

**消融**：同场景开/关某机制，看行为差多少，验证机制真承重。

## 关键：eval 靠架构 seam，不是测试套件的事

每个第二层场景都要能被脚本重放。这是架构要求，现在不留缝以后做不了：

```
  脚本 ingress            test channel 适配器挂 gateway 后        免费
  状态可读                材料是文件、② 是 domain                大体免费
  强制 rollover           context-continuity 的 context 工具可触发  半免费
  ★ 可注入时钟             时间走一个 seam，不到处 Date.now()      需现在定
  ★ Instance Root 快照/恢复 sqlite ② + session log 一致性快照      需现在定
```

前三基本白得。**两条现在就要定死：时间可注入、Instance Root 可一致性快照/恢复。** 时间本就是 harness 提供的连续条件，做成 seam 顺理成章；快照/恢复决定场景能否重放。不定，第二层就是空中楼阁。
