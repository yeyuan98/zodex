/**
 * specs/agent-runtimes.md §4.6（生命周期矩阵 install 行）+ §4.7（A2′ 实现契约）
 * 编排层：探测 → 上游版本解析 → 候选梯下载 → 跨源校验 → 解压 v<ver>/ → 冒烟门
 * → runtime.json(pinned) → CURRENT 原子换指针 → 旧目录 GC。
 *
 * 更新顺序不变量（§4.7 (iii)）：新目录 → runtime.json → CURRENT → GC——编排按此
 * 顺序执行并以 validateUpdateOrdering 自检。override 源硬失败 = 明确报错 +
 * 保留 override（不静默回落）；重探只作用于无 override 位。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  collectVersionDirMeta,
  executeVersionDirGc,
  planVersionDirGc,
  readCurrentPointer,
  writeCurrentPointer,
} from "./current.js";
import { extractRuntimeArchive, resolveArchiveLayout } from "./layouts.js";
import {
  APP_RUNTIME_ARTIFACT_CLASSES,
  applyOverrideSourceHardFailure,
  readAppRuntimeJson,
  resolveEffectiveDecisions,
  resolveReprobeSlots,
  validateUpdateOrdering,
  writeAppRuntimeJson,
  type AppRuntimeArtifactClass,
  type AppRuntimeJson,
  type AppRuntimeMirrorMeasurement,
  type UpdateOrderingStep,
} from "./runtime-json.js";
import {
  NODE_KNOWN_GOOD_PROBE_TAG,
  UV_KNOWN_GOOD_PROBE_TAG,
  MIRROR_CANDIDATE_TABLES,
  probeArtifactClass,
} from "./probe.js";
import {
  buildNodeArtifactFileName,
  buildUvArtifactFileName,
  buildUvTriple,
  resolveLatestNodeVersion,
  resolveLatestUvVersion,
} from "./upstream.js";
import {
  buildCandidateLadder,
  downloadAndVerifyCandidate,
  smokeTestVersion,
} from "./download-verify.js";
import {
  LocalRuntimeInstallError,
  VERSION_DIR_GC_GRACE_MS,
  fetchOptionsFor,
  kindArtifactClass,
  onProgressSafe,
  resolveLogger,
  resolveRuntimeJsonPath,
  resolveRuntimeKindDir,
  type LocalRuntimeDeps,
  type LocalRuntimeInstallOptions,
  type LocalRuntimeInstallResult,
} from "./shared.js";

interface ProbeRoundOutcome {
  readonly decisions: Partial<Record<AppRuntimeArtifactClass, string>>;
  readonly measurements: readonly AppRuntimeMirrorMeasurement[];
}

/** 探测轮：逐类探测 + 择优；日志粒度 = 每轮一行汇总（§4.7，不逐候选刷屏）。 */
async function runProbeRound(
  slots: readonly AppRuntimeArtifactClass[],
  json: AppRuntimeJson | null,
  deps: LocalRuntimeDeps,
): Promise<ProbeRoundOutcome> {
  const logger = resolveLogger(deps);
  const decisions: Partial<Record<AppRuntimeArtifactClass, string>> = {};
  const measurements: AppRuntimeMirrorMeasurement[] = [];
  const summary: string[] = [];
  for (const artifactClass of slots) {
    // 探针版本来源（§4.1）：上一轮钉住版本；首轮无记录用内置 known-good tag。
    const probeVersion =
      artifactClass === "nodeDist"
        ? json?.pinned.node || NODE_KNOWN_GOOD_PROBE_TAG
        : artifactClass === "uvRelease"
          ? json?.pinned.uv || UV_KNOWN_GOOD_PROBE_TAG
          : "";
    const result = await probeArtifactClass(artifactClass, probeVersion, fetchOptionsFor(deps));
    decisions[artifactClass] = result.outcome.winner;
    const winnerMeasurement = result.measurements.find(
      (entry) => entry.candidate === result.outcome.winner,
    );
    summary.push(
      `${artifactClass}=${result.outcome.winner}${winnerMeasurement ? `(${winnerMeasurement.latencyMs}ms)` : ""}`,
    );
    measurements.push(...result.measurements.map((entry) => ({ ...entry, artifactClass })));
  }
  logger.info(undefined, `probe round: ${summary.join(" ")}`);
  return { decisions, measurements };
}

