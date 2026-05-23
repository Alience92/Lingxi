---
name: 2026-05-19-bugfix-round
description: 2026-05-19 用户测试发现16个问题，8个直接修复完成
metadata: 
  node_type: memory
  type: project
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 已修复（8/16）

| # | 问题 | 修改文件 | 方案 |
|---|------|---------|------|
| #1 | 进度条静态显示像卡死 | 全部7个Phase的index.tsx | 加status字段+status="active"动画+状态文字 |
| #2 | 🔵无悬停溯源 | SourceDot.tsx(新), InsightCard, ReasoningChain | renderWithSources()将🔵替换为Popover，悬停展示可点击链接 |
| #3 | Phase 2出镜人画像输出为空 | ai-parse.ts, Phase2/index.tsx | JSON提取从简单正则改为贪婪匹配+修复尾逗号/中文引号；AI返回内层对象时自动包装到expectedKey |
| #4 | Phase 2无网络搜索 | Phase2/index.tsx, Phase2Report.tsx | 参照Phase1/4模式，在AI分析前加executeSearch |
| #8 | 无中断按钮+输入丢失 | Phase1/2/4的index.tsx+DataInput/PresenterInput/PlanInput | AbortController+取消按钮；sessionStorage自动保存/恢复输入 |
| #10 | 框架下拉英文名 | StepFramework.tsx | 添加zh映射表（PAS→PAS问题→放大→解决...） |
| #11 | AI推荐框架不自动选中 | StepFramework.tsx | 推荐完成后自动handleSelect(recommendedFramework) |
| #14 | 图片生成API残留 | SettingsPage.tsx, modelStore.ts, inference.py | 从SLOTS/ALL_SLOTS删除image_gen |

## 关键技术决策

- **parseAIJson健壮性**: 不再用简单正则`/\{[\s\S]*\}/`做贪婪匹配（会误匹配到跨JSON的括号），改用深度计数法精确定位最外层JSON边界
- **AI输出包装检测**: Phase2任务增加`expectedKeys`字段，解析后检查预期key是否存在，缺失则自动用primary key包装
- **SourceDot设计**: 🔵用蓝色圆点+Popover而非inline文本替换，保持AI输出原样不变，hover才展示来源
- **中断模式**: sessionStorage而非localStorage，关闭标签页自动清除，属于"临时保存"范畴

## 后续修复（8/16，2026-05-20 全部结案）

#5 对标账号分析结果全错 → v1.3 竞品文案手动输入替代
#6 Phase5脚本框架输出错误 → v1.3 框架系统重构(推荐替代生成)
#7 脚本框架添加机制 → v1.3 frameworkStore + 手动添加Modal
#9 Phase 10剪辑指导缺少历史记录+新建按钮 → 2026-05-20 已修
#12 文案细节不妥 → 2026-05-20 已修
#13 数据看板混乱需分平台 → PlatformDashboard 分平台Tab
#15 技能编辑器 → v1.3 框架系统重构中微调
#16 决策链需深化 → 2026-05-20 已修（隐藏至2.0）

---

## parseAIJson 新架构

```
输入文本 → 去markdown代码块 → 精确深度计数提取{...}/[...] → 
候选列表 [原文本, 提取的JSON段] → 逐个尝试JSON.parse → 
失败则repairJson(去尾逗号/中文引号)重试 → 全部失败才throw
```
