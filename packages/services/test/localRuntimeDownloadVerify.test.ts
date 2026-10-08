import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAndVerifyCandidate } from "../src/runtime-tools/local-runtime/download-verify.js";
import { NodeChecksumAnchorsUnavailableError } from "../src/runtime-tools/local-runtime/verify.js";

// [ulw] 评审折叠红测（specs/agent-runtimes.md §4.2/§4.7）：
// - MAJOR-2：候选可恢复失败 / 锚点级 rethrow 后，下载暂存 `.download-*` 必须被
//   清理，不得残留在 `<config>/.runtime` 根。
// - MINOR-3：锚点对候选（tarball 自 nodejs.org/npmmirror）只尝试另一侧单锚点，
//   单锚点失败 = 候选失败（ok:false，梯次继续），不升级为「双锚点不可达」typed
//   硬失败；tuna 路径两锚点皆真实尝试，双双不可达才 typed 中止。
//
// fetchImpl 注入形制沿 probe/upstream 的 option-injection 契约（不起真实网络）。

const NODE_VERSION = "v22.14.0";
const NODE_TARBALL_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz`;
const TUNA_TARBALL_URL = `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz`;
const NPMIRROR_SHASUMS_URL = `https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/SHASUMS256.txt`;
const NODEJS_SHASUMS_URL = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;

function routingFetch(routes: Readonly<Record<string, number>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const status = routes[url];
    return new Response(status === undefined ? "not found" : "", {
      status: status ?? 404,
    });
  }) as typeof fetch;
}

async function listDownloadLeftovers(root: string): Promise<string[]> {
  const entries = await readdir(root).catch(() => []);
  return entries.filter((entry) => entry.startsWith(".download-"));
}

interface Sandbox {
  root: string;
  dispose: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "zcode-local-runtime-dl-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("MAJOR-2：候选下载失败（HTTP 500）→ ok:false 且无 .download-* 残留", async () => {
  const sandbox = await makeSandbox();
  try {
    const outcome = await downloadAndVerifyCandidate("node", "nodejs.org", NODE_VERSION, {
      runtimeRootDir: sandbox.root,
      platform: "linux",
      arch: "x64",
      fetchImpl: routingFetch({ [NODE_TARBALL_URL]: 500 }),
    });
    assert.equal(outcome.ok, false, "下载失败 = 可恢复候选失败（走梯次）");
    assert.deepEqual(
      await listDownloadLeftovers(sandbox.root),
      [],
      "失败退出后暂存文件必须删除，不得残留 .download-*",
    );
  } finally {
    await sandbox.dispose();
  }
});

test("MINOR-3：锚点对候选（自 nodejs.org）单锚点（npmmirror SHASUMS）失败 → 候选失败而非双锚点硬中止", async () => {
  const sandbox = await makeSandbox();
  try {
    const outcome = await downloadAndVerifyCandidate("node", "nodejs.org", NODE_VERSION, {
      runtimeRootDir: sandbox.root,
      platform: "linux",
      arch: "x64",
      fetchImpl: routingFetch({ [NODE_TARBALL_URL]: 200, [NPMIRROR_SHASUMS_URL]: 500 }),
    });
    assert.equal(
      outcome.ok,
      false,
      "单锚点拉取失败 = 该候选失败（梯次继续），不得抛 NodeChecksumAnchorsUnavailableError",
    );
    assert.deepEqual(
      await listDownloadLeftovers(sandbox.root),
      [],
      "失败退出同样无 .download-* 残留",
    );
  } finally {
    await sandbox.dispose();
  }
});

test("MINOR-3：tuna 候选双锚点均不可达 → typed 硬失败中止（且无 .download-* 残留）", async () => {
  const sandbox = await makeSandbox();
  try {
    await assert.rejects(
      downloadAndVerifyCandidate("node", "tuna", NODE_VERSION, {
        runtimeRootDir: sandbox.root,
        platform: "linux",
        arch: "x64",
        fetchImpl: routingFetch({
          [TUNA_TARBALL_URL]: 200,
          [NPMIRROR_SHASUMS_URL]: 500,
          [NODEJS_SHASUMS_URL]: 503,
        }),
      }),
      (error: unknown) => error instanceof NodeChecksumAnchorsUnavailableError,
      "tuna 路径两锚点皆真实尝试后双双不可达 = typed 硬失败（§4.7 对称规则）",
    );
    assert.deepEqual(
      await listDownloadLeftovers(sandbox.root),
      [],
      "锚点级 rethrow 路径也必须清理暂存文件",
    );
  } finally {
    await sandbox.dispose();
  }
});
