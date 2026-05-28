# 灵犀 Relationship Profile — 状态机规格

基于 GPT 审查建议：动态恢复/衰减、滑动窗口升级、多源触发。

---

## 1. 数据结构

```typescript
interface RelationshipProfile {
  trustLevel: "L1" | "L2" | "L3";
  frictionScore: number;        // 0-10, 浮点
  autonomyBudget: number;       // 0-10, 浮点
  repairNeeded: boolean;
  signals7d: {
    correction: number;         // 纠正次数
    frustration: number;        // 挫败次数
    urgency: number;            // 紧迫次数
    confirmation: number;       // 确认次数
  };
  windowStats: {                // 滑动窗口（14天/30天）
    totalInteractions: number;
    acceptedAutonomy: number;   // 用户接受了 AI 的自主执行
    correctionCount: number;
    highSeverityErrors: number;  // 宪法级冲突
  };
  lastUpdatedAt: number;        // epoch ms
}
```

### 存储

- 每 project 一条记录，存 `projects` 表 JSON 字段或独立 `relationship_profiles` 表
- 每次 FEEL 事件触发更新
- `signals7d` 每天衰减：`* 0.85`（7 天前的事件权重降至 ~30%）

---

## 2. frictionScore 规则

### 上升（触发时 +N）

| 事件 | 增量 | 说明 |
|------|------|------|
| 明确纠正 | +2 | encoder FEEL=correction 且置信 ≥0.7 |
| 连续两轮纠正 | +3 | 同一 topic 连续 2 次纠正 |
| 明确负面反馈 | +4 | FEEL=frustration 置信 ≥0.7 |
| 宪法级冲突 | +6 | challenge_event 触发且 L3 阻断 |

### 下降（事件触发 或 时间衰减）

| 条件 | 变化 | 说明 |
|------|------|------|
| 一次明确确认 | -1 | FEEL=confirmation 置信 ≥0.7 |
| 连续 3 次顺利交互 | -2 | 3 轮无 correction/frustration/urgency |
| 每 24h 无摩擦 | ×0.85 | 定时 decay（dreaming worker 触发） |

### 边界

- 下限 0，上限 10
- `frictionScore >= 8`：禁止 L3，challenge 升级更敏感，默认多确认少自主

---

## 3. autonomyBudget 规则

### 上升

| 事件 | 增量 | 说明 |
|------|------|------|
| 明确认可 | +1 | FEEL=confirmation |
| 用户接受自主执行结果 | +2 | AI 主动执行且用户未否定 |
| 连续成功完成 | +1 | 3 轮内无纠正且任务完成 |

### 下降

| 事件 | 减量 | 说明 |
|------|------|------|
| 被纠正 | -2 | 任何 correction |
| 高风险误判 | -4 | AI 自主执行导致错误 |
| frictionScore >= 6 时 | 自动封顶 | autonomyBudget 不能超过 (10 - frictionScore/2) |

### 边界

- 下限 0，上限 10
- `autonomyBudget >= 8 && frictionScore <= 3`：允许进入更高自主度（减少确认、主动建议）

---

## 4. trustLevel 升级/降级

### L1 → L2（门槛：14 天窗口）

**全部满足：**
- 窗口内 `acceptedAutonomy >= 5`
- `correctionCount / totalInteractions < 20%`
- `frictionScore < 6`
- `repairNeeded === false`

### L2 → L3（门槛：30 天窗口）

**全部满足：**
- 窗口内 `acceptedAutonomy >= 15`
- `highSeverityErrors === 0`
- `correctionCount / totalInteractions < 10%`
- `repairNeeded === false`

### 降级规则

| 条件 | 动作 |
|------|------|
| 连续 2 次高风险纠正 | 降一级（L3→L2, L2→L1） |
| 宪法级冲突 | 直接回 L1 |
| `repairNeeded === true` 超过 48h 未恢复 | 降一级 |

### 升级冷却

- 每次升级后 7 天冷却期，冷却期内不再次升级
- 降级不受冷却限制

---

## 5. repairNeeded 状态机

```
正常 → repairNeeded:
  触发: frictionScore >= 8 持续 > 1h
  或: 单次宪法级冲突
  
repairNeeded 期间:
  - 输出前优先澄清（不假设理解正确）
  - 关闭主动插话
  - challenge 行为从 advise 升级为 revise_required
  
repairNeeded → 正常:
  触发: 连续 2 次正向确认（FEEL=confirmation）
  且: frictionScore < 6
```

---

## 6. challenge_event 最小闭环

### 触发源（多源——不依赖单一分类器）

| 来源 | 信号 | 权重 |
|------|------|------|
| encoder FEEL 分类 | channel=FEEL, confidence≥0.7 | 软信号 |
| 显式语言规则 | "你又""别再""不是这个""就按上次""别动这个" | 硬信号 |
| active_context 决策表 | preference/decision 被违反 | 结构化证据 |

**触发条件**：至少 2 个来源同时命中。

### 行为等级

| 级别 | 行为 | 触发条件 |
|------|------|---------|
| L1 advise | 提示用户存在冲突，建议方案 | 默认 |
| L2 revise_required | 明确要求用户确认，不继续执行 | trustLevel=L1 且 frictionScore≥5 |
| L3 deliver_blocked | 阻断操作，解释原因 | 宪法级冲突 或 trustLevel=L1 且 frictionScore≥8 |

### 宪法级 FEEL 定义

以下 FEEL 信号标记为宪法级（不可绕过）：
- 用户明确说"别动"/"不要改"/"保留" + 具体对象
- 用户纠正同一行为 ≥3 次（跨 session）
- active_context 中标记为 `is_preference=true` 的规则被违反

---

## 7. 周期维护

### dreaming worker 触发（每次 dreaming 时）

1. 计算 `signals7d` 衰减：`signals7d.* = signals7d.* × 0.85^days_since_last_update`
2. 计算 `frictionScore` 衰减：如果 24h 无摩擦事件，`frictionScore *= 0.85`
3. 检查 `repairNeeded` 超时：>48h 未恢复 → 降 trustLevel + 清 repairNeeded
4. 检查升级条件（14 天/30 天滑动窗口）
5. 写入 `health_snapshots` 新增 `relationship` 字段

### 窗口维护

- 14 天窗口：`windowStats` 只计数最近 14 天的事件
- 30 天窗口：`windowStats` 只计数最近 30 天的事件
- 每次 dreaming 清理过期计数

---

## 8. 实施优先级

| 优先级 | 模块 | 依赖 |
|--------|------|------|
| P1-1 | 数据结构 + 存储 | schema.ts |
| P1-2 | friction/autonomy 升降 | FEEL 事件流（encoder 切主分类后） |
| P1-3 | trustLevel 升级/降级 | 滑动窗口数据积累 ≥14 天 |
| P1-4 | repairNeeded 状态机 | frictionScore 稳定运行 |
| P1-5 | challenge_event | repairNeeded + 多源触发 |

---

## 修订历史

- 2026-05-28 v1: 初版，GPT 审查 P1 设计后制定
