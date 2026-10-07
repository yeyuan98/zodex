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
  // skills→skill / mcpServers→mcp / plugins→plugin，kebab 惯例对齐 settings-*- 家族；
  // 未知未来类别按原名入 reason，绝不误标为 plugin（[ulw] NIT-4）。
  if (category === "skills") return "settings-sync-skill-import";
  if (category === "mcpServers") return "settings-sync-mcp-import";
  if (category === "plugins") return "settings-sync-plugin-import";
  return `settings-sync-${category}-import`;
}
