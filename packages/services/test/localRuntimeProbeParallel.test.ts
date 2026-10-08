import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { createLocalRuntimeService } from "../src/runtime-tools/local-runtime/service.js";

// specs/agent-runtimes.md §4.1（类间并行，alpha.3 F2）红测：W1′ 先红（今日
// service.probeMirrors 对五类工件**串行** await——§2o 取证：探测轮类间串行，
// 上限 5×5s=25s、实测 16.65s），W-A 类间 Promise.allSettled 化后转绿。
//
// NIT-10：注入 clock（mock.timers fake setTimeout + Date）+ 按类分层的假想延迟
// fake fetch——串行 wall ≈ 各类延迟之和（450ms 假想），并行 wall ≈ max(类)
// （150ms 假想）；断言墙钟 < 300ms（假想时间），CI 零真实等待。
//
// C 项（并行探测汇总行保持确定性类序输出——rig checklist 的 grep 锚点）：
// 今绿钉——类间并行化后仍须按候选表类序输出，防乱序回退。

const CLASS_DELAY_MS: ReadonlyArray<[string, number]> = [
  ["nodejs.org/dist/,npmmirror node, tuna nodejs-release", 30],
  ["astral-sh/uv/releases", 60],
  ["/simple/", 90],
  ["/react", 120],
  ["python-build-standalone", 150],
];

function classDelayForUrl(url: string): number {
  for (const [signature, delayMs] of CLASS_DELAY_MS) {
    const signatures = signature.split(",");
    if (signatures.some((entry) => url.includes(entry))) return delayMs;
  }
  return 30;
}

function makeDelayedFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const delayMs = classDelayForUrl(url);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return new Response("", { status: 200 });
  }) as typeof fetch;
}

interface CapturingLogger extends ServiceLogger {
  readonly infoLines: string[];
}

function makeCapturingLogger(): CapturingLogger {
  const infoLines: string[] = [];
  return {
    infoLines,
    debug: () => {},
    info: (_traceId, ...args) => {
      infoLines.push(args.join(" "));
    },
    warn: () => {},
    error: () => {},
  };
}

function flushLoop(rounds: number): Promise<void> {
  return (async () => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
}

/** 假想时钟驱动循环：逐步 tick + 放行 IO，直到 promise 定格（NIT-10 零真实等待）。 */
async function driveUntilSettled(
  t: import("node:test").TestContext,
  promise: Promise<unknown>,
): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let index = 0; index < 2_000 && !settled; index += 1) {
    t.mock.timers.tick(10);
    await flushLoop(2);
  }
  assert.ok(settled, "探测轮必须在假想时钟驱动内完成");
}

test("F2 类间并行：五类各带假想延迟 → 探测轮 wall ≈ max(类) 而非各类之和（红：今日串行 450ms）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-probe-par-"));
  try {
    mkdirSync(join(root, "node"), { recursive: true });
    const logger = makeCapturingLogger();
    const service = createLocalRuntimeService({
      runtimeRootDir: root,
      fetchImpl: makeDelayedFetch(),
      logger,
    });
    const startedAt = Date.now();
    await driveUntilSettled(t, service.probeMirrors({ force: true }));
    const elapsedMs = Date.now() - startedAt;
    const serialSumMs = CLASS_DELAY_MS.reduce((sum, [, delay]) => sum + delay, 0);
    assert.ok(
      elapsedMs < 300,
      `类间并行后探测轮 wall（假想 ${elapsedMs}ms）应 ≈ max(类)=150ms，而非串行之和 ${serialSumMs}ms`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F2 C 项汇总行：probe round 日志按候选表类序确定性输出（今绿钉——并行化后不得乱序）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-probe-order-"));
  try {
    mkdirSync(join(root, "node"), { recursive: true });
    const logger = makeCapturingLogger();
    const service = createLocalRuntimeService({
      runtimeRootDir: root,
      fetchImpl: makeDelayedFetch(),
      logger,
    });
    await driveUntilSettled(t, service.probeMirrors({ force: true }));
    const summaryLine = logger.infoLines.find((line) => line.includes("probe round:"));
    assert.ok(summaryLine !== undefined, "每轮探测一行汇总日志必须存在（§4.7 日志通道）");
    const canonicalOrder = ["nodeDist=", "uvRelease=", "pypiIndex=", "npmRegistry=", "pbsMirror="];
    let lastIndex = -1;
    for (const marker of canonicalOrder) {
      const index = summaryLine.indexOf(marker);
      assert.ok(
        index > lastIndex,
        `汇总行类序必须确定性（${marker} 应按候选表类序出现）：${summaryLine}`,
      );
      lastIndex = index;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
