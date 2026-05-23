---
name: 2026-05-20-discussion-round
description: "2026-05-20 剩余问题讨论记录：#9已修，#12方案确认，#13方案确认（cheat-on-content集成），#16待讨论"
metadata: 
  node_type: memory
  type: project
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 已确认

### #9 Phase10 剪辑指导 — 已修
- 报告页增加"历史记录"按钮（RunHistoryPanel，phase="10"）
- 增加"新建分析"按钮（清空脚本+报告，回到空白输入页）
- 提交：56e50cd + f8eee32

### #12 文案细节不妥 — 方案确认，待修
- 根因：AI生成文案时只有框架名+选题名，无知识库/项目上下文，只能编造
- 方案：StepScript/StepTopic/StepTitleCover/StepComments 注入三样东西：
  1. 项目上下文（phaseStore reports['0'~'4']）
  2. 知识库摘要（按标签过滤：projectType + platform + contentStage）
  3. 用户约束（session中已有选择）
- 数量控制：每步Top 5-8条，总token < 1500
- 待所有讨论完毕后统一修改

### #13 数据看板 — 方案确认，待修
- 集成 cheat-on-content (XBuilderLAB) 方法论
- Phase 8 从"数据追踪"升级为"内容校准系统"
- 四个步骤：发布前AI评分 → 用户盲预测 → 发布 → Day1/3/7/15录入 → AI对比归因
- 分平台独立Tab + 独立评分模型
- 评分公式进化：连续3次同方向偏差触发升级，新公式需验证通过
- 视频详情页：数据趋势曲线 + 各时间点AI分析 + 优缺点 + 优化建议
- 知识库联动：复盘学习沉淀自动入库
- 设计文档：docs/design/2026-05-20-phase8-content-calibration.md

### 知识库高级机制 — 状态确认
- 沙漏衰减/语义检索/RAG注入管线/知识图谱：**全部在设计阶段，1.0未实现**
- 当前只有标签过滤（projectType/platform/skillDimensionId）
- 短期用标签过滤做#12，够用
- 需预留2.0字段：embedding, accessCount, decayScore, links

## 待讨论
- #16 决策链需深化
