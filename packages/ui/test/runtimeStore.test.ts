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
  useRuntimeStore.setState({ status: null, installing: null, progress: [], error: null });
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

// specs/agent-runtimes.md §4.7（alpha.3 F4 错误呈现契约 / D 项 / MINOR-14）红测：
// W1′ 先红——今日 refreshStatus 成功路径无条件 set({status, error: null})
// （runtimeStore.ts:130），install 失败的 error 至多存活一个异步 tick（§2o 主诉：
// 卡片静默回到安装钮）；且 installRuntime catch 吞掉错误从不 rethrow（卡侧
// .catch = 死代码 → renderer 成败同日志 "install done"）。W-B 落地「成功刷新
// 保留既有 error + 新动作开始才清 + 失败 rethrow」后转绿。
// 计划锚点：../ZCode-runtime-alpha3-plan.md §2 F4 / §9 MINOR-14。

function makeFailingInstallService(snapshot: RuntimeStatusSnapshot): RuntimeStoreService {
  return {
    getRuntimeStatus: async () => snapshot,
    setMirrorOverride: async () => {},
    installRuntime: async () => {
      throw new Error("boom: all candidates failed");
    },
    removeRuntime: async () => {},
  };
}

test("F4 错误常驻：refreshStatus 成功路径保留既有 error（红：今日无条件清空 :130）", async () => {
  resetStore();
  setRuntimeStoreService(makeSpyService(SNAPSHOT));
  useRuntimeStore.setState({ error: "boom: previous install failed" });
  await useRuntimeStore.getState().refreshStatus();
  assert.equal(
    useRuntimeStore.getState().error,
    "boom: previous install failed",
    "成功的状态刷新不得清空既有 error——错误常驻至下一动作开始（§4.7 F4）",
  );
  assert.notEqual(useRuntimeStore.getState().status, null, "刷新照常写入新快照");
});

test("F4 错误常驻：install 失败 → error 存活 finally 的 refreshStatus（红：今日被成功刷新擦掉 = §2o 主诉）", async () => {
  resetStore();
  setRuntimeStoreService(makeFailingInstallService(SNAPSHOT));
  // 计划 §10 MAJOR-1：本例断言 store 的 error 状态而非拒绝，吞掉 rethrow（rethrow 契约由下方姊妹测钉住）。
  await useRuntimeStore
    .getState()
    .installRuntime("node")
    .catch(() => undefined);
  assert.notEqual(
    useRuntimeStore.getState().error,
    null,
    "install 失败的 error 必须在 finally refreshStatus 后仍然在场（红色错误段常驻卡片）",
  );
  const progress = useRuntimeStore.getState().progress;
  assert.ok(
    progress.some((event) => event.kind === "node" && event.phase === "failed"),
    "失败流必须产出 failed 进度事件（今绿钉）",
  );
});

test("F4/MINOR-14：installRuntime 失败必须 rethrow（红：今日 catch 吞掉、resolve undefined）", async () => {
  resetStore();
  setRuntimeStoreService(makeFailingInstallService(SNAPSHOT));
  await assert.rejects(
    useRuntimeStore.getState().installRuntime("node"),
    /boom/,
    "store installRuntime 失败必须 rethrow（§4.7 选定机制）——卡侧 .then(install done)/.catch(install failed) 分流才有输入",
  );
});

test("F4 清除时机：新动作开始时才清 error（今绿钉——install start 已置空）", async () => {
  resetStore();
  const spy = makeSpyService(SNAPSHOT);
  setRuntimeStoreService(spy.service);
  useRuntimeStore.setState({ error: "stale error" });
  await useRuntimeStore.getState().installRuntime("node");
  assert.equal(
    useRuntimeStore.getState().error,
    null,
    "新动作（install start）清 error；成功安装后仍为空",
  );
});
