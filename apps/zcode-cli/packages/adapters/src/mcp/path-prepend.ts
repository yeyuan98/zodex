import { isAbsolute, join } from "node:path";

/**
 * specs/agent-runtimes.md §2.1/§2.5 L5（C1 pathPrepend）的纯函数实现：
 * 展开、校验、env 前插三件事同时服务两处消费方——
 * 1. `config/schema.ts` 的 mcpStdioServerSchema superRefine（层(1) CLI 配置装载腿）；
 * 2. `mcp/index.ts` createTransport（层(3) 传输防御腿 + L5 前插点）。
 * 保持纯函数 + 可注入 homeDir/separator，单测见 test/pathPrependEnv.test.ts。
 */

/** `~` → homeDir；`~/x` → join(homeDir, "x")；其余元素原样返回（不做绝对化）。 */
export function expandPathPrependElement(element: string, homeDir: string): string {
  if (element === "~") return homeDir;
  if (element.startsWith("~/")) return join(homeDir, element.slice(2));
  return element;
}

export type PathPrependValidation = { ok: true } | { ok: false; invalidElement: string };

/**
 * 绝对路径不变量（spec §2.2）：每个元素 `~` 展开后必须是绝对路径。
 * 判定用 node:path 的 isAbsolute（按当前平台语义；unix 主机不交叉校验 win 配置的
 * 盘符形态，反之亦然——跨平台配置以目标机器上的运行时校验为准）。
 */
export function validatePathPrepend(elements: string[], homeDir: string): PathPrependValidation {
  for (const element of elements) {
    const expanded = expandPathPrependElement(element, homeDir);
    if (!isAbsolute(expanded)) {
      return { ok: false, invalidElement: element };
    }
  }
  return { ok: true };
}

/**
 * 返回 NEW env：PATH = 展开后的元素按 pathSeparator 连接 + pathSeparator + 既有 PATH。
 * 不变量「pathPrepend 最优先」由调用点保证（必须在 `...config.env` spread 之后应用）。
 * 既有 PATH 键按大小写不敏感命中（win 形态 `Path`）；env 无 PATH 键时仍写入前插目录。
 * pathPrepend 为 undefined/空数组时 no-op（原样返回 env）。
 */
export function applyPathPrependToEnv(
  env: Record<string, string>,
  pathPrepend: string[] | undefined,
  opts: { homeDir: string; pathSeparator: string },
): Record<string, string> {
  if (!pathPrepend || pathPrepend.length === 0) {
    return env;
  }
  const joined = pathPrepend
    .map((element) => expandPathPrependElement(element, opts.homeDir))
    .join(opts.pathSeparator);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const existingPath = env[pathKey];
  return {
    ...env,
    [pathKey]: existingPath ? `${joined}${opts.pathSeparator}${existingPath}` : joined,
  };
}

/**
 * 传输防御腿（spec §2.2 层(3)）：spawn 前发现非绝对元素时仅令该 server 失败。
 * 该错误由 openServerConnection 的既有 per-server 失败路径捕获并归类为
 * `config_invalid`（不抛 -32602、不影响会话其余 server）。
 */
export class McpPathPrependInvalidError extends Error {
  constructor(readonly invalidElement: string) {
    super(
      `MCP server pathPrepend contains a non-absolute element after ~ expansion: ${invalidElement}`,
    );
    this.name = "McpPathPrependInvalidError";
  }
}
