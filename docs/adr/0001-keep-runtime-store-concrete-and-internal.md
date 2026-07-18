# Keep Runtime Store concrete and internal

Loom 的每个 Runtime Instance 使用一个由 Runtime 内部持有的本地 `node:sqlite` Store，以 WAL、`synchronous=FULL`、current rows 与同事务 transition audit 保存恢复事实。首版不提供 database driver Interface，也不把 Agent Workspace 或 Primary Agent Transcript 放进 Store：一个实例只有一个主要 writer，具体 SQLite 能直接提供需要的原子性；预建可替换存储只会扩大调用方必须理解的 Interface，并削弱恢复规则的集中性。
