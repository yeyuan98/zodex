import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import {
  buildCandidateLadder,
  downloadAndVerifyCandidate,
} from "../src/runtime-tools/local-runtime/download-verify.js";
import type { AppRuntimeJson } from "../src/runtime-tools/local-runtime/runtime-json.js";

// specs/agent-runtimes.md §4.7（alpha.3 F5×F1 互作，计划 §3 P4a SANCTION 新测试）：
// useMirrors:false → 梯次 origin-only（MAJOR-1）⇒ origin **即**梯次末位候选 ⇒
// F1 末位候选豁免速度下限（MINOR-5c）落其上——OFF 直连 origin 的慢速真实下载
// （持续有新 chunk、窗口速度 ≪ 256KB/s）被允许继续并完成（跨源校验通过），
// 而非被速度下限处死（V1/V3① 的唯一自动化钉）。
//
// 对照腿：同形 OFF 涓流在豁免未武装（exemptSpeedFloor:false，如独立调用缺省）
// 时必须被速度下限 abort——证明「OFF origin 涓流可活」归因于末位豁免而非涓流
// 本身够快。
//
// 驱动缝 = 安装编排同形的迷你梯次遍历（install.ts 逐候选、末位元素传
// exemptSpeedFloor:true）；NIT-10：一律注入 clock（mock.timers fake
// setTimeout + Date）+ fake fetch，形制沿 localRuntimeStallExemption.test.ts
// （自控异步迭代体 + AbortSignal 观察 + setImmediate 泵放行真实 fs IO）。

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
 * （16KB）之下：sink.write 恒返回 true、全程无 drain await（形制依据见
 * localRuntimeStallExemption.test.ts 同段注释）。
 */
const TRICKLE_CHUNK_BYTES = 1024;
const TRICKLE_INTERVAL_MS = 2_000;
const TRICKLE_TOTAL_CHUNKS = 12;

/** OFF runtime.json：decisions 钉镜像主选 + overrides 在场（压制语义一并入梯次）。 */
function offRuntimeJson(): AppRuntimeJson {
  return {
    probedAt: new Date(1_750_000_000_000).toISOString(),
    ttlDays: 7,
    decisions: {
      nodeDist: "npmmirror",
      uvRelease: "gh-proxy.com",
      pypiIndex: "tuna",
      npmRegistry: "registry.npmmirror.com",
      pbsMirror: "registry.npmmirror.com",
    },
    overrides: { nodeDist: "tuna" },
    measurements: [],
    pinned: { node: NODE_VERSION, uv: "0.8.6" },
    useMirrors: false,
  };
}

/** 涓流体：先吐首 chunk，其后每 2s（假想时钟）一个 1KB chunk，共 12 份（24s）。 */
function makeTrickleBody(signals: readonly AbortSignal[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(TRICKLE_CHUNK_BYTES).fill(0xab);
      for (let index = 1; index < TRICKLE_TOTAL_CHUNKS; index += 1) {
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, TRICKLE_INTERVAL_MS)),
          abortRejection(signals),
        ]);
        yield new Uint8Array(TRICKLE_CHUNK_BYTES).fill(0xab);
      }
    },
  };
}

/** 涓流全部 chunk 拼接后的期望 sha256（SHASUMS 锚点供正确值，让豁免路径走完校验）。 */
function trickleSha256(): string {
  return createHash("sha256")
    .update(Buffer.alloc(TRICKLE_CHUNK_BYTES * TRICKLE_TOTAL_CHUNKS, 0xab))
    .digest("hex");
}

/**
 * 路由 fake fetch：SHASUMS 锚点（F3 前置——先于 tarball 被取）回静态文本；
 * tarball 回自控异步迭代体（观察 AbortSignal，与真实 fetch body 同形）。
 */
function makeStreamingFetch(shasumsBody: string): {
  readonly fetchImpl: typeof fetch;
  readonly teardown: AbortController;
} {
  const teardownController = new AbortController();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === NPMIRROR_SHASUMS_URL) {
      return new Response(shasumsBody, { status: 200 });
    }
    const signals = init?.signal
      ? [init.signal, teardownController.signal]
      : [teardownController.signal];
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: makeTrickleBody(signals),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, teardown: teardownController };
}

