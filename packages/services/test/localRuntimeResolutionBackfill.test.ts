import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { installRuntime } from "../src/runtime-tools/local-runtime/install.js";

// specs/agent-runtimes.md §4.2（版本解析；alpha.3 F2 解析顺序回填探活）红测：
// W1′ 先红——今日 resolveLatestNodeVersion 固定先试 nodejs.org/dist/index.json
// （探活结论不回填，§2o 次因：CN 挂起 20s 税——代码推导值），W-A 按 §4.1 探测
// 决策择 index.json 源（origin 探活死 → 先 npmmirror）后转绿。
//
// 断言面（fetch 调用日志）：探测轮已判定 nodeDist origin（nodejs.org）死 → 安装
// 的版本解析**不得再咨询** nodejs.org/dist/index.json（跳过死的解析源），npmmirror
// index.json 恰好咨询一次。fetch 全即时响应（真实网络零等待）。

interface Route {
  readonly match: (url: string) => boolean;
  readonly status: number;
  readonly body?: string;
}

interface LoggedFetch {
  readonly fetchImpl: typeof fetch;
  readonly log: readonly string[];
  readonly count: (exactUrl: string) => number;
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
  return { fetchImpl, log, count: (exactUrl) => log.filter((entry) => entry === exactUrl).length };
}

function silentLogger(): ServiceLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSandbox(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-backfill-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const ORIGIN_INDEX_URL = "https://nodejs.org/dist/index.json";
const NPMIRROR_INDEX_URL = "https://registry.npmmirror.com/-/binary/node/index.json";

test("F2 解析顺序回填：探测判定 origin（nodejs.org）死 → 版本解析不再咨询 nodejs.org index.json（红：今日固定先试 origin）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node"), { recursive: true });
    const routes: readonly Route[] = [
      // nodeDist 探测（known-good tag v22.14.0）：origin 死、npmmirror 存活（tuna 死
      // 消平平局）→ 决策 = npmmirror。
      { match: (url) => url === "https://nodejs.org/dist/v22.14.0/SHASUMS256.txt", status: 500 },
      {
        match: (url) =>
          url === "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v22.14.0/SHASUMS256.txt",
        status: 500,
      },
      // 版本解析：origin index.json 死（会被回填跳过）、npmmirror 同名文件存活。
      { match: (url) => url === ORIGIN_INDEX_URL, status: 500 },
      { match: (url) => url === NPMIRROR_INDEX_URL, status: 200, body: '[{"version":"v26.11.1"}]' },
      // 下载梯全部失败（本测试只关心解析顺序，不关心下载结果）。
      { match: (url) => url.endsWith(".tar.xz"), status: 500 },
      // 其余探测候选一律存活。
      { match: () => true, status: 200 },
    ];
    const logged = makeLoggedFetch(routes);
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
        },
      ),
    );
    assert.equal(
      logged.count(ORIGIN_INDEX_URL),
      0,
      `探测已判定 origin 死后不得再咨询 ${ORIGIN_INDEX_URL}（调用日志：${logged.log.join(" | ")}）`,
    );
    assert.equal(
      logged.count(NPMIRROR_INDEX_URL),
      1,
      "npmmirror index.json 恰好咨询一次并完成解析",
    );
  } finally {
    sandbox.dispose();
  }
});
