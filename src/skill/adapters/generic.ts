export function generateSystemPromptAppendix(): string {
  return `## Memory

每次对话开始前调用 memory_recall 获取相关上下文。
每次重要决策后调用 memory_remember(decision, context) 记录。
Bug 修复后调用 memory_remember(bug, fix, root_cause) 记录。
如果 memory_recall 返回了有用信息，请在回复中自然地引用它。`;
}

export function generateHeartbeatReminder(roundsSinceLastCall: number): string | null {
  if (roundsSinceLastCall < 10) return null;
  if (roundsSinceLastCall >= 20) {
    return "[Memory] ⚠️ 已超过 20 轮未调用 memory_recall，建议立即搜索相关上下文。";
  }
  return "[Memory] 本轮尚未调用 memory_recall，如有需要请立即调用。";
}

export function generateReinforcementMessage(
  recentRecalls: Array<{ query: string; resultCount: number; timestamp: number }>
): string | null {
  if (recentRecalls.length === 0) return null;
  const recentCount = recentRecalls.filter(
    (r) => r.resultCount > 0 && Date.now() - r.timestamp < 3600000
  ).length;
  if (recentCount >= 3) {
    return `最近 ${recentCount} 次 memory_recall 都找到了相关记忆。请继续保持这个习惯。`;
  }
  return null;
}