function mergeRuntimeJsonWithProbe(
  previous: AppRuntimeJson | null,
  probe: ProbeRoundOutcome,
  nowMs: number,
): AppRuntimeJson {
  const defaultDecisions = Object.fromEntries(
    APP_RUNTIME_ARTIFACT_CLASSES.map((artifactClass) => [
      artifactClass,
      MIRROR_CANDIDATE_TABLES[artifactClass][0]?.id ?? "",
    ]),
  ) as Record<AppRuntimeArtifactClass, string>;
  return {
    probedAt: new Date(nowMs).toISOString(),
    ttlDays: previous?.ttlDays ?? 7,
    decisions: { ...defaultDecisions, ...previous?.decisions, ...probe.decisions },
    ...(previous?.overrides ? { overrides: previous.overrides } : {}),
    measurements: probe.measurements,
    pinned: previous?.pinned ?? { node: "", uv: "" },
  };
}

/** install 前置：确保 runtime.json 处于可用状态（TTL/force/缺失时先探测一轮并落盘）。 */
async function ensureRuntimeJsonState(
  deps: LocalRuntimeDeps,
  options: { readonly forceReprobe?: boolean },
): Promise<AppRuntimeJson> {
  const jsonPath = resolveRuntimeJsonPath(deps);
  const existing = readAppRuntimeJson(jsonPath);
  const nowMs = (deps.now ?? Date.now)();
  const slots = existing
    ? resolveReprobeSlots(existing, { nowMs, force: options.forceReprobe })
    : [...APP_RUNTIME_ARTIFACT_CLASSES];
  if (existing && slots.length === 0) {
    return existing;
  }
  const probe = await runProbeRound(slots, existing, deps);
  const merged = mergeRuntimeJsonWithProbe(existing, probe, nowMs);
  writeAppRuntimeJson(jsonPath, merged);
  return merged;
}

