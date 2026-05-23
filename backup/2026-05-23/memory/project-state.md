---
name: project-state
description: 2026-05-18 最新状态：1.0 已完成搜索补全+白屏修复，2.0 暂停等1.0完成。版本隔离规则已确立。
metadata: 
  node_type: memory
  type: project
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 当前状态

### 1.0 (feat/mvp-1.0, 工作树: mvp-phase0-1)
- 最新 commit: `b47c055` (搜索补全+设计报告)
- 运行端口: 前端 5173 / 后端 18765
- 主题: 深色 (darkAlgorithm)

**已完成**:
- ✅ 白屏修复 (Ant Design Menu bug → 纯div导航)
- ✅ 搜索系统 (百度+热搜+时间过滤+置信度)
- ✅ Phase 1/4 搜索注入 + ReferenceList 参考来源展示
- ✅ StepTopic 微博热搜自动加载
- ✅ 反蒸馏基础设施 (Vite混淆/Prompt加密/知识库加密/Bundle校验 — 代码就绪未生产构建)
- ✅ 版本隔离规则

**已知未完成 1.0**:
- Phase 8/9 未接入搜索 (P2)
- 来源标注体系未完整 (AI推断 vs 搜索事实)
- image_gen 类型定义残留

### 2.0 (feat/mvp-2.0, 工作树: mvp-2.0)
- 最新 commit: `6ee8cf4` (2.0架构提交)
- 运行端口: 前端 5174 / 后端 18766
- 主题: 浅色暖纸 (#F8F4E8 / #D4A017)
- 状态: **暂停，等1.0完成后继续**
- 核心差异: Session对话式入口（替代Phase0）、知识库全链路、局域网管理

## 设计文档
- `docs/design/2026-05-18-1.0-final-report.md` — 1.0 完整功能设计报告
- `docs/design/2026-05-16-system-design.md` — 2.0 系统设计
- `docs/design/2026-05-17-architecture-decisions.md` — 架构决策记录
- `docs/design/2026-05-18-plan.md` — 1.0 收尾计划

## 关键规则
- ⚠️ 禁止跨分支复制文件 (rule-version-isolation)
- ⚠️ 修改前必须先讨论确认 (feedback-ask-before-implement)
- Ant Design Menu + React 19 已知无限循环bug (bug-antd-menu-infinite-loop)
