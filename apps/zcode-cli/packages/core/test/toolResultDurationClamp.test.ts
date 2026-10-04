import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { executeToolCall } from "../src/tool/executor/call-runner.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import type { ToolEntry } from "../src/tool/types.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import type { ExecutableToolCall } from "../src/tool/types.js";

// specs/bot-provider-network.md「值类漂移跟进（3.14.5-alpha.5）」红测试（Class 2）：
// tool.updated(result) `duration` 发射端在同机 wall-clock 回拨下会发射负数——
// call-runner.ts:452 `const durationMs = Date.now() - startTime` 直接喂给
// executor/events.ts:84 的 `duration: durationMs`，host strict schema 对负值整事件丢弃
// （2026-10-02 远端会话 tool.updated 13 次elapsedMs/duration 类丢弃的同类向量）。
//
// 驱动方式：executeToolCall 走最小 stub deps（registry 单工具 + permissionService
// 直接 allow + 无 hookRunner/telemetry）。handler 执行期间把 Date.now 回拨 60s：
// startTime 在 handler 前按 T1 捕获，handler 返回后读数 T0 < T1 ⇒ 当前代码发射负
// duration。生产代码没有注入 clock 的缝隙，测试不重构生产代码，只模拟时钟事实。

const CLOCK_STEP_BACK_MS = -60_000;

interface ClockController {
  stepBack(): void;
}

function mockWallClock(t: test.TestContext): ClockController {
  const realNow = Date.now.bind(Date);
  let clockOffsetMs = 0;
  t.mock.method(Date, "now", () => realNow() + clockOffsetMs);
  return {
    stepBack() {
      clockOffsetMs = CLOCK_STEP_BACK_MS;
    },
  };
}

test("tool.updated(result) duration：handler 执行中时钟回拨 ⇒ 发射 duration 必须 clamp 到非负（修复前必红）", async (t) => {
  const clock = mockWallClock(t);

  const emittedEvents: SessionEvent[] = [];
  let handlerStartedAtWallClock: number | undefined;

  const entry = {
    metadata: { name: "ClampProbe", riskLevel: "low" },
    handler: async () => {
      handlerStartedAtWallClock = Date.now();
      // 工具执行期间发生 wall-clock 回拨（NTP 校正 / VM 暂停恢复）。
      clock.stepBack();
      return { note: "clamp-probe-done" };
    },
  } as unknown as ToolEntry;

  const deps = {
    registry: {
      get: (name: string) => (name === "ClampProbe" ? entry : undefined),
      has: (name: string) => name === "ClampProbe",
      list: () => ["ClampProbe"],
      getMetadata: (name: string) => (name === "ClampProbe" ? entry.metadata : undefined),
    },
    permissionService: {
      checkPermission: () => ({ allowed: true, decision: "allow" }),
    },
    permissionBroker: {},
    emitEvent: async (event: SessionEvent) => {
      emittedEvents.push(event);
    },
    sessionId: "sess_clamp_tool_1",
    turnId: "turn_clamp_tool_1",
    defaultTimeoutMs: 10_000,
    readFileState: new Map(),
    getWorkingDirectory: () => "/tmp",
    getWorkspaceRoot: () => "/tmp",
    runtimeScope: "main",
    getMode: () => "build",
    maxConcurrency: 1,
  } as unknown as ToolExecutorDeps;

  const backgroundTasks = new BackgroundTaskTracker(deps);
  const toolCall: ExecutableToolCall = {
    id: "tc_clamp_tool_1",
    name: "ClampProbe",
    input: { probe: true },
  } as unknown as ExecutableToolCall;

  const result = await executeToolCall(deps, backgroundTasks, toolCall);

  assert.ok(result.success, `工具调用必须成功（测试只针对 duration 值）：${JSON.stringify(result.error)}`);
  assert.ok(handlerStartedAtWallClock !== undefined, "handler 必须真实执行");

  const resultEvents = emittedEvents.filter(
    (event) => event.type === SessionEventType.ToolCallResult,
  );
  assert.equal(resultEvents.length, 1, "必须恰好发射一条 tool.updated(result)");
  const payload = resultEvents[0]!.payload as Record<string, unknown>;
  const duration = payload.duration;
  assert.ok(typeof duration === "number", `duration 必须是数字，实际 ${typeof duration}`);
  assert.ok(
    duration >= 0,
    `时钟回拨 ${CLOCK_STEP_BACK_MS}ms 后 tool.updated(result) duration 必须 clamp 到非负，实际 ${duration}`,
  );
});
