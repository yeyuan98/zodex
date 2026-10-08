import assert from "node:assert/strict";
import test from "node:test";
import type { ILocalRuntimeService, LocalRuntimeStatusSnapshot } from "@zcode/services";
import {
  setRuntimeStoreService,
  useRuntimeStore,
  type RuntimeStatusSnapshot,
  type RuntimeStoreService,
} from "../src/store/runtimeStore.ts";
import { makeRuntimeCardStoreService } from "../src/settings/runtimeEnvironmentCardHelpers.ts";

// specs/agent-runtimes.md §4.6/§4.7（alpha.3 W-B2 卡面行为）在 store/helpers 层可钉
// 契约的红测：手动 Probe 腿（probing 状态迁移 + force 委托 + 探测结果经
// refreshStatus 流入排名数据）、失败 error+rethrow（F4 形制）、安装失败 kind 记账
// （错误段旁「重试安装」入口的事实源）。
//
// 边界披露：组件可视形状（Switch 常显 / Collapsible 默认折叠 / Probe spinner /
// 双向禁用）无组件渲染基建（packages/ui/test = node --test、无 rendering infra），
// 不在本文件钉；此处只钉可达的 store/helper 契约。

function resetStore(): void {
  useRuntimeStore.setState({
    status: null,
    installing: null,
    probing: false,
    lastFailedInstallKind: null,
    progress: [],
    error: null,
  });
  setRuntimeStoreService(null);
}

const SNAPSHOT_BEFORE_PROBE: RuntimeStatusSnapshot = {
  installed: { node: "v22.14.0", uv: null },
  available: { node: [], uv: [] },
  lastVerify: { node: null, uv: null },
  probeRanking: {},
};

const SNAPSHOT_AFTER_PROBE: RuntimeStatusSnapshot = {
  ...SNAPSHOT_BEFORE_PROBE,
  probeRanking: {
    npmRegistry: [
      { candidate: "registry.npmmirror.com", httpCode: 200, latencyMs: 45, ok: true },
      { candidate: "registry.npmjs.org", httpCode: 200, latencyMs: 180, ok: true },
    ],
    pypiIndex: [{ candidate: "pypi.org", httpCode: 500, latencyMs: 0, ok: false }],
  },
};

test("W-B2 Probe 腿：probing 迁移 true→false、委托 {force:true}、探测结果流入排名数据", async () => {
  resetStore();
  const probeCalls: Array<{ force?: boolean } | undefined> = [];
  let probingObservedInFlight = false;
  let snapshot = SNAPSHOT_BEFORE_PROBE;
  const service: RuntimeStoreService = {
    getRuntimeStatus: async () => snapshot,
    setMirrorOverride: async () => {},
    installRuntime: async () => {},
    removeRuntime: async () => {},
    probeMirrors: async (options) => {
      probeCalls.push(options);
      // 模拟服务侧持久化 measurements 后，下一次 status() 读到新探测结果。
      snapshot = SNAPSHOT_AFTER_PROBE;
      probingObservedInFlight = useRuntimeStore.getState().probing;
      return { perClass: [] };
    },
  };
  setRuntimeStoreService(service);
  await useRuntimeStore.getState().probeMirrors();
  assert.deepEqual(
    probeCalls,
    [{ force: true }],
    "手动 Probe 必须以 probeMirrors({force:true}) 委托（owner ③(4)/§4.7 MINOR-6 纯展示腿）",
  );
  assert.equal(
    probingObservedInFlight,
    true,
    "探测期间 store.probing 必须为 true（spinner/互斥依据）",
  );
  assert.equal(useRuntimeStore.getState().probing, false, "探测结束后 probing 必须复位 false");
  assert.deepEqual(
    useRuntimeStore.getState().status?.probeRanking,
    SNAPSHOT_AFTER_PROBE.probeRanking,
    "探测结果必须经 refreshStatus 流入 status.probeRanking（含失败候选行）",
  );
});

test("W-B2 Probe 失败：error 记账且 rethrow、probing 复位（F4 形制；含 P6 互斥文案常驻）", async () => {
  resetStore();
  const service: RuntimeStoreService = {
    getRuntimeStatus: async () => SNAPSHOT_BEFORE_PROBE,
    setMirrorOverride: async () => {},
    installRuntime: async () => {},
    removeRuntime: async () => {},
    probeMirrors: async () => {
      throw new Error("local-runtime install 进行中，probeMirrors 被互斥拒绝");
    },
  };
  setRuntimeStoreService(service);
  await assert.rejects(
    useRuntimeStore.getState().probeMirrors(),
    /互斥拒绝/,
    "Probe 失败必须 rethrow（卡侧 .catch 分流）；互斥拒绝文案原样上抛",
  );
  assert.ok(
    (useRuntimeStore.getState().error ?? "").includes("互斥拒绝"),
    "失败文案必须入 store.error（错误段常驻呈现，卡不崩溃）",
  );
  assert.equal(
    useRuntimeStore.getState().probing,
    false,
    "失败路径的 finally 同样复位 probing（不卡死互斥）",
  );
});

