import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRuntimeJsonAtFinalize } from "../src/runtime-tools/local-runtime/install.js";
import {
  readAppRuntimeJson,
  writeAppRuntimeJson,
  type AppRuntimeJson,
} from "../src/runtime-tools/local-runtime/runtime-json.js";

// [ulw] MINOR-4 红测（specs/agent-runtimes.md §4.7 写读契约 (iii)）：finalize 写入
// 必须重读当前 runtime.json 只合并 {pinned}——安装窗口（探测/下载耗时）内其它写入者
// （镜像 override 切换/显式探测）落盘的字段不得被安装起点的旧快照整串覆盖。
//
// 模拟形制：安装起点快照 = fallback；「安装中途」= 在两次调用之间直接改写
// runtime.json 文件（等价于另一写入者落盘），再断言 finalize 合并结果。

function baseJson(): AppRuntimeJson {
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
    measurements: [{ candidate: "nodejs.org", httpCode: 200, latencyMs: 120, ok: true }],
    pinned: { node: "v22.14.0", uv: "0.8.6" },
  };
}

test("MINOR-4：安装中途写入的镜像 override 不被 finalize 旧快照覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-runtime-finalize-"));
  try {
    const jsonPath = join(dir, "runtime.json");
    const snapshotAtInstallStart = baseJson();
    writeAppRuntimeJson(jsonPath, snapshotAtInstallStart);
    // 模拟安装窗口内用户切换镜像 override（另一写入者落盘）。
    writeAppRuntimeJson(jsonPath, {
      ...snapshotAtInstallStart,
      overrides: { npmRegistry: "registry.npmmirror.com" },
    });
    const merged = mergeRuntimeJsonAtFinalize(
      readAppRuntimeJson(jsonPath),
      snapshotAtInstallStart,
      "node",
      "v23.0.0",
    );
    assert.equal(
      merged.overrides?.npmRegistry,
      "registry.npmmirror.com",
      "安装中途写入的 override 必须在 finalize 后存活（丢失更新防护）",
    );
    assert.equal(merged.pinned.node, "v23.0.0", "finalize 只合并 pinned[kind]=新版本");
    assert.equal(merged.pinned.uv, "0.8.6", "另一 kind 的 pinned 不被误改");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MINOR-4：finalize 幂等（重复调用不回退 overrides/pinned）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-runtime-finalize-2-"));
  try {
    const jsonPath = join(dir, "runtime.json");
    const snapshotAtInstallStart = baseJson();
    writeAppRuntimeJson(jsonPath, snapshotAtInstallStart);
    // 第一次 finalize 落盘后，第二次 finalize（等价重入）必须以重读值为基础。
    const first = mergeRuntimeJsonAtFinalize(
      readAppRuntimeJson(jsonPath),
      snapshotAtInstallStart,
      "node",
      "v23.0.0",
    );
    writeAppRuntimeJson(jsonPath, { ...first, overrides: { pypiIndex: "tuna" } });
    const second = mergeRuntimeJsonAtFinalize(
      readAppRuntimeJson(jsonPath),
      snapshotAtInstallStart,
      "node",
      "v23.0.0",
    );
    assert.equal(second.overrides?.pypiIndex, "tuna", "二次 finalize 不回退期间写入");
    assert.equal(second.pinned.node, "v23.0.0", "pinned 保持第一次 finalize 结果");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MINOR-4：fresh 读失败/文件缺席 → 回落安装起点快照（只补 pinned）", () => {
  const fallback = baseJson();
  const merged = mergeRuntimeJsonAtFinalize(null, fallback, "uv", "0.9.0");
  assert.equal(merged.pinned.uv, "0.9.0", "缺席时以快照为基底写 pinned");
  assert.deepEqual(merged.decisions, fallback.decisions, "决策位原样保留");
});