function makeSandbox(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-mirrors-exempt-"));
  return {
    root,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function silentLogger(): ServiceLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * 安装编排同形的迷你梯次遍历（install.ts 逐候选尝试、末位元素豁免速度下限）：
 * 逐候选调 downloadAndVerifyCandidate，exemptSpeedFloor = 是否末位；任一成功
 * 即返回。OFF 梯次 = origin-only ⇒ 首个（唯一）候选即末位 ⇒ 豁免武装。
 */
async function walkLadderLikeInstall(options: {
  readonly root: string;
  readonly fetchImpl: typeof fetch;
  readonly armed: boolean;
}): Promise<
  {
    readonly candidate: string;
    readonly ok: boolean;
    readonly error?: string;
  }[]
> {
  const ladder = buildCandidateLadder("nodeDist", offRuntimeJson());
  const outcomes: { candidate: string; ok: boolean; error?: string }[] = [];
  for (let index = 0; index < ladder.candidates.length; index += 1) {
    const candidate = ladder.candidates[index];
    const outcome = await downloadAndVerifyCandidate(
      "node",
      candidate,
      NODE_VERSION,
      {
        runtimeRootDir: options.root,
        platform: "linux",
        arch: "x64",
        fetchImpl: options.fetchImpl,
        logger: silentLogger(),
      },
      undefined,
      {
        exemptSpeedFloor: options.armed && index === ladder.candidates.length - 1,
      },
    );
    outcomes.push({
      candidate,
      ok: outcome.ok,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.ok) break;
  }
  return outcomes;
}

/** 驱动假想时钟直到 walkLadder 落定（自适应轮询，形制沿 StallExemption）。 */
async function driveClockUntilSettled(
  t: test.MockTestContext,
  walking: Promise<{ candidate: string; ok: boolean; error?: string }[]>,
): Promise<{ candidate: string; ok: boolean; error?: string }[] | null> {
  for (let index = 0; index < 1200; index += 1) {
    t.mock.timers.tick(50);
    await flushLoop(2);
    const settled = await Promise.race([
      walking.then(
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

test("F5×F1 OFF 互作：origin-only 梯次 ⇒ origin 即末位 ⇒ 豁免武装，慢涓流完成而非下限处死", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  // 前置钉：OFF（含 overrides 在场）梯次 = origin-only（MAJOR-1/压制语义随路复验）。
  const ladder = buildCandidateLadder("nodeDist", offRuntimeJson());
  assert.deepEqual(ladder.candidates, ["nodejs.org"], "OFF 梯次 = origin-only（唯一候选即末位）");
  assert.equal(ladder.isOverrideSlot, false, "压制期间 override 槽位语义不适用");

  const sandbox = makeSandbox();
  const { fetchImpl, teardown } = makeStreamingFetch(`${trickleSha256()}  ${TARBALL_FILE_NAME}`);
  try {
    const outcomes = await driveClockUntilSettled(
      t,
      walkLadderLikeInstall({ root: sandbox.root, fetchImpl, armed: true }),
    );
    assert.ok(
      outcomes !== null,
      "OFF origin 慢涓流必须在假想时钟内走完 24s（60s 预算），不被速度下限 abort",
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.candidate),
      ["nodejs.org"],
      "OFF 梯次只产生 origin 一次尝试（无镜像主选/次选让梯次分叉）",
    );
    assert.equal(
      outcomes[0].ok,
      true,
      `末位豁免武装 ⇒ origin 慢涓流完成且跨源校验通过；实际：${outcomes[0].error ?? ""}`,
    );
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});

test("F5×F1 对照：同形 OFF 涓流在豁免未武装（独立调用缺省）→ 仍被速度下限 abort（豁免是 OFF origin 存活的充分条件）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sandbox = makeSandbox();
  const { fetchImpl, teardown } = makeStreamingFetch(`${"0".repeat(64)}  ${TARBALL_FILE_NAME}`);
  try {
    const outcomes = await driveClockUntilSettled(
      t,
      walkLadderLikeInstall({ root: sandbox.root, fetchImpl, armed: false }),
    );
    assert.ok(outcomes !== null, "豁免未武装时同形涓流必须在假想时钟内完成判定（速度下限起判）");
    assert.equal(outcomes[0].ok, false, "无豁免 ⇒ 512B/s ≪ 256KB/s 必须按候选失败处理");
    assert.match(
      outcomes[0].error ?? "",
      /stalled \(speed\)/u,
      "失速类型必须是速度下限（闲置看门狗不该触发——涓流持续有新 chunk）",
    );
  } finally {
    teardown.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    sandbox.dispose();
  }
});
