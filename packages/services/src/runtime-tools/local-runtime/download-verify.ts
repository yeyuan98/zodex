/**
 * specs/agent-runtimes.md §4.2（跨源校验 + F3 锚点前置，alpha.3）/§4.1（次优顺位
 * 重试）候选下载腿：候选梯构建（override 位不回落）+ 【先取校验值】+ 下载 +
 * 跨源校验（node SHASUMS 锚点对另一方 / uv api.github.com digest）+ 冒烟
 * （--version）。顺序反转注记（§4.2）：校验锚点不可达 = 候选失败且不发起下载
 * （alpha.2 为下载后取——锚点 20s 取败会把已完成的 28MB 下载白白丢弃，§2o
 * path-6）。
 */
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GitHubRateLimitError,
  RuntimeVersionResolutionError,
  buildNodeArtifactFileName,
  buildNodeDownloadUrl,
  buildUvArtifactFileName,
  buildUvDownloadUrl,
  downloadArtifactToFile,
  fetchNodeShasumsText,
  fetchUvReleaseMetadata,
  type UvReleaseMetadata,
} from "./upstream.js";
import {
  NodeChecksumAnchorsUnavailableError,
  ChecksumMismatchError,
  UvDigestSourceUnavailableError,
  assertNodeChecksumAnchorsAvailable,
  compareSha256Digest,
  parseShasums256,
  resolveExpectedSha256,
  resolveUvAssetDigest,
  resolveUvDigestSource,
  selectNodeChecksumSource,
  type NodeChecksumAnchor,
} from "./verify.js";
import { MIRROR_CANDIDATE_TABLES } from "./probe.js";
import { APP_RUNTIME_ORIGIN_DECISIONS } from "./runtime-json.js";
import type { AppRuntimeArtifactClass, AppRuntimeJson } from "./runtime-json.js";
import { resolveRuntimeBinaryRelativePath } from "./layouts.js";
import {
  LocalRuntimeInstallError,
  SMOKE_TIMEOUT_MS,
  fetchOptionsFor,
  resolveRuntimeRootDir,
  type LocalRuntimeDeps,
  type LocalRuntimeKind,
  type LocalRuntimeProgressEvent,
} from "./shared.js";

const execFileAsync = promisify(execFile);

/**
 * 候选梯（次优顺位重试，§4.1）：override 位只含 override 候选（硬失败不回落）。
 *
 * F5（alpha.3，§4.7 MAJOR-1 下载梯次同义）：消费 effective 投影的等价内部
 * 逻辑——`useMirrors === false` → 梯次 = **origin-only**（仅 origin 候选；无
 * 镜像主选、无镜像次选——同 override 槽位形制），且 `isOverrideSlot = false`：
 * OFF 期间 overrides 被压制（记住但不删，ON 恢复即生效），压制期间 override
 * 源硬失败规则**不武装**（§4.7 (iv) 的前提是 override 被咨询）。副作用 =
 * origin 即梯次末位候选，安装编排的末位豁免速度下限旗标（MINOR-5c）落其上。
 */
export function buildCandidateLadder(
  artifactClass: AppRuntimeArtifactClass,
  json: AppRuntimeJson,
): { readonly candidates: readonly string[]; readonly isOverrideSlot: boolean } {
  if (json.useMirrors === false) {
    return { candidates: [APP_RUNTIME_ORIGIN_DECISIONS[artifactClass]], isOverrideSlot: false };
  }
  const override = json.overrides?.[artifactClass];
  if (override !== undefined) {
    return { candidates: [override], isOverrideSlot: true };
  }
  const primary = json.decisions[artifactClass];
  const ranked = json.measurements
    .filter(
      (entry) => entry.artifactClass === artifactClass && entry.ok && entry.candidate !== primary,
    )
    .sort((left, right) => left.latencyMs - right.latencyMs)
    .map((entry) => entry.candidate);
  const fallback = MIRROR_CANDIDATE_TABLES[artifactClass]
    .map((spec) => spec.id)
    .filter((id) => id !== primary && !ranked.includes(id));
  // F6/MINOR-13（§4.7 填充类失败降级 + 类型涟漪）：decisions 值可选化——primary
  // undefined（该类键删/缺键形态）不得进入 candidates（readonly string[]）：梯次
  // 退为 ranked + 候选表 fallback（表序含 origin 兜底），不猜主选。
  const candidates =
    primary === undefined ? [...ranked, ...fallback] : [primary, ...ranked, ...fallback];
  return { candidates, isOverrideSlot: false };
}

