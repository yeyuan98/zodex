/**
 * specs/agent-runtimes.md §4.6（GC 重试归属：app 级 = desktop main 启动时扫
 * `<config>/.runtime` 下各 kind 目录）+ §4.3（启动清理残留 CURRENT.tmp*）启动期
 * 执行器：
 * - 清理 `CURRENT.tmp*` 半写残留（best-effort，失败不阻断启动）；
 * - 清理 runtime 根下过宽限期的 `.download-*` 下载暂存崩溃残留（F7）；
 * - GC 未被 CURRENT 引用且已过宽限期的版本目录（planVersionDirGc 决策）；
 * - Windows 文件锁真实处置 = rename-probe：重命名失败（运行中进程持有目录内
 *   文件，EPERM/EBUSY）→ 保留 + warn，下次启动重试；不强删。
 */
import { renameSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupCurrentTmpLeftovers,
  collectVersionDirMeta,
  planVersionDirGc,
  readCurrentPointer,
  VERSION_DIR_NAME_PATTERN,
} from "./current.js";
import {
  VERSION_DIR_GC_GRACE_MS,
  resolveLogger,
  resolveRuntimeRootDir,
  type LocalRuntimeDeps,
} from "./shared.js";

/**
 * F7（alpha.3，§4.6 启动清扫增项）：`.download-*` 半写崩溃残留的 mtime 清扫
 * 宽限 = 24h。取值对齐版本目录 GC 的 VERSION_DIR_GC_GRACE_MS（7d）形制但显著
 * 更短：下载暂存生命周期以分钟计，mtime 超过 24h 的 `.download-*` 不可能仍属
 * 在飞安装（= 进程崩溃/断电残留），可安全删除；宽限期内视作另一进程在飞安装
 * 的暂存，保留不误删（测试钉 24h 语义）。
 */
const DOWNLOAD_LEFTOVER_GC_GRACE_MS = 24 * 3_600_000;

/** download-verify 暂存命名 `.download-${kind}-${pid}-${ts}-${rand}`（kind 目录外、runtime 根下）。 */
const DOWNLOAD_LEFTOVER_NAME_PATTERN = /^\.download-(?:node|uv)-\d+-\d+-\d+/u;

export interface LocalRuntimeStartupGcResult {
  readonly cleanedTmpFiles: readonly string[];
  readonly removedVersionDirs: readonly string[];
  /** rename-probe 失败（Windows 文件锁等）保留的目录——下次启动重试。 */
  readonly keptLockedVersionDirs: readonly string[];
}

