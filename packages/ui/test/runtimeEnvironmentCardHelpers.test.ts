import assert from "node:assert/strict";
import test from "node:test";
import type { ILocalRuntimeService, LocalRuntimeStatusSnapshot } from "@zcode/services";
import {
  buildProbeRanking,
  makeRuntimeCardStoreService,
} from "../src/settings/runtimeEnvironmentCardHelpers.ts";

// specs/agent-runtimes.md §4.6/§4.7（alpha.3 F5 卡面行为）在 helpers/store 层可钉
// 契约的红测：W1′ 先红——今日 makeRuntimeCardStoreService 的状态快照不含 useMirrors
// （全局「使用镜像」开关常显需要卡侧读到开关状态），W-B 落地后转绿。
//
// W1′ 边界披露：组件形状断言（Switch 常显 / Collapsible 默认折叠 / Probe 按钮 /
// 双向互斥）无组件渲染基建（packages/ui/test = node --test、无 rendering infra），
// 且 probing/mutex store 字段尚不存在（引用不编译）——归 W-B 实现；本文件只钉
// 现有 helpers 可达的最深契约（状态快照字段 + 探测快照排名投影）。

const RUNTIME_JSON_WITH_USE_MIRRORS = {
  probedAt: "2026-10-08T00:00:00.000Z",
  ttlDays: 7,
  decisions: {
    nodeDist: "npmmirror",
    uvRelease: "github.com",
    pypiIndex: "pypi.org",
    npmRegistry: "registry.npmjs.org",
    pbsMirror: "registry.npmmirror.com",
  },
  measurements: [
    {
      candidate: "registry.npmmirror.com",
      httpCode: 200,
      latencyMs: 45,
      ok: true,
      artifactClass: "npmRegistry",
    },
    {
      candidate: "registry.npmjs.org",
      httpCode: 200,
      latencyMs: 180,
      ok: true,
      artifactClass: "npmRegistry",
    },
    {
      candidate: "pypi.org",
      httpCode: 500,
      latencyMs: 0,
      ok: false,
      artifactClass: "pypiIndex",
    },
  ],
  pinned: { node: "v22.14.0", uv: "" },
  useMirrors: false,
} as const;

function makeFakeService(snapshotRuntimeJson: unknown): ILocalRuntimeService {
  const snapshot = {
    runtimeJson: snapshotRuntimeJson,
    effectiveDecisions: null,
    current: { node: "v22.14.0", uv: null },
    reprobeSlots: [],
  } as LocalRuntimeStatusSnapshot;
  const service = {
    install: async () => ({
      kind: "node" as const,
      version: "v22.14.0",
      candidate: "npmmirror",
      alreadyInstalled: true,
    }),
    checkUpdate: async () => ({
      kind: "node" as const,
      pinned: "v22.14.0",
      latest: "v26.11.1",
      updateAvailable: true,
    }),
    remove: async () => {},
    reverify: async () => ({
      kind: "node" as const,
      ok: true,
      version: "v22.14.0",
      output: "v22.14.0",
    }),
    status: async () => snapshot,
    setMirrorOverride: async () => {},
    clearMirrorOverride: async () => {},
    probeMirrors: async () => ({ perClass: [] }),
    listMirrorCandidates: async () => ({}),
  };
  return service as unknown as ILocalRuntimeService;
}

test("F5 开关可达：状态快照必须携带 useMirrors（红：今日快照无该字段）", async () => {
  const adapter = makeRuntimeCardStoreService(makeFakeService(RUNTIME_JSON_WITH_USE_MIRRORS));
  const status = await adapter.getRuntimeStatus();
  const useMirrors = (status as unknown as { useMirrors?: boolean }).useMirrors;
  assert.equal(
    useMirrors,
    false,
    "卡侧常显的「使用镜像」开关需要状态快照携带 useMirrors（service runtime.json → store 快照投影）",
  );
});

test("F5 探测快照投影（今绿钉）：per-candidate {httpCode, latencyMs, ok} 分组排名、可用在前", () => {
  const ranking = buildProbeRanking(RUNTIME_JSON_WITH_USE_MIRRORS.measurements);
  const npmRows = ranking.npmRegistry;
  assert.ok(npmRows !== undefined, "npmRegistry 分组在场");
  assert.deepEqual(
    npmRows?.map((row) => row.candidate),
    ["registry.npmmirror.com", "registry.npmjs.org"],
    "可用候选按延迟升序（45ms < 180ms）——Probe 快照渲染 {httpCode} · {latencyMs} 的数据源",
  );
  const pypiRows = ranking.pypiIndex;
  assert.deepEqual(
    pypiRows?.map((row) => [row.candidate, row.ok]),
    [["pypi.org", false]],
    "不可用候选照常呈现（状态码/失败可见）",
  );
});
