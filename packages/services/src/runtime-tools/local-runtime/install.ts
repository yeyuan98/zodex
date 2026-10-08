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
  isFillerRuntimeArtifactClass,
  readAppRuntimeJson,
  resolveEffectiveDecisions,
  resolveReprobeSlots,
  validateUpdateOrdering,
  writeAppRuntimeJson,
  type AppRuntimeArtifactClass,
  type AppRuntimeDecisions,
  type AppRuntimeJson,
  type AppRuntimeMirrorMeasurement,
  type UpdateOrderingStep,
} from "./runtime-json.js";
import {
  NODE_KNOWN_GOOD_PROBE_TAG,
  UV_KNOWN_GOOD_PROBE_TAG,
  AllProbeCandidatesDeadError,
  probeArtifactClass,
} from "./probe.js";
import {
  buildNodeArtifactFileName,
  buildUvArtifactFileName,
  buildUvTriple,
  fetchNodeShasumsText,
  fetchUvReleaseMetadata,
  resolveLatestNodeVersion,
  resolveLatestUvVersion,
  type UvReleaseMetadata,
} from "./upstream.js";
import type { NodeChecksumAnchor } from "./verify.js";
import {
  buildCandidateLadder,
  downloadAndVerifyCandidate,
  smokeTestVersion,
  type CandidateAttemptContext,
  type NodeShasumsPrefetchEntry,
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
  // F6（alpha.3，§4.1 规则 4 类域限定 + §4.7）：全灭报错仅适用**安装相关类**
  // （nodeDist/uvRelease——all-dead = 中止安装，语义不变）；填充类
  // （pypiIndex/npmRegistry/pbsMirror）all-dead = 降级（warn + decisions 键删，
  // 下方处理），不在此抛。仍按 slots 顺序抛第一个不可降级拒绝（与原串行逐类
  // await 的首失败即抛同形）；非 AllProbeCandidatesDeadError 的意外拒绝保守照旧
  // loud（不吞未知异常）。
  for (const [index, artifactClass] of slots.entries()) {
    const result = settled[index];
    if (result === undefined || result.status !== "rejected") continue;
    if (
      isFillerRuntimeArtifactClass(artifactClass) &&
      result.reason instanceof AllProbeCandidatesDeadError
    ) {
      continue;
    }
    throw result.reason;
  }
  const decisions: Partial<Record<AppRuntimeArtifactClass, string>> = {};
  const measurements: AppRuntimeMirrorMeasurement[] = [];
  const summary: string[] = [];
  // 汇总行按候选表类序确定性拼接（slots 源自 APP_RUNTIME_ARTIFACT_CLASSES 序）——
  // 并行完成顺序不得影响输出（§9 (C)：`probe round:` 是 rig checklist 的 grep 锚点）。
  for (const [index, artifactClass] of slots.entries()) {
    const result = settled[index];
    if (result === undefined) continue;
    if (result.status === "fulfilled") {
      decisions[artifactClass] = result.value.outcome.winner;
      const winnerMeasurement = result.value.measurements.find(
        (entry) => entry.candidate === result.value.outcome.winner,
      );
      summary.push(
        `${artifactClass}=${result.value.outcome.winner}${winnerMeasurement ? `(${winnerMeasurement.latencyMs}ms)` : ""}`,
      );
      measurements.push(...result.value.measurements.map((entry) => ({ ...entry, artifactClass })));
      continue;
    }
    // F6 填充类降级（§4.7 键删语义）：all-dead → 本类无 winner/measurements 回填
    // （探测抛出即丢），decisions 不含该类键 = 不填空（不保 stale 镜像值）；汇总
    // 行按类序占位标记；warn 一行/类（不逐候选刷屏）。
    summary.push(`${artifactClass}=all-dead`);
    logger.warn(
      undefined,
      `probe degrade: ${artifactClass} 所有候选探测失败——decisions 键删除（不填空，不保 stale 镜像值），安装照常；手工覆盖位 = runtime.json overrides 字段`,
    );
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
  // F6/MINOR-13（§4.7 键删语义）：本轮重探槽位的 decisions 旧值**显式删除**、
  // 只回填 winner——填充类 all-dead 无 winner 回填 = 键缺席（键删 = 不填空，不保
  // stale 镜像值）。原 defaultDecisions + spread 合并会把已删键复活回候选表
  // origin id（MINOR-13 复活缺陷），故弃用 defaults 基底：未探测槽位只保留
  // previous 在场值，缺席不猜默认。
  const decisions: AppRuntimeDecisions = {};
  for (const artifactClass of APP_RUNTIME_ARTIFACT_CLASSES) {
    if (probedSlots.includes(artifactClass)) continue;
    const preserved = previous?.decisions[artifactClass];
    if (preserved !== undefined) decisions[artifactClass] = preserved;
  }
  Object.assign(decisions, probe.decisions);
  // [ulw] NIT-9：只替换本轮实际重探槽位的 measurements，保留未探测类（如 override
  // 位跳过的类）的既有记录——与 service.ts 单类重探同形，不做整串替换（整串替换会
  // 丢掉 override 类条目，卡内排名显示随之失真）。
  const preservedMeasurements = (previous?.measurements ?? []).filter(
    (entry) => !entry.artifactClass || !probedSlots.includes(entry.artifactClass),
  );
  return {
    probedAt: new Date(nowMs).toISOString(),
    ttlDays: previous?.ttlDays ?? 7,
    decisions,
    ...(previous?.overrides ? { overrides: previous.overrides } : {}),
    measurements: [...preservedMeasurements, ...probe.measurements],
    pinned: previous?.pinned ?? { node: "", uv: "" },
    // F5 MAJOR-5（§4.7 useMirrors schema）：本字面量逐字段构造 runtime.json——
    // 遗漏 useMirrors 会把 OFF 静默翻回缺省 true（探测合并即翻开关）。仅在场时
    // 保留（缺席 = true 现行为，不主动补写）。
    ...(previous?.useMirrors !== undefined ? { useMirrors: previous.useMirrors } : {}),
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
  // F5（§4.7 OFF 全链「安装跳过探测轮」）：OFF（useMirrors === false；缺席 =
  // true 现行为）时 install 跳过探测——安装选路全走 origin-only 梯次（P4a
  // 投影），探测决策无意义；TTL 过期/force 也不例外。runtime.json 原样返回
  // 不重写（合并位点缺席即 MAJOR-5 翻开关风险的最小暴露面）；runtime.json
  // 缺席/损坏时读端 treat-as-absent → 缺席 = true → 照常探测（OFF+缺席在
  // install 缝不可达：OFF 状态本身只持久于 runtime.json）。
  if (existing?.useMirrors === false) {
    return existing;
  }
  const slots = existing
    ? resolveReprobeSlots(existing, { nowMs, force: options.forceReprobe })
    : [...APP_RUNTIME_ARTIFACT_CLASSES];
  if (existing && slots.length === 0) {
    return existing;
  }
  const probe = await runProbeRound(slots, existing, deps);
  const merged = mergeRuntimeJsonWithProbe(existing, probe, slots, nowMs);
  // [ulw] MINOR-1（用户显式设置不得被内部探测合并静默回退）：探测窗口内
  // setUseMirrors 的翻转已落盘 fresh json——合并写前重读，以 fresh 的 useMirrors
  // 为准（finalize 重读模式同形，见 mergeRuntimeJsonAtFinalize）；fresh 缺席/
  // 损坏时维持 merged 不主动补写（MAJOR-5 缺席语义）。
  const freshUseMirrors = readAppRuntimeJson(jsonPath)?.useMirrors;
  writeAppRuntimeJson(
    jsonPath,
    freshUseMirrors !== undefined ? { ...merged, useMirrors: freshUseMirrors } : merged,
  );
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
      // F6/MINOR-13（§4.7 类型涟漪）：decisions 值可选化——kind 类（nodeDist/
      // uvRelease，安装相关类）effective 正常恒在场（all-dead 已在探测轮中止，
      // 见 runProbeRound 类域限定）；手改 runtime.json 缺键的边缘回退空串，保持
      // LocalRuntimeInstallResult.candidate: string 契约不动（shared.ts 非本相白名单）。
      candidate: effective[kindArtifactClass(kind)] ?? "",
      alreadyInstalled: true,
    };
  }
  const artifactClass = kindArtifactClass(kind);
  const ladder = buildCandidateLadder(artifactClass, json);
  // F3 校验锚点前置（§4.2，alpha.3；plan §9 NIT-1 预取位置）：noop 早退【之后】、
  // 梯次循环之前——noop 安装不得取任何新东西。先取校验值再下载 tarball，锚点
  // 不可达不再浪费已完成下载（§2o path-6：npmmirror 28MB tarball 下载后被锚点
  // 20s 取败丢弃）。node 双锚 SHASUMS per-anchor 预取、候选间复用（每锚点每安装
  // 尝试至多取一次）；uv digest（api.github.com 恒定锚点、不随传输候选变）每安装
  // 尝试一次——消除「gh-proxy 下载成功却被第二次 digest 取败毁掉整次安装」（§1.3.2）。
  const nodeShasumsPrefetch = new Map<NodeChecksumAnchor, NodeShasumsPrefetchEntry>();
  let uvReleaseMetadata: UvReleaseMetadata | undefined;
  if (kind === "node") {
    // 锚点对内确定性顺序：先 npmmirror 再 nodejs.org（§4.7 tuna 路径同序）。预取
    // 失败不在此处判死：缓存如实标记不可达，由各候选按单锚失败语义处置（锚点对
    // 候选单锚败 = 该候选跳过下载、梯次继续；tuna 双锚皆败 = §4.7 typed 中止）。
    for (const anchor of ["npmmirror", "nodejs.org"] as const) {
      nodeShasumsPrefetch.set(
        anchor,
        await fetchNodeShasumsText(anchor, version, fetchOptionsFor(deps)),
      );
    }
  } else {
    // uv：digest 锚点（api.github.com）不可达/限流 = typed 快速失败（≤
    // METADATA_FETCH_TIMEOUT_MS，不降级为无校验，§4.2 不变量）——直接传播出
    // installRuntime，不进梯次。
    uvReleaseMetadata = await fetchUvReleaseMetadata(version, fetchOptionsFor(deps));
  }
  let lastError = "no candidate attempted";
  // [ulw] MINOR-2（§4.7 错误文案含各候选速度摘要）：逐候选累积
  // `${candidate}: ${error}` 失败摘要（error 携带失速速度等诊断），最终错误
  // 文案按梯次序拼接全部候选而非只留最后一条——用户可据此逐源判断并手工
  // override（确定性：join 顺序 = 梯次顺序，不依赖完成顺序）。
  const candidateFailures: string[] = [];
  let succeeded: { candidate: string; downloadFilePath: string } | null = null;
  for (const [candidateIndex, candidate] of ladder.candidates.entries()) {
    logger.info(undefined, `download: kind=${kind} version=${version} candidate=${candidate}`);
    // F1 末位候选豁免速度下限（§4.7 MINOR-5c）：豁免由安装编排按梯次位置传入
    // （仅末位元素）——慢速真实下载不被 256KB/s 下限处死（OFF 直连 origin 时
    // 「慢好过没有」）；闲置看门狗与 DOWNLOAD_TIMEOUT_MS 总上限仍管。
    const attempt: CandidateAttemptContext = {
      exemptSpeedFloor: candidateIndex === ladder.candidates.length - 1,
      ...(kind === "node" ? { nodeShasumsPrefetch } : { uvReleaseMetadata }),
    };
    const outcome = await downloadAndVerifyCandidate(
      kind,
      candidate,
      version,
      deps,
      options.onProgress,
      attempt,
    );
    if (outcome.ok && outcome.downloadFilePath) {
      succeeded = { candidate, downloadFilePath: outcome.downloadFilePath };
      break;
    }
    lastError = outcome.error ?? "unknown";
    candidateFailures.push(`${candidate}: ${lastError}`);
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
      `install failed: kind=${kind} version=${version}；全部候选失败；各候选摘要：${candidateFailures.join("；")}`,
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
