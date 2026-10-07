import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverrideSourceHardFailure,
  readAppRuntimeJson,
  resolveEffectiveDecisions,
  resolveReprobeSlots,
  validateUpdateOrdering,
  writeAppRuntimeJson,
  type AppRuntimeArtifactClass,
  type AppRuntimeJson,
} from "../src/runtime-tools/local-runtime/runtime-json.js";

// specs/agent-runtimes.md §4.1（固化与复用）/§4.7（A2′ 实现契约）红测：W1 先红
// （runtime-json.ts 为零行为桩），W5 实现后转绿。
//
// 断言面：effective decision = override ?? probed；TTL/force 重探只作用于无
// override 位；tmp+rename 原子写 + 读端容错（缺失/损坏 = 缺席，不猜）；更新顺序
// 不变量（新目录→runtime.json→CURRENT→GC）；override 源硬失败 = 报错 + 保留。

const DAY_MS = 24 * 3600_000;

function sampleJson(overrides?: Partial<Record<AppRuntimeArtifactClass, string>>): AppRuntimeJson {
  return {
    probedAt: new Date(1_000_000_000).toISOString(),
    ttlDays: 7,
    decisions: {
      nodeDist: "nodejs.org",
      uvRelease: "github.com",
      pypiIndex: "pypi.org",
      npmRegistry: "registry.npmjs.org",
      pbsMirror: "registry.npmmirror.com",
    },
    ...(overrides ? { overrides } : {}),
    measurements: [{ candidate: "nodejs.org", httpCode: 200, latencyMs: 120, ok: true }],
    pinned: { node: "v22.14.0", uv: "0.8.6" },
  };
}

const ALL_CLASSES: AppRuntimeArtifactClass[] = [
  "nodeDist",
  "uvRelease",
  "pypiIndex",
  "npmRegistry",
  "pbsMirror",
];

test("effective decision：override 胜 probed（红：桩不应用 override）", () => {
  const effective = resolveEffectiveDecisions(
    sampleJson({ npmRegistry: "https://registry.npmmirror.com" }),
  );
  assert.equal(
    effective.npmRegistry,
    "https://registry.npmmirror.com",
    "override 优先于探测决策（§4.7）",
  );
  assert.equal(effective.nodeDist, "nodejs.org", "无 override 位保持 probed 决策");
});

test("effective decision：无 override → probed 原样（今绿钉）", () => {
  const effective = resolveEffectiveDecisions(sampleJson());
  assert.deepEqual(effective, sampleJson().decisions, "无 override 时 = 探测决策");
});

test("重探槽位：TTL 过期 → 全部无 override 位（红：桩恒空）", () => {
  const slots = resolveReprobeSlots(sampleJson(), { nowMs: 1_000_000_000 + 8 * DAY_MS });
  assert.deepEqual(
    [...slots].sort(),
    [...ALL_CLASSES].sort(),
    "probedAt 超 7d TTL → 五类工件全部重探",
  );
});

test("重探槽位：TTL 过期 + npmRegistry 有 override → 不含 override 位（红：桩恒空）", () => {
  const slots = resolveReprobeSlots(sampleJson({ npmRegistry: "https://registry.npmmirror.com" }), {
    nowMs: 1_000_000_000 + 8 * DAY_MS,
  });
  assert.equal(slots.includes("npmRegistry"), false, "重探触发只作用于无 override 的决策位");
  assert.deepEqual(
    [...slots].sort(),
    ALL_CLASSES.filter((cls) => cls !== "npmRegistry").sort(),
    "其余四类照常重探",
  );
});

test("重探槽位：TTL 未过期且非 force → 空（今绿钉）", () => {
  const slots = resolveReprobeSlots(sampleJson(), { nowMs: 1_000_000_000 + DAY_MS });
  assert.deepEqual(slots, [], "TTL 内非显式 refresh 不重探");
});

