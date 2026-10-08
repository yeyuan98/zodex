import assert from "node:assert/strict";
import test from "node:test";
import {
  setRuntimeStoreService,
  useRuntimeStore,
  type RuntimeStatusSnapshot,
  type RuntimeStoreService,
} from "../src/store/runtimeStore.ts";

// specs/agent-runtimes.md §4.6/§4.7（alpha.3 F5 useMirrors 写入链路，W-B1）：
// 「使用镜像」Switch 的 store 动作——服务调用 + 成功后 refreshStatus + F4 错误
// 呈现契约（新动作开始清 error / 失败记账并 rethrow）。形制沿 runtimeStore.test.ts
// 的 spy-service 模式（module-level DI：setRuntimeStoreService(spy.service)）。
// 计划锚点：../ZCode-runtime-alpha3-plan.md §2 F4/F5 / §3 W-B。

function makeSpyService(snapshot: RuntimeStatusSnapshot): {
  calls: { setUseMirrors: boolean[] };
  service: RuntimeStoreService;
} {
  const calls = { setUseMirrors: [] as boolean[] };
  return {
    calls,
    service: {
      getRuntimeStatus: async () => snapshot,
      setMirrorOverride: async () => {},
      installRuntime: async () => {},
      removeRuntime: async () => {},
      setUseMirrors: async (useMirrors) => {
        calls.setUseMirrors.push(useMirrors);
      },
    },
  };
}

function makeFailingSetUseMirrorsService(snapshot: RuntimeStatusSnapshot): RuntimeStoreService {
  return {
    getRuntimeStatus: async () => snapshot,
    setMirrorOverride: async () => {},
    installRuntime: async () => {},
    removeRuntime: async () => {},
    setUseMirrors: async () => {
      throw new Error("boom: write failed");
    },
  };
}

function resetStore(): void {
  useRuntimeStore.setState({ status: null, installing: null, progress: [], error: null });
  setRuntimeStoreService(null);
}

const SNAPSHOT: RuntimeStatusSnapshot = {
  installed: { node: "v22.14.0", uv: null },
  available: { node: [], uv: [] },
  lastVerify: { node: null, uv: null },
  probeRanking: {},
  useMirrors: false,
};

test("W-B1 快乐路径：setUseMirrors 调用服务写入并刷新快照、清除既有 error", async () => {
  resetStore();
  const spy = makeSpyService(SNAPSHOT);
  setRuntimeStoreService(spy.service);
  useRuntimeStore.setState({ error: "stale error" });
  await useRuntimeStore.getState().setUseMirrors(false);
  assert.deepEqual(
    spy.calls.setUseMirrors,
    [false],
    "开关翻转必须经服务写 useMirrors（§4.7：全局镜像开关唯一持久状态）",
  );
  assert.deepEqual(
    useRuntimeStore.getState().status,
    SNAPSHOT,
    "成功后 refreshStatus——卡内开关状态从服务快照重投影（不自造本地第二事实源）",
  );
  assert.equal(
    useRuntimeStore.getState().error,
    null,
    "新动作开始清 error（F4：错误常驻至下一动作，成功路径不再回写）",
  );
});

test("W-B1 失败路径：error 记账且 rethrow（F4/MINOR-14 选定机制 = rethrow）", async () => {
  resetStore();
  setRuntimeStoreService(makeFailingSetUseMirrorsService(SNAPSHOT));
  await assert.rejects(
    useRuntimeStore.getState().setUseMirrors(true),
    /boom/,
    "失败必须 rethrow——卡侧 .catch 分流（成败可辨）才有输入",
  );
  assert.ok(
    (useRuntimeStore.getState().error ?? "").includes("boom"),
    "失败同时记账 store.error（红色错误段常驻卡片，不吞）",
  );
});

test("W-B1 未接线 no-op：seam 未提供 setUseMirrors（可选方法）时 warn 返回、不抛错", async () => {
  resetStore();
  const unwired: RuntimeStoreService = {
    getRuntimeStatus: async () => SNAPSHOT,
    setMirrorOverride: async () => {},
    installRuntime: async () => {},
    removeRuntime: async () => {},
  };
  setRuntimeStoreService(unwired);
  await useRuntimeStore.getState().setUseMirrors(true);
  assert.equal(
    useRuntimeStore.getState().error,
    null,
    "适配器接线归 W-B2；未接线时与无 service 同形制（warn + no-op，不记错误）",
  );
});
