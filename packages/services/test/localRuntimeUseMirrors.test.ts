import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { installRuntime } from "../src/runtime-tools/local-runtime/install.js";
import { createLocalRuntimeService } from "../src/runtime-tools/local-runtime/service.js";
import { buildCandidateLadder } from "../src/runtime-tools/local-runtime/download-verify.js";
import {
  readAppRuntimeJson,
  resolveEffectiveDecisions,
  writeAppRuntimeJson,
  type AppRuntimeArtifactClass,
  type AppRuntimeJson,
} from "../src/runtime-tools/local-runtime/runtime-json.js";

// specs/agent-runtimes.md §4.7（alpha.3 F5 useMirrors 全链 + MAJOR-5 合并保留）红测：
// W1′ 先红（今日 runtime.json 无 useMirrors 概念、梯次直读 decisions、
// probeMirrors 恒写 decisions 且合并字面量逐字段构造），W-A 落地 OFF 投影 /
// origin-only 梯次 / 探测跳过 / 手动 Probe 展示腿 / 合并保留后转绿。
//
// 计划锚点：../ZCode-runtime-alpha3-plan.md §2 F5 / §5 D1（OFF = 用官方源）/
// §8 MAJOR-1（梯次同义）/ §9 MAJOR-5（合并丢 useMirrors = OFF 静默翻回 true）。

const BASE_NOW = 1_750_000_000_000;
const DAY_MS = 24 * 3_600_000;

function baseJson(options?: {
  readonly useMirrors?: boolean;
  readonly expired?: boolean;
  readonly overrides?: Partial<Record<AppRuntimeArtifactClass, string>>;
}): AppRuntimeJson {
  const json: AppRuntimeJson = {
    probedAt: new Date(
      options?.expired ? BASE_NOW - 8 * DAY_MS : BASE_NOW - 3_600_000,
    ).toISOString(),
    ttlDays: 7,
    decisions: {
      nodeDist: "npmmirror",
      uvRelease: "gh-proxy.com",
      pypiIndex: "tuna",
      npmRegistry: "registry.npmmirror.com",
      pbsMirror: "registry.npmmirror.com",
    },
    ...(options?.overrides ? { overrides: options.overrides } : {}),
    measurements: [
      {
        candidate: "npmmirror",
        httpCode: 200,
        latencyMs: 100,
        ok: true,
        artifactClass: "nodeDist",
      },
      {
        candidate: "nodejs.org",
        httpCode: 200,
        latencyMs: 500,
        ok: true,
        artifactClass: "nodeDist",
      },
      { candidate: "tuna", httpCode: 200, latencyMs: 900, ok: true, artifactClass: "nodeDist" },
    ],
    pinned: { node: "v22.14.0", uv: "0.8.6" },
  };
  // useMirrors 为 additive 可选字段：经变量赋值（非字面量直写）避开 excess property
  // 检查——运行时字段保留，类型面归 W-A 扩展。
  if (options?.useMirrors !== undefined) {
    return { ...json, useMirrors: options.useMirrors };
  }
  return json;
}

function readUseMirrors(json: AppRuntimeJson | null): boolean | undefined {
  return (json as unknown as { useMirrors?: boolean }).useMirrors;
}