export async function installRuntime(
  kind: "node" | "uv",
  options: LocalRuntimeInstallOptions = {},
  deps: LocalRuntimeDeps = {},
): Promise<LocalRuntimeInstallResult> {
  const logger = resolveLogger(deps);
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const jsonPath = resolveRuntimeJsonPath(deps);
  const kindDir = resolveRuntimeKindDir(deps, kind);
  logger.info(undefined, `install start: kind=${kind}`);
  const json = await ensureRuntimeJsonState(deps, options);
  onProgressSafe(options.onProgress, { kind, phase: "resolve-version" });
  const version =
    kind === "node"
      ? await resolveLatestNodeVersion(fetchOptionsFor(deps))
      : await resolveLatestUvVersion(fetchOptionsFor(deps));
  if (readCurrentPointer(kindDir) === version) {
    logger.info(undefined, `install noop: kind=${kind} version=${version} already current`);
    const effective = resolveEffectiveDecisions(json);
    return {
      kind,
      version,
      candidate: effective[kindArtifactClass(kind)],
      alreadyInstalled: true,
    };
  }
  const artifactClass = kindArtifactClass(kind);
  const ladder = buildCandidateLadder(artifactClass, json);
  let lastError = "no candidate attempted";
  let succeeded: { candidate: string; downloadFilePath: string } | null = null;
  for (const candidate of ladder.candidates) {
    logger.info(undefined, `download: kind=${kind} version=${version} candidate=${candidate}`);
    const outcome = await downloadAndVerifyCandidate(
      kind,
      candidate,
      version,
      deps,
      options.onProgress,
    );
    if (outcome.ok && outcome.downloadFilePath) {
      succeeded = { candidate, downloadFilePath: outcome.downloadFilePath };
      break;
    }
    lastError = outcome.error ?? "unknown";
    // 可恢复失败 = warn（§4.7 日志通道）：换次优顺位候选重试。
    logger.warn(
      undefined,
      `candidate failed, trying next in ladder: kind=${kind} candidate=${candidate} error=${lastError}`,
    );
  }
  if (!succeeded) {
    if (ladder.isOverrideSlot) {
      // override 源硬失败 = 明确报错 + 保留 override（绝不静默回落，§4.7 (iv)）。
      const failure = applyOverrideSourceHardFailure(
        readAppRuntimeJson(jsonPath) ?? json,
        artifactClass,
      );
      logger.error(undefined, failure.error);
      throw new LocalRuntimeInstallError(`${failure.error}；底层错误：${lastError}`);
    }
    throw new LocalRuntimeInstallError(
      `install failed: kind=${kind} version=${version}；全部候选失败；最后错误：${lastError}`,
    );
  }
  const artifactFileName =
    kind === "node"
      ? buildNodeArtifactFileName(version, platform, arch)
      : buildUvArtifactFileName(platform, arch);
  const layout = resolveArchiveLayout({
    kind,
    platform,
    archiveFileName: artifactFileName,
    topLevelDir:
      kind === "node"
        ? artifactFileName.replace(/\.(?:zip|tar\.xz)$/u, "")
        : `uv-${buildUvTriple(platform, arch)}`,
  });
  const targetDir = join(kindDir, version);
  onProgressSafe(options.onProgress, { kind, phase: "extract", version });
  await rm(targetDir, { recursive: true, force: true });
  try {
    await extractRuntimeArchive({
      archivePath: succeeded.downloadFilePath,
      targetDir,
      stripComponents: layout.stripComponents,
      platform,
    });
  } finally {
    await rm(succeeded.downloadFilePath, { force: true });
  }
  onProgressSafe(options.onProgress, { kind, phase: "smoke", version });
  const smokeOutput = await smokeTestVersion(kind, targetDir, deps);
  logger.info(undefined, `smoke ok: kind=${kind} version=${version} output=${smokeOutput}`);
  // 更新顺序不变量（§4.7 (iii)）：version-dir → runtime.json → CURRENT → GC。
  const executedSteps: UpdateOrderingStep[] = ["version-dir"];
  onProgressSafe(options.onProgress, { kind, phase: "finalize", version });
  writeAppRuntimeJson(jsonPath, { ...json, pinned: { ...json.pinned, [kind]: version } });
  executedSteps.push("runtime-json");
  writeCurrentPointer(kindDir, version);
  executedSteps.push("current");
  const meta = await collectVersionDirMeta(kindDir);
  const gcPlan = planVersionDirGc(meta, {
    currentVersion: version,
    nowMs: (deps.now ?? Date.now)(),
    graceMs: VERSION_DIR_GC_GRACE_MS,
  });
  const gcResult = await executeVersionDirGc(kindDir, gcPlan);
  executedSteps.push("gc");
  const ordering = validateUpdateOrdering(executedSteps);
  if (!ordering.ok) {
    throw new LocalRuntimeInstallError(
      `更新顺序不变量被违反（firstOutOfOrder=${ordering.firstOutOfOrder ?? "unknown"}）`,
    );
  }
  if (gcResult.removed.length > 0 || gcPlan.retryLater.length > 0) {
    logger.info(
      undefined,
      `gc: kind=${kind} removed=[${gcResult.removed.join(",")}] retryLater=[${gcPlan.retryLater.join(",")}]`,
    );
  }
  logger.info(
    undefined,
    `install done: kind=${kind} version=${version} candidate=${succeeded.candidate}`,
  );
  return { kind, version, candidate: succeeded.candidate, alreadyInstalled: false };
}
