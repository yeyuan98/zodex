import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { installRuntime } from "../src/runtime-tools/local-runtime/install.js";
import { downloadAndVerifyCandidate } from "../src/runtime-tools/local-runtime/download-verify.js";
import {
  writeAppRuntimeJson,
  type AppRuntimeJson,
} from "../src/runtime-tools/local-runtime/runtime-json.js";

// specs/agent-runtimes.md §4.2（alpha.3 F3 校验锚点前置）红测：W1′ 先红——今日
// download-verify 先下载 tarball 再取校验值（锚点不可达浪费已完成下载，§1.3.1），
// 且 uv digest 每候选重复取 api.github.com（§1.3.2 path-6），W-A 落地「先取校验值
// 再下载 + 双锚 per-anchor 预取缓存 + digest 每安装尝试一次」后转绿。
//
// 断言面（fetch 调用日志 + 计数器）：
// - 锚点不可达 → tarball 下载计数 = 0（先验货再搬运，不白下 28MB）；
// - node 双锚点（nodejs.org + npmmirror）每安装尝试各预取一次，候选间复用
//   （今日每候选重复取 → 计数 2）；
// - 单锚失败 = 候选失败（ok:false 走梯次），不升级为安装失败（§4.7 MINOR-3 今绿钉）；
// - uv digest（api.github.com releases/tags/<ver>）每安装尝试一次（今日每候选一次 → 3）。

interface Route {
  readonly match: (url: string) => boolean;
  readonly status: number;
  readonly body?: string;
}

interface LoggedFetch {
  readonly fetchImpl: typeof fetch;
  readonly count: (exactUrl: string) => number;
  readonly countWhere: (predicate: (url: string) => boolean) => number;
}

function makeLoggedFetch(routes: readonly Route[]): LoggedFetch {
  const log: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.push(url);
    const route = routes.find((entry) => entry.match(url));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", { status: route.status });
  }) as typeof fetch;
  return {
    fetchImpl,
    count: (exactUrl) => log.filter((entry) => entry === exactUrl).length,
    countWhere: (predicate) => log.filter(predicate).length,
  };
}

