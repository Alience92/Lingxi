---
name: 2026-05-21-session-summary
description: 2026-05-21 工作记录：打包完成、7项修复、知识库导出、API精简、UI居中
metadata: 
  node_type: memory
  type: project
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 版本状态

```
v1.3 → [当前 HEAD c54ab26]
```

## 今日提交

| 提交 | 内容 |
|------|------|
| `eb75b77` | 页面内容居中排列（19个页面） |
| `4baf686` | 知识库导出/导入功能 |
| `52f5a8a` | 补全showSaveDialog类型声明 |
| `2f56199` | 精简为单API槽位 |
| `c54ab26` | 修复ModelRecommend单槽位残留 |

## 打包状态

- electron-builder 成功运行，根因是 Electron zip 缓存损坏（非代码bug）
- 产物：`release/FaCaiDirector Setup 0.1.0.exe`（148MB）
- 安装包结构：Electron + ASAR前端 + PyInstaller后端 + better-sqlite3
- 重新下载 Electron zip 后构建通过

## 已修复（7项）

| # | 问题 | 状态 |
|---|------|------|
| 1 | SetupWizard 跳过按钮 | ✅ |
| 2 | 隐藏决策链 | ✅ |
| 3 | 标签溢出容器 | ✅ |
| 4 | 转圈平行于标题 | ✅ |
| 5 | AI选题去重 | ✅ |
| 6a | 取消标题封面配色+设计图 | ✅ |
| 6b | 选完标题自动保存 | ✅ |
| 7 | 每日创作→数据追踪同步 | ✅ |

## 其他完成

- 知识库导出/导入（浏览器下载 + Electron保存对话框）
- API槽位从6个精简为1个（`general_reasoning`）
- NSIS卸载时清理AppData（重装可重新引导）
- Electron中文菜单
- SetupWizard Ollama安装引导

## 已讨论未实施

- 反蒸馏 + 局域网远程锁 → 2.0
- Anthropic API → 暂缓
- 软件打包已配置完成，可随时 `npm run electron:build`
