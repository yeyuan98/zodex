/**
 * specs/agent-runtimes.md §4.2（跨源校验）/§4.1（次优顺位重试）候选下载腿：
 * 候选梯构建（override 位不回落）+ 下载 + 跨源校验（node SHASUMS 锚点对另一方 /
 * uv api.github.com digest）+ 冒烟（--version）。
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

/** 候选梯（次优顺位重试，§4.1）：override 位只含 override 候选（硬失败不回落）。 */
export function buildCandidateLadder(
  artifactClass: AppRuntimeArtifactClass,
  json: AppRuntimeJson,
): { readonly candidates: readonly string[]; readonly isOverrideSlot: boolean } {
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
  return { candidates: [primary, ...ranked, ...fallback], isOverrideSlot: false };
}

async function fetchNodeExpectedSha256(
  candidateId: string,
  version: string,
  artifactFileName: string,
  deps: LocalRuntimeDeps,
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
    const result = await fetchNodeShasumsText(anchor, version, fetchOptionsFor(deps));
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
    const download = await downloadArtifactToFile(url, downloadPath, {
      ...fetchOptionsFor(deps),
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
    let expectedSha256: string | null = null;
    if (kind === "node") {
      expectedSha256 = await fetchNodeExpectedSha256(candidateId, version, artifactFileName, deps);
    } else {
      // uv digest 恒直连 api.github.com（§4.7）：不可达/限流由 upstream 抛 typed 错误，
      // 绝不降级为无校验、也不从 gh-proxy 系取校验值。
      const metadata = await fetchUvReleaseMetadata(version, fetchOptionsFor(deps));
      // [ulw] NIT-11：digest 解析路由经 resolveUvDigestSource（锚点恒
      // api.github.com；上行 fetchUvReleaseMetadata 已直连，不可达时已抛 typed 错）。
      const { digestSource } = resolveUvDigestSource(true);
      expectedSha256 = resolveUvAssetDigest(metadata.assets, artifactFileName);
      if (!expectedSha256) {
        throw new LocalRuntimeInstallError(
          `uv 校验源 ${digestSource} release 资产摘要缺席：${artifactFileName}（不降级为无校验）`,
        );
      }
    }
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
