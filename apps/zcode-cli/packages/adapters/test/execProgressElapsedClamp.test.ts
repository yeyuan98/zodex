import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import type {
  ExecutionEvent,
  ExecutionPort,
  ExecutionRequest,
  ExecutionRunOptions,
} from "@zcode/contracts";

// specs/bot-provider-network.md「值类漂移跟进（3.14.5-alpha.5）」红测试（Class 3）：
// tool.updated(progress) `elapsedMs` 的透传源在同机 wall-clock 回拨下会发射负数——
// adapters exec/node-execution-adapter-run.ts 的 posix-bash 合并输出进度路径
// （`elapsedMs: Date.now() - startedAt.getTime()`）没有非负保护，core
// tool/handlers/bash.ts emitProgressEvent 原样透传，host strict schema 对负值
// 整事件丢弃（2026-10-02 远端会话 tool.updated progress 类丢弃的来源）。
//
// 驱动方式：真实 NodeExecutionAdapter + 真实 bash 子进程（posix-bash profile 走
// 合并输出文件 + watchProgress 进度链路）。run() 在第一个 await 前同步捕获
// startedAt = new Date()（T1，真实时钟）；随后把 Date.now 回拨 60s（new Date() 不受
// Date.now mock 影响），进度回调里的差值即为负。progressThreshold/interval 用小值
// 缩短命令时长。生产代码没有注入 clock 的缝隙，测试不重构生产代码，只模拟时钟事实。

const CLOCK_STEP_BACK_MS = -60_000;

test("exec progress elapsedMs：子进程运行中时钟回拨 ⇒ 发射 elapsedMs 必须 clamp 到非负（修复前必红）", async (t) => {
  // 本用例只支持 POSIX bash（posix-bash 合并输出链路）；其他平台直接跳过，
  // 不强行模拟（§8.2：模拟不可信就停）。
  if (process.platform === "win32") {
    t.diagnostic("posix-bash merged-output progress path 未在 Windows 上驱动，跳过");
    return;
  }

  const realNow = Date.now.bind(Date);
  let clockOffsetMs = 0;
  t.mock.method(Date, "now", () => realNow() + clockOffsetMs);

  const outputRoot = await mkdtemp(join(tmpdir(), "zcode-exec-progress-clamp-"));
  const workspace = await mkdtemp(join(tmpdir(), "zcode-exec-progress-clamp-ws-"));
  const adapter: ExecutionPort = createNodeExecutionAdapter({
    outputRootDir: outputRoot,
    processEnv: process.env,
    progressThresholdMs: 50,
    progressIntervalMs: 40,
  });

  const progressEvents: Array<Extract<ExecutionEvent, { type: "progress" }>> = [];
  const options: ExecutionRunOptions = {
    onEvent: (event) => {
      if (event.type === "progress") {
        progressEvents.push(event as Extract<ExecutionEvent, { type: "progress" }>);
      }
      return Promise.resolve();
    },
  };
  const request: ExecutionRequest = {
    command: {
      mode: "shell",
      command: "sleep 0.6",
      shellProfile: "posix-bash",
    },
    cwd: workspace,
    trace: { sessionId: "sess_clamp_exec_1", traceId: "trace_clamp_exec_1" } as never,
  };

  try {
    // run() 同步段先捕获 startedAt（真实 T1），随后立刻回拨时钟 ⇒
    // 首个进度事件的 elapsedMs 即为 ≈ -60s。
    const runPromise = adapter.run(request, options);
    clockOffsetMs = CLOCK_STEP_BACK_MS;
    const result = await runPromise;

    assert.equal(
      result.status,
      "completed",
      `探测命令必须正常完成（测试只针对 elapsedMs 值）：${JSON.stringify(result.error)}`,
    );
    assert.ok(progressEvents.length > 0, "必须捕获到至少一条 progress 事件");

    const negatives = progressEvents.filter((event) => event.elapsedMs < 0);
    assert.ok(
      negatives.length === 0,
      `时钟回拨 ${CLOCK_STEP_BACK_MS}ms 后 progress elapsedMs 必须 clamp 到非负：` +
        `${negatives.length}/${progressEvents.length} 条为负，最小值 ${Math.min(
          ...progressEvents.map((event) => event.elapsedMs),
        )}`,
    );
  } finally {
    await adapter.close?.();
    await rm(outputRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
