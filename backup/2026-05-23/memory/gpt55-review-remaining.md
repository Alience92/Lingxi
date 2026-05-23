---
name: gpt55-review-remaining
description: 2026-05-21 GPT-5.5审查剩余4项未修，评估2.0优先级
metadata: 
  node_type: memory
  type: project
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 已修（7项，commits 42a1663 + 98420c8）

knowledge_entries 建表、updateProject 列名漂移、IPC 收紧、stale 类型清理、App.tsx 路由拆分、npm install、**Phase 配置化**

## 未修（3项，全部留待 2.0）

### #4 Phase 系统脆弱 → 建议 2.0 前修

**现状：**
- 路由在 App.tsx 手工平铺 Phase0~10（10行），每个加一行
- phase_status 默认 JSON 只到 "9":"locked"
- Phase10 实现后没注册 Phase11 占位（违反架构铁律 #5）

**为什么现在修：** 新增 Phase 时改 3 处（路由、phase_status、导航），容易漏。Phase10→11 已经出现此问题。

**方案（小改，<30行）：**
- Phase 路由改为 `['0','1',...,'10'].map(n => <Route .../>)` 配置化
- phase_status 生成函数：`Object.fromEntries([...Array(11)].map((_,i) => [i, i===0?'active':'locked']))`
- 注册 Phase11 的 `/phase/11` 占位路由

**2.0 是否需要提前修：** 是。改动很小，消除一类 bug。

### #6 持久化三轨并存 → 2.0 统一

**现状：** SQLite（Electron）、backend SQLite（Python 独立连接）、localStorage（dev/browser 降级）三套并存。modelStore、knowledgeStore、creationStore 各自判断用哪个。

**为什么现在不修：** 这是 workload 最大的项，需要统一抽象层 + 版本化迁移。之前 staged-crafting-hopcroft.md 计划的 Phase 1-6 正是处理这个。

**方案：** 执行 staged-crafting-hopcroft.md 计划，但优先级可调。

**2.0 是否需要提前修：** 否。工作量太大，且当前运行基本正常（dev 用 localStorage，production 用 SQLite 各有各的路径）。

### #7 数据库路径不一致 → 2.0 修

**现状：**
- Electron: `app.getPath('userData')/data/content-director.db`
- Python: `APPDATA/short-video-agent/data/` 或 `~/short-video-agent/data/`
- 开发模式下可能写到不同位置

**为什么现在不修：** 实际影响有限 — Python 后端通过 API 调用不直接读写 DB（除了 import_.py 知识库导入）。打包后两者路径基本对齐。

**方案：** 统一通过 Electron 的 `get-app-data-path` IPC 告知 Python 端口使用同一数据目录。

**2.0 是否需要提前修：** 否。当前打包后路径基本一致。

### #3（深入）IPC 进一步加固 → 2.0 完善

**已做：** SQL 动词白名单 + 文件路径沙箱约束在 AppData 范围内。

**未做：** 将 `dbQuery`/`dbRun` 替换为具体的业务 API（如 `saveProject`、`getKnowledgeEntries`），而非接受任意 SQL。

**2.0 是否需要提前修：** 否。当前桌面应用无网络暴露面，白名单+路径约束已足够。

## 结论

| 优先级 | 项目 | 时机 |
|--------|------|------|
| P0 立即 | #4 Phase 配置化 | 下次开 Session 直接修 |
| P1 2.0 | #6 持久化统一 | 执行 staged-crafting-hopcroft 计划 |
| P2 2.0 | #7 路径统一 | 跟 #6 一起处理 |
| P2 2.0 | IPC 深入加固 | 不需要单独处理 |

**只有 #4 需要在 2.0 前修。** 改动非常小，消除 11→12 时漏改路由的风险。
