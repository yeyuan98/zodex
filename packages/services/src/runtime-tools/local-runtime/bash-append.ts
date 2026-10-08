/**
 * specs/agent-runtimes.md §2.5（Bash 工具腿：app 级 host 侧追加）契约：app 运行时
 * 在场（CURRENT 有效 + bin 目录存在）→ 向 Bash env 追加（append，非前插）app 级
 * bin 目录 + 镜像缺省填空；缺席 → null（patch 不变）。W6 把本 seam 接进
 * `runtimeCommandEnv.ts` 的 `buildRuntimeProcessEnvPatch` 与 agent spawn 缝
 * （两段——app-bin 追加段与填空值——都在 agent spawn 缝重算，防池化陈旧）。
 *
 * 同步 IO 说明：默认 wiring（resolveAppRuntimeBashAppendFromDisk）为每调用同步
 * 读 CURRENT + runtime.json（§2.5「accessSync 同步 IO 先例」），保持纯函数可注入
 * 可单测（binDirExists/fs 访问器注入）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeMirrorEnvValues } from "@zcode/shared";
import { readCurrentPointer } from "./current.js";
import {
  readAppRuntimeJson,
  resolveAppRuntimeRootDir,
  resolveEffectiveDecisions,
} from "./runtime-json.js";
import type { LocalRuntimeDeps } from "./shared.js";

export interface AppRuntimeBashAppendInput {
  /** app 级运行时根（<config>/.runtime）。 */
  readonly root: string;
  readonly current: { readonly node: string | null; readonly uv: string | null };
  /** bin 目录存在性检查（注入 fs，保持纯函数可测）。 */
  readonly binDirExists: (dir: string) => boolean;
  /** effective decision（§4.7 override ?? probed）的填空投影。 */
  readonly decisions: {
    readonly npmRegistry?: string;
    readonly pypiIndex?: string;
    readonly pbsMirror?: string;
  };
  readonly platform?: NodeJS.Platform;
}

export interface AppRuntimeBashAppendResult {
  /** 追加到 PATH 尾部的 app 级 bin 目录（追加语义，与 MCP 腿前插区分）。 */
  readonly pathAppend: readonly string[];
  /** 镜像缺省填空键（大小写不敏感存在性；键已存在不覆盖）。 */
  readonly envFill: Readonly<Record<string, string>>;
}

/** 版本化 bin 目录：win 平铺；unix 取 `bin/` 子目录（红测契约）。 */
function resolveBashAppendBinDir(
  root: string,
  kind: "node" | "uv",
  version: string,
  platform: NodeJS.Platform,
): string {
  const versionDir = join(root, kind, version);
  return platform === "win32" ? versionDir : join(versionDir, "bin");
}

function hasEnvKeyCaseInsensitive(env: NodeJS.ProcessEnv, key: string): boolean {
  const lowerKey = key.toLowerCase();
  return Object.keys(env).some((candidate) => candidate.toLowerCase() === lowerKey);
}

export function buildAppRuntimeBashAppend(
  baseEnv: NodeJS.ProcessEnv,
  input: AppRuntimeBashAppendInput,
): AppRuntimeBashAppendResult | null {
  const platform = input.platform ?? process.platform;
  // 在场判定（红测契约）：CURRENT 有效且 bin 目录存在才贡献追加段；
  // 悬空/半装（bin 不存在）= 运行时不在场，不得追加幽灵路径。
  const pathAppend: string[] = [];
  for (const kind of ["node", "uv"] as const) {
    const version = input.current[kind];
    if (!version) continue;
    const binDir = resolveBashAppendBinDir(input.root, kind, version, platform);
    if (!input.binDirExists(binDir)) continue;
    pathAppend.push(binDir);
  }
  if (pathAppend.length === 0) {
    return null;
  }
  // 填空与运行时在场性独立（红测契约 3：运行时在场即有追加段，与填空键是否已存在无关）。
  const envFill: Record<string, string> = {};
  const decision = input.decisions;
  for (const [artifactClass, envKey] of [
    ["npmRegistry", "npm_config_registry"],
    ["pypiIndex", "UV_DEFAULT_INDEX"],
    ["pbsMirror", "UV_PYTHON_INSTALL_MIRROR"],
  ] as const) {
    const value = decision[artifactClass];
    if (value === undefined) continue;
    if (hasEnvKeyCaseInsensitive(baseEnv, envKey)) continue;
    envFill[envKey] = value;
  }
  return { pathAppend, envFill };
}

/**
 * 默认 wiring：从磁盘解析（<config>/.runtime 与 A2′ 写入同源：getDataBaseDir/
 * ZCODE_DATA_BASE_DIR），CURRENT/runtime.json 读端容错（缺失/损坏 = 缺席）。
 */
export function resolveAppRuntimeBashAppendFromDisk(
  baseEnv: NodeJS.ProcessEnv,
  deps: Pick<LocalRuntimeDeps, "runtimeRootDir" | "platform"> = {},
): AppRuntimeBashAppendResult | null {
  const root = deps.runtimeRootDir ?? resolveAppRuntimeRootDir();
  const platform = deps.platform ?? process.platform;
  const json = readAppRuntimeJson(join(root, "runtime.json"));
  const effective = json ? resolveEffectiveDecisions(json) : null;
  const decision = effective
    ? resolveRuntimeMirrorEnvValues({
        npmRegistry: effective.npmRegistry,
        pypiIndex: effective.pypiIndex,
        pbsMirror: effective.pbsMirror,
      })
    : {};
  return buildAppRuntimeBashAppend(baseEnv, {
    root,
    current: {
      node: readCurrentPointer(join(root, "node")),
      uv: readCurrentPointer(join(root, "uv")),
    },
    binDirExists: (dir) => existsSync(dir),
    decisions: decision,
    platform,
  });
}

/**
 * agent spawn 缝合并辅助：把追加段并进既有 env——PATH 追加到尾部（大小写不敏感
 * 命中既有键），envFill 直接展开（存在性检查已在 buildAppRuntimeBashAppend 内按
 * 传入 baseEnv 完成）。结果供 spawn env spread 使用。
 */
export function mergeAppRuntimeBashAppendIntoEnv(
  env: Record<string, string>,
  append: AppRuntimeBashAppendResult,
  options: { readonly platform?: NodeJS.Platform } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const next = { ...env, ...append.envFill };
  if (append.pathAppend.length === 0) {
    return next;
  }
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = next[pathKey] ?? "";
  const existingEntries = currentPath.split(pathDelimiter).filter(Boolean);
  const appended = append.pathAppend.filter((entry) => !existingEntries.includes(entry));
  if (appended.length === 0) {
    return next;
  }
  next[pathKey] = currentPath
    ? `${currentPath}${pathDelimiter}${appended.join(pathDelimiter)}`
    : appended.join(pathDelimiter);
  return next;
}