function silentLogger(): ServiceLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSandbox(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-mirrors-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("F5 投影：useMirrors:false → 全类 effective = origin id（红：今日投影无视 useMirrors）", () => {
  const effective = resolveEffectiveDecisions(baseJson({ useMirrors: false }));
  assert.deepEqual(
    { ...effective },
    {
      nodeDist: "nodejs.org",
      uvRelease: "github.com",
      pypiIndex: "pypi.org",
      npmRegistry: "registry.npmjs.org",
      pbsMirror: "github.com",
    },
    "OFF 时投影唯一：全类 effective = origin（D1）",
  );
});

test("F5 投影：useMirrors:true → override ?? probed 照常（今绿钉）", () => {
  const effective = resolveEffectiveDecisions(
    baseJson({ useMirrors: true, overrides: { npmRegistry: "registry.npmjs.org" } }),
  );
  assert.equal(effective.npmRegistry, "registry.npmjs.org", "ON 时 override 胜出（§4.7 既有语义）");
  assert.equal(effective.nodeDist, "npmmirror", "ON 时无 override 位保持 probed 决策");
});

test("F5 梯次：useMirrors:false → origin-only（仅 origin 候选），无镜像主选/次选（红：今日直读 decisions）", () => {
  const ladder = buildCandidateLadder("nodeDist", baseJson({ useMirrors: false }));
  assert.deepEqual(ladder.candidates, ["nodejs.org"], "OFF 梯次 = origin-only（MAJOR-1）");
  assert.equal(ladder.isOverrideSlot, false, "OFF 梯次非 override 槽位");
});

test("F5 梯次：OFF 压制 overrides → 仍 origin-only 且硬失败规则不武装（红：今日 override 仍胜）", () => {
  const ladder = buildCandidateLadder(
    "nodeDist",
    baseJson({ useMirrors: false, overrides: { nodeDist: "tuna" } }),
  );
  assert.deepEqual(
    ladder.candidates,
    ["nodejs.org"],
    "OFF 期间 overrides 被压制（记住但不生效），梯次仍 origin-only",
  );
  assert.equal(
    ladder.isOverrideSlot,
    false,
    "压制期间 override 源硬失败规则不武装（isOverrideSlot = false）",
  );
});

test("F5 梯次：ON + override → 仅 override 候选（今绿钉——ON 恢复即生效）", () => {
  const ladder = buildCandidateLadder(
    "nodeDist",
    baseJson({ useMirrors: true, overrides: { nodeDist: "tuna" } }),
  );
  assert.deepEqual(ladder.candidates, ["tuna"], "ON 时 override 槽位形制保持");
  assert.equal(ladder.isOverrideSlot, true, "ON 时 override 硬失败规则武装（§4.7 (iv)）");
});

test("F5 探测跳过：OFF + TTL 过期 → install 不发起任何探测请求（红：今日照探 14 个候选 URL）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    writeAppRuntimeJson(
      join(sandbox.root, "runtime.json"),
      baseJson({ useMirrors: false, expired: true }),
    );
    const log: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      log.push(url);
      if (url === "https://nodejs.org/dist/index.json") {
        return new Response('[{"version":"v26.11.1"}]', { status: 200 });
      }
      if (url.endsWith(".tar.xz")) return new Response("", { status: 500 });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      installRuntime(
        "node",
        {},
        {
          runtimeRootDir: sandbox.root,
          platform: "linux",
          arch: "x64",
          fetchImpl,
          logger: silentLogger(),
          now: () => BASE_NOW,
        },
      ),
    );
    const probeUrls = log.filter(
      (url) =>
        url.includes("/v22.14.0/") ||
        url.includes("/0.8.6/") ||
        url.includes("/simple/") ||
        url.includes("/react") ||
        url.includes("python-build-standalone"),
    );
    assert.equal(
      probeUrls.length,
      0,
      `OFF 时 install 跳过探测轮（决策无意义）；探测形态 URL 调用日志：${probeUrls.join(" | ")}`,
    );
  } finally {
    sandbox.dispose();
  }
});

