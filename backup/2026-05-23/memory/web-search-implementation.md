---
name: web-search-implementation
description: 网络搜索+参考来源功能：需求清单、优先级、实施要点、前置条件
metadata: 
  node_type: memory
  type: project
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 背景

2026-05-14 用户询问"找选题阶段是否有网络信息搜索参与"→ 发现完全没有。所有 Phase 0/1 的分析（竞品、受众、行业趋势）全靠 AI 训练数据，无实时搜索，无参考来源标注。

## 核心原则

- **不依赖 MiniMax 的搜索能力**（不是所有用户都用 MiniMax）
- 用系统自身功能 + 通用大模型实现搜索
- 搜索结果必须在输出中标注参考来源

## 已确认的搜索需求（按优先级）

### P0 — Phase 1 竞品分析
- **当前**：AI 凭训练数据生成竞品信息，字段 `sources` 写死为 `{type: "manual", path: "用户输入"}`
- **需要**：真实竞品账号数据 + 网络搜索竞品内容策略 + 来源标注
- **已有基础**：`douyin_service.py` 可爬抖音竞品主页数据（粉丝、作品、互动）；`src/services/douyin.ts` 有 `authorToCompetitor()` 转换函数
- **还需补**：通用网页搜索（竞品品牌信息、其他平台数据）

### P1 — Phase 1 受众画像
- **当前**：AI 生成用户画像，可能用泛化标签
- **需要**：当前平台用户行为趋势、圈层标签、内容消费偏好数据

### P1 — Phase 4 内容方案+对标
- **当前**：AI 基于前期分析生成内容排期
- **需要**：当前热门选题方向、平台热点趋势、同行近期爆款模式

### P2 — Phase 9 爆款优化
- **当前**：AI 基于历史策略提炼爆款公式
- **需要**：当前平台真实爆款案例参考

### P2 — 每日创作 StepTopic 选题
- **当前**：基于项目策略数据生成选题
- **需要**：当日热点事件、平台热搜、节假日节点

### 基础设施 — 抖音数据抓取
- **已有**：`douyin_service.py`（DrissionPage + Edge/Chromium，扫码登录→cookie 持久化→headless 静默查询）
- **缺口**：报告未区分"爬回来的真实数据"和"AI 推断数据"

## 实施要点

### 后端
1. 新增通用网页搜索 API（Tavily / SerpAPI / Brave Search 等，用户可配置 API key）
2. 搜索 API 需支持：关键词搜索 + 返回 URL + 摘要片段
3. Prompt 改造：搜索结果作为上下文注入，要求 AI 区分"搜索来源"和"推理来源"
4. 所有带搜索的 Phase 输出 JSON 增加 `references` 字段：`[{url, title, snippet, usedFor}]`

### 前端
1. 竞品分析/受众画像/内容方案报告页新增「参考来源」卡片
2. 每条参考来源显示：标题+链接+摘要+被用于哪个分析结论
3. 抖音爬取的数据标注为"抖音真实数据"，AI 推断标注为"AI 分析"
4. 设置页新增搜索 API 配置槽位

### 抖音爬取前置条件（使用须知）
- 必须有一个抖音账号扫码登录
- **建议使用非主力抖音号**（存在中低封号风险）
- 首次使用会弹出浏览器窗口，手机扫码后 cookie 自动保存
- Cookie 过期后需重新扫码
- 建议单次分析不超过 5 个竞品账号（控制请求频率）
- 提供手动输入降级方案（直接粘贴已知竞品数据）

### 封号风险评估
- 风险等级：中低（只读公开数据，不写操作）
- 已有多层反检测：隐藏 AutomationControlled、伪装 UA、新版 headless、优先 requests HTTP 请求
- 还需补充：请求间延迟（3-5s）、查询数量上限、深度指纹伪装
- **需在设置页明确告知风险，用户知情后自行决定是否使用**

## 搜索 API 选型（待定）

候选：Tavily（AI 搜索专用）、SerpAPI（Google 搜索）、Brave Search API（免费额度）
选择标准：中文搜索质量、价格、是否需要用户自行申请 Key

## 涉及文件

| 文件 | 动作 |
|------|------|
| `backend/api/search.py` | **新建** — 通用网页搜索端点 |
| `backend/services/search_service.py` | **新建** — 搜索服务封装 |
| `backend/models/schemas.py` | 改 — 增加 SearchRequest/SearchResult schema |
| `src/phases/Phase0/prompts.ts` | 可能改 — 如果搜索参与需求解构 |
| `src/phases/Phase1/prompts.ts` | 改 — 注入搜索结果上下文，增加 references 字段 |
| `src/phases/Phase4/index.tsx` | 改 — 注入搜索上下文 |
| `src/phases/Phase1/CompetitorView.tsx` | 改 — 展示参考来源卡片 |
| `src/phases/Phase1/AudienceProfile.tsx` | 改 — 展示参考来源卡片 |
| `src/services/douyin.ts` | 可能改 — 增加来源标注 |
| `src/components/settings/` | 改 — 新增搜索 API 配置 |
| `docs/` | **新建** — 使用须知文档 |