/** F3：node 单锚 SHASUMS 预取缓存条目（fetchNodeShasumsText 返回形；per-anchor）。 */
export interface NodeShasumsPrefetchEntry {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

/**
 * F3/F1（alpha.3）：单次安装尝试的候选级共享上下文——install 编排在梯次开始前
 * 构造、逐候选传入（specs/agent-runtimes.md §4.2 双锚预取 / §4.7 digest 每尝试
 * 一次 + 末位候选豁免速度下限）。独立调用 downloadAndVerifyCandidate 不传 =
 * 现场取校验值、不豁免速度下限（安全缺省不变）。
 */
export interface CandidateAttemptContext {
  /** node 双锚 SHASUMS 预取缓存（每锚点每安装尝试至多取一次，候选间复用）。 */
  readonly nodeShasumsPrefetch?: ReadonlyMap<NodeChecksumAnchor, NodeShasumsPrefetchEntry>;
  /** uv release 元数据（digest 锚点恒 api.github.com、不随传输候选变——每安装尝试一次）。 */
  readonly uvReleaseMetadata?: UvReleaseMetadata;
  /** 末位候选豁免速度下限（§4.7 MINOR-5c）：仅豁免速度下限；闲置看门狗与总上限仍管。 */
  readonly exemptSpeedFloor?: boolean;
}

async function fetchNodeExpectedSha256(
  candidateId: string,
  version: string,
  artifactFileName: string,
  deps: LocalRuntimeDeps,
  prefetch?: ReadonlyMap<NodeChecksumAnchor, NodeShasumsPrefetchEntry>,
): Promise<string> {
  // 校验锚点选择（§4.2/§4.7）：tarball 来自 X → 取 nodejs.org↔npmmirror 另一方；
  // tuna（仅探测位）→ 两锚点皆合法（selectNodeChecksumSource 确定性取 npmmirror）。
  const primaryAnchor = selectNodeChecksumSource(
    candidateId as "nodejs.org" | "npmmirror" | "tuna",
  );
  if (!primaryAnchor) {
    throw new LocalRuntimeInstallError(`unknown node tarball source: ${candidateId}`);
  }
  const anchors: readonly NodeChecksumAnchor[] =
    candidateId === "tuna"
      ? [primaryAnchor, primaryAnchor === "npmmirror" ? "nodejs.org" : "npmmirror"]
      : [primaryAnchor];
  const anchorReachable: Record<NodeChecksumAnchor, boolean> = {
    "nodejs.org": false,
    npmmirror: false,
  };
  for (const anchor of anchors) {
    // F3 锚点前置（§4.2，alpha.3）：优先消费安装级 per-anchor 预取缓存（每锚点每
    // 安装尝试至多取一次、候选间复用）；独立调用（无缓存）现场取——「先验货再
    // 搬运」对两条路径一致成立。
    const result =
      prefetch?.get(anchor) ?? (await fetchNodeShasumsText(anchor, version, fetchOptionsFor(deps)));
    if (!result.ok) continue;
    anchorReachable[anchor] = true;
    const shasums = parseShasums256(result.text);
    const expected = resolveExpectedSha256(shasums, artifactFileName);
    if (expected) return expected;
    // tuna 陈旧坑（§4.1）：探测命中但目标版本工件不存在 → 该候选按失败处理。
  }
  if (candidateId === "tuna") {
    // tuna 路径两锚点皆被真实尝试：双双不可达才升级为 typed 硬失败（§4.7，
    // 与 uv api.github.com 规则对称）。
    assertNodeChecksumAnchorsAvailable(anchorReachable);
  } else if (!anchorReachable[primaryAnchor]) {
    // [ulw] MINOR-3：锚点对候选（tarball 来自 nodejs.org/npmmirror）只尝试另一侧
    // 单锚点——单锚点失败 = 该候选失败（梯次继续），不得误报「双锚点不可达」
    // 中止安装（下载源本身可达，Western 用户单镜像被墙时仍可装）。
    throw new LocalRuntimeInstallError(
      `node 校验锚点 ${primaryAnchor} 不可达（候选 ${candidateId} 按失败处理，走梯次）`,
    );
  }
  // 任一可达但不含期望条目 = 版本不存在（候选失败，走梯次）。
  throw new LocalRuntimeInstallError(
    `SHASUMS256.txt 不含期望工件 ${artifactFileName}（版本 ${version} 在校验源缺席）`,
  );
}

export interface CandidateOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly downloadFilePath?: string;
}

