// specs/draft-session-invalidation.md §3：settings-sync 导入的类别若改变 agent
// 运行时能力（技能/MCP/插件），必须失效 pending draft session。commands/providers
// 等其余类别不影响运行时能力，不失效（多余失效 = 一次廉价重建，但会打断预热，能省则省）。
const DRAFT_INVALIDATING_CATEGORIES = new Set(["skills", "mcpServers", "plugins"]);

export function settingsSyncImportInvalidatesDraft(categories: Iterable<string>): boolean {
  for (const category of categories) {
    if (DRAFT_INVALIDATING_CATEGORIES.has(category)) return true;
  }
  return false;
}

export function settingsSyncDraftInvalidationReason(category: string): string {
  // skills→skill / mcpServers→mcp / plugins→plugin，kebab 惯例对齐 settings-*- 家族。
  const noun = category === "skills" ? "skill" : category === "mcpServers" ? "mcp" : "plugin";
  return `settings-sync-${noun}-import`;
}
