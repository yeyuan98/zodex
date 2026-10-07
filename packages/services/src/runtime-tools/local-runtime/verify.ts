/**
 * specs/agent-runtimes.md §4.2（版本解析与跨源校验）/§4.7（校验锚点）纯函数契约：
 * 校验来源选择 + 锚点不可达的明确报错（不降级为无校验）。
 *
 * TODO(W5)：当前为 W1 红测桩——零行为，仅锁定签名与语义。
 */

export type NodeDistSource = "nodejs.org" | "npmmirror" | "tuna";

/** node 校验锚点对（§4.7）：SHASUMS256.txt 只从这一对取，tuna 永不作校验来源。 */
export type NodeChecksumAnchor = "nodejs.org" | "npmmirror";

/**
 * node 跨源校验选择：tarball 来自 X → SHASUMS256.txt 取 nodejs.org↔npmmirror 中的
 * **另一方**；X ∈ 锚点对时返回另一侧；X = tuna（仅探测位）→ 仍从锚点对取
 * （tuna **永不作校验来源**）。
 */
export function selectNodeChecksumSource(tarballSource: NodeDistSource): NodeChecksumAnchor | null {
  // TODO(W5)
  void tarballSource;
  return null;
}

/**
 * node 双锚点均不可达 = 明确抛错（与 uv api.github.com 规则对称，§4.7）；
 * 任一锚点可达即通过。
 */
export function assertNodeChecksumAnchorsAvailable(
  reachable: Readonly<Record<NodeChecksumAnchor, boolean>>,
): void {
  // TODO(W5)
  void reachable;
}

/**
 * uv 校验锚点：asset digest 恒直连 api.github.com；不可达 = 明确抛错并提示稍后
 * 重试/走 ws 级技能，**不降级为无校验**。
 */
export function resolveUvDigestSource(apiGithubReachable: boolean): {
  digestSource: string;
} {
  // TODO(W5)
  void apiGithubReachable;
  return { digestSource: "" };
}
