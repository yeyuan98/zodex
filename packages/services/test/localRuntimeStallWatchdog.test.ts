import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOWNLOAD_TIMEOUT_MS,
  downloadArtifactToFile,
} from "../src/runtime-tools/local-runtime/upstream.js";

// specs/agent-runtimes.md §4.7（alpha.3 F1 下载失速看门狗精确语义）红测：
// W1′ 先红（upstream.downloadArtifactToFile 现仅有 DOWNLOAD_TIMEOUT_MS 总超时、
// 无失速检测——§2o 取证：npmmirror 停滞干等 600.01s = 95.1% 安装时长），W-A 落地
// 闲置看门狗 + 速度下限后转绿。
//
// NIT-10：一律注入 clock（node:test mock.timers fake setTimeout + Date）+ fake
// fetch（自控异步迭代体，观察 AbortSignal——与真实 Response body 同形），CI 不做
// 真实等待——失速 abort 必须发生在假想 8-15s 量级，而非等待 DOWNLOAD_TIMEOUT_MS
// （10min）。
//
// 计划锚点：../ZCode-runtime-alpha3-plan.md §2 F1 / §5 D2（参数固定：
// DOWNLOAD_STALL_IDLE_MS = 8_000 / DOWNLOAD_SPEED_GRACE_MS = 15_000 /
// DOWNLOAD_SPEED_FLOOR_BYTES_PER_SEC = 256 * 1024 / DOWNLOAD_SPEED_WINDOW_MS =
// 10_000）/ §9 MINOR-15（chunk 时间戳在流 yield 处取，磁盘 drain 不算网络闲置）。

/** setImmediate 泵：放行真实 fs IO（sink open/write 完成走 macrotask，非 microtask）。 */
const flushLoop = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/**
 * 自控异步迭代体（非 undici Response）：impl 只消费 ok/status/headers/body 迭代。
 * body 观察 impl 传入的 AbortSignal（与真实 fetch body 同形——abort → 迭代抛错）；
 * teardownController 供测试收尾（今日实现永不 abort 时解除悬挂，防跨测试泄漏）。
 */
function makeFakeFetch(makeBody: (signals: readonly AbortSignal[]) => AsyncIterable<Uint8Array>): {
  fetchImpl: typeof fetch;
  teardown: AbortController;
} {
  const teardownController = new AbortController();
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signals = init?.signal
      ? [init.signal, teardownController.signal]
      : [teardownController.signal];
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: makeBody(signals),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, teardown: teardownController };
}

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

interface Sandbox {
  root: string;
  dispose: () => void;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-stall-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("F1 闲置看门狗：首 chunk 后连续无新 chunk → 假想 8s 量级快速 abort（红：今日干等 DOWNLOAD_TIMEOUT_MS）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sandbox = makeSandbox();
  const { fetchImpl, teardown } = makeFakeFetch((signals) => ({
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(8 * 1024);
      // 停滞：首 chunk 之后永远不再 yield（§2o npmmirror 停滞形态）；只有 abort 能解除。
      await abortRejection(signals);
    },
  }));
  try {
    const outcome = downloadArtifactToFile(
      "https://mirror.example/node.tar.xz",
      join(sandbox.root, "f"),
      {
        fetchImpl,
      },
    );
    // 驱动假想时钟越过 DOWNLOAD_STALL_IDLE_MS（8s）+ 余量——远小于 10min 总上限。
    for (let index = 0; index < 95; index += 1) {
      t.mock.timers.tick(100);
      await flushLoop(2);
    }
    const settled = await Promise.race([
      outcome.then(
        () => "resolved",
        (error) => `rejected:${String(error)}`,
      ),
      (async () => {
        await flushLoop(10);
        return "pending";
      })(),
    ]);
    assert.ok(
      settled.startsWith("rejected"),
      `闲置 8s 后必须 abort 候选下载（快速失败而非等待 DOWNLOAD_TIMEOUT_MS=${DOWNLOAD_TIMEOUT_MS}ms）；实际状态：${settled}`,
    );
    await outcome.catch(() => undefined);
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});

test("F1 速度下限：15s 宽限后慢涓流（2KB/s ≪ 256KB/s）→ abort（红：今日无速度下限）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sandbox = makeSandbox();
  const { fetchImpl, teardown } = makeFakeFetch((signals) => ({
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(1024);
      // 慢涓流：每 500ms（假想时钟）1KB = 2KB/s——持续有新 chunk（闲置看门狗
      // 不触发），但宽限 15s 后滑动窗口速度远低于 256KB/s 下限。
      for (;;) {
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
          abortRejection(signals),
        ]);
        yield new Uint8Array(1024);
      }
    },
  }));
  try {
    const outcome = downloadArtifactToFile(
      "https://mirror.example/node.tar.xz",
      join(sandbox.root, "f"),
      {
        fetchImpl,
      },
    );
    // 驱动假想时钟 40s（宽限 15s + 评估余量；chunk 间隔 500ms ≪ 闲置 8s）。
    for (let index = 0; index < 400; index += 1) {
      t.mock.timers.tick(100);
      await flushLoop(1);
    }
    const settled = await Promise.race([
      outcome.then(
        () => "resolved",
        (error) => `rejected:${String(error)}`,
      ),
      (async () => {
        await flushLoop(10);
        return "pending";
      })(),
    ]);
    assert.ok(
      settled.startsWith("rejected"),
      `宽限 15s 后窗口平均速度 < 256KB/s 必须 abort（慢涓流候选让位梯次）；实际状态：${settled}`,
    );
    await outcome.catch(() => undefined);
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});

/** [ulw] NIT-3（满载 flake 稳定化）：自适应驱动假想时钟直至下载落定，替代固定预算轮询（形制沿 UseMirrorsOffExemption）。 */
async function driveClockUntilSettled(
  t: test.MockTestContext,
  downloading: Promise<{ readonly bytes: number }>,
): Promise<{ readonly bytes: number } | null> {
  for (let index = 0; index < 1200; index += 1) {
    t.mock.timers.tick(50);
    await flushLoop(2);
    const settled = await Promise.race([
      downloading.then(
        (value) => value,
        () => null,
      ),
      (async () => {
        await flushLoop(1);
        return null;
      })(),
    ]);
    if (settled !== null) return settled;
  }
  return null;
}

test("F1 首 chunk 前不起表：10s 慢 TTFB 后送达 → 下载照常完成（今绿钉 guard：TTFB 由总超时管）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sandbox = makeSandbox();
  const { fetchImpl, teardown } = makeFakeFetch((signals) => ({
    async *[Symbol.asyncIterator]() {
      // TTFB 10s > 闲置阈值 8s，但首 chunk 前闲置看门狗不得起表（MINOR-5b）。
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        abortRejection(signals),
      ]);
      yield new Uint8Array(2048);
    },
  }));
  try {
    const outcome = downloadArtifactToFile(
      "https://origin.example/node.tar.xz",
      join(sandbox.root, "f"),
      {
        fetchImpl,
      },
    );
    const result = await driveClockUntilSettled(t, outcome);
    assert.ok(result !== null, "20s 假想时钟内慢 TTFB 下载必须完成（不 abort）");
    assert.equal(result.bytes, 2048, "慢 TTFB 但正常送达的下载不得被误杀");
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});
