import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalRuntimeStartupGc } from "../src/runtime-tools/local-runtime/startup-gc.js";
import { writeCurrentPointer } from "../src/runtime-tools/local-runtime/current.js";

// specs/agent-runtimes.md §4.6（GC 重试归属；alpha.3 F7 增扫 `.download-*`）红测：
// W1′ 先红（今日启动 GC 只清 CURRENT.tmp* 与 v<ver>.gc-*，`.download-*` 崩溃残留
// 无清扫——§1.3.3），W-A 增扫后转绿。
//
// 语义：`<config>/.runtime` 根下的 `.download-*` 半写残留按 mtime 宽限清扫——
// 超过宽限期（崩溃残留，不可能仍属在飞安装）→ 删除；宽限期内（可能是在飞安装的
// 暂存）→ 保留。deps.now 注入时钟（NIT-10）。

const BASE_NOW = Date.parse("2026-10-08T12:00:00.000Z");
const LEFTOVER_GRACE_MS = 24 * 3_600_000;

interface Sandbox {
  root: string;
  dispose: () => void;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "zcode-runtime-gc-dl-"));
  mkdirSync(join(root, "node"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("F7 启动 GC：过期（>24h）`.download-*` 崩溃残留被清扫（红：今日只清 CURRENT.tmp*/gc 孤儿）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node", "v22.14.0"), { recursive: true });
    writeCurrentPointer(join(sandbox.root, "node"), "v22.14.0");
    const staleLeftover = join(sandbox.root, `.download-node-${process.pid}-1-1`);
    writeFileSync(staleLeftover, "half-written-bytes");
    // 崩溃残留：mtime 早于宽限（>24h）。
    utimesSync(
      staleLeftover,
      new Date(BASE_NOW - LEFTOVER_GRACE_MS - 3_600_000),
      new Date(BASE_NOW - LEFTOVER_GRACE_MS - 3_600_000),
    );
    await runLocalRuntimeStartupGc({ runtimeRootDir: sandbox.root, now: () => BASE_NOW });
    assert.equal(
      existsSync(staleLeftover),
      false,
      "过期 .download-* 崩溃残留必须在启动 GC 清扫（不留残骸在 <config>/.runtime 根）",
    );
  } finally {
    sandbox.dispose();
  }
});

test("F7 启动 GC：宽限期内 `.download-*`（可能是在飞安装暂存）保留（今绿钉——不误删并发安装）", async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(join(sandbox.root, "node", "v22.14.0"), { recursive: true });
    writeCurrentPointer(join(sandbox.root, "node"), "v22.14.0");
    const freshLeftover = join(sandbox.root, `.download-node-${process.pid}-2-2`);
    writeFileSync(freshLeftover, "in-flight-bytes");
    utimesSync(freshLeftover, new Date(BASE_NOW - 3_600_000), new Date(BASE_NOW - 3_600_000));
    await runLocalRuntimeStartupGc({ runtimeRootDir: sandbox.root, now: () => BASE_NOW });
    assert.equal(
      existsSync(freshLeftover),
      true,
      "宽限期内 .download-* 保留（另一进程在飞安装的暂存不得误删）",
    );
  } finally {
    sandbox.dispose();
  }
});
