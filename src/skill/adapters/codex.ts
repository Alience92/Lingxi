// Codex CLI adapter — generates TOML config snippet and CODEX.md appendix.
// Codex uses ~/.codex/config.toml for MCP server registration and
// CODEX.md (project-level) or CODEX.md (global) for system instructions.

export function generateTomlConfig(mcpServerCommand: string): string {
  // Codex CLI MCP servers are configured in ~/.codex/config.toml
  // under [mcp_servers.<name>] sections.
  // The command should be "node" with args pointing to the MCP server entry.
  const [command, ...args] = mcpServerCommand.split(/\s+/);
  return `
# AgentMemory MCP server — persistent cross-session memory
# Add this to ~/.codex/config.toml

[mcp_servers.agentmemory]
command = "${command}"
args = [${args.map((a) => `"${a}"`).join(", ")}]
`;
}

export function generateCodexMdAppendix(): string {
  return `
## Memory

This project uses AgentMemory for persistent cross-session memory via MCP.

**At session start**, call \`memory_recall\` to load relevant context:
\`\`\`
memory_recall(projectId="<project>", workspaceDir="<path>")
\`\`\`

**After important decisions or bug fixes**, call \`memory_remember\`:
\`\`\`
memory_remember(transcript="<summary>", sessionId="<id>", projectId="<project>")
\`\`\`

**Periodically**, call \`memory_search\` with specific queries to find past context.
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