export async function runLocalRuntimeStartupGc(
  deps: LocalRuntimeDeps = {},
): Promise<LocalRuntimeStartupGcResult> {
  const logger = resolveLogger(deps);
  const root = resolveRuntimeRootDir(deps);
  const nowMs = (deps.now ?? Date.now)();
  const cleanedTmpFiles = [...(await cleanupCurrentTmpLeftovers(root))];
  if (cleanedTmpFiles.length > 0) {
    logger.info(undefined, `startup gc: cleaned CURRENT.tmp leftovers x${cleanedTmpFiles.length}`);
  }
  // 上次启动在 rename-probe 后、rm 完成前崩溃会留下 `<version>.gc-*` 孤儿目录
  // （版本目录形态校验不含该后缀，主 GC 环不会认领）——这里先行清理。
  for (const kind of ["node", "uv"] as const) {
    const kindDir = join(root, kind);
    let orphanEntries: string[];
    try {
      orphanEntries = await readdir(kindDir);
    } catch {
      continue;
    }
    for (const entry of orphanEntries) {
      const match = /^(v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\.gc-/u.exec(entry);
      if (!match || !VERSION_DIR_NAME_PATTERN.test(match[1] ?? "")) continue;
      try {
        await rm(join(kindDir, entry), { recursive: true, force: true });
        cleanedTmpFiles.push(join(kindDir, entry));
      } catch (error) {
        logger.warn(
          undefined,
          `startup gc: orphan gc dir cleanup failed: ${entry} (${String(error)})`,
        );
      }
    }
  }
  // F7（alpha.3，§4.6）：增扫 runtime 根下的 `.download-*` 下载暂存半写崩溃
  // 残留（§1.3.3——编排层只保证候选非成功退出的主动清理，进程崩溃留下的残骸
  // 由启动 GC 按 mtime 宽限兜底）：过期（>DOWNLOAD_LEFTOVER_GC_GRACE_MS）删除，
  // 宽限期内保留（可能属另一进程在飞安装，不误删）。best-effort：单项失败只
  // warn 不阻断启动（与上方 gc 孤儿清理同形）。
  let rootEntries: string[] = [];
  try {
    rootEntries = await readdir(root);
  } catch {
    rootEntries = [];
  }
  let cleanedDownloadLeftovers = 0;
  for (const entry of rootEntries) {
    if (!DOWNLOAD_LEFTOVER_NAME_PATTERN.test(entry)) continue;
    const entryPath = join(root, entry);
    try {
      const { mtimeMs } = await stat(entryPath);
      if (nowMs - mtimeMs <= DOWNLOAD_LEFTOVER_GC_GRACE_MS) continue;
      await rm(entryPath, { recursive: true, force: true });
      cleanedTmpFiles.push(entryPath);
      cleanedDownloadLeftovers += 1;
    } catch (error) {
      logger.warn(
        undefined,
        `startup gc: .download leftover cleanup failed: ${entry} (${String(error)})`,
      );
    }
  }
  if (cleanedDownloadLeftovers > 0) {
    logger.info(undefined, `startup gc: cleaned .download leftovers x${cleanedDownloadLeftovers}`);
  }
  const removedVersionDirs: string[] = [];
  const keptLockedVersionDirs: string[] = [];
  for (const kind of ["node", "uv"] as const) {
    const kindDir = join(root, kind);
    const meta = await collectVersionDirMeta(kindDir);
    if (meta.length === 0) continue;
    const plan = planVersionDirGc(meta, {
      currentVersion: readCurrentPointer(kindDir),
      nowMs,
      graceMs: VERSION_DIR_GC_GRACE_MS,
    });
    for (const dirName of plan.remove) {
      const dirPath = join(kindDir, dirName);
      const probePath = `${dirPath}.gc-${process.pid}-${Date.now()}`;
      try {
        // rename-probe（D1）：同卷重命名成功 = 独占持有，可安全删除；
        // 失败（win 文件锁/EPERM）= 有进程在用 → 保留待下次启动重试。
        renameSync(dirPath, probePath);
      } catch (error) {
        keptLockedVersionDirs.push(join(kind, dirName));
        logger.warn(
          undefined,
          `startup gc: version dir locked, keep and retry next boot: ${join(kind, dirName)} (${String(error)})`,
        );
        continue;
      }
      try {
        await rm(probePath, { recursive: true, force: true });
        removedVersionDirs.push(join(kind, dirName));
      } catch (error) {
        // 删除失败则把目录放回原名，保留待下次启动重试（不丢数据）。
        try {
          renameSync(probePath, dirPath);
        } catch {
          // 放不回去只记 warn；残留 .gc-* 目录下次启动按孤儿清理语义处理。
        }
        keptLockedVersionDirs.push(join(kind, dirName));
        logger.warn(
          undefined,
          `startup gc: remove failed, keep and retry next boot: ${join(kind, dirName)} (${String(error)})`,
        );
      }
    }
  }
  if (removedVersionDirs.length > 0 || keptLockedVersionDirs.length > 0) {
    logger.info(
      undefined,
      `startup gc: removed=[${removedVersionDirs.join(",")}] keptLocked=[${keptLockedVersionDirs.join(",")}]`,
    );
  }
  return { cleanedTmpFiles, removedVersionDirs, keptLockedVersionDirs };
}
