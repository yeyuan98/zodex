/**
 * specs/agent-runtimes.md §2.5 L3（C3 app 级前插 + 镜像缺省填空）的纯函数契约：
 * W6 在 createTransport 调用点（buildMcpStdioEnv 输出之后、...config.env spread
 * 之前）接线；本文件只承载可单测的纯函数（<config> 根解析 / CURRENT 读取 /
 * PATH 前插 / 镜像填空）。<config> 解析与 services `paths.ts` 同源
 * （env.ZCODE_DATA_BASE_DIR ?? homedir），adapters 不 import services。
 *
 * TODO(W6)：当前为 W1 红测桩——零行为（返回空值/原样 env），仅锁定签名与语义。
 */

export type AppRuntimeKind = "node" | "uv";

/** 镜像缺省填空相关的 effective decision（§4.7 override ?? probed 的投影）。 */
export interface AppRuntimeMirrorDecision {
  readonly npmRegistry?: string;
  readonly pypiIndex?: string;
  readonly pbsMirror?: string;
}

/**
 * app 级运行时根目录 = base + `.zcode/.runtime`；base = env.ZCODE_DATA_BASE_DIR
 * （优先，desktop 在 dataBaseDir ≠ homedir 时注入）?? homedir（fallback 必须保留）。
 */
export function resolveAppRuntimeRoot(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  // TODO(W6)
  void env;
  void homeDir;
  return "";
}

/**
 * 读 `<root>/<kind>/CURRENT`（纯文本指针，内容 = 版本目录名）。读端容错（§4.3）：
 * 缺失/垃圾/悬空（指向已 GC 目录）→ null；**禁止**回退扫描最高 `v<ver>` 目录。
 */
export function readAppRuntimeCurrent(root: string, kind: AppRuntimeKind): string | null {
  // TODO(W6)
  void root;
  void kind;
  return null;
}

/**
 * 把 app 级版本化 bin 目录按序前插到 env PATH 最左（L3 语义；大小写不敏感命中
 * 既有 PATH 键，win 形态 `Path`）。binDirs 为空 → 原样返回 env（L3 缺席）。
 */
export function applyAppRuntimePrependToEnv(
  env: Record<string, string>,
  binDirs: readonly string[],
  options?: { readonly platform?: NodeJS.Platform; readonly pathDelimiter?: string },
): Record<string, string> {
  // TODO(W6)
  void binDirs;
  void options;
  return env;
}

/**
 * 镜像缺省填空：按 effective decision 填 `npm_config_registry`（小写优先，§4.4）/
 * `UV_DEFAULT_INDEX` / `UV_PYTHON_INSTALL_MIRROR`。存在性检查在传入 env 上**大小写
 * 不敏感**进行（win `NPM_CONFIG_REGISTRY`）；键已存在不覆盖；config.env 胜出由调用
 * 点 L4 spread 顺序结构性达成。
 */
export function applyMirrorEnvDefaults(
  env: Record<string, string>,
  decision: AppRuntimeMirrorDecision,
): Record<string, string> {
  // TODO(W6)
  void decision;
  return env;
}
