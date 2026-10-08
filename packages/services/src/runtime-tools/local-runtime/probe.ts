/**
 * specs/agent-runtimes.md §4.1（镜像探测与择优）A2′ TS 实现：
 * 五类工件候选表 + 每候选一次 Range GET 探测编排 + 确定性择优纯函数。
 *
 * 设计边界（与 spec 对齐）：
 * - 候选表 = 五类工件各自独立（最快 PyPI ≠ 最快 node dist）；origin = 官方源；
 *   proxy/mirror 仅传输层，永不作校验来源（校验锚点见 verify.ts）。
 * - 探针只测传输延迟，不代表目标版本工件存在（tuna 陈旧坑由下载期跨源校验兜底）。
 * - 探针 URL 版本 = runtime.json 上一轮钉住版本；首轮无记录时用内置 known-good tag。
 * - 择优纯函数（rankMirrorCandidates）与 fetch 编排分离，前者可单测。
 */
import type { AppRuntimeArtifactClass } from "./runtime-json.js";

/** 单候选一次 Range GET 的探测记录（§4.1）；输入数组顺序 = 候选表顺序。 */
export interface ProbeMeasurement {
  readonly candidate: string;
  readonly isOrigin: boolean;
  readonly httpCode: number;
  readonly latencyMs: number;
  readonly ok: boolean;
}

export type MirrorRankOutcome =
  | { readonly winner: string; readonly reason: "origin-default" }
  | { readonly winner: string; readonly reason: "mirror-threshold" }
  | { readonly winner: string; readonly reason: "fastest-alive" }
  | { readonly winner: string; readonly reason: "tie-order" };

/** 探测超时（§4.1：`curl --max-time 5` 形的 TS 等价 = fetch + AbortController 5s）。 */
export const PROBE_TIMEOUT_MS = 5_000;
/** Range GET 首段字节数（§4.1 探测路径「前 64KB」）。 */
export const PROBE_RANGE_BYTES = 65_536;

/** 首轮无钉版记录时的内置 known-good 探针 tag（§4.1 探针版本来源；S1 技能同值）。 */
export const NODE_KNOWN_GOOD_PROBE_TAG = "v22.14.0";
export const UV_KNOWN_GOOD_PROBE_TAG = "0.8.6";

/** 单候选描述：id 即 runtime.json decisions/overrides 的取值域。 */
export interface MirrorCandidateSpec {
  readonly id: string;
  readonly isOrigin: boolean;
  /** tuna 为陈旧镜像：仅探测位，命中后下载期仍须校验版本存在。 */
  readonly probeOnly?: boolean;
  readonly buildProbeUrl: (version: string) => string;
  /** api.github.com 匿名调用需要自定义 UA（沿 adapters github-archive-source.ts:79 先例）。 */
  readonly headers?: Readonly<Record<string, string>>;
}

const NODE_DIST_ORIGIN = "https://nodejs.org/dist";
const NODE_DIST_NPMMIRROR = "https://registry.npmmirror.com/-/binary/node";
const NODE_DIST_TUNA = "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release";
const UV_RELEASE_ORIGIN_PATH = "https://github.com/astral-sh/uv/releases/download";
const GITHUB_API_BASE = "https://api.github.com";

/** 五类工件候选表（§4.1 表格逐行；顺序 = 平局规则依赖的候选表顺序）。 */
export const MIRROR_CANDIDATE_TABLES: Readonly<
  Record<AppRuntimeArtifactClass, readonly MirrorCandidateSpec[]>
> = {
  nodeDist: [
    {
      id: "nodejs.org",
      isOrigin: true,
      buildProbeUrl: (version) => `${NODE_DIST_ORIGIN}/${version}/SHASUMS256.txt`,
    },
    {
      id: "npmmirror",
      isOrigin: false,
      buildProbeUrl: (version) => `${NODE_DIST_NPMMIRROR}/${version}/SHASUMS256.txt`,
    },
    {
      id: "tuna",
      isOrigin: false,
      // tuna nodejs 镜像陈旧：仅探测位，命中须校验版本存在（下载期跨源校验兜底）。
      probeOnly: true,
      buildProbeUrl: (version) => `${NODE_DIST_TUNA}/${version}/SHASUMS256.txt`,
    },
  ],
  uvRelease: [
    {
      id: "github.com",
      isOrigin: true,
      buildProbeUrl: (version) => `${UV_RELEASE_ORIGIN_PATH}/${version}/sha256.sum`,
    },
    {
      id: "gh-proxy.com",
      isOrigin: false,
      buildProbeUrl: (version) =>
        `https://gh-proxy.com/${UV_RELEASE_ORIGIN_PATH}/${version}/sha256.sum`,
    },
    {
      id: "ghfast.top",
      isOrigin: false,
      buildProbeUrl: (version) =>
        `https://ghfast.top/${UV_RELEASE_ORIGIN_PATH}/${version}/sha256.sum`,
    },
  ],
  pypiIndex: [
    { id: "pypi.org", isOrigin: true, buildProbeUrl: () => "https://pypi.org/simple/" },
    {
      id: "tuna",
      isOrigin: false,
      buildProbeUrl: () => "https://pypi.tuna.tsinghua.edu.cn/simple/",
    },
    {
      id: "aliyun",
      isOrigin: false,
      buildProbeUrl: () => "https://mirrors.aliyun.com/pypi/simple/",
    },
    {
      id: "tencent",
      isOrigin: false,
      buildProbeUrl: () => "https://mirrors.cloud.tencent.com/pypi/simple/",
    },
  ],
  npmRegistry: [
    {
      id: "registry.npmjs.org",
      isOrigin: true,
      buildProbeUrl: () => "https://registry.npmjs.org/react",
    },
    {
      id: "registry.npmmirror.com",
      isOrigin: false,
      buildProbeUrl: () => "https://registry.npmmirror.com/react",
    },
  ],
  pbsMirror: [
    {
      id: "registry.npmmirror.com",
      isOrigin: false,
      buildProbeUrl: () => "https://registry.npmmirror.com/-/binary/python-build-standalone/",
    },
    {
      id: "github.com",
      isOrigin: true,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Zodex-Local-Runtime" },
      buildProbeUrl: () =>
        `${GITHUB_API_BASE}/repos/astral-sh/python-build-standalone/releases/latest`,
    },
  ],
};

