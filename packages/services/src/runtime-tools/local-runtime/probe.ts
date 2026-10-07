/**
 * specs/agent-runtimes.md §4.1（镜像探测与择优——确定性规则）纯函数契约：
 * 择优规则的 TS 孪生（与 S1 技能 curl 版同一算法）。
 *
 * TODO(W5)：当前为 W1 红测桩——零行为，仅锁定签名与语义。
 */

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

/**
 * 择优规则（§4.1，确定性）：
 * 1. origin 存活时，mirror/proxy 仅当 latency(mirror) ≤ 0.6 × latency(origin) 才胜出；
 * 2. origin 失败/超时 → 存活候选中最快者胜；
 * 3. 平局（±10%）→ 候选表顺序（输入数组顺序）靠前者胜；
 * 4. 全灭 → 明确抛错（不静默选不可用源）。
 */
export function rankMirrorCandidates(measurements: readonly ProbeMeasurement[]): MirrorRankOutcome {
  // TODO(W5)
  void measurements;
  return { winner: "", reason: "origin-default" };
}
