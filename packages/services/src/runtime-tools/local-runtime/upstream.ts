/**
 * specs/agent-runtimes.md §4.2（版本解析）/§4.6（install 行：上游版本解析）网络腿：
 * node dist index.json（探测决策回填源序：origin 优先、npmmirror 同名文件兜底；
 * F2 alpha.3 起 origin 探活死时先 npmmirror）、uv GitHub API
 * latest（匿名 + 自定义 UA，沿 adapters github-archive-source.ts:79 先例）、
 * 工件下载（流式 + AbortController 超时 + 进度回调）与 URL 构造。
 *
 * npmmirror `latest-*` 目录陈旧（实测坑，§4.2）——只允许 index.json 文件级兜底。
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { NodeChecksumAnchor } from "./verify.js";

/** 下载总超时（大工件；远大于探测 5s——具名常量，§4.1/W5 任务约束）。 */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** 元数据（index.json / GitHub API / SHASUMS）拉取超时。 */
export const METADATA_FETCH_TIMEOUT_MS = 20_000;
/**
 * 闲置看门狗阈值（§4.7 F1；owner 裁定 D2 = 固定有名常量、不做配置）：收到首 chunk 后
 * 连续 8s 无新 chunk → abort 该候选下载。依据（§2o 取证）：npmmirror 停滞时干等
 * DOWNLOAD_TIMEOUT_MS（600s）占单次安装时长 95.1%——坏候选必须在秒级放弃换梯次。
 * 首 chunk 前不起表（TTFB 慢 = CN→origin 常态，MINOR-5b，由总超时管）。
 */
const DOWNLOAD_STALL_IDLE_MS = 8_000;
/**
 * 速度下限宽限（自首 chunk 到达起算，D2 固定）：15s 内不限速——TCP 慢启动不罚
 * （MINOR-5a），此后按滑动窗口平均速度判。
 */
const DOWNLOAD_SPEED_GRACE_MS = 15_000;
/** 滑动窗口速度下限（D2 固定）：宽限期后窗口平均速度 < 256KB/s → abort。 */
const DOWNLOAD_SPEED_FLOOR_BYTES_PER_SEC = 256 * 1024;
/** 速度滑动窗口长度（D2 固定）：以 chunk 到达时刻为界回看不超过 10s 的字节积分区间。 */
const DOWNLOAD_SPEED_WINDOW_MS = 10_000;
/**
 * 看门狗定时器轮询粒度：非 D2 失速语义参数，仅为定时器节奏（评估时机② = 每次该
 * 定时器触发，§4.7）；远小于闲置阈值 8s 与窗口 10s，使失速判定附加延迟 ≤1s 量级。
 */
const DOWNLOAD_WATCHDOG_TICK_MS = 1_000;

const NODE_DIST_ORIGIN = "https://nodejs.org/dist";
const NODE_DIST_NPMMIRROR = "https://registry.npmmirror.com/-/binary/node";
const UV_RELEASE_ORIGIN_PATH = "https://github.com/astral-sh/uv/releases/download";
const GITHUB_API_BASE = "https://api.github.com";
const UV_REPO = "astral-sh/uv";
/** api.github.com 匿名调用 UA（仓内无带认证 REST 客户端；60 req/h 对偶发检查足够）。 */
const GITHUB_ANONYMOUS_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Zodex-Local-Runtime",
} as const;

export class RuntimeVersionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeVersionResolutionError";
  }
}

/** GitHub API 匿名限流（60 req/h）命中 = 明确报错稍后重试（§4.7）。 */
export class GitHubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

export class ArtifactDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDownloadError";
  }
}

export interface UpstreamFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function normalizePlatformOs(platform: NodeJS.Platform): string {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "darwin";
  return "linux";
}

function normalizeNodeArch(arch: NodeJS.Architecture): string {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return arch;
}