function silentLogger(): ServiceLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSandbox(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-anchor-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const BASE_NOW = 1_750_000_000_000;
const NODE_VERSION = "v26.11.1";
const ORIGIN_SHASUMS_URL = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
const NPMIRROR_SHASUMS_URL = `https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/SHASUMS256.txt`;
const UV_VERSION = "0.9.0";
const UV_TAGS_METADATA_URL = `https://api.github.com/repos/astral-sh/uv/releases/tags/${UV_VERSION}`;
const UV_LATEST_URL = "https://api.github.com/repos/astral-sh/uv/releases/latest";

/** 新鲜 runtime.json（TTL 内不触发重探）+ nodeDist 梯次 [npmmirror, nodejs.org, tuna]。 */
function nodeLadderJson(): AppRuntimeJson {
  return {
    probedAt: new Date(BASE_NOW - 3_600_000).toISOString(),
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
}

test("F3 前置（候选级）：校验锚点不可达 → tarball 下载永不发起（红：今日先下载后取校验值）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    const logged = makeLoggedFetch([
      { match: (url) => url === NPMIRROR_SHASUMS_URL, status: 500 },
      { match: (url) => url.endsWith(".tar.xz"), status: 200, body: "fake-node-tarball" },
    ]);
    const outcome = await downloadAndVerifyCandidate("node", "npmmirror", NODE_VERSION, {
      runtimeRootDir: sandbox.root,
      platform: "linux",
      arch: "x64",
      fetchImpl: logged.fetchImpl,
      logger: silentLogger(),
    });
    assert.equal(outcome.ok, false, "校验锚点不可达 = 该候选失败（ok:false，走梯次）");
    assert.equal(
      logged.countWhere((url) => url.endsWith(".tar.xz")),
      0,
      "锚点不可达时不得发起 tarball 下载（先取校验值再下载——白下 28MB 是 §1.3.1 缺陷）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F3 双锚预取（安装级）：多候选共用 nodejs.org/npmmirror 两份 SHASUMS，各恰好取一次（红：今日每候选重复取 = 2 次）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    writeAppRuntimeJson(join(sandbox.root, "runtime.json"), nodeLadderJson());
    const logged = makeLoggedFetch([
      // 双锚点可达但不含期望条目 → 每个候选都失败（走完整个梯次 [npmmirror,
      // nodejs.org, tuna]），从而暴露「候选间是否复用预取缓存」。
      {
        match: (url) => url === ORIGIN_SHASUMS_URL,
        status: 200,
        body: `${"a".repeat(64)}  other-file.tar.xz`,
      },
      {
        match: (url) => url === NPMIRROR_SHASUMS_URL,
        status: 200,
        body: `${"b".repeat(64)}  other-file.tar.xz`,
      },
      {
        match: (url) => url === "https://nodejs.org/dist/index.json",
        status: 200,
        body: `[{"version":"${NODE_VERSION}"}]`,
      },
      { match: (url) => url.endsWith(".tar.xz"), status: 200, body: "fake-node-tarball" },
    ]);
    await assert.rejects(
      installRuntime(
        "node",
        {},
        {
          runtimeRootDir: sandbox.root,
          platform: "linux",
          arch: "x64",
          fetchImpl: logged.fetchImpl,
          logger: silentLogger(),
          now: () => BASE_NOW,
        },
      ),
    );
    assert.equal(
      logged.count(ORIGIN_SHASUMS_URL),
      1,
      "nodejs.org SHASUMS 每安装尝试至多预取一次（候选间复用 per-anchor 缓存）",
    );
    assert.equal(
      logged.count(NPMIRROR_SHASUMS_URL),
      1,
      "npmmirror SHASUMS 每安装尝试至多预取一次（候选间复用 per-anchor 缓存）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F3 双锚预取（安装级）：双锚均不可达 → 全梯次零 tarball 下载，安装失败（红：今日先下满 3 个候选）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    writeAppRuntimeJson(join(sandbox.root, "runtime.json"), nodeLadderJson());
    const logged = makeLoggedFetch([
      { match: (url) => url === ORIGIN_SHASUMS_URL, status: 500 },
      { match: (url) => url === NPMIRROR_SHASUMS_URL, status: 500 },
      {
        match: (url) => url === "https://nodejs.org/dist/index.json",
        status: 200,
        body: `[{"version":"${NODE_VERSION}"}]`,
      },
      { match: (url) => url.endsWith(".tar.xz"), status: 200, body: "fake-node-tarball" },
    ]);
    await assert.rejects(
      installRuntime(
        "node",
        {},
        {
          runtimeRootDir: sandbox.root,
          platform: "linux",
          arch: "x64",
          fetchImpl: logged.fetchImpl,
          logger: silentLogger(),
          now: () => BASE_NOW,
        },
      ),
      undefined,
      "全部候选不可行 = 安装明确失败（单锚预取失败 = 候选跳过下载，不升级硬失败语义）",
    );
    assert.equal(
      logged.countWhere((url) => url.endsWith(".tar.xz")),
      0,
      "双锚不可达 → 预检阶段就放弃，梯次三候选均不得发起 tarball 下载",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F3 uv digest 每尝试一次：多候选（github.com → gh-proxy.com → ghfast.top）只取一次 api.github.com digest（红：今日每候选取 = 3 次）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "uv"), { recursive: true });
    const json: AppRuntimeJson = {
      probedAt: new Date(BASE_NOW - 3_600_000).toISOString(),
      ttlDays: 7,
      decisions: {
        nodeDist: "nodejs.org",
        uvRelease: "github.com",
        pypiIndex: "pypi.org",
        npmRegistry: "registry.npmjs.org",
        pbsMirror: "registry.npmmirror.com",
      },
      measurements: [
        {
          candidate: "gh-proxy.com",
          httpCode: 200,
          latencyMs: 100,
          ok: true,
          artifactClass: "uvRelease",
        },
        {
          candidate: "ghfast.top",
          httpCode: 200,
          latencyMs: 200,
          ok: true,
          artifactClass: "uvRelease",
        },
      ],
      pinned: { node: "v22.14.0", uv: "0.8.6" },
    };
    writeAppRuntimeJson(join(sandbox.root, "runtime.json"), json);
    const wrongDigest = `sha256:${"0".repeat(64)}`;
    const logged = makeLoggedFetch([
      { match: (url) => url === UV_LATEST_URL, status: 200, body: `{"tag_name":"${UV_VERSION}"}` },
      {
        match: (url) => url === UV_TAGS_METADATA_URL,
        status: 200,
        body: `{"tag_name":"${UV_VERSION}","assets":[{"name":"uv-x86_64-unknown-linux-gnu.tar.gz","digest":"${wrongDigest}"}]}`,
      },
      // 三候选 tarball 全部可达但摘要不匹配 → 三候选全失败（走完梯次暴露重复取 digest）。
      { match: (url) => url.endsWith(".tar.gz"), status: 200, body: "fake-uv-tarball" },
    ]);
    await assert.rejects(
      installRuntime(
        "uv",
        {},
        {
          runtimeRootDir: sandbox.root,
          platform: "linux",
          arch: "x64",
          fetchImpl: logged.fetchImpl,
          logger: silentLogger(),
          now: () => BASE_NOW,
        },
      ),
    );
    assert.equal(
      logged.count(UV_TAGS_METADATA_URL),
      1,
      "uv digest（api.github.com 恒定锚点）每安装尝试取一次、候选间复用——防 gh-proxy 下载成功被第二次 digest 取败毁掉（§1.3.2）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F3 单锚失败语义（今绿钉）：非 tuna 候选单锚拉取失败 = 候选失败（ok:false），不抛双锚点硬失败", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    const logged = makeLoggedFetch([
      { match: (url) => url === NPMIRROR_SHASUMS_URL, status: 500 },
      { match: (url) => url.endsWith(".tar.xz"), status: 200, body: "fake-node-tarball" },
    ]);
    const outcome = await downloadAndVerifyCandidate("node", "nodejs.org", NODE_VERSION, {
      runtimeRootDir: sandbox.root,
      platform: "linux",
      arch: "x64",
      fetchImpl: logged.fetchImpl,
      logger: silentLogger(),
    });
    assert.equal(
      outcome.ok,
      false,
      "锚点对候选（tarball 自 nodejs.org）单锚（npmmirror）失败 = 该候选失败，梯次继续",
    );
  } finally {
    sandbox.dispose();
  }
});
