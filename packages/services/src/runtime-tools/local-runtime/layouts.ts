/**
 * specs/agent-runtimes.md §4.3（解压归一化布局矩阵）A2′ TS 实现：
 * 归档成员 → `v<ver>/` 目标路径的纯映射 + 解压工具选择 + 解压执行器
 * （系统 tar，execFile 数组参数——跨平台规则禁 shell 字符串拼接）。
 *
 * 布局矩阵：node win `.zip` 与 unix `.tar.xz` 均含 `node-v<ver>-<os>-<arch>/`
 * 顶层需剥离；uv win `.zip` 平铺、unix `uv-<triple>/` 顶层剥离；Windows 用系统
 * 自带 tar.exe（bsdtar，Win10+）解 `.zip`/`.tar.xz`。
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RuntimeArchiveKind = "node-unix-tar" | "node-win-zip" | "uv-unix-tar" | "uv-win-zip";

/** 归档形态描述：kind 决定顶层剥离语义（uv-win-zip 平铺）。 */
export interface ArchiveLayoutSpec {
  readonly kind: RuntimeArchiveKind;
  readonly topLevelDir: string;
  readonly stripComponents: number;
}

/** 平台/工件 → 归档布局（解压编排侧的输入构造）。 */
export function resolveArchiveLayout(options: {
  readonly kind: "node" | "uv";
  readonly platform: NodeJS.Platform;
  readonly archiveFileName: string;
  readonly topLevelDir: string;
}): ArchiveLayoutSpec {
  const isWindows = options.platform === "win32";
  if (options.kind === "node") {
    return {
      kind: isWindows ? "node-win-zip" : "node-unix-tar",
      topLevelDir: options.topLevelDir,
      stripComponents: 1,
    };
  }
  return {
    kind: isWindows ? "uv-win-zip" : "uv-unix-tar",
    // uv win zip 平铺（无顶层目录可剥）；unix tarball 剥 uv-<triple>/ 顶层。
    topLevelDir: isWindows ? "" : options.topLevelDir,
    stripComponents: isWindows ? 0 : 1,
  };
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes("\0")) return false;
  if (isAbsolute(relativePath)) return false;
  return relativePath.split(/[\\/]/u).every((segment) => segment !== "..");
}

/**
 * 归一化映射：归档成员路径 → 版本目录（`v<ver>/`）内目标相对路径。
 * topLevelDir = 预期顶层目录名（uv win 平铺 = ""）；成员不在 topLevelDir 下 → null。
 */
export function mapArchiveMemberToTargetPath(options: {
  readonly kind: RuntimeArchiveKind;
  readonly memberPath: string;
  readonly topLevelDir: string;
}): string | null {
  const normalized = options.memberPath.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (options.topLevelDir === "") {
    return isSafeRelativePath(normalized) ? normalized : null;
  }
  const prefix = `${options.topLevelDir}/`;
  if (!normalized.startsWith(prefix)) return null;
  const rest = normalized.slice(prefix.length);
  if (!isSafeRelativePath(rest)) return null;
  return rest;
}

/**
 * 解压工具选择：win 平台 `.zip`/`.tar.xz` 均 = 系统 tar.exe（bsdtar 兼容）；
 * unix = tar（.tar.xz/.tar.gz）。工件按平台构造（win 下 zip、unix 下 tar 系），
 * 工具只随平台分叉，避免扩展名矩阵漂移。
 */
export function resolveExtractionTool(archiveFileName: string, platform: NodeJS.Platform): string {
  void archiveFileName;
  return platform === "win32" ? "tar.exe" : "tar";
}