async function fetchText(
  url: string,
  options: UpstreamFetchOptions & { readonly headers?: Readonly<Record<string, string>> },
): Promise<{ readonly ok: boolean; readonly status: number; readonly text: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? METADATA_FETCH_TIMEOUT_MS,
  );
  try {
    // [ulw] NIT-8：GitHub 匿名头（Accept/UA）只发给 api.github.com——发往
    // nodejs.org/npmmirror 等镜像/发行站既无必要，也可能扰动其 CDN 缓存键。
    const isGitHubApi = url.startsWith(GITHUB_API_BASE);
    const headers = isGitHubApi
      ? { ...GITHUB_ANONYMOUS_HEADERS, ...options.headers }
      : { ...options.headers };
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

function parseLatestStableNodeVersion(indexJsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexJsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // index.json 新版本在前；只接受精确 vX.Y.Z（滤掉 nightly/v8-canary 等通道）。
  const entry = parsed.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { version?: unknown }).version === "string" &&
      /^v\d+\.\d+\.\d+$/u.test((item as { version: string }).version),
  ) as { version?: string } | undefined;
  return entry?.version ?? null;
}

export interface NodeVersionResolutionOptions extends UpstreamFetchOptions {
  /**
   * F2 解析顺序回填（§4.2/§4.1，alpha.3）：探测轮 nodeDist 有效决策源
   * （override ?? probed）。非 origin（nodejs.org 探活死或镜像胜出）时 index.json
   * 先咨询 npmmirror 同名文件、origin 降为兜底——消除「探测已判死、解析仍先撞
   * origin 挂起」的 CN ~20s 税（§2o：代码推导值，非 log 实测）。缺省/origin 决策
   * 维持 origin 优先；npmmirror `latest-*` 目录陈旧禁用不变（仅 index.json 文件级
   * 换序，兜底顺序仍是同两名文件）。
   */
  readonly preferredNodeDistCandidate?: string;
}

/** node 上游版本解析：origin `dist/index.json` 小文件 → npmmirror 同名文件兜底。 */
export async function resolveLatestNodeVersion(
  options: NodeVersionResolutionOptions = {},
): Promise<string> {
  const indexUrls =
    options.preferredNodeDistCandidate !== undefined &&
    options.preferredNodeDistCandidate !== "nodejs.org"
      ? [`${NODE_DIST_NPMMIRROR}/index.json`, `${NODE_DIST_ORIGIN}/index.json`]
      : [`${NODE_DIST_ORIGIN}/index.json`, `${NODE_DIST_NPMMIRROR}/index.json`];
  for (const url of indexUrls) {
    const result = await fetchText(url, options);
    if (!result.ok) continue;
    const version = parseLatestStableNodeVersion(result.text);
    if (version) return version;
  }
  throw new RuntimeVersionResolutionError(
    "node 版本解析失败：nodejs.org 与 npmmirror 的 dist/index.json 均不可用/不可解析",
  );
}

export interface UvReleaseMetadata {
  readonly tag: string;
  readonly assets: readonly { readonly name?: unknown; readonly digest?: unknown }[];
}

