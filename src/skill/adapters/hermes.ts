// Hermes adapter — generates YAML config snippet and system prompt appendix.
// Hermes uses ~/.hermes/config.yaml for toolset/MCP registration,
// and SOUL.md for persistent system instructions.

export function generateYamlConfig(mcpServerCommand: string): string {
  // Hermes config.yaml uses toolsets list and/or mcp_servers map.
  // AgentMemory registers as an MCP server.
  const [command, ...args] = mcpServerCommand.split(/\s+/);
  return `
# AgentMemory MCP server — persistent cross-session memory
# Add to ~/.hermes/config.yaml

mcp_servers:
  agentmemory:
    command: "${command}"
    args: [${args.map((a) => `"${a}"`).join(", ")}]
    env:
      AGENTMEMORY_PROJECT: "\${AGENTMEMORY_PROJECT}"
      AGENTMEMORY_API_KEY: "\${AGENTMEMORY_API_KEY}"
      AGENTMEMORY_EMBEDDING_URL: "\${AGENTMEMORY_EMBEDDING_URL}"
`;
}

export function generateSoulMdAppendix(): string {
  return `
## Memory

You have access to AgentMemory for persistent cross-session memory via MCP tools.

Tools available:
- \`memory_recall\` — Load relevant context at session start (call with projectId + workspaceDir)
- \`memory_remember\` — Store important decisions, bug fixes, or insights
- \`memory_search\` — Search past sessions for specific information
- \`memory_get\` — Read a specific memory fragment and its linked context
- \`memory_bootstrap\` — First-run import of existing memory files

**At session start**, call \`memory_recall\` to load relevant context for the current task.
**After important decisions, bug fixes, or discoveries**, call \`memory_remember\` to persist the insight.
If \`memory_recall\` returns useful information, naturally reference it in your response without explicitly mentioning the tool.
`;
}

export function generateHeartbeatReminder(roundsSinceLastCall: number): string | null {
  if (roundsSinceLastCall < 10) return null;
  if (roundsSinceLastCall >= 20) {
    return "[Memory] ⚠️ 已超过 20 轮未调用 memory_recall，建议立即搜索相关上下文。";
  }
  return "[Memory] 本轮尚未调用 memory_recall，如有需要请立即调用。";
}
