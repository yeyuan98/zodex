import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import {
  downloadAndVerifyCandidate,
  type CandidateOutcome,
} from "../src/runtime-tools/local-runtime/download-verify.js";

// specs/agent-runtimes.md §4.7（alpha.3 F1「梯次末位候选豁免速度下限」，MINOR-5c）+
// §4.2（F3 锚点前置：候选先过校验锚点关，才有下载与失速语义）：
// - 末位候选（安装编排按梯次位置传入 exemptSpeedFloor:true）慢涓流——持续有新
//   chunk、窗口速度远低于 256KB/s 下限——必须被允许继续并完成（「OFF 直连 origin
//   时慢速真实下载不被下限处死，慢好过没有」）；
// - 非末位候选同形涓流必须被速度下限 abort（让位梯次）；
// - 豁免仅覆盖速度下限：末位候选停滞（首 chunk 后无新 chunk）仍被闲置看门狗
//   abort（8s 阈值），DOWNLOAD_TIMEOUT_MS 总上限继续兜底。
//
// 驱动缝 = downloadAndVerifyCandidate 的 attempt.exemptSpeedFloor（install 梯次
// 循环对末位元素传 true、其余传 false——本测试按同形直接驱动；独立调用不传
// attempt = 不豁免，安全缺省）。
//
// NIT-10：一律注入 clock（mock.timers fake setTimeout + Date）+ fake fetch，CI 不做
// 真实等待；形制沿 localRuntimeStallWatchdog.test.ts（自控异步迭代体 + AbortSignal
// 观察 + setImmediate 泵放行真实 fs IO）。

/** setImmediate 泵：放行真实 fs IO（sink open/write 完成走 macrotask，非 microtask）。 */
const flushLoop = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** 任一 signal abort → 拒绝（模拟 fetch body 对 abort 的传播）。 */
function abortRejection(signals: readonly AbortSignal[]): Promise<never> {
  return new Promise<never>((_, reject) => {
    for (const signal of signals) {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
        once: true,
      });
    }
  });
}

const NODE_VERSION = "v22.14.0";
const TARBALL_FILE_NAME = `node-${NODE_VERSION}-linux-x64.tar.xz`;
// 候选 nodejs.org 的跨源校验锚点 = npmmirror（§4.2：tarball 来自 X → 另一侧）。
const NPMIRROR_SHASUMS_URL = `https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/SHASUMS256.txt`;

/**
 * 涓流参数：1KB / 2s = 512B/s ≪ 256KB/s 下限（持续有新 chunk——闲置看门狗不触发，
 * 只有速度下限/豁免语义能区分结局）。总量刻意压在 fs WriteStream highWaterMark
 * （16KB）之下：sink.write 恒返回 true、全程无 drain await——真实 fs 背压延迟
 * 会把假想时钟的 chunk 间距始终撑过 8s 闲置阈值（MINOR-15 披露缝，全量套件并行
 * 负载下曾以 4KB×100 chunks 触发误判），不在本测试射程内，直接排除。
 */
const TRICKLE_CHUNK_BYTES = 1024;
const TRICKLE_INTERVAL_MS = 2_000;

/** 涓流体：先吐首 chunk，其后每 500ms（假想时钟）一个 4KB chunk；totalChunks=null 永续。 */
function makeTrickleBody(
  totalChunks: number | null,
): (signals: readonly AbortSignal[]) => AsyncIterable<Uint8Array> {
  return (signals: readonly AbortSignal[]) => ({
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(TRICKLE_CHUNK_BYTES).fill(0xab);
      for (let index = 1; totalChunks === null || index < totalChunks; index += 1) {
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, TRICKLE_INTERVAL_MS)),
          abortRejection(signals),
        ]);
        yield new Uint8Array(TRICKLE_CHUNK_BYTES).fill(0xab);
      }
    },
  });
}

/** 涓流全部 chunk 拼接后的期望 sha256（SHASUMS 锚点供正确值，让豁免路径能走完校验）。 */
function trickleSha256(totalChunks: number): string {
  return createHash("sha256")
    .update(Buffer.alloc(TRICKLE_CHUNK_BYTES * totalChunks, 0xab))
    .digest("hex");
}

/**
 * 路由 fake fetch：SHASUMS 锚点（F3 前置——先于 tarball 被取）回静态文本；
 * tarball 回自控异步迭代体（观察 AbortSignal，与真实 fetch body 同形）。
 */
function makeStreamingFetch(options: {
  readonly shasumsBody: string;
  readonly makeTarballBody: (signals: readonly AbortSignal[]) => AsyncIterable<Uint8Array>;
}): {
  readonly fetchImpl: typeof fetch;
  readonly teardown: AbortController;
} {
  const teardownController = new AbortController();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === NPMIRROR_SHASUMS_URL) {
      return new Response(options.shasumsBody, { status: 200 });
    }
    const signals = init?.signal
      ? [init.signal, teardownController.signal]
      : [teardownController.signal];
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: options.makeTarballBody(signals),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, teardown: teardownController };
}