/** uv release 元数据（tag + asset digest）：恒直连 api.github.com（§4.7 校验锚点）。 */
export async function fetchUvReleaseMetadata(
  tag: string,
  options: UpstreamFetchOptions = {},
): Promise<UvReleaseMetadata> {
  const url = `${GITHUB_API_BASE}/repos/${UV_REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const result = await fetchText(url, options);
  if (result.status === 403 || result.status === 429) {
    throw new GitHubRateLimitError(
      "GitHub API 匿名限流（60 req/h）命中：稍后重试；或走 ws 级 zcode-workspace-runtimes 技能",
    );
  }
  if (!result.ok) {
    throw new RuntimeVersionResolutionError(
      `uv 校验锚点 api.github.com 不可达（${url}）：明确报错、不降级为无校验`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new RuntimeVersionResolutionError("uv release 元数据不可解析（api.github.com）");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { tag_name?: unknown }).tag_name !== "string" ||
    !Array.isArray((parsed as { assets?: unknown }).assets)
  ) {
    throw new RuntimeVersionResolutionError("uv release 元数据形状不符（api.github.com）");
  }
  const record = parsed as { tag_name: string; assets: unknown[] };
  return {
    tag: record.tag_name.replace(/^v/u, ""),
    assets: record.assets as UvReleaseMetadata["assets"],
  };
}

/** uv 上游版本解析：GitHub API latest（匿名）。 */
export async function resolveLatestUvVersion(options: UpstreamFetchOptions = {}): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${UV_REPO}/releases/latest`;
  const result = await fetchText(url, options);
  if (result.status === 403 || result.status === 429) {
    throw new GitHubRateLimitError(
      "GitHub API 匿名限流（60 req/h）命中：稍后重试；或走 ws 级 zcode-workspace-runtimes 技能",
    );
  }
  if (!result.ok) {
    throw new RuntimeVersionResolutionError(
      "uv 版本解析失败：api.github.com latest release 不可达",
    );
  }
  try {
    const parsed = JSON.parse(result.text) as { tag_name?: unknown };
    if (typeof parsed.tag_name !== "string" || !parsed.tag_name) {
      throw new Error("missing tag_name");
    }
    return parsed.tag_name.replace(/^v/u, "");
  } catch {
    throw new RuntimeVersionResolutionError("uv latest release 响应不可解析（api.github.com）");
  }
}

