import {
  BENCHMARK_MEMORIES,
  BENCHMARK_QUERIES,
  type BenchmarkMemory,
  type BenchmarkQuery,
} from "./eval-retrieval-dataset.js";

const REPLACEMENTS: Array<[string, string]> = [
  ["state-gate", "状态门控"],
  ["active_context", "活跃上下文"],
  ["active context", "活跃上下文"],
  ["evidence bridge", "证据桥接"],
  ["concept convergence", "概念收敛"],
  ["raw evidence", "原始证据"],
  ["raw_text", "原始文本"],
  ["working memory", "工作记忆"],
  ["project context", "项目上下文"],
  ["char graph", "字图"],
  ["long-term memory", "长期记忆"],
  ["destructive action", "破坏性操作"],
  ["destructive", "破坏性操作"],
  ["profile_id", "用户档案标识"],
  ["top1", "第一名命中率"],
  ["review", "审查"],
  ["findings", "问题发现"],
  ["push", "推送"],
  ["GitHub push", "推送远端代码仓库"],
  ["GitHub", "远端代码仓库"],
  ["maintenance cycle", "维护周期"],
  ["recall", "召回"],
  ["cheerleading", "空泛鼓劲"],
  ["SQLite", "轻量数据库"],
  ["TypeScript", "脚本类型系统"],
  ["V7", "第七版"],
  ["state", "状态"],
  ["dreaming", "梦境整理"],
  ["care", "关怀状态"],
  ["alerts", "提醒"],
  ["decision", "决策"],
  ["todo", "待办"],
  ["preference", "偏好"],
  ["reflection", "反思"],
  ["vector", "向量"],
  ["Top1", "第一名"],
];

function localize(text: string): string {
  let result = text;
  for (const [from, to] of REPLACEMENTS) {
    result = result.split(from).join(to);
  }
  return result;
}

export type { BenchmarkMemory, BenchmarkQuery };

export const BENCHMARK_MEMORIES_ZH: BenchmarkMemory[] = BENCHMARK_MEMORIES.map((memory) => ({
  ...memory,
  summary: localize(memory.summary),
  keywords: localize(memory.keywords),
  rawText: localize(memory.rawText),
}));

export const BENCHMARK_QUERIES_ZH: BenchmarkQuery[] = BENCHMARK_QUERIES.map((query) => ({
  ...query,
  query: localize(query.query),
})).map((query) => {
  switch (query.id) {
    case 57:
      return { ...query, query: "沟通风格" };
    case 61:
      return { ...query, query: "统一入口" };
    case 68:
      return { ...query, query: "记忆评测最看重的指标" };
    case 69:
      return { ...query, query: "破坏性操作" };
    case 85:
      return { ...query, query: "当前工作默认允不允许直接推送远端代码仓库" };
    default:
      return query;
  }
});
