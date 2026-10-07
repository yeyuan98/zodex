// `.agents/mcp.json` 运行时腿装载（specs/agent-runtimes.md §5.1-§5.3，alpha.1）。
//
// 根因（handoff §2m）：CLI 运行时（spawn MCP server 的进程）从不读 `.agents/mcp.json`——
// workspace 发现候选硬编码 zcode.json/.zcode/config.json、user 默认 ~/.zcode/cli——而
// alpha.0 的 bundled skills 教了「两腿等价」，导致按技能写 `.agents` 的 server 完全缺席。
// 修复依据 = spec §5.1 四源逐名合并 + skills/roots.ts merge-not-fallback 先例。
//
// §5.3 接缝钉死：`.agents/mcp.json` 的发现是 **MCP 专用平行发现**（祖先向上到 worktree
// 根，与 `.zcode` 项目发现同广度——广度不对称 vs desktop 是已披露残留 §5.5(f)），
// 绝不经由/进入 buildWorkspaceHookCandidatePaths / WorkspaceHookConfigFileKind /
// projectSummary.hookCandidates / hook bundle snapshot/digest——否则加一个
// `.agents/mcp.json` 就会改变 bundleDigest、既有 workspace 信任记录全部失效。

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@zcode/contracts";
import { parseMcpServerEntriesWithDiagnostics, type ConfigDiagnostic } from "./schema.js";

export interface LoadedAgentsMcpConfig {
  config: RuntimeConfigPatch;
  diagnostics: ConfigDiagnostic[];
  path: string;
  loaded: boolean;
}

const AGENTS_MCP_FILE_NAME = "mcp.json";
const AGENTS_DIR_NAME = ".agents";
const AGENTS_MCP_SERVERS_KEY = "mcpServers";

export function getUserAgentsMcpConfigPath(): string {
  return join(homedir(), AGENTS_DIR_NAME, AGENTS_MCP_FILE_NAME);
}

/**
 * MCP 专用平行发现：镜像 shared `getProjectConfigDirectories` 的祖先向上遍历
 * （worktree 根 → 当前目录），返回存在的 `.agents/mcp.json` 列表（根在前、深目录在后，
 * 与 `.zcode` 发现同序）。见文件头 §5.3 注记——本函数不得并入 hook 发现链。
 */
export function discoverAgentsMcpConfigPaths(input: { workingDirectory: string }): string[] {
  return getAgentsDiscoveryDirectories(resolve(input.workingDirectory))
    .map((directory) => join(directory, AGENTS_DIR_NAME, AGENTS_MCP_FILE_NAME))
    .filter((path) => existsSync(path));
}

/**
 * 装载单个 `.agents/mcp.json`：`mcpServers` 条目与 `.zcode` 条目走同一
 * `mcpStdioServerSchema` strict 解析（§5.2）——坏条目逐 server 丢弃 + warning 诊断
 * （filePath 归属本文件），其余条目照常装载。仅产出 `mcp.servers`，不参与
 * hooks/plugins/ui 等其它配置字段。
 */
export function loadAgentsMcpConfigFile(
  filePath: string,
  options: { normalizeProjectCwd?: boolean } = {},
): LoadedAgentsMcpConfig {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return { config: {}, diagnostics: [], path: resolvedPath, loaded: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf-8"));
  } catch (error) {
    return {
      config: {},
      diagnostics: [
        {
          code: "config_file_invalid",
          filePath: resolvedPath,
          message: error instanceof Error ? error.message : "Unable to parse config file.",
          severity: "error",
        },
      ],
      path: resolvedPath,
      loaded: false,
    };
  }

  if (!isRecord(parsed)) {
    return {
      config: {},
      diagnostics: [
        {
          code: "config_file_invalid",
          filePath: resolvedPath,
          message: "Config file must contain a JSON object.",
          severity: "error",
        },
      ],
      path: resolvedPath,
      loaded: false,
    };
  }

  const servers = parsed[AGENTS_MCP_SERVERS_KEY];
  if (servers === undefined) {
    return { config: {}, diagnostics: [], path: resolvedPath, loaded: true };
  }

  if (!isRecord(servers)) {
    return {
      config: { mcp: { servers: {} } },
      diagnostics: [
        {
          code: "config_mcp_server_invalid",
          filePath: resolvedPath,
          message: `${AGENTS_MCP_SERVERS_KEY} must be a JSON object; ignoring all MCP servers.`,
          path: AGENTS_MCP_SERVERS_KEY,
          severity: "warning",
        },
      ],
      path: resolvedPath,
      loaded: true,
    };
  }

  const parsedServers = parseMcpServerEntriesWithDiagnostics(servers, AGENTS_MCP_SERVERS_KEY);
  const baseDir = options.normalizeProjectCwd ? resolveAgentsMcpBaseDir(resolvedPath) : undefined;
  const serversOut: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(parsedServers.servers)) {
    serversOut[name] = baseDir ? normalizeAgentsMcpServerCwd(server, baseDir) : server;
  }

  return {
    config: { mcp: { servers: serversOut } },
    diagnostics: parsedServers.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      filePath: diagnostic.filePath ?? resolvedPath,
    })),
    path: resolvedPath,
    loaded: true,
  };
}

/**
 * 合并同一 scope 的多个 `.agents/mcp.json`（根在前、深目录在后）：深目录逐名遮蔽
 * 根目录，与 `.zcode` 项目文件「既有顺序 = 后者胜」一致。诊断按文件原序拼接。
 */
export function mergeAgentsMcpConfigFiles(files: readonly LoadedAgentsMcpConfig[]): {
  config: RuntimeConfigPatch;
  diagnostics: ConfigDiagnostic[];
} {
  const servers: Record<string, McpServerConfig> = {};
  const diagnostics: ConfigDiagnostic[] = [];
  for (const file of files) {
    diagnostics.push(...file.diagnostics);
    for (const [name, server] of Object.entries(file.config.mcp?.servers ?? {})) {
      servers[name] = server;
    }
  }
  return {
    config: Object.keys(servers).length > 0 ? { mcp: { servers } } : {},
    diagnostics,
  };
}

// 镜像 shared workspace-hook-config 的 getProjectConfigDirectories：从 start 向上走到
// worktree 根（.git 目录或文件标记），返回 [根, ..., start]；无标记时仅 [start]。
// 不能复用 shared 私有实现，此处按同一语义镜像（候选广度与 `.zcode` 发现一致）。
function getAgentsDiscoveryDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (hasWorktreeMarker(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

function hasWorktreeMarker(directory: string): boolean {
  const marker = join(directory, ".git");
  try {
    if (!existsSync(marker)) return false;
    const stats = statSync(marker);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

// `.agents/mcp.json` 的相对 cwd 以包含 `.agents` 的目录为基准（对齐 `.zcode/config.json`
// 的 baseDir 语义：剥掉配置目录段，落在 workspace 根）。
function resolveAgentsMcpBaseDir(filePath: string): string {
  const configDirectory = dirname(filePath);
  return basename(configDirectory) === AGENTS_DIR_NAME ? dirname(configDirectory) : configDirectory;
}

function normalizeAgentsMcpServerCwd(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;
  const cwd = server.cwd ?? ".";
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