test("F5 手动 Probe 展示腿（OFF）：不写 decisions/overrides 且 useMirrows 保留 false（红：今日恒写 decisions + MAJOR-5 丢字段）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    // 计划 §10 MAJOR-2：本例本地覆写哨兵 nodeDist=tuna（baseJson 默认 npmmirror 供 :107 绿钉依赖），否则「不写 decisions」永不可判。
    const initialJson = baseJson({
      useMirrors: false,
      overrides: { npmRegistry: "registry.npmjs.org" },
    });
    writeAppRuntimeJson(join(sandbox.root, "runtime.json"), {
      ...initialJson,
      decisions: { ...initialJson.decisions, nodeDist: "tuna" },
    });
    const log: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      log.push(url);
      // 每类只有单一存活候选（避免 0ms 平局非确定性）：nodeDist 存活 npmmirror
      // （探测 winner ≠ 既有 decisions.nodeDist=tuna 哨兵 → 是否被写入一目了然）。
      const alive = new Set([
        "https://registry.npmmirror.com/-/binary/node/v22.14.0/SHASUMS256.txt",
        "https://github.com/astral-sh/uv/releases/download/0.8.6/sha256.sum",
        "https://pypi.org/simple/",
        "https://registry.npmjs.org/react",
        "https://registry.npmmirror.com/-/binary/python-build-standalone/",
      ]);
      return new Response("", { status: alive.has(url) ? 200 : 500 });
    }) as typeof fetch;
    const service = createLocalRuntimeService({
      runtimeRootDir: sandbox.root,
      fetchImpl,
      logger: silentLogger(),
      now: () => BASE_NOW,
    });
    const snapshot = await service.probeMirrors({ force: true });
    assert.ok(snapshot.perClass.length > 0, "手动 Probe 仍返回排名快照（纯展示面）");
    const after = readAppRuntimeJson(join(sandbox.root, "runtime.json"));
    assert.notEqual(after, null, "runtime.json 仍在场");
    assert.equal(
      after?.decisions.nodeDist,
      "tuna",
      "OFF 下手动 Probe = 纯展示腿，不写 decisions（哨兵 tuna 必须原样——今日被探测 winner 覆盖）",
    );
    assert.equal(
      readUseMirrors(after),
      false,
      "OFF 下手动 Probe 后 useMirrors 必须保留 false（MAJOR-5：合并丢字段 = OFF 静默翻回默认 true）",
    );
    assert.equal(
      after?.overrides?.npmRegistry,
      "registry.npmjs.org",
      "OFF 下手动 Probe 不动 overrides（今绿钉）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F5 MAJOR-5 安装合并：useMirrors:true + TTL 过期重探 → 合并后仍为 true（红：今日合并字面量丢字段）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    writeAppRuntimeJson(
      join(sandbox.root, "runtime.json"),
      baseJson({ useMirrors: true, expired: true }),
    );
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://nodejs.org/dist/index.json") {
        return new Response('[{"version":"v26.11.1"}]', { status: 200 });
      }
      if (url.endsWith(".tar.xz")) return new Response("", { status: 500 });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      installRuntime(
        "node",
        {},
        {
          runtimeRootDir: sandbox.root,
          platform: "linux",
          arch: "x64",
          fetchImpl,
          logger: silentLogger(),
          now: () => BASE_NOW,
        },
      ),
    );
    const after = readAppRuntimeJson(join(sandbox.root, "runtime.json"));
    assert.equal(
      readUseMirrors(after),
      true,
      "探测合并（mergeRuntimeJsonWithProbe）必须保留 useMirrors 字段（MAJOR-5）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F5 MAJOR-5 安装合并：useMirrors:false + TTL 过期 → 合并后仍为 false（红：今日重探合并丢字段）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    writeAppRuntimeJson(
      join(sandbox.root, "runtime.json"),
      baseJson({ useMirrors: false, expired: true }),
    );
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://nodejs.org/dist/index.json") {
        return new Response('[{"version":"v26.11.1"}]', { status: 200 });
      }
      if (url.endsWith(".tar.xz")) return new Response("", { status: 500 });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      installRuntime(
        "node",
        {},
        {
          runtimeRootDir: sandbox.root,
          platform: "linux",
          arch: "x64",
          fetchImpl,
          logger: silentLogger(),
          now: () => BASE_NOW,
        },
      ),
    );
    const after = readAppRuntimeJson(join(sandbox.root, "runtime.json"));
    assert.equal(
      readUseMirrors(after),
      false,
      "重探/合并链路不得把 useMirrors 翻回默认 true（MAJOR-5；OFF 侧跳过探测时文件原样保留同样满足）",
    );
  } finally {
    sandbox.dispose();
  }
});
