import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { installRuntime } from "../src/runtime-tools/local-runtime/install.js";
import { buildAppRuntimeBashAppend } from "../src/runtime-tools/local-runtime/bash-append.js";
import {
  readAppRuntimeJson,
  resolveEffectiveDecisions,
  type AppRuntimeDecisions,
  type AppRuntimeJson,
} from "../src/runtime-tools/local-runtime/runtime-json.js";
import { resolveRuntimeMirrorEnvValues } from "@zcode/shared";

// specs/agent-runtimes.md §4.1（规则 4 类域限定）/§4.7（alpha.3 F6 填充类失败降级 +
// MINOR-13 defaults 不得复活已删键）红测：W1′ 先红（今日填充类探测 all-dead 会以
// AllProbeCandidatesDeadError 中止整个安装——§1.3.4，且合并 = defaultDecisions +
// spread 会复活已删键），W-A 落地「warn + 该类不填空（键删）、安装照常」后转绿。
//
// 计划锚点：../ZCode-runtime-alpha3-plan.md §2 F6 / §8 MINOR-7（schema 表达 =
// decisions 键删）/ §9 MINOR-13（类型涟漪 + 复活缺陷）。

const BASE_NOW = 1_750_000_000_000;

function silentLogger(): ServiceLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** pypiIndex 四候选全灭，其余四类各有单一存活候选（避免 0ms 平局非确定性）。 */
function makeDegradeFetch(log: string[]): typeof fetch {
  const alive = new Set([
    "https://registry.npmmirror.com/-/binary/node/v22.14.0/SHASUMS256.txt",
    "https://github.com/astral-sh/uv/releases/download/0.8.6/sha256.sum",
    "https://registry.npmjs.org/react",
    "https://registry.npmmirror.com/-/binary/python-build-standalone/",
  ]);
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.push(url);
    if (url === "https://nodejs.org/dist/index.json") {
      return new Response('[{"version":"v26.11.1"}]', { status: 200 });
    }
    if (url.endsWith(".tar.xz")) return new Response("", { status: 500 });
    return new Response("", { status: alive.has(url) ? 200 : 500 });
  }) as typeof fetch;
}

function makeSandbox(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-degrade-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("F6 填充类降级：pypiIndex 全灭 → 安装照常过探测（不中止），decisions 键 pypiIndex 删除（红：今日 all-dead 中止安装）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    const log: string[] = [];
    await assert.rejects(
      installRuntime(
        "node",
        {},
        {
          runtimeRootDir: sandbox.root,
          platform: "linux",
          arch: "x64",
          fetchImpl: makeDegradeFetch(log),
          logger: silentLogger(),
          now: () => BASE_NOW,
        },
      ),
      undefined,
      "安装最终仍失败（下载梯全 500）——但失败必须发生在探测之后的下载阶段，而非探测中止",
    );
    const after = readAppRuntimeJson(join(sandbox.root, "runtime.json"));
    assert.notEqual(
      after,
      null,
      "填充类 all-dead 不得中止安装：探测轮照常落盘 runtime.json（今日 AllProbeCandidatesDeadError 直接抛出、文件缺席）",
    );
    const decisions = after?.decisions as Partial<AppRuntimeDecisions> | undefined;
    assert.equal(
      decisions?.pypiIndex,
      undefined,
      "pypiIndex all-dead → decisions 键删除（键删 = 不填空，不保 stale 镜像值）",
    );
    assert.equal(
      log.filter((url) => url === "https://nodejs.org/dist/index.json").length,
      1,
      "安装照常推进到版本解析（探测阶段未被填充类失败打断）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F6 MINOR-13：force 重探合并不得复活已删键（红：今日 defaultDecisions+spread 复活 pypi.org）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    const log: string[] = [];
    const deps = {
      runtimeRootDir: sandbox.root,
      platform: "linux" as const,
      arch: "x64" as const,
      fetchImpl: makeDegradeFetch(log),
      logger: silentLogger(),
      now: () => BASE_NOW,
    };
    // 第一次安装（未来语义：落盘无 pypiIndex 键的 runtime.json）；强制重探第二次
    // 安装的合并 defaultDecisions 含 pypiIndex="pypi.org"，不得把它复活回 decisions。
    await installRuntime("node", {}, deps).catch(() => undefined);
    await installRuntime("node", { forceReprobe: true }, deps).catch(() => undefined);
    const after = readAppRuntimeJson(join(sandbox.root, "runtime.json"));
    assert.notEqual(after, null, "两次安装后 runtime.json 必须在场（第一次安装已落盘）");
    const decisions = after?.decisions as Partial<AppRuntimeDecisions> | undefined;
    assert.equal(
      decisions?.pypiIndex,
      undefined,
      "重探合并的 defaultDecisions 不得复活已删键（MINOR-13：需显式删除处理，不能只靠省略）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F6 读端容错（今绿钉）：decisions 缺键 → effective 投影 undefined → L3/Bash 填空缺席", () => {
  const json: AppRuntimeJson = {
    probedAt: new Date(BASE_NOW).toISOString(),
    ttlDays: 7,
    // 缺 pypiIndex 键（F6 键删形态；类型可选化归 W-A，此处 Partial 断言形态）。
    decisions: {
      nodeDist: "nodejs.org",
      uvRelease: "github.com",
      npmRegistry: "registry.npmjs.org",
      pbsMirror: "registry.npmmirror.com",
    } as AppRuntimeDecisions,
    measurements: [],
    pinned: { node: "v22.14.0", uv: "0.8.6" },
  };
  const effective = resolveEffectiveDecisions(json);
  assert.equal(
    (effective as Partial<AppRuntimeDecisions>).pypiIndex,
    undefined,
    "effective 投影对缺席键 = undefined（读端本就容错）",
  );
  assert.deepEqual(resolveRuntimeMirrorEnvValues({}), {}, "决策缺席 → 填空值投影空");
  const bashAppend = buildAppRuntimeBashAppend(
    { PATH: "/usr/bin" },
    {
      root: join("/", "opt", "rt"),
      current: { node: "v22.14.0", uv: null },
      binDirExists: () => true,
      decisions: {},
      platform: "linux",
    },
  );
  assert.equal(
    bashAppend?.envFill.UV_DEFAULT_INDEX,
    undefined,
    "decisions 缺 pypiIndex → Bash 腿不填 UV_DEFAULT_INDEX（不猜默认镜像）",
  );
});