test("W-B2 Probe 清除时机：新动作开始清 error（F4），探测中重复触发 no-op", async () => {
  resetStore();
  let releaseProbe: (() => void) | undefined;
  let probeCalls = 0;
  const service: RuntimeStoreService = {
    getRuntimeStatus: async () => SNAPSHOT_BEFORE_PROBE,
    setMirrorOverride: async () => {},
    installRuntime: async () => {},
    removeRuntime: async () => {},
    probeMirrors: async () => {
      probeCalls += 1;
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      return { perClass: [] };
    },
  };
  setRuntimeStoreService(service);
  useRuntimeStore.setState({ error: "stale error" });
  const inFlight = useRuntimeStore.getState().probeMirrors();
  // 探测已开始：stale error 被清（F4 新动作语义），重复触发直接 no-op。
  assert.equal(useRuntimeStore.getState().error, null, "Probe 开始即清既有 error（F4）");
  await useRuntimeStore.getState().probeMirrors();
  assert.equal(probeCalls, 1, "probing 期间重复 Probe 不得再次委托服务");
  releaseProbe?.();
  await inFlight;
  assert.equal(useRuntimeStore.getState().probing, false);
});

test("W-B2 重试记账：install 失败记 lastFailedInstallKind，成功安装清零", async () => {
  resetStore();
  const failing: RuntimeStoreService = {
    getRuntimeStatus: async () => SNAPSHOT_BEFORE_PROBE,
    setMirrorOverride: async () => {},
    installRuntime: async () => {
      throw new Error("boom: all candidates failed");
    },
    removeRuntime: async () => {},
  };
  setRuntimeStoreService(failing);
  await useRuntimeStore
    .getState()
    .installRuntime("uv")
    .catch(() => undefined);
  assert.equal(
    useRuntimeStore.getState().lastFailedInstallKind,
    "uv",
    "安装失败必须记账 kind——错误段旁「重试安装 {kind}」入口的事实源（owner ③(7)）",
  );
  const succeeding: RuntimeStoreService = {
    ...failing,
    installRuntime: async () => {},
  };
  setRuntimeStoreService(succeeding);
  await useRuntimeStore.getState().installRuntime("uv");
  assert.equal(
    useRuntimeStore.getState().lastFailedInstallKind,
    null,
    "重试（或再安装）成功后记账清零——重试入口不再出现",
  );
});

test("W-B2 重试归属：非安装动作的新 error 不得沿用旧失败 kind（重试只归属当前 error）", async () => {
  resetStore();
  const failingInstall: RuntimeStoreService = {
    getRuntimeStatus: async () => SNAPSHOT_BEFORE_PROBE,
    setMirrorOverride: async () => {},
    installRuntime: async () => {
      throw new Error("boom: install");
    },
    removeRuntime: async () => {},
    probeMirrors: async () => {
      throw new Error("boom: probe");
    },
  };
  setRuntimeStoreService(failingInstall);
  await useRuntimeStore
    .getState()
    .installRuntime("node")
    .catch(() => undefined);
  assert.equal(useRuntimeStore.getState().lastFailedInstallKind, "node");
  await useRuntimeStore
    .getState()
    .probeMirrors()
    .catch(() => undefined);
  assert.equal(
    useRuntimeStore.getState().lastFailedInstallKind,
    null,
    "Probe 开始即清重试上下文——probe 的 error 旁不得出现「重试安装」入口",
  );
  assert.ok((useRuntimeStore.getState().error ?? "").includes("probe"));
});

test("W-B2 适配器委托：setUseMirrors 与 probeMirrors({force:true}) 透传 ILocalRuntimeService", async () => {
  const calls: {
    setUseMirrors: boolean[];
    probeMirrors: Array<{ force?: boolean } | undefined>;
  } = { setUseMirrors: [], probeMirrors: [] };
  const fakeService = {
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
    status: async () =>
      ({
        runtimeJson: null,
        effectiveDecisions: null,
        current: { node: null, uv: null },
        reprobeSlots: [],
      }) as LocalRuntimeStatusSnapshot,
    setMirrorOverride: async () => {},
    clearMirrorOverride: async () => {},
    setUseMirrors: async (useMirrors: boolean) => {
      calls.setUseMirrors.push(useMirrors);
    },
    probeMirrors: async (options?: { force?: boolean }) => {
      calls.probeMirrors.push(options);
      return { perClass: [] };
    },
    listMirrorCandidates: async () => ({}),
  } as unknown as ILocalRuntimeService;
  const adapter = makeRuntimeCardStoreService(fakeService);
  await adapter.setUseMirrors?.(false);
  await adapter.probeMirrors?.({ force: true });
  assert.deepEqual(
    calls.setUseMirrors,
    [false],
    "Switch 写入必须透传服务 setUseMirrors（W-B1 收口）",
  );
  assert.deepEqual(
    calls.probeMirrors,
    [{ force: true }],
    "Probe 必须透传 {force:true}（显式重探，§4.6 手动 Probe 语义）",
  );
});

test("W-B2 开关投影：快照 useMirrors 缺席 = ON（§4.7 F5 缺省 true）", async () => {
  const fakeService = {
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
    status: async () =>
      ({
        // runtimeJson 缺席（未安装/未探测）——useMirrors 投影必须回落 ON。
        runtimeJson: null,
        effectiveDecisions: null,
        current: { node: null, uv: null },
        reprobeSlots: [],
      }) as LocalRuntimeStatusSnapshot,
    setMirrorOverride: async () => {},
    clearMirrorOverride: async () => {},
    setUseMirrors: async () => {},
    probeMirrors: async () => ({ perClass: [] }),
    listMirrorCandidates: async () => ({}),
  } as unknown as ILocalRuntimeService;
  const status = await makeRuntimeCardStoreService(fakeService).getRuntimeStatus();
  assert.equal(
    status.useMirrors,
    true,
    "status.useMirrors 缺席/undefined = ON——卡顶 Switch 的缺省勾选态（owner ③(1)）",
  );
});
