import assert from "node:assert/strict";
import test from "node:test";
import {
  setRuntimeStoreService,
  useRuntimeStore,
  type RuntimeStatusSnapshot,
  type RuntimeStoreService,
} from "../src/store/runtimeStore.ts";

// specs/agent-runtimes.md §4.6/§4.7（运行时环境卡：生命周期 + 镜像切换）红测：
// W1 先红（runtimeStore 为零行为桩 store），W6 实现卡片接线后转绿。
// 沿 mcpStore/pluginManagementStore 测试形制：service seam 模块级 DI 注入
// （setRuntimeStoreService），断言只盯 store 层派生（不触真实平台/文件系统）。

interface SpyServiceCalls {
  setMirrorOverride: Array<[string, string | null]>;
  install: string[];
  remove: string[];
}

function makeSpyService(snapshot: RuntimeStatusSnapshot): {
  calls: SpyServiceCalls;
  service: RuntimeStoreService;
} {
  const calls: SpyServiceCalls = { setMirrorOverride: [], install: [], remove: [] };
  return {
    calls,
    service: {
      getRuntimeStatus: async () => snapshot,
      setMirrorOverride: async (artifactClass, candidate) => {
        calls.setMirrorOverride.push([artifactClass, candidate]);
      },
      installRuntime: async (kind) => {
        calls.install.push(kind);
      },
      removeRuntime: async (kind) => {
        calls.remove.push(kind);
      },
    },
  };
}

function resetStore(): void {
  useRuntimeStore.setState({ status: null, installing: null, progress: [] });
  setRuntimeStoreService(null);
}

const SNAPSHOT: RuntimeStatusSnapshot = {
  installed: { node: "v22.14.0", uv: null },
  available: { node: ["v22.14.0", "v23.0.0"], uv: ["0.8.6"] },
  lastVerify: { node: "v22.14.0", uv: null },
  probeRanking: {
    npmRegistry: [
      { candidate: "registry.npmmirror.com", httpCode: 200, latencyMs: 45, ok: true },
      { candidate: "registry.npmjs.org", httpCode: 200, latencyMs: 180, ok: true },
    ],
  },
};

test("镜像切换：setMirrorOverride 调用服务写入 override（红：桩 no-op）", async () => {
  resetStore();
  const spy = makeSpyService(SNAPSHOT);
  setRuntimeStoreService(spy.service);
  await useRuntimeStore
    .getState()
    .setMirrorOverride("npmRegistry", "https://registry.npmmirror.com");
  assert.deepEqual(
    spy.calls.setMirrorOverride,
    [["npmRegistry", "https://registry.npmmirror.com"]],
    "卡内镜像切换必须经服务写 overrides（§4.7：override 优先于探测决策）",
  );
});

test("镜像切换：clearMirrorOverride 以 null 清除 override（红：桩 no-op）", async () => {
  resetStore();
  const spy = makeSpyService(SNAPSHOT);
  setRuntimeStoreService(spy.service);
  await useRuntimeStore.getState().clearMirrorOverride("npmRegistry");
  assert.deepEqual(
    spy.calls.setMirrorOverride,
    [["npmRegistry", null]],
    "清除 = 服务层以 null 覆写该工件类 override（回落探测决策）",
  );
});

test("状态呈现：refreshStatus 从服务快照派生（installed/available/lastVerify/排名）（红：桩不派生）", async () => {
  resetStore();
  const spy = makeSpyService(SNAPSHOT);
  setRuntimeStoreService(spy.service);
  await useRuntimeStore.getState().refreshStatus();
  assert.deepEqual(
    useRuntimeStore.getState().status,
    SNAPSHOT,
    "refreshStatus 后 store.status 必须等于服务快照（已装/可用/最近验证/探测排名）",
  );
});

test("安装流：installRuntime 调用服务并产出进度事件（红：桩 no-op）", async () => {
  resetStore();
  const spy = makeSpyService(SNAPSHOT);
  setRuntimeStoreService(spy.service);
  await useRuntimeStore.getState().installRuntime("node");
  assert.deepEqual(spy.calls.install, ["node"], "安装流必须调用服务 installRuntime");
  const progress = useRuntimeStore.getState().progress;
  assert.ok(
    progress.some((event) => event.kind === "node"),
    "安装流必须经 store 事件面向卡内进度呈现（至少一条 node 进度事件）",
  );
});

test("删除流：removeRuntime 调用服务（红：桩 no-op）", async () => {
  resetStore();
  const spy = makeSpyService(SNAPSHOT);
  setRuntimeStoreService(spy.service);
  await useRuntimeStore.getState().removeRuntime("node");
  assert.deepEqual(spy.calls.remove, ["node"], "删除流必须调用服务 removeRuntime");
});
