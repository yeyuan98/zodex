/**
 * specs/agent-runtimes.md §2.5 L3（C3 app 级前插 + 镜像缺省填空）实现：
 * 纯函数（<config> 根解析 / CURRENT 读取 / PATH 前插 / 镜像填空）+ createTransport
 * 调用点编排（buildMcpStdioEnv 输出之后、...config.env spread 之前）。
 * <config> 解析与 services `paths.ts` 同源（env.ZCODE_DATA_BASE_DIR ?? homedir），
 * adapters 不 import services。
 *
 * 同步 IO 说明：每次 spawn 同步读 CURRENT + runtime.json、不跨 spawn 缓存
 * （§2.5「accessSync 同步 IO 先例」——镜像切换/换版后下一次 spawn 生效）。
 * fs 访问经 options 注入（prependRunningNodeDirectory 的 option-injection 形制）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { resolveRuntimeMirrorEnvValues } from "@zcode/shared";

export type AppRuntimeKind = "node" | "uv";

/** 镜像缺省填空相关的 effective decision（§4.7 override ?? probed 的投影）。 */
export interface AppRuntimeMirrorDecision {
  readonly npmRegistry?: string;
  readonly pypiIndex?: string;
  readonly pbsMirror?: string;
}

/** 可注入的同步 fs 访问器（测试用；默认 node:fs 真实实现）。 */
export interface AppRuntimeFsAccessor {
  readonly readTextFile: (path: string) => string;
  readonly statDirectory: (path: string) => boolean;
  readonly exists: (path: string) => boolean;
}

const DEFAULT_APP_RUNTIME_FS_ACCESSOR: AppRuntimeFsAccessor = {
  readTextFile: (path) => readFileSync(path, "utf8"),
  statDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  exists: (path) => existsSync(path),
};

/** 与 services local-runtime current.ts 同形的版本目录名形态（node v22.14.0 / uv 0.8.6）。 */
const APP_RUNTIME_VERSION_DIR_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u;

/**
 * app 级运行时根目录 = base + `.zcode/.runtime`；base = env.ZCODE_DATA_BASE_DIR
 * （优先，desktop 在 dataBaseDir ≠ homedir 时注入）?? homedir（fallback 必须保留）。
 */
export function resolveAppRuntimeRoot(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || homeDir;
  return join(base, ".zcode", ".runtime");
}

/**
 * 读 `<root>/<kind>/CURRENT`（纯文本指针，内容 = 版本目录名）。读端容错（§4.3）：
 * 缺失/垃圾/悬空（指向已 GC 目录）→ null；**禁止**回退扫描最高 `v<ver>` 目录。
 */
export function readAppRuntimeCurrent(
  root: string,
  kind: AppRuntimeKind,
  options?: { readonly fs?: AppRuntimeFsAccessor },
): string | null {
  const fs = options?.fs ?? DEFAULT_APP_RUNTIME_FS_ACCESSOR;
  const kindDir = join(root, kind);
  let raw: string;
  try {
    raw = fs.readTextFile(join(kindDir, "CURRENT"));
  } catch {
    return null;
  }
  const dirName = raw.trim();
  if (!dirName || !APP_RUNTIME_VERSION_DIR_PATTERN.test(dirName)) {
    return null;
  }
  // 悬空指针（指向已 GC 目录）→ 视为缺席，不猜、不扫目录回退。
  return fs.statDirectory(join(kindDir, dirName)) ? dirName : null;
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
  if (binDirs.length === 0) {
    return env;
  }
  const platform = options?.platform ?? process.platform;
  const pathDelimiter = options?.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const prependEntries = binDirs.filter(Boolean);
  if (prependEntries.length === 0) {
    return env;
  }
  const prepended = prependEntries.join(pathDelimiter);
  return {
    ...env,
    [pathKey]: currentPath ? `${prepended}${pathDelimiter}${currentPath}` : prepended,
  };
}

function hasEnvKeyCaseInsensitive(env: Readonly<Record<string, string>>, key: string): boolean {
  const lowerKey = key.toLowerCase();
  return Object.keys(env).some((candidate) => candidate.toLowerCase() === lowerKey);
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
  const next = { ...env };
  for (const [artifactClass, envKey] of [
    ["npmRegistry", "npm_config_registry"],
    ["pypiIndex", "UV_DEFAULT_INDEX"],
    ["pbsMirror", "UV_PYTHON_INSTALL_MIRROR"],
  ] as const) {
    const value = decision[artifactClass];
    if (value === undefined) continue;
    if (hasEnvKeyCaseInsensitive(next, envKey)) continue;
    next[envKey] = value;
  }
  return next;
}