interface Sandbox {
  root: string;
  dispose: () => void;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-exempt-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function silentLogger(): ServiceLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

test("F1 末位豁免：非末位候选慢涓流（8KB/s ≪ 256KB/s）→ 速度下限 abort，让位梯次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sandbox = makeSandbox();
  const { fetchImpl, teardown } = makeStreamingFetch({
    shasumsBody: `${"0".repeat(64)}  ${TARBALL_FILE_NAME}`,
    makeTarballBody: makeTrickleBody(null),
  });
  try {
    const outcome = downloadAndVerifyCandidate(
      "node",
      "nodejs.org",
      NODE_VERSION,
      {
        runtimeRootDir: sandbox.root,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        logger: silentLogger(),
      },
      undefined,
      { exemptSpeedFloor: false },
    );
    // 驱动假想时钟（自适应轮询直到判定落定：宽限 15s + 首次窗口评估 ≈ 16s 假想
    // 时钟量级；满负载下 fs 竞争会拖慢真实宏任务节奏，固定预算会误报 pending）。
    let settled: string | null = null;
    for (let index = 0; index < 900 && settled === null; index += 1) {
      t.mock.timers.tick(50);
      await flushLoop(2);
      settled = await Promise.race([
        outcome.then(
          (value) => `ok:${value.ok}:${value.error ?? ""}`,
          (error) => `rejected:${String(error)}`,
        ),
        (async () => {
          await flushLoop(1);
          return null;
        })(),
      ]);
    }
    assert.ok(settled !== null, "非末位候选慢涓流必须在假想时钟内完成判定（速度下限起判）");
    assert.ok(
      settled.startsWith("ok:false"),
      `非末位候选慢涓流必须按速度下限判候选失败（ok:false 走梯次）；实际：${settled}`,
    );
    assert.match(
      settled,
      /stalled \(speed\)/u,
      "失速类型必须是速度下限（闲置看门狗不该触发——涓流持续有新 chunk）",
    );
    await outcome.catch(() => undefined);
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});

test("F1 末位豁免：末位候选（exemptSpeedFloor）同形慢涓流 → 不被下限处死，允许继续并完成", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sandbox = makeSandbox();
  // 12 chunks × 2s = 24s 假想时钟：宽限 15s 后有 4 次以上 chunk 到达处的窗口评估
  // （无豁免必然已 abort；豁免正确则涓流走完并进入跨源校验——SHASUMS 供正确
  // 摘要 → ok:true）。总量 12KB < 16KB highWaterMark（见上）。
  const totalChunks = 12;
  const { fetchImpl, teardown } = makeStreamingFetch({
    shasumsBody: `${trickleSha256(totalChunks)}  ${TARBALL_FILE_NAME}`,
    makeTarballBody: makeTrickleBody(totalChunks),
  });
  try {
    const outcome = downloadAndVerifyCandidate(
      "node",
      "nodejs.org",
      NODE_VERSION,
      {
        runtimeRootDir: sandbox.root,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        logger: silentLogger(),
      },
      undefined,
      { exemptSpeedFloor: true },
    );
    let result: CandidateOutcome | null = null;
    for (let index = 0; index < 1200 && result === null; index += 1) {
      t.mock.timers.tick(50);
      await flushLoop(2);
      result = await Promise.race([
        outcome.then(
          (value) => value,
          () => null,
        ),
        (async () => {
          await flushLoop(1);
          return null;
        })(),
      ]);
    }
    assert.ok(
      result !== null,
      "末位候选慢涓流必须允许继续并完成（60s 假想时钟内走完 24s 涓流，不被速度下限 abort）",
    );
    assert.equal(
      result.ok,
      true,
      `末位候选完成后跨源校验应通过（锚点供正确摘要）；实际：${result.error ?? ""}`,
    );
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});

test("F1 末位豁免：豁免仅限速度下限——末位候选停滞（无新 chunk）仍被闲置看门狗 abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sandbox = makeSandbox();
  const { fetchImpl, teardown } = makeStreamingFetch({
    shasumsBody: `${"0".repeat(64)}  ${TARBALL_FILE_NAME}`,
    makeTarballBody: (signals) => ({
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(TRICKLE_CHUNK_BYTES);
        // 停滞：首 chunk 之后永远不再 yield（§2o npmmirror 停滞形态）——豁免不覆盖
        // 闲置看门狗，8s 阈值照常起表。
        await abortRejection(signals);
      },
    }),
  });
  try {
    const outcome = downloadAndVerifyCandidate(
      "node",
      "nodejs.org",
      NODE_VERSION,
      {
        runtimeRootDir: sandbox.root,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        logger: silentLogger(),
      },
      undefined,
      { exemptSpeedFloor: true },
    );
    // 驱动假想时钟越过闲置阈值 8s + 余量（自适应轮询直到判定落定，理由同上）。
    let settled: string | null = null;
    for (let index = 0; index < 900 && settled === null; index += 1) {
      t.mock.timers.tick(50);
      await flushLoop(2);
      settled = await Promise.race([
        outcome.then(
          (value) => `ok:${value.ok}:${value.error ?? ""}`,
          (error) => `rejected:${String(error)}`,
        ),
        (async () => {
          await flushLoop(1);
          return null;
        })(),
      ]);
    }
    assert.ok(settled !== null, "末位候选停滞必须在假想时钟内完成判定（闲置看门狗起表）");
    assert.ok(
      settled.startsWith("ok:false"),
      `末位候选停滞必须仍被闲置看门狗 abort（豁免仅限速度下限）；实际：${settled}`,
    );
    assert.match(settled, /stalled \(idle\)/u, "失速类型必须是闲置看门狗（8s 无新 chunk）");
    await outcome.catch(() => undefined);
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});
