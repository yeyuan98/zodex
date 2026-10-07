import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNodeChecksumAnchorsAvailable,
  resolveUvDigestSource,
  selectNodeChecksumSource,
} from "../src/runtime-tools/local-runtime/verify.js";

// specs/agent-runtimes.md §4.2（跨源校验不变量）/§4.7（校验锚点）红测：W1 先红
// （verify.ts 为零行为桩），W5 实现后转绿。
//
// 不变量：node tarball 来自 X → SHASUMS256.txt 取 nodejs.org↔npmmirror 中的另一方，
// tuna **永不作校验来源**；node 双锚点均不可达 = 明确报错（与 uv api.github.com
// 规则对称）；uv digest 恒 api.github.com、不可达 = 明确报错（不降级为无校验）。

test("node 跨源校验：tarball 自 nodejs.org → SHASUMS 取 npmmirror（另一方）", () => {
  assert.equal(
    selectNodeChecksumSource("nodejs.org"),
    "npmmirror",
    "tarball 来自 X 时校验值必来自另一源",
  );
});

test("node 跨源校验：tarball 自 npmmirror → SHASUMS 取 nodejs.org（另一方）", () => {
  assert.equal(selectNodeChecksumSource("npmmirror"), "nodejs.org", "双向对称");
});

test("node 跨源校验：tarball 自 tuna → SHASUMS 仍取 nodejs.org↔npmmirror 锚点对（tuna 永不作校验来源）", () => {
  const anchor = selectNodeChecksumSource("tuna");
  assert.ok(
    anchor === "nodejs.org" || anchor === "npmmirror",
    `tuna 只能作探测位；校验来源必须 ∈ {nodejs.org, npmmirror}（实际：${anchor}）`,
  );
});

test("node 双锚点均不可达 → 明确抛错，不降级为无校验（红：桩不抛）", () => {
  assert.throws(
    () => assertNodeChecksumAnchorsAvailable({ "nodejs.org": false, npmmirror: false }),
    "nodejs.org 与 npmmirror 双锚点均不可达 = 明确报错（与 uv api.github.com 规则对称）",
  );
});

test("node 任一锚点可达 → 通过（不抛）", () => {
  assert.doesNotThrow(() =>
    assertNodeChecksumAnchorsAvailable({ "nodejs.org": true, npmmirror: false }),
  );
  assert.doesNotThrow(() =>
    assertNodeChecksumAnchorsAvailable({ "nodejs.org": false, npmmirror: true }),
  );
});

test("uv 校验锚点：digest 恒直连 api.github.com（红：桩空 digestSource）", () => {
  assert.equal(
    resolveUvDigestSource(true).digestSource,
    "api.github.com",
    "uv asset digest 校验源恒为 api.github.com（gh-proxy 系永不作校验来源）",
  );
});

test("uv 校验锚点：api.github.com 不可达 → 明确抛错，绝不降级为无校验（红：桩不抛）", () => {
  assert.throws(
    () => resolveUvDigestSource(false),
    "api.github.com 不可达 = 明确报错并提示稍后重试，不返回降级结果",
  );
});