/** 版本化 bin 目录：win 平铺（node.exe/uv.exe 直接在版本目录）；unix 取 `bin/` 子目录。 */
export function resolveAppRuntimeBinDir(
  root: string,
  kind: AppRuntimeKind,
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const versionDir = join(root, kind, version);
  return platform === "win32" ? versionDir : join(versionDir, "bin");
}

interface AppRuntimeJsonShape {
  readonly decisions?: Record<string, unknown>;
  readonly overrides?: Record<string, unknown>;
}

function readEffectiveMirrorDecisionIds(
  root: string,
  fs: AppRuntimeFsAccessor,
): { decision: AppRuntimeMirrorDecision; filePresent: boolean; parseFailed: boolean } {
  const empty = { decision: {}, filePresent: false, parseFailed: false };
  let raw: string;
  try {
    raw = fs.readTextFile(join(root, "runtime.json"));
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decision: {}, filePresent: true, parseFailed: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { decision: {}, filePresent: true, parseFailed: true };
  }
  const shape = parsed as AppRuntimeJsonShape;
  // effective decision = override ?? probed（§4.7），只投影三个填空键。
  const project = (artifactClass: "npmRegistry" | "pypiIndex" | "pbsMirror") => {
    const override = shape.overrides?.[artifactClass];
    if (typeof override === "string" && override.trim()) return override.trim();
    const probed = shape.decisions?.[artifactClass];
    if (typeof probed === "string" && probed.trim()) return probed.trim();
    return undefined;
  };
  const npmRegistry = project("npmRegistry");
  const pypiIndex = project("pypiIndex");
  const pbsMirror = project("pbsMirror");
  return {
    decision: {
      ...(npmRegistry !== undefined ? { npmRegistry } : {}),
      ...(pypiIndex !== undefined ? { pypiIndex } : {}),
      ...(pbsMirror !== undefined ? { pbsMirror } : {}),
    },
    filePresent: true,
    parseFailed: false,
  };
}

/** L3 编排用的最小 warn 通道（形制沿 mcp/index.ts 的 this.logger.warn）。 */
export interface AppRuntimeLayerLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface AppRuntimeLayerOptions {
  /** `<config>` 解析基准 env（默认 process.env）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly logger?: AppRuntimeLayerLogger;
  readonly fs?: AppRuntimeFsAccessor;
}

/**
 * L3 编排（createTransport 调用点）：L2 输出之上应用 app 级 bin 前插 + 镜像缺省
 * 填空。读端全部容错（§4.3/§4.7）：CURRENT 缺失 = 未安装（无前插，不 warn）；
 * CURRENT 在场但垃圾/悬空 = warn + 缺席（禁止目录扫描回退）；runtime.json 损坏 =
 * 不填空 + warn。返回新 env（L4 spread 仍由调用点在其后进行）。
 */
export function applyAppRuntimeLayerToEnv(
  l2Env: Record<string, string>,
  options: AppRuntimeLayerOptions = {},
): Record<string, string> {
  const fs = options.fs ?? DEFAULT_APP_RUNTIME_FS_ACCESSOR;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const root = resolveAppRuntimeRoot(env, options.homeDir ?? "");

  const binDirs: string[] = [];
  for (const kind of ["node", "uv"] as const) {
    const current = readAppRuntimeCurrent(root, kind, { fs });
    if (current === null) {
      // CURRENT 文件在场但不可用（垃圾/悬空）才 warn；整体缺失 = 未安装，静默缺席。
      if (fs.exists(join(root, kind, "CURRENT"))) {
        options.logger?.warn("app runtime CURRENT present but invalid; L3 absent for kind", {
          kind,
          root,
        });
      }
      continue;
    }
    binDirs.push(resolveAppRuntimeBinDir(root, kind, current, platform));
  }

  const mirror = readEffectiveMirrorDecisionIds(root, fs);
  if (mirror.parseFailed) {
    options.logger?.warn("app runtime runtime.json unreadable; mirror defaults absent", { root });
  }

  return applyMirrorEnvDefaults(applyAppRuntimePrependToEnv(l2Env, binDirs, { platform }), {
    ...resolveRuntimeMirrorEnvValues(mirror.decision),
  });
}