test("重探槽位：显式 force → 无 override 位全量（红：桩恒空）", () => {
  const slots = resolveReprobeSlots(sampleJson({ npmRegistry: "https://registry.npmmirror.com" }), {
    nowMs: 1_000_000_000 + DAY_MS,
    force: true,
  });
  assert.equal(slots.includes("npmRegistry"), false, "force 也不重探 override 位");
  assert.deepEqual(
    [...slots].sort(),
    ALL_CLASSES.filter((cls) => cls !== "npmRegistry").sort(),
    "force → 其余四类全量重探",
  );
});

test("runtime.json 原子写 + 读回：写后可读、内容等值、无 .tmp* 残留（红：桩 no-op/恒 null）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-local-runtime-json-"));
  try {
    const filePath = join(dir, "runtime.json");
    const json = sampleJson();
    writeAppRuntimeJson(filePath, json);
    const leftovers = (await readdir(dir)).filter((name) => name.startsWith("runtime.json.tmp"));
    assert.deepEqual(leftovers, [], "tmp+rename 完成后不得残留 runtime.json.tmp*");
    const readBack = readAppRuntimeJson(filePath);
    assert.notEqual(readBack, null, "写后必须可读回");
    assert.deepEqual(readBack, json, "读回内容与写入等值");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime.json 读端容错：缺失 → null 不抛（今绿钉）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-local-runtime-json-missing-"));
  try {
    assert.doesNotThrow(() => readAppRuntimeJson(join(dir, "runtime.json")));
    assert.equal(readAppRuntimeJson(join(dir, "runtime.json")), null, "缺失 = treat-as-absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime.json 读端容错：损坏 JSON → null 不抛、不猜（今绿钉）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-local-runtime-json-corrupt-"));
  try {
    const filePath = join(dir, "runtime.json");
    await writeFile(filePath, "{ not valid json !!");
    assert.doesNotThrow(() => readAppRuntimeJson(filePath));
    assert.equal(readAppRuntimeJson(filePath), null, "损坏 = treat-as-absent（warn，不猜）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("更新顺序不变量：dir→runtime.json→CURRENT→GC 为唯一合法序（今绿钉）", () => {
  assert.equal(
    validateUpdateOrdering(["version-dir", "runtime-json", "current", "gc"]).ok,
    true,
    "合法顺序必须通过",
  );
});

test("更新顺序不变量：runtime.json 先于新目录 → 拒绝（红：桩恒 ok）", () => {
  assert.equal(
    validateUpdateOrdering(["runtime-json", "version-dir", "current", "gc"]).ok,
    false,
    "新 v<ver>/ 目录就绪前不得写 runtime.json",
  );
});

test("更新顺序不变量：CURRENT 先于 runtime.json → 拒绝（红：桩恒 ok）", () => {
  assert.equal(
    validateUpdateOrdering(["version-dir", "current", "runtime-json", "gc"]).ok,
    false,
    "pinned 未落 runtime.json 前不得换 CURRENT 指针",
  );
});

test("更新顺序不变量：GC 先于 CURRENT 换指针 → 拒绝（红：桩恒 ok）", () => {
  assert.equal(
    validateUpdateOrdering(["version-dir", "runtime-json", "gc", "current"]).ok,
    false,
    "旧目录 GC 必须最后（先 GC 会悬空在用指针）",
  );
});

test("override 源硬失败：明确报错 + override 保留，绝不静默回落（红：桩 error 为空）", () => {
  const json = sampleJson({ npmRegistry: "https://registry.npmmirror.com" });
  const result = applyOverrideSourceHardFailure(json, "npmRegistry");
  assert.notEqual(result.error, "", "override 源硬失败必须携带非空错误（明确报错）");
  assert.equal(
    result.json.overrides?.npmRegistry,
    "https://registry.npmmirror.com",
    "硬失败后 override 必须原样保留（用户已弃用的源不静默换回）",
  );
});
