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
  type LocalRuntimeKind,
} from "./shared.js";

interface ProbeRoundOutcome {
  readonly decisions: Partial<Record<AppRuntimeArtifactClass, string>>;
  readonly measurements: readonly AppRuntimeMirrorMeasurement[];
}

/** 探测轮：类间并行探测 + 择优；日志粒度 = 每轮一行汇总（§4.7，不逐候选刷屏）。 */
async function runProbeRound(
  slots: readonly AppRuntimeArtifactClass[],
  json: AppRuntimeJson | null,
  deps: LocalRuntimeDeps,
): Promise<ProbeRoundOutcome> {
  const logger = resolveLogger(deps);
  // F2 类间并行（§4.1，alpha.3）：五类 Promise.allSettled——探测轮 wall = max(类)
  // ≈ ≤5s（原类间串行上限 5×5s=25s、§2o 取证实测 16.65s）。类内并行维持
  // （probe.ts 不动）；S1 技能 curl 腿仍串行（双实现差异注记，行为等价仅 wall 不同）。
  // 探针版本来源（§4.1）：上一轮钉住版本；首轮无记录用内置 known-good tag。
  const probeVersionFor = (artifactClass: AppRuntimeArtifactClass): string =>
    artifactClass === "nodeDist"
      ? json?.pinned.node || NODE_KNOWN_GOOD_PROBE_TAG
      : artifactClass === "uvRelease"
        ? json?.pinned.uv || UV_KNOWN_GOOD_PROBE_TAG
        : "";
  const settled = await Promise.allSettled(
    slots.map((artifactClass) =>
      probeArtifactClass(artifactClass, probeVersionFor(artifactClass), fetchOptionsFor(deps)),
    ),
  );
  // 并行化不改变失败语义：仍按 slots 顺序抛第一个 all-dead 类（与原串行逐类 await
  // 的首失败即抛同形；F6 填充类降级归后续 phase，本相不扩语义）。
  const firstRejected = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected",
  );
  if (firstRejected !== undefined) {
    throw firstRejected.reason;
  }
  const decisions: Partial<Record<AppRuntimeArtifactClass, string>> = {};
  const measurements: AppRuntimeMirrorMeasurement[] = [];
  const summary: string[] = [];
  // 汇总行按候选表类序确定性拼接（slots 源自 APP_RUNTIME_ARTIFACT_CLASSES 序）——
  // 并行完成顺序不得影响输出（§9 (C)：`probe round:` 是 rig checklist 的 grep 锚点）。
  for (const [index, artifactClass] of slots.entries()) {
    const result = settled[index];
    if (result === undefined || result.status !== "fulfilled") continue;
    decisions[artifactClass] = result.value.outcome.winner;
    const winnerMeasurement = result.value.measurements.find(
      (entry) => entry.candidate === result.value.outcome.winner,
    );
    summary.push(
      `${artifactClass}=${result.value.outcome.winner}${winnerMeasurement ? `(${winnerMeasurement.latencyMs}ms)` : ""}`,
    );
    measurements.push(...result.value.measurements.map((entry) => ({ ...entry, artifactClass })));
  }
  logger.info(undefined, `probe round: ${summary.join(" ")}`);
  return { decisions, measurements };
}

function mergeRuntimeJsonWithProbe(
  previous: AppRuntimeJson | null,
  probe: ProbeRoundOutcome,
  probedSlots: readonly AppRuntimeArtifactClass[],
  nowMs: number,
): AppRuntimeJson {
  const defaultDecisions = Object.fromEntries(
    APP_RUNTIME_ARTIFACT_CLASSES.map((artifactClass) => [
      artifactClass,
      MIRROR_CANDIDATE_TABLES[artifactClass][0]?.id ?? "",
    ]),
  ) as Record<AppRuntimeArtifactClass, string>;
  // [ulw] NIT-9：只替换本轮实际重探槽位的 measurements，保留未探测类（如 override
  // 位跳过的类）的既有记录——与 service.ts 单类重探同形，不做整串替换（整串替换会
  // 丢掉 override 类条目，卡内排名显示随之失真）。
  const preservedMeasurements = (previous?.measurements ?? []).filter(
    (entry) => !entry.artifactClass || !probedSlots.includes(entry.artifactClass),
  );
  return {
    probedAt: new Date(nowMs).toISOString(),
    ttlDays: previous?.ttlDays ?? 7,
    decisions: { ...defaultDecisions, ...previous?.decisions, ...probe.decisions },
    ...(previous?.overrides ? { overrides: previous.overrides } : {}),
    measurements: [...preservedMeasurements, ...probe.measurements],
    pinned: previous?.pinned ?? { node: "", uv: "" },
  };
}

/**
 * finalize 写入（§4.7 (iii) runtime.json 步）的合并纯函数：重读当前 runtime.json
 * 只合并 `{pinned}`。[ulw] MINOR-4 修复丢失更新竞态：安装窗口（探测/下载耗时）内
 * 其它写入者（镜像 override 切换/显式探测）落盘的字段不得被安装起点的旧快照整串
 * 覆盖；fresh 读失败/文件缺席时才回落安装起点快照 fallback。
 */
export function mergeRuntimeJsonAtFinalize(
  fresh: AppRuntimeJson | null,
  fallback: AppRuntimeJson,
  kind: LocalRuntimeKind,
  version: string,
): AppRuntimeJson {
  const base = fresh ?? fallback;
  return { ...base, pinned: { ...base.pinned, [kind]: version } };
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
  const merged = mergeRuntimeJsonWithProbe(existing, probe, slots, nowMs);
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
      ? await resolveLatestNodeVersion({
          ...fetchOptionsFor(deps),
          // F2 解析顺序回填（§4.2，alpha.3）：探测轮已判定的 nodeDist 有效决策源
          // 传入版本解析——origin（nodejs.org）探活死时先咨询 npmmirror index.json，
          // 消除 CN 挂起 ~20s 税（§2o：代码推导值）。uv 恒 api.github.com（不变量）。
          preferredNodeDistCandidate: resolveEffectiveDecisions(json).nodeDist,
        })
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
  try {
    await rm(targetDir, { recursive: true, force: true });
    await extractRuntimeArchive({
      archivePath: succeeded.downloadFilePath,
      targetDir,
      kind: layout.kind,
      topLevelDir: layout.topLevelDir,
      stripComponents: layout.stripComponents,
      platform,
    });
  } finally {
    // [ulw] MAJOR-2：编排层持有下载 tmp 所有权——进入解压段后无论 `rm(targetDir)`
    // 还是解压本身何处抛出，都必须清理暂存文件，防 `.download-*` 残留。
    await rm(succeeded.downloadFilePath, { force: true });
  }
  onProgressSafe(options.onProgress, { kind, phase: "smoke", version });
  const smokeOutput = await smokeTestVersion(kind, targetDir, deps);
  logger.info(undefined, `smoke ok: kind=${kind} version=${version} output=${smokeOutput}`);
  // 更新顺序不变量（§4.7 (iii)）：version-dir → runtime.json → CURRENT → GC。
  const executedSteps: UpdateOrderingStep[] = ["version-dir"];
  onProgressSafe(options.onProgress, { kind, phase: "finalize", version });
  // [ulw] MINOR-4：finalize 重读 runtime.json 只合并 pinned——安装窗口内的
  // override 切换/显式探测写入不被安装起点的旧快照覆盖（丢失更新防护）。
  writeAppRuntimeJson(
    jsonPath,
    mergeRuntimeJsonAtFinalize(readAppRuntimeJson(jsonPath), json, kind, version),
  );
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
