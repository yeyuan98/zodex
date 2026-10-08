/**
 * specs/agent-runtimes.md §4.2（版本解析与跨源校验）/§4.7（校验锚点）A2′ TS 实现：
 * 校验来源选择（跨源不变量）+ 锚点不可达明确报错（不降级为无校验）+
 * SHASUMS256.txt 解析与摘要比对（纯函数）。
 *
 * 不变量：tarball 来自 X，校验值必来自**另一源**——node：SHASUMS256.txt 取自
 * 「nodejs.org ↔ npmmirror」中的另一方（tuna 永不作校验来源）；uv：GitHub API
 * asset digest 恒直连 api.github.com；gh-proxy/ghfast 系只作传输，永不作校验来源。
 */
import { timingSafeEqual } from "node:crypto";

export type NodeDistSource = "nodejs.org" | "npmmirror" | "tuna";

/** node 校验锚点对（§4.7）：SHASUMS256.txt 只从这一对取，tuna 永不作校验来源。 */
export type NodeChecksumAnchor = "nodejs.org" | "npmmirror";

/** node 双锚点均不可达 = 明确报错（与 uv api.github.com 规则对称，§4.7）。 */
export class NodeChecksumAnchorsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeChecksumAnchorsUnavailableError";
  }
}

/** uv 校验锚点 api.github.com 不可达 = 明确报错（不降级为无校验）。 */
export class UvDigestSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UvDigestSourceUnavailableError";
  }
}

/** 校验失败（摘要不匹配）= 拒绝落盘的明确报错。 */
export class ChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumMismatchError";
  }
}

/**
 * node 跨源校验选择：tarball 来自 X → SHASUMS256.txt 取 nodejs.org↔npmmirror 中的
 * **另一方**；X ∈ 锚点对时返回另一侧；X = tuna（仅探测位）→ 仍从锚点对取
 * （tuna **永不作校验来源**——确定性取 npmmirror：tuna 可达时同区域的 npmmirror
 * 可达概率最高，且满足「校验值来自非 tarball 源」的跨源语义）。
 */
export function selectNodeChecksumSource(tarballSource: NodeDistSource): NodeChecksumAnchor | null {
  switch (tarballSource) {
    case "nodejs.org":
      return "npmmirror";
    case "npmmirror":
      return "nodejs.org";
    case "tuna":
      return "npmmirror";
    default:
      return null;
  }
}

/**
 * node 双锚点均不可达 = 明确抛错（与 uv api.github.com 规则对称，§4.7）；
 * 任一锚点可达即通过。
 */
export function assertNodeChecksumAnchorsAvailable(
  reachable: Readonly<Record<NodeChecksumAnchor, boolean>>,
): void {
  if (!reachable["nodejs.org"] && !reachable.npmmirror) {
    throw new NodeChecksumAnchorsUnavailableError(
      "node 校验双锚点（nodejs.org + npmmirror）均不可达：明确报错、不降级为无校验；请稍后重试或走 ws 级技能",
    );
  }
}

/**
 * uv 校验锚点：asset digest 恒直连 api.github.com；不可达 = 明确抛错并提示稍后
 * 重试/走 ws 级技能，**不降级为无校验**。
 */
export function resolveUvDigestSource(apiGithubReachable: boolean): {
  digestSource: string;
} {
  if (!apiGithubReachable) {
    throw new UvDigestSourceUnavailableError(
      "uv 校验锚点 api.github.com 不可达：明确报错、绝不降级为无校验；请稍后重试或走 ws 级技能",
    );
  }
  return { digestSource: "api.github.com" };
}

/**
 * SHASUMS256.txt 解析（纯函数）：`<sha256>  <filename>` 行 → filename→sha256 映射。
 * 容忍 \r\n 与多余空白； malformed 行跳过（不猜）。
 */
export function parseShasums256(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([0-9a-fA-F]{64})\s+(\S.+)$/u.exec(line);
    if (!match) continue;
    const [, sha256, fileName] = match;
    if (sha256 && fileName) {
      map.set(fileName.trim(), sha256.toLowerCase());
    }
  }
  return map;
}

/** 从 SHASUMS 映射取目标工件期望摘要；缺失 = null（调用方必须明确报错，不猜）。 */
export function resolveExpectedSha256(
  shasums: ReadonlyMap<string, string>,
  artifactFileName: string,
): string | null {
  return shasums.get(artifactFileName) ?? null;
}

/** 摘要比对（纯函数）：大小写归一 + 长度校验 + timingSafeEqual。 */
export function compareSha256Digest(actualHex: string, expectedHex: string): boolean {
  const actual = actualHex.trim().toLowerCase();
  const expected = expectedHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(actual) || !/^[0-9a-f]{64}$/u.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/**
 * GitHub API asset digest 解析（uv）：assets[].digest 形如 "sha256:<hex>"。
 * 缺失 digest = null（调用方明确报错，不降级为无校验）。
 */
export function resolveUvAssetDigest(
  assets: readonly { readonly name?: unknown; readonly digest?: unknown }[],
  assetFileName: string,
): string | null {
  for (const asset of assets) {
    if (asset.name !== assetFileName) continue;
    if (typeof asset.digest !== "string") return null;
    const hex = asset.digest
      .replace(/^sha256:/u, "")
      .trim()
      .toLowerCase();
    return /^[0-9a-f]{64}$/u.test(hex) ? hex : null;
  }
  return null;
}
