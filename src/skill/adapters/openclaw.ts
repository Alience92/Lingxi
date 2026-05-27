// OpenClaw adapter — generates JSON config snippet and AGENTS.md appendix.
// OpenClaw uses ~/.openclaw/openclaw.json for MCP server registration,
// and supports AGENTS.md for project-level system instructions.

export function generateMcpConfig(mcpServerCommand: string): Record<string, unknown> {
  const [command, ...args] = mcpServerCommand.split(/\s+/);
  return {
    agentmemory: {
      command,
      args,
      env: {
        AGENTMEMORY_PROJECT: "${AGENTMEMORY_PROJECT}",
        AGENTMEMORY_API_KEY: "${AGENTMEMORY_API_KEY}",
        AGENTMEMORY_EMBEDDING_URL: "${AGENTMEMORY_EMBEDDING_URL}",
      },
    },
  };
}

export function generateAgentsMdAppendix(): string {
  return `
## Memory

This project uses AgentMemory for persistent cross-session memory via MCP.

Tools available:
- \`memory_recall\` — Load relevant context at session start (call with projectId + workspaceDir)
- \`memory_remember\` — Store important decisions, bug fixes, or insights
- \`memory_search\` — Search past sessions for specific information
- \`memory_get\` — Read a specific memory fragment and its linked context
- \`memory_bootstrap\` — First-run import of existing memory files

**At session start**, call \`memory_recall\` to load context.
**After important work**, call \`memory_remember\` to persist insights.
If \`memory_recall\` returns useful information, naturally reference it in your response.
`;
}

export function generateHeartbeatReminder(roundsSinceLastCall: number): string | null {
  if (roundsSinceLastCall < 10) return null;
  if (roundsSinceLastCall >= 20) {
    return "[Memory] ⚠️ 已超过 20 轮未调用 memory_recall，建议立即搜索相关上下文。";
  }
  return "[Memory] 本轮尚未调用 memory_recall，如有需要请立即调用。";
}