export function buildNodeArtifactFileName(
  version: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string {
  const os = normalizePlatformOs(platform);
  const ext = platform === "win32" ? "zip" : "tar.xz";
  return `node-${version}-${os}-${normalizeNodeArch(arch)}.${ext}`;
}

export function buildUvTriple(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  if (platform === "win32")
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (platform === "darwin")
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

export function buildUvArtifactFileName(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string {
  return `uv-${buildUvTriple(platform, arch)}.${platform === "win32" ? "zip" : "tar.gz"}`;
}

/** node tarball 下载 URL（candidateId ∈ probe 候选表 nodeDist 取值域）。 */
export function buildNodeDownloadUrl(
  candidateId: string,
  version: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string {
  const bases: Readonly<Record<string, string>> = {
    "nodejs.org": NODE_DIST_ORIGIN,
    npmmirror: NODE_DIST_NPMMIRROR,
    tuna: "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release",
  };
  const base = bases[candidateId];
  if (!base) throw new ArtifactDownloadError(`unknown nodeDist candidate: ${candidateId}`);
  return `${base}/${version}/${buildNodeArtifactFileName(version, platform, arch)}`;
}

/** node SHASUMS256.txt URL（锚点对内取值；tuna 永不作校验来源——verify.ts 选择）。 */
export function buildNodeShasumsUrl(anchor: NodeChecksumAnchor, version: string): string {
  const base = anchor === "nodejs.org" ? NODE_DIST_ORIGIN : NODE_DIST_NPMMIRROR;
  return `${base}/${version}/SHASUMS256.txt`;
}

/** node SHASUMS256.txt 拉取（小文件整取；返回可达性与文本，判定归调用方）。 */
export async function fetchNodeShasumsText(
  anchor: NodeChecksumAnchor,
  version: string,
  options: UpstreamFetchOptions = {},
): Promise<{ readonly ok: boolean; readonly status: number; readonly text: string }> {
  return fetchText(buildNodeShasumsUrl(anchor, version), options);
}

/** uv 工件下载 URL（origin 直链；gh-proxy/ghfast = `<proxy>/<origin-url>` 传输形态）。 */
export function buildUvDownloadUrl(
  candidateId: string,
  version: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string {
  const originUrl = `${UV_RELEASE_ORIGIN_PATH}/${version}/${buildUvArtifactFileName(platform, arch)}`;
  if (candidateId === "github.com") return originUrl;
  if (candidateId === "gh-proxy.com") return `https://gh-proxy.com/${originUrl}`;
  if (candidateId === "ghfast.top") return `https://ghfast.top/${originUrl}`;
  throw new ArtifactDownloadError(`unknown uvRelease candidate: ${candidateId}`);
}

export interface DownloadArtifactOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: {
    readonly bytes: number;
    readonly totalBytes: number | null;
  }) => void;
  /**
   * F1 梯次末位候选豁免速度下限（specs/agent-runtimes.md §4.7 MINOR-5c，alpha.3）：
   * true 时仅豁免【速度下限】——闲置看门狗（8s 无新 chunk）与 DOWNLOAD_TIMEOUT_MS
   * 总上限仍照常生效。旗标由安装编排按梯次位置传入（末位元素）；独立调用下载函数
   * 不豁免（缺省 false），慢速涓流照旧被下限处死让位梯次。
   */
  readonly exemptSpeedFloor?: boolean;
}

/** 速度窗口积分用：一次 chunk 到达（时刻 = 流 yield 处，pre-sink-write——MINOR-15）。 */
interface ChunkArrivalRecord {
  readonly at: number;
  readonly bytes: number;
}

/**
 * 流式下载 + 边读边算 sha256（一次性返回摘要，供跨源校验复用，避免二次读盘）。
 * 总超时 via AbortController（具名常量 DOWNLOAD_TIMEOUT_MS）。
 *
 * F1 下载失速看门狗（specs/agent-runtimes.md §4.7，alpha.3）：闲置看门狗（首 chunk
 * 后 8s 无新 chunk）+ 速度下限（首 chunk 起 15s 宽限后，10s 滑动窗口平均速度
 * < 256KB/s）→ abort 该候选，让既有梯次推进；失速 abort 经由同一 AbortController，
 * 抛出的 ArtifactDownloadError 文案可区分失速类型并携带统计（累计字节/时长/窗口速度，
 * §4.7 观测——install 侧后续落 warn，本层先由错误文案承载）。
 * 梯次末位候选豁免速度下限（MINOR-5c）经 options.exemptSpeedFloor 由安装编排按
 * 梯次位置传入；本函数仍不感知梯次，仅按旗标跳过速度下限评估。
 *
 * 半写文件清理归调用方（install 编排持有下载 tmp 路径的所有权）。
 *
 * 预挂 no-op 拒绝 continuation 的原因：失速/总超时 abort 在看门狗触发当刻就把
 * 返回 promise 置为 rejected，而调用方挂接观察者可能晚于该刻（本仓测试先驱动假想
 * 时钟、再在 race 中观察结果；abort → 观察之间隔着若干宏任务轮）。Node 以「turn 末
 * 仍无 handler」判定 unhandledRejection，会把这种必然被处理的拒绝误报为未处理。
 * 预挂的 no-op catch 只把该 promise 标记为 handled，不改变其状态——调用方随后
 * attach 的 then/catch 仍照常收到拒绝/兑现。
 */
export function downloadArtifactToFile(
  url: string,
  destPath: string,
  options: DownloadArtifactOptions = {},
): Promise<{ readonly sha256Hex: string; readonly bytes: number }> {
  const outcome = runArtifactDownload(url, destPath, options);
  outcome.catch(() => undefined);
  return outcome;
}

async function runArtifactDownload(
  url: string,
  destPath: string,
  options: DownloadArtifactOptions = {},
): Promise<{ readonly sha256Hex: string; readonly bytes: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const hash = createHash("sha256");
  const sink = createWriteStream(destPath);
  let bytes = 0;
  const startedAt = Date.now();
  let firstChunkAt: number | null = null;
  let lastChunkAt: number | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let stallAbortMessage: string | null = null;
  const chunkArrivals: ChunkArrivalRecord[] = [];

  // 滑动窗口速度（§4.7 A 项窗口度量钉死）：以评估时刻为界，回看起点 =
  // max(首 chunk 时刻, 评估时刻 − 窗口长度)，窗口速度 = 区间内到达 chunk 字节总和 ÷
  // 区间实际跨度（非累计平均）。跨度为 0（评估点即首 chunk 时刻）时速度无定义，不判。
  const windowSpeedAt = (
    now: number,
  ): {
    readonly spanMs: number;
    readonly windowBytes: number;
    readonly bytesPerSec: number;
  } | null => {
    if (firstChunkAt === null) return null;
    const windowStart = Math.max(firstChunkAt, now - DOWNLOAD_SPEED_WINDOW_MS);
    const spanMs = now - windowStart;
    if (spanMs <= 0) return null;
    let windowBytes = 0;
    for (const arrival of chunkArrivals) {
      if (arrival.at >= windowStart) windowBytes += arrival.bytes;
    }
    return { spanMs, windowBytes, bytesPerSec: (windowBytes * 1000) / spanMs };
  };

  const abortForStall = (message: string): void => {
    if (stallAbortMessage !== null) return;
    stallAbortMessage = message;
    controller.abort();
  };

  // 速度下限评估：宽限（自首 chunk 到达起 15s）内不罚 TCP 慢启动；此后窗口平均速度
  // 低于下限 → abort（评估时机①新 chunk 到达 / ②看门狗定时器触发，§4.7）。
  const evaluateSpeedFloor = (now: number): void => {
    // 末位候选豁免（§4.7 MINOR-5c）：OFF 直连 origin 的慢速真实下载不被下限处死
    // （慢好过没有）——仅此一项豁免；闲置看门狗与 DOWNLOAD_TIMEOUT_MS 总上限在
    // 本函数外照常生效。旗标由安装编排按梯次位置传入，独立调用缺省不豁免。
    if (options.exemptSpeedFloor === true) return;
    if (firstChunkAt === null || now - firstChunkAt < DOWNLOAD_SPEED_GRACE_MS) return;
    const snapshot = windowSpeedAt(now);
    if (snapshot === null || snapshot.bytesPerSec >= DOWNLOAD_SPEED_FLOOR_BYTES_PER_SEC) return;
    abortForStall(
      `download stalled (speed): 滑动窗口（${snapshot.spanMs}ms 内 ${snapshot.windowBytes}B）` +
        `平均速度 ${Math.round(snapshot.bytesPerSec)}B/s < 下限 ${DOWNLOAD_SPEED_FLOOR_BYTES_PER_SEC}B/s` +
        `（宽限 ${DOWNLOAD_SPEED_GRACE_MS}ms 后起判）；累计 ${bytes}B / 已耗时 ${now - startedAt}ms /` +
        ` 窗口速度 ${Math.round(snapshot.bytesPerSec)}B/s (${url})`,
    );
  };

  const onWatchdogTick = (): void => {
    if (stallAbortMessage !== null) return;
    const now = Date.now();
    if (lastChunkAt !== null && now - lastChunkAt >= DOWNLOAD_STALL_IDLE_MS) {
      const snapshot = windowSpeedAt(now);
      abortForStall(
        `download stalled (idle): 距上一 chunk ${now - lastChunkAt}ms 无新增` +
          `（阈值 ${DOWNLOAD_STALL_IDLE_MS}ms）；累计 ${bytes}B / 已耗时 ${now - startedAt}ms /` +
          ` 窗口速度 ${snapshot === null ? 0 : Math.round(snapshot.bytesPerSec)}B/s (${url})`,
      );
      return;
    }
    evaluateSpeedFloor(now);
    if (!controller.signal.aborted) {
      watchdogTimer = setTimeout(onWatchdogTick, DOWNLOAD_WATCHDOG_TICK_MS);
    }
  };

  const recordChunkArrival = (byteLength: number, arrivedAt: number): void => {
    if (firstChunkAt === null) {
      firstChunkAt = arrivedAt;
      lastChunkAt = arrivedAt;
      // 看门狗定时器链自首 chunk 起表；首 chunk 前无任何失速判定（MINOR-5b：慢 TTFB
      // 不误杀，由 DOWNLOAD_TIMEOUT_MS 总超时管）。
      watchdogTimer = setTimeout(onWatchdogTick, DOWNLOAD_WATCHDOG_TICK_MS);
    } else {
      lastChunkAt = arrivedAt;
    }
    chunkArrivals.push({ at: arrivedAt, bytes: byteLength });
    // 窗口剪裁：早于（当前时刻 − 窗口长度）的到达记录不可能再进入任何后续回看区间。
    const trimBefore = arrivedAt - DOWNLOAD_SPEED_WINDOW_MS;
    while (chunkArrivals[0] !== undefined && chunkArrivals[0].at < trimBefore) {
      chunkArrivals.shift();
    }
    evaluateSpeedFloor(arrivedAt);
  };

  const writeChunk = async (chunk: Uint8Array, totalBytes: number | null): Promise<void> => {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    hash.update(buffer);
    bytes += buffer.byteLength;
    options.onProgress?.({ bytes, totalBytes });
    if (!sink.write(buffer)) {
      // MINOR-15 披露（不改）：drain 阻塞中不观察 abort——与既有总超时同形的已知潜伏
      // 问题；chunk 时间戳已在流 yield 处先于本函数取好，磁盘背压不计入网络闲置/窗口速度。
      await once(sink, "drain");
    }
  };
  let stallFastFail = false;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new ArtifactDownloadError(`download failed: HTTP ${response.status} (${url})`);
    }
    // content-length 在代理/镜像腿常缺失或与实际不符：仅作进度提示，不参与校验。
    const headerValue = Number(response.headers.get("content-length"));
    const totalBytes = Number.isFinite(headerValue) && headerValue > 0 ? headerValue : null;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      // MINOR-15：chunk 时间戳在流 yield 处取（pre-sink-write）——磁盘 drain 背压不算
      // 网络闲置、不拖慢窗口速度。
      recordChunkArrival(chunk.byteLength, Date.now());
      await writeChunk(chunk, totalBytes);
    }
    return { sha256Hex: hash.digest("hex"), bytes };
  } catch (error) {
    if (stallAbortMessage !== null) {
      // 失速 abort 的错误须可与普通网络失败区分并携带统计（§4.7 观测），供 install
      // 编排落 warn + 全候选失败时聚合速度摘要（后续 phase；本层先由文案承载）。
      stallFastFail = true;
      throw new ArtifactDownloadError(stallAbortMessage);
    }
    if (error instanceof ArtifactDownloadError) throw error;
    throw new ArtifactDownloadError(`download failed: ${String(error)} (${url})`);
  } finally {
    clearTimeout(timer);
    if (watchdogTimer !== null) clearTimeout(watchdogTimer);
    if (stallFastFail) {
      // 失速快速失败：拒绝不得排队等 fs 关闭链（end→write flush→finish→close 均为真实
      // IO，线程池在 CI 并发抢占下墙钟可达数十 ms，会把秒级失速 abort 的拒绝拖出调用
      // 方的观察窗口）。半写文件本就要被编排层删除：这里同步 destroy 丢弃缓冲、后台
      // 收 fd；调用方 rm 与 fd 关闭的竞态由 libuv 打开句柄的 FILE_SHARE_DELETE 语义
      // （POSIX 下 unlink-while-open 同义恒安全）覆盖。成功/其余失败路径维持既有
      // 「settle 前流已收尾」的严格语义不变（数据完整/行为与总超时路径同形）。
      // 注意：destroy 只能在消费方自身的 catch 里发起——若在定时器回调（消费方可能
      // 正挂起在 drain 等待中）发起，drain 永不再触发会把「abort 延迟观察」恶化成
      // 永久挂起（MINOR-15 披露的潜伏形状只允许延迟、不允许挂死）。
      sink.destroy();
      void finished(sink).catch(() => undefined);
    } else {
      await new Promise<void>((resolve) => sink.end(() => resolve()));
      await finished(sink).catch(() => undefined);
    }
  }
}
