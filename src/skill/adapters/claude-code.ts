export function generateHookConfig(mcpServerCommand: string): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [
        { matcher: "", command: `${mcpServerCommand} session-start` },
      ],
      UserPromptSubmit: [
        { matcher: "", command: `${mcpServerCommand} prefetch` },
      ],
      PreCompact: [
        { matcher: "", command: `${mcpServerCommand} pre-compact` },
      ],
      Stop: [
        { matcher: "", command: `${mcpServerCommand} session-stop` },
      ],
    },
  };
}

export function generateAgentsMdAppendix(): string {
  return `
## Memory

This project uses AgentMemory for persistent cross-session memory.

- Session start: memory is automatically loaded
- During work: relevant context is silently prefetched
- Before compaction: new memories are automatically saved
- Manual recall: use /memory-recall to search past sessions
`;
}