export async function downloadAndVerifyCandidate(
  kind: LocalRuntimeKind,
  candidateId: string,
  version: string,
  deps: LocalRuntimeDeps,
  onProgress?: (event: LocalRuntimeProgressEvent) => void,
  attempt?: CandidateAttemptContext,
): Promise<CandidateOutcome> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const artifactFileName =
    kind === "node"
      ? buildNodeArtifactFileName(version, platform, arch)
      : buildUvArtifactFileName(platform, arch);
  const url =
    kind === "node"
      ? buildNodeDownloadUrl(candidateId, version, platform, arch)
      : buildUvDownloadUrl(candidateId, version, platform, arch);
  const downloadPath = join(
    resolveRuntimeRootDir(deps),
    `.download-${kind}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  let succeeded = false;
  try {
    // F3 顺序反转（§4.2，alpha.3）：先取校验值、后下载 tarball——校验锚点不可达 =
    // 候选失败且【不发起下载】（先验货再搬运；§2o path-6：npmmirror 28MB 下载后
    // 被锚点 20s 取败丢弃）。安装级预取缓存经 attempt 传入（候选间复用）。
    let expectedSha256: string;
    if (kind === "node") {
      expectedSha256 = await fetchNodeExpectedSha256(
        candidateId,
        version,
        artifactFileName,
        deps,
        attempt?.nodeShasumsPrefetch,
      );
    } else {
      // uv digest 恒直连 api.github.com（§4.7）：不可达/限流由 upstream 抛 typed
      // 错误，绝不降级为无校验、也不从 gh-proxy 系取校验值。F3 每安装尝试一次：
      // 优先消费安装级预取（候选间复用——消除「gh-proxy 下载成功却被第二次
      // digest 取败毁掉整次安装」）；独立调用现场取。
      const metadata =
        attempt?.uvReleaseMetadata ??
        (await fetchUvReleaseMetadata(version, fetchOptionsFor(deps)));
      // [ulw] NIT-11：digest 解析路由经 resolveUvDigestSource（锚点恒
      // api.github.com；上行 fetchUvReleaseMetadata 已直连，不可达时已抛 typed 错）。
      const { digestSource } = resolveUvDigestSource(true);
      const digest = resolveUvAssetDigest(metadata.assets, artifactFileName);
      if (!digest) {
        throw new LocalRuntimeInstallError(
          `uv 校验源 ${digestSource} release 资产摘要缺席：${artifactFileName}（不降级为无校验）`,
        );
      }
      expectedSha256 = digest;
    }
    const download = await downloadArtifactToFile(url, downloadPath, {
      ...fetchOptionsFor(deps),
      // F1 末位候选豁免速度下限（§4.7 MINOR-5c）：旗标由安装编排按梯次位置传入
      // （末位元素才置 true）；独立调用缺省不豁免。仅豁免速度下限——闲置看门狗
      // 与 DOWNLOAD_TIMEOUT_MS 总上限在 upstream 内仍照常生效。
      exemptSpeedFloor: attempt?.exemptSpeedFloor ?? false,
      onProgress: (progress) =>
        onProgress?.({
          kind,
          phase: "download",
          candidate: candidateId,
          version,
          bytes: progress.bytes,
          totalBytes: progress.totalBytes,
        }),
    });
    onProgress?.({ kind, phase: "verify", candidate: candidateId, version });
    if (!compareSha256Digest(download.sha256Hex, expectedSha256)) {
      // [ulw] NIT-11：摘要不一致 = ChecksumMismatchError（候选级可恢复失败，梯次继续）。
      throw new ChecksumMismatchError(
        `跨源校验失败：${artifactFileName} 来自 ${candidateId}，摘要与校验源不一致`,
      );
    }
    succeeded = true;
    return { ok: true, downloadFilePath: downloadPath };
  } catch (error) {
    if (
      error instanceof UvDigestSourceUnavailableError ||
      error instanceof GitHubRateLimitError ||
      error instanceof NodeChecksumAnchorsUnavailableError ||
      error instanceof RuntimeVersionResolutionError
    ) {
      // 校验锚点级硬失败：明确抛出（typed），不进候选梯重试——换传输候选救不了死锚点。
      throw error;
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    // [ulw] MAJOR-2：暂存文件清理——可恢复失败（ok:false 返回）与锚点级 rethrow
    // 都会留下半写文件，任何非成功退出必须删除，防 `.download-*` 残留在
    // `<config>/.runtime` 根（成功路径由 install 编排在解压就位后清理）。
    if (!succeeded) {
      await rm(downloadPath, { force: true });
    }
  }
}

/** 冒烟（--version）：换 CURRENT 前的门（防指针指向坏版本的半状态）。 */
export async function smokeTestVersion(
  kind: LocalRuntimeKind,
  versionDir: string,
  deps: LocalRuntimeDeps,
): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const binaryPath = join(versionDir, resolveRuntimeBinaryRelativePath(kind, platform));
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      timeout: SMOKE_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    throw new LocalRuntimeInstallError(`--version 冒烟失败（${binaryPath}）：${String(error)}`);
  }
}
