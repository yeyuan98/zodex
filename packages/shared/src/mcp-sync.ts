import type { McpServerConfig } from "./mcp.js";

export type McpSyncImportStatus = "synced" | "skipped" | "failed";
export type McpSyncSource = "zcode" | "agents";

export interface McpSyncCandidate {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

export interface McpSyncCandidateListResult {
  candidates: McpSyncCandidate[];
  localHomeDir: string;
}

export interface McpSyncRemoteStatus {
  name: string;
  exists: boolean;
  path?: string;
}

export interface McpSyncRemoteStatusResult {
  statuses: McpSyncRemoteStatus[];
  remoteHomeDir: string;
}

export interface McpSyncExportedServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

export interface McpSyncExportResult {
  servers: McpSyncExportedServer[];
  localHomeDir: string;
}

export interface McpSyncImportResultItem {
  name: string;
  status: McpSyncImportStatus;
  path?: string;
  error?: string;
}

export interface McpSyncImportResult {
  results: McpSyncImportResultItem[];
}

/**
 * specs/agent-runtimes.md §5.4（alpha.1）desktop 显示三位点共享纯函数：
 * 同 scope 双文件腿从「文件级 fallback（`.zcode` 非空 → 整个 `.agents` 被遮蔽）」收窄为
 * **逐名合并**——`.zcode` 腿按精确 server 名胜出，`.agents` 独有名保持可见。
 * services `mcp-sync` 与 desktop main `mcpUserDirectory` 孪生必须共同调用本 helper，
 * 禁止再各自复制粘贴（孪生分叉正是本 bug 类成因，[ulw] m3）。纯函数、无 IO：
 * 只吃两个已读取结果，合并顺序 = `.zcode` 条目在前、`.agents` 独有条目追加在后。
 */
export function mergeDirectoryMcpRecordsByName<T extends { name: string }>(input: {
  zcodeServers: readonly T[];
  agentsServers: readonly T[];
}): T[] {
  const merged: T[] = [];
  const seenNames = new Set<string>();
  for (const record of input.zcodeServers) {
    merged.push(record);
    seenNames.add(record.name);
  }
  for (const record of input.agentsServers) {
    if (seenNames.has(record.name)) continue;
    merged.push(record);
    seenNames.add(record.name);
  }
  return merged;
}