/** 解压失败（工具退出非零/产物为空/搬移失败）的明确报错。 */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export interface ExtractArchiveOptions {
  readonly archivePath: string;
  readonly targetDir: string;
  /** 归档形态（布局契约；成员穿越校验据此判定合法形状）。 */
  readonly kind: RuntimeArchiveKind;
  /** 预期顶层目录名（uv win 平铺 = ""）。 */
  readonly topLevelDir: string;
  readonly stripComponents: number;
  readonly platform: NodeJS.Platform;
  /** 注入 execFile（测试用）；参数恒为数组形态，禁 shell 字符串拼接。 */
  readonly runTool?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

/**
 * 解压前成员可接受性判定（[ulw] MINOR-5 布局契约接线）：顶层目录条目本身（尾 `/`
 * 剥离后 == topLevelDir）= 合法容器；其余成员必须能经 mapArchiveMemberToTargetPath
 * 映射出目标相对路径——`..` 段、绝对路径、意外顶层形状一律拒绝。
 */
function isAcceptableArchiveMember(options: {
  readonly kind: RuntimeArchiveKind;
  readonly memberPath: string;
  readonly topLevelDir: string;
}): boolean {
  if (!options.memberPath || options.memberPath.includes("\0")) return false;
  if (isAbsolute(options.memberPath)) return false;
  const normalized = options.memberPath.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (options.topLevelDir !== "" && normalized === options.topLevelDir) return true;
  return mapArchiveMemberToTargetPath(options) !== null;
}

/**
 * 解压执行器（§4.3：解压先落 tmp 临时目录再就位，成功后清理）：
 * 1. `tar -tf` 全量列表 → 逐成员穿越校验（[ulw] MINOR-5：sha256 只保证字节完整性，
 *    不保证成员路径形状；`..` 段/绝对路径/意外形状 = 拒绝整个归档，不解压）；
 * 2. 校验通过才 `tar -xf <archive> -C <tmpDir> [--strip-components N]` → 校验非空 →
 *    rename 到目标。目标目录已存在 = 报错（install 编排保证新 v<ver>/ 唯一）。
 */
export async function extractRuntimeArchive(options: ExtractArchiveOptions): Promise<void> {
  const tool = resolveExtractionTool(options.archivePath, options.platform);
  const runTool = options.runTool ?? execFileAsync;
  const tmpExtractDir = `${options.targetDir}.extract-${process.pid}-${Date.now()}`;
  await rm(tmpExtractDir, { recursive: true, force: true });
  await mkdir(tmpExtractDir, { recursive: true });
  const args = [
    "-xf",
    options.archivePath,
    "-C",
    tmpExtractDir,
    ...(options.stripComponents > 0 ? ["--strip-components", String(options.stripComponents)] : []),
  ];
  try {
    const listing = await runTool(tool, ["-tf", options.archivePath]);
    const members = listing.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (members.length === 0) {
      throw new ExtractionError(`archive listing empty: ${options.archivePath}`);
    }
    for (const member of members) {
      if (
        !isAcceptableArchiveMember({
          kind: options.kind,
          memberPath: member,
          topLevelDir: options.topLevelDir,
        })
      ) {
        throw new ExtractionError(
          `archive member rejected by layout contract: ${member} (${options.archivePath})`,
        );
      }
    }
    await runTool(tool, args);
    const extracted = await readdir(tmpExtractDir);
    if (extracted.length === 0) {
      throw new ExtractionError(`extraction produced no entries: ${options.archivePath}`);
    }
    await mkdir(dirname(options.targetDir), { recursive: true });
    try {
      await rename(tmpExtractDir, options.targetDir);
    } catch (error) {
      // 目标已存在（同版本残留）或跨卷 rename 失败：明确报错，不静默覆盖。
      throw new ExtractionError(
        `cannot move extracted archive into place: ${options.targetDir} (${String(error)})`,
      );
    }
  } finally {
    await rm(tmpExtractDir, { recursive: true, force: true });
  }
}

/** 版本目录内可执行文件相对路径（冒烟 spawn 用；win 平铺 / unix bin/）。 */
export function resolveRuntimeBinaryRelativePath(
  kind: "node" | "uv",
  platform: NodeJS.Platform,
): string {
  const executable = platform === "win32" ? `${kind}.exe` : kind;
  if (platform === "win32") return executable;
  return kind === "node" ? join("bin", executable) : executable;
}
