/**
 * specs/agent-runtimes.md §4.2（版本解析）/§4.6（install 行：上游版本解析）网络腿：
 * node dist index.json（origin 优先、npmmirror 同名文件兜底）、uv GitHub API
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

/** node 上游版本解析：origin `dist/index.json` 小文件 → npmmirror 同名文件兜底。 */
export async function resolveLatestNodeVersion(
  options: UpstreamFetchOptions = {},
): Promise<string> {
  for (const url of [`${NODE_DIST_ORIGIN}/index.json`, `${NODE_DIST_NPMMIRROR}/index.json`]) {
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
}

/**
 * 流式下载 + 边读边算 sha256（一次性返回摘要，供跨源校验复用，避免二次读盘）。
 * 总超时 via AbortController（具名常量 DOWNLOAD_TIMEOUT_MS）。
 * 半写文件清理归调用方（install 编排持有下载 tmp 路径的所有权）。
 */
export async function downloadArtifactToFile(
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
  const writeChunk = async (chunk: Uint8Array, totalBytes: number | null): Promise<void> => {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    hash.update(buffer);
    bytes += buffer.byteLength;
    options.onProgress?.({ bytes, totalBytes });
    if (!sink.write(buffer)) {
      await once(sink, "drain");
    }
  };
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new ArtifactDownloadError(`download failed: HTTP ${response.status} (${url})`);
    }
    // content-length 在代理/镜像腿常缺失或与实际不符：仅作进度提示，不参与校验。
    const headerValue = Number(response.headers.get("content-length"));
    const totalBytes = Number.isFinite(headerValue) && headerValue > 0 ? headerValue : null;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      await writeChunk(chunk, totalBytes);
    }
    return { sha256Hex: hash.digest("hex"), bytes };
  } catch (error) {
    if (error instanceof ArtifactDownloadError) throw error;
    throw new ArtifactDownloadError(`download failed: ${String(error)} (${url})`);
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => sink.end(() => resolve()));
    await finished(sink).catch(() => undefined);
  }
}