/** 全灭明确报错（§4.1 规则 4）：给出手工覆盖位提示，不静默选不可用源。 */
export class AllProbeCandidatesDeadError extends Error {
  /**
   * 归属工件类。[ulw] NIT-10：raw 调用（rankMirrorCandidates）不知道类别，置
   * `null`；真实类别由 probeArtifactClass 的重映射保证（其构造点持有 artifactClass）。
   */
  constructor(
    readonly artifactClass: AppRuntimeArtifactClass | null,
    message: string,
  ) {
    super(message);
    this.name = "AllProbeCandidatesDeadError";
  }
}

/**
 * 择优规则（§4.1，确定性；纯函数，不触网）：
 * 1. origin 存活时，mirror/proxy 仅当 latency(mirror) ≤ 0.6 × latency(origin) 才胜出；
 * 2. origin 失败/超时 → 存活候选中最快者胜；
 * 3. 平局（±10%）→ 候选表顺序（输入数组顺序）靠前者胜；
 * 4. 全灭 → 明确抛错（不静默选不可用源）。
 */
export function rankMirrorCandidates(measurements: readonly ProbeMeasurement[]): MirrorRankOutcome {
  const alive = measurements.filter((entry) => entry.ok);
  if (alive.length === 0) {
    // [ulw] NIT-10：raw 调用不硬编码工件类（曾误写 nodeDist）——类别无关报错，
    // 由 probeArtifactClass 携真实 artifactClass 重抛。
    throw new AllProbeCandidatesDeadError(
      null,
      "probe: all mirror candidates failed; 手工覆盖位 = runtime.json overrides 字段（--base 语义）",
    );
  }
  const origin = alive.find((entry) => entry.isOrigin);
  let pool: readonly ProbeMeasurement[];
  let baseReason: "mirror-threshold" | "fastest-alive";
  if (origin) {
    const threshold = 0.6 * origin.latencyMs;
    const qualifyingMirrors = alive.filter(
      (entry) => entry !== origin && entry.latencyMs <= threshold,
    );
    if (qualifyingMirrors.length === 0) {
      return { winner: origin.candidate, reason: "origin-default" };
    }
    pool = qualifyingMirrors;
    baseReason = "mirror-threshold";
  } else {
    pool = alive;
    baseReason = "fastest-alive";
  }
  const minLatencyMs = Math.min(...pool.map((entry) => entry.latencyMs));
  // 平局带：与最快者相差 ≤10% 视为平局 → 取输入顺序（候选表顺序）靠前者，保证确定性。
  const tieBand = pool.filter((entry) => entry.latencyMs <= minLatencyMs * 1.1);
  const winner = tieBand[0];
  if (!winner) {
    // [ulw] NIT-10：同上——raw 调用类别无关，重映射归 probeArtifactClass。
    throw new AllProbeCandidatesDeadError(null, "probe: no alive candidate in tie band");
  }
  const reason = winner.latencyMs > minLatencyMs ? "tie-order" : baseReason;
  return { winner: winner.candidate, reason };
}

export interface ProbeFetchOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

/** 单候选一次 Range GET（首 64KB；206/200 皆可；失败/超时 = 淘汰）。 */
export async function probeCandidate(
  spec: MirrorCandidateSpec,
  version: string,
  options: ProbeFetchOptions = {},
): Promise<ProbeMeasurement> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(spec.buildProbeUrl(version), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Range: `bytes=0-${PROBE_RANGE_BYTES - 1}`,
        ...spec.headers,
        ...options.headers,
      },
    });
    const latencyMs = Date.now() - startedAt;
    const ok = response.status === 200 || response.status === 206;
    // 只取状态与延迟即可判定，body 立即释放（小请求，无需消费内容）。
    await response.body?.cancel().catch(() => undefined);
    return {
      candidate: spec.id,
      isOrigin: spec.isOrigin,
      httpCode: response.status,
      latencyMs,
      ok,
    };
  } catch {
    return {
      candidate: spec.id,
      isOrigin: spec.isOrigin,
      httpCode: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ArtifactClassProbeResult {
  readonly artifactClass: AppRuntimeArtifactClass;
  readonly measurements: readonly ProbeMeasurement[];
  readonly outcome: MirrorRankOutcome;
}

/** 单类工件探测：候选表全量并行各一次 Range GET，再走确定性择优。 */
export async function probeArtifactClass(
  artifactClass: AppRuntimeArtifactClass,
  version: string,
  options: ProbeFetchOptions = {},
): Promise<ArtifactClassProbeResult> {
  const specs = MIRROR_CANDIDATE_TABLES[artifactClass];
  const measurements = await Promise.all(
    specs.map((spec) => probeCandidate(spec, version, options)),
  );
  try {
    return { artifactClass, measurements, outcome: rankMirrorCandidates(measurements) };
  } catch (error) {
    if (error instanceof AllProbeCandidatesDeadError) {
      throw new AllProbeCandidatesDeadError(
        artifactClass,
        `probe(${artifactClass}): 所有候选探测失败；手工覆盖位 = runtime.json overrides 字段（--base 语义）`,
      );
    }
    throw error;
  }
}
