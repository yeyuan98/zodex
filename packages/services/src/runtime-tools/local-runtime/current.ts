/**
 * specs/agent-runtimes.md §4.3（版本化目录 + CURRENT 原子指针）/§4.6（GC 重试归属）
 * A2′ TS 实现：CURRENT tmp+rename 原子换指针、读端容错（禁目录扫描回退）、
 * 版本目录 GC 决策纯函数 + 执行器 + 启动期 CURRENT.tmp* 清理。
 *
 * 同步 IO 说明：L3（adapters spawn 缝）每 spawn 同步读 CURRENT + runtime.json
 * （§2.5「accessSync 同步 IO 先例」）；指针写路径同为同步 tmp+rename，
 * 保证「写后立即可见、读者只见旧或新、无半写」（W5 测试契约为同步调用形）。
 */
import { existsSync, type Stats } from "node:fs";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const CURRENT_FILE_NAME = "CURRENT";
const CURRENT_TMP_PREFIX = "CURRENT.tmp";

/** 版本目录名形态：node `v22.14.0` / uv `0.8.6`（含 prerelease 后缀变体）。 */
export const VERSION_DIR_NAME_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u;

function nextTmpSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** CURRENT 原子写入：`CURRENT.tmp*` → fs.rename（同卷原子；读者只见旧或新、无半写）。 */
export function writeCurrentPointer(runtimeKindDir: string, version: string): void {
  // 指针内容 = 版本目录名：先校验形态（防路径穿越），并确保目录在位（install
  // 编排就位目录后调用；此处补 mkdir 兜底「写后读回即有效」的原子可见契约）。
  if (!VERSION_DIR_NAME_PATTERN.test(version)) {
    throw new Error(`invalid CURRENT pointer version: ${version}`);
  }
  mkdirSync(join(runtimeKindDir, version), { recursive: true });
  mkdirSync(runtimeKindDir, { recursive: true });
  const tmpPath = join(runtimeKindDir, `${CURRENT_TMP_PREFIX}-${nextTmpSuffix()}`);
  writeFileSync(tmpPath, version, "utf8");
  renameSync(tmpPath, join(runtimeKindDir, CURRENT_FILE_NAME));
}

/**
 * CURRENT 读取（§4.3 读端容错）：内容 = 版本目录名；缺失/不可解析/悬空（指向已
 * GC 目录）→ null；**禁止**回退扫描最高 `v<ver>`（会复活待 GC 版本）。
 */
export function readCurrentPointer(runtimeKindDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(runtimeKindDir, CURRENT_FILE_NAME), "utf8");
  } catch {
    return null;
  }
  const dirName = raw.trim();
  if (!dirName || !VERSION_DIR_NAME_PATTERN.test(dirName)) {
    return null;
  }
  let stats: Stats;
  try {
    stats = statSync(join(runtimeKindDir, dirName));
  } catch {
    // 悬空指针（指向已 GC 目录）→ 视为缺席，不猜。
    return null;
  }
  return stats.isDirectory() ? dirName : null;
}

/** 版本目录元数据（GC 决策输入，纯数据）。 */
export interface RuntimeVersionDirMeta {
  readonly dirName: string;
  readonly lastTouchedMs: number;
  /** Windows 文件锁模拟标记：运行中进程持有目录内文件。 */
  readonly locked?: boolean;
}

/** GC 计划：remove = 本轮删除；keep = 保留（被引用/宽限期内/锁定）；retryLater = 锁定保留待启动重试。 */
export interface VersionDirGcPlan {
  readonly remove: readonly string[];
  readonly keep: readonly string[];
  readonly retryLater: readonly string[];
}

/**
 * GC 规则（§4.6）：未被 CURRENT 引用且已过宽限期 → remove；被引用 → keep；
 * 未引用但在宽限期内 → keep；locked（win 文件锁）→ 保留 + 标记 retryLater
 * （desktop main 启动时重试）。
 */
export function planVersionDirGc(
  meta: readonly RuntimeVersionDirMeta[],
  options: {
    readonly currentVersion: string | null;
    readonly nowMs: number;
    readonly graceMs: number;
  },
): VersionDirGcPlan {
  const remove: string[] = [];
  const keep: string[] = [];
  const retryLater: string[] = [];
  for (const entry of meta) {
    if (entry.dirName === options.currentVersion) {
      keep.push(entry.dirName);
      continue;
    }
    if (entry.locked) {
      // Windows 文件锁：运行中进程持有目录内文件 → 保留 + 标记启动重试，不强删。
      keep.push(entry.dirName);
      retryLater.push(entry.dirName);
      continue;
    }
    if (options.nowMs - entry.lastTouchedMs > options.graceMs) {
      remove.push(entry.dirName);
    } else {
      keep.push(entry.dirName);
    }
  }
  return { remove, keep, retryLater };
}

/** 收集版本目录元数据（mtime = lastTouched；仅形态合法的目录进入决策）。 */
export async function collectVersionDirMeta(
  runtimeKindDir: string,
): Promise<readonly RuntimeVersionDirMeta[]> {
  if (!existsSync(runtimeKindDir)) return [];
  const entries = await readdir(runtimeKindDir, { withFileTypes: true });
  const meta: RuntimeVersionDirMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_DIR_NAME_PATTERN.test(entry.name)) continue;
    const stats = await stat(join(runtimeKindDir, entry.name));
    meta.push({ dirName: entry.name, lastTouchedMs: stats.mtimeMs });
  }
  return meta;
}

/** GC 执行器：按计划删除 remove 目录（best-effort）；retryLater 由调用方记日志、启动期重试。 */
export async function executeVersionDirGc(
  runtimeKindDir: string,
  plan: VersionDirGcPlan,
): Promise<{ readonly removed: readonly string[]; readonly failed: readonly string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const dirName of plan.remove) {
    try {
      await rm(join(runtimeKindDir, dirName), { recursive: true, force: true });
      removed.push(dirName);
    } catch {
      failed.push(dirName);
    }
  }
  return { removed, failed };
}

/** 启动清理：删除残留 `CURRENT.tmp*` 半写文件（§4.3；desktop main 启动时调用）。 */
export async function cleanupCurrentTmpLeftovers(
  runtimeRootDir: string,
  kinds: readonly string[] = ["node", "uv"],
): Promise<readonly string[]> {
  const cleaned: string[] = [];
  for (const kind of kinds) {
    const kindDir = join(runtimeRootDir, kind);
    if (!existsSync(kindDir)) continue;
    const entries = await readdir(kindDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(CURRENT_TMP_PREFIX)) continue;
      try {
        await unlink(join(kindDir, entry.name));
        cleaned.push(join(kindDir, entry.name));
      } catch {
        // best-effort：残留 tmp 清理失败不阻断启动。
      }
    }
  }
  return cleaned;
}
