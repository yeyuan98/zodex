import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createRootTraceContext, type TurnId } from "@zcode/contracts";
import { executeRewindCommand } from "../src/runtime/methods/rewind.js";
import type { ParsedRewindCommand } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

// specs/bot-provider-network.md「值类漂移跟进（3.14.5-alpha.5）」红测试（Class 1）：
// turn.completed `duration` 发射端在**同机 wall-clock 回拨**（NTP 校正 / VM 暂停恢复 /
// 手动改时间）下会发射负数——2026-10-02 远端会话 sess_a39948fb 7× turn.completed 即因
// `too_small: expected number >=0` 被 host strict schema 整事件丢弃。
//
// 驱动方式：executeRewindCommand(status) 是 turn.completed 发射站点中成本最低的可驱动
// 路径（rewind.ts:119 `duration: Date.now() - startedAt`，startedAt 为 rewind.ts:46 的
// 同进程 Date.now()）。用 node:test 的 t.mock 接管 Date.now：turn 开始时读数 T1，
// turn 进行中把时钟回拨 60s，完成时读数 T0 < T1 ⇒ 当前代码发射负 duration。
// 生产代码没有注入 clock 的缝隙，测试不重构生产代码，只模拟时钟事实。

const CLOCK_STEP_BACK_MS = -60_000;

test("turn.completed duration：运行中时钟回拨 ⇒ 发射 duration 必须 clamp 到非负（修复前必红）", async (t) => {
  const realNow = Date.now.bind(Date);
  let clockOffsetMs = 0;
  t.mock.method(Date, "now", () => realNow() + clockOffsetMs);

  const turnCompletePayloads: Array<Record<string, unknown>> = [];
  const runtime = {
    sessionId: "sess_clamp_turn_1",
    turnNumber: 1,
    logger: undefined,
    sessionStore: undefined,
    messageHistory: { getCacheStats: () => undefined },
    beginActiveTurn: () => ({ kind: "stub-active-turn" }),
    finishActiveTurn: () => undefined,
    ensureSessionPersisted: async () => {
      // 模拟 turn 进行中发生 wall-clock 回拨：startedAt 已按 T1 捕获，
      // 此后所有 Date.now() 读数回退 60s（保持真实时间继续前进，等价 NTP 阶跃）。
      clockOffsetMs = CLOCK_STEP_BACK_MS;
    },
    createEvent: (type: string, payload: unknown) => ({
      id: `evt_${crypto.randomUUID()}`,
      sessionId: "sess_clamp_turn_1",
      turnId: "turn_clamp_turn_1",
      sequenceNumber: 0,
      timestamp: new Date(),
      traceId: "trace_clamp_turn_1",
      type,
      payload,
    }),
    appendEvent: async (event: { type: string; payload?: unknown }) => {
      if (event.type === SessionEventType.TurnComplete) {
        turnCompletePayloads.push(event.payload as Record<string, unknown>);
      }
    },
    formatRewindStatus: async () => "No workspace checkpoint is available yet.",
    rebuildProjection: async () => ({ lastCheckpoint: undefined }),
  } as unknown as AgentRuntimeInternal;

  const result = await executeRewindCommand.call(
    runtime,
    "/rewind status",
    { action: "status" } as ParsedRewindCommand,
    "turn_clamp_turn_1" as TurnId,
    createRootTraceContext({ sessionId: "sess_clamp_turn_1", turnId: "turn_clamp_turn_1" }),
  );

  assert.ok(result, "rewind turn 必须正常完成（测试只针对 duration 值）");
  assert.equal(turnCompletePayloads.length, 1, "必须恰好发射一条 turn.completed");
  const duration = turnCompletePayloads[0]?.duration;
  assert.ok(typeof duration === "number", `duration 必须是数字，实际 ${typeof duration}`);
  assert.ok(
    duration >= 0,
    `时钟回拨 ${CLOCK_STEP_BACK_MS}ms 后 turn.completed duration 必须 clamp 到非负，实际 ${duration}`,
  );
});
