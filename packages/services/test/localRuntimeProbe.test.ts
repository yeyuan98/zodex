import assert from "node:assert/strict";
import test from "node:test";
import {
  rankMirrorCandidates,
  type ProbeMeasurement,
} from "../src/runtime-tools/local-runtime/probe.js";

// specs/agent-runtimes.md §4.1（镜像探测与择优——确定性规则 1-4）红测：W1 先红
// （probe.ts 为零行为桩），W5 实现后转绿。输入数组顺序 = 候选表顺序（平局规则依赖）。

function measurement(partial: Partial<ProbeMeasurement> & { candidate: string }): ProbeMeasurement {
  return {
    isOrigin: false,
    httpCode: 200,
    latencyMs: 100,
    ok: true,
    ...partial,
  };
}

test("择优规则 1：origin 存活 + mirror ≤0.6×origin-latency → mirror 胜（红：桩空 winner）", () => {
  const outcome = rankMirrorCandidates([
    measurement({ candidate: "nodejs.org", isOrigin: true, latencyMs: 200 }),
    measurement({ candidate: "npmmirror", latencyMs: 100 }),
  ]);
  assert.equal(outcome.winner, "npmmirror", "100ms ≤ 0.6×200ms → mirror 必须胜出");
});

test("择优规则 1：origin 存活 + mirror >0.6×origin-latency → origin 胜（防白信第三方）", () => {
  const outcome = rankMirrorCandidates([
    measurement({ candidate: "nodejs.org", isOrigin: true, latencyMs: 200 }),
    measurement({ candidate: "npmmirror", latencyMs: 150 }),
  ]);
  assert.equal(outcome.winner, "nodejs.org", "150ms > 0.6×200ms=120ms → origin 必须胜出");
});

test("择优规则 2：origin 失败/超时 → 存活候选中最快者胜", () => {
  const outcome = rankMirrorCandidates([
    measurement({
      candidate: "github.com",
      isOrigin: true,
      ok: false,
      httpCode: 0,
      latencyMs: 5000,
    }),
    measurement({ candidate: "gh-proxy.com", latencyMs: 300 }),
    measurement({ candidate: "ghfast.top", latencyMs: 180 }),
  ]);
  assert.equal(outcome.winner, "ghfast.top", "origin 死 → 存活最快者（180ms）胜");
});

test("择优规则 3：平局（±10%）→ 候选表顺序靠前者胜（非性能最优者）", () => {
  const outcome = rankMirrorCandidates([
    measurement({ candidate: "tuna", latencyMs: 100 }),
    measurement({ candidate: "aliyun", latencyMs: 95 }),
  ]);
  assert.equal(
    outcome.winner,
    "tuna",
    "95ms 与 100ms 在 ±10% 平局带内 → 输入顺序靠前的 tuna 胜（确定性）",
  );
});

test("择优规则 4：全灭 → 明确抛错，不静默选不可用源（红：桩不抛）", () => {
  assert.throws(
    () =>
      rankMirrorCandidates([
        measurement({ candidate: "nodejs.org", isOrigin: true, ok: false, httpCode: 0 }),
        measurement({ candidate: "npmmirror", ok: false, httpCode: 0 }),
      ]),
    "全部候选失败/超时必须明确报错（给出手工覆盖位），不得静默择源",
  );
});
