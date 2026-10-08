import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import {
  createLocalRuntimeService,
  LocalRuntimeOperationInFlightError,
} from "../src/runtime-tools/local-runtime/service.js";
import {
  readAppRuntimeJson,
  writeAppRuntimeJson,
  type AppRuntimeJson,
} from "../src/runtime-tools/local-runtime/runtime-json.js";

// specs/agent-runtimes.md §4.6/§4.7（alpha.3 F5 useMirrors 写入链路，W-B1）：
// 卡内「使用镜像」Switch 的服务 setter——字段级读改写（sibling 原样保留）+
// 缺席/损坏 runtime.json 建最小合法载体（不触发网络探测）+ P6 互斥裁定
// （probeMirrors 在飞时定向拒绝；install 放行——finalize 重读 fresh json）。
// 计划锚点：../ZCode-runtime-alpha3-plan.md §2 F5 / §3 W-B / §9 MINOR-6。

const BASE_NOW = 1_750_000_000_000;

function richJson(useMirrors: boolean): AppRuntimeJson {
  return {
    probedAt: new Date(BASE_NOW - 3_600_000).toISOString(),
    ttlDays: 3,
    decisions: {
      nodeDist: "npmmirror",
      uvRelease: "gh-proxy.com",
      pypiIndex: "tuna",
      npmRegistry: "registry.npmmirror.com",
      pbsMirror: "registry.npmmirror.com",
    },
    overrides: { pypiIndex: "pypi.org" },
    measurements: [
      {
        candidate: "npmmirror",
        httpCode: 200,
        latencyMs: 100,
        ok: true,
        artifactClass: "nodeDist",
      },
      { candidate: "tuna", httpCode: 500, latencyMs: 900, ok: false, artifactClass: "pypiIndex" },
    ],
    pinned: { node: "v22.14.0", uv: "0.8.6" },
    useMirrors,
  };
}

function silentLogger(): ServiceLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSandbox(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-setusemirrors-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("W-B1 字段级读改写：true→false→true 翻转只动 useMirrors，sibling 逐字段原样", async () => {
  const sandbox = makeSandbox();
  try {
    const jsonPath = join(sandbox.root, "runtime.json");
    const original = richJson(true);
    writeAppRuntimeJson(jsonPath, original);
    const service = createLocalRuntimeService({
      runtimeRootDir: sandbox.root,
      logger: silentLogger(),
      now: () => BASE_NOW,
    });
    await service.setUseMirrors(false);
    const off = readAppRuntimeJson(jsonPath);
    assert.deepEqual(
      off,
      { ...original, useMirrors: false },
      "翻转 OFF 后除 useMirrors 外 decisions/overrides/measurements/pinned/probedAt/ttlDays 全部原样",
    );
    await service.setUseMirrors(true);
    const on = readAppRuntimeJson(jsonPath);
    assert.deepEqual(on, original, "翻回 ON 后同样只动 useMirrors（读写不丢任何 sibling 字段）");
  } finally {
    sandbox.dispose();
  }
});

test("W-B1 缺席载体：runtime.json 缺席时翻转建最小合法载体，且不触发任何网络探测", async () => {
  const sandbox = makeSandbox();
  try {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new Error("setUseMirrors 不得触发网络探测（开关翻转 = 即时配置写）");
    }) as typeof fetch;
    const service = createLocalRuntimeService({
      runtimeRootDir: sandbox.root,
      fetchImpl,
      logger: silentLogger(),
      now: () => BASE_NOW,
    });
    await service.setUseMirrors(false);
    const after = readAppRuntimeJson(join(sandbox.root, "runtime.json"));
    assert.deepEqual(
      after,
      {
        probedAt: new Date(BASE_NOW).toISOString(),
        ttlDays: 7,
        decisions: {},
        measurements: [],
        pinned: { node: "", uv: "" },
        useMirrors: false,
      },
      "缺席 = 建最小载体：decisions 全键缺席自 P5 起合法（填空不填 + 梯次回落候选表）",
    );
    assert.equal(
      urls.length,
      0,
      "翻转必须即时——不得为建载体跑探测轮（ON 后下次 install 自然探测）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("W-B1 损坏载体：runtime.json 损坏（读端容错 null）同样落最小载体（treat-as-absent）", async () => {
  const sandbox = makeSandbox();
  try {
    const jsonPath = join(sandbox.root, "runtime.json");
    writeFileSync(jsonPath, "{ not valid json", "utf8");
    const service = createLocalRuntimeService({
      runtimeRootDir: sandbox.root,
      logger: silentLogger(),
      now: () => BASE_NOW,
    });
    await service.setUseMirrors(false);
    const after = readAppRuntimeJson(jsonPath);
    assert.deepEqual(
      after,
      {
        probedAt: new Date(BASE_NOW).toISOString(),
        ttlDays: 7,
        decisions: {},
        measurements: [],
        pinned: { node: "", uv: "" },
        useMirrors: false,
      },
      "损坏按缺席处理（不猜原字段），翻转仍即时落盘",
    );
  } finally {
    sandbox.dispose();
  }
});

test("W-B1 快照反映翻转：status() 的 runtimeJson.useMirrors 与 effective 投影同步翻转", async () => {
  const sandbox = makeSandbox();
  try {
    const jsonPath = join(sandbox.root, "runtime.json");
    writeAppRuntimeJson(jsonPath, richJson(true));
    const service = createLocalRuntimeService({
      runtimeRootDir: sandbox.root,
      logger: silentLogger(),
      now: () => BASE_NOW,
    });
    assert.notEqual(service.status().runtimeJson?.useMirrors, false, "翻转前 ON");
    await service.setUseMirrors(false);
    const snapshot = service.status();
    assert.equal(snapshot.runtimeJson?.useMirrors, false, "翻转后快照携带 OFF");
    assert.deepEqual(
      { ...snapshot.effectiveDecisions },
      {
        nodeDist: "nodejs.org",
        uvRelease: "github.com",
        pypiIndex: "pypi.org",
        npmRegistry: "registry.npmjs.org",
        pbsMirror: "github.com",
      },
      "OFF 投影唯一：全类 effective = origin（D1，读侧既有语义经本翻转入口可达）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("W-B1 P6 互斥：probeMirrors 在飞时翻转被定向拒绝（探测合并以起点旧快照落盘会丢翻转）", async () => {
  const sandbox = makeSandbox();
  try {
    const jsonPath = join(sandbox.root, "runtime.json");
    writeAppRuntimeJson(jsonPath, richJson(true));
    const gate = Promise.withResolvers<void>();
    const fetchImpl = (async () => {
      await gate.promise;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const service = createLocalRuntimeService({
      runtimeRootDir: sandbox.root,
      fetchImpl,
      logger: silentLogger(),
      now: () => BASE_NOW,
    });
    const probing = service.probeMirrors({ force: true });
    await assert.rejects(
      service.setUseMirrors(false),
      (error: unknown) => error instanceof LocalRuntimeOperationInFlightError,
      "探测在飞时翻转必须显式拒绝（MINOR-6：不静默排队、不静默丢翻转）",
    );
    gate.resolve();
    const snapshot = await probing;
    assert.ok(snapshot.perClass.length > 0, "探测照常完成（拒绝不破坏在飞操作）");
    assert.equal(readAppRuntimeJson(jsonPath)?.useMirrors, true, "被拒的翻转不落盘");
  } finally {
    sandbox.dispose();
  }
});
