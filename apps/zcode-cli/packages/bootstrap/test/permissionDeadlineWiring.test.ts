import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { PermissionBrokerRequest } from "@zcode/contracts";
import { buildPermissionInteractionRegistrationOptions } from "../src/zcode-protocol/interaction-broker.js";
// 经 handlers barrel（NATIVE_HANDLERS）取 createSession handler：直接以
// session-mgmt 为入口会触发 session-mgmt → executor → handlers/index →
// session-mgmt 的模块环 TDZ，barrel 入口即生产求值顺序。
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import {
  V4InteractionRegistry,
  type V4InteractionAnswer,
  type V4InteractionAutoResolution,
} from "../src/zcode-protocol-v4/interaction-registry.js";

/**
 * 契约（specs/bot-permissions.md §3a.3 / §3b.1 / §3b.5 / §7.11，Track B W3a）：
 *
 * 1. v4 createSession handler 把 payload 的 permissionAutoDenyMs 写入 session
 *    record（deadline 只走 v4，不进 v3 strict schema）；缺省不写 = 桌面会话无倒计时。
 * 2. broker 权限注册选项装配（纯函数缝）：kind "permission" + 会话 deadline 为
 *    per-entry autoResolutionMs；无 deadline 不携带该键；持久化恢复的
 *    initialAutoResolution 原样透传（登记表恢复同一 deadlineAt，不重置时钟）。
 * 3. 边界 guard：askUserQuestion 全局 gate 关闭 ⇒ 问题类不武装；permission
 *    倒计时独立于 gate（且不排队头——前面有未武装问题时照样注册即武装）。
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEnvelope(permissionAutoDenyMs?: number): CommandEnvelope {
  return {
    payload: {
      workspaceId: "/tmp/demo",
      ...(permissionAutoDenyMs !== undefined ? { permissionAutoDenyMs } : {}),
    },
  } as unknown as CommandEnvelope;
}

test("createSession handler：payload 携带 permissionAutoDenyMs ⇒ 写入 session record；缺省不写", async () => {
  const record: { permissionAutoDenyMs?: number } = {};
  const host: V4CommandCoreHost = {
    getRecord: (sessionId: string) =>
      sessionId === "sess-deadline" ? (record as unknown as V4SessionRecordView) : undefined,
    createSessionRecord: async () => ({ sessionId: "sess-deadline" }),
  };
  const withDeadline = await NATIVE_HANDLERS.createSession(host, createEnvelope(600_000));
  assert.equal(withDeadline?.type, "createSession");
  assert.equal(
    record.permissionAutoDenyMs,
    600_000,
    "handler 必须在建档后把 deadline 写入 session record（spec §3a.3；broker 注册权限交互时按 sessionId 读取）",
  );

  const recordWithoutDeadline: { permissionAutoDenyMs?: number } = {};
  const hostWithoutDeadline: V4CommandCoreHost = {
    getRecord: (sessionId: string) =>
      sessionId === "sess-nodeadline"
        ? (recordWithoutDeadline as unknown as V4SessionRecordView)
        : undefined,
    createSessionRecord: async () => ({ sessionId: "sess-nodeadline" }),
  };
  await NATIVE_HANDLERS.createSession(hostWithoutDeadline, createEnvelope());
  assert.equal(
    recordWithoutDeadline.permissionAutoDenyMs,
    undefined,
    "缺省不得凭空写值（桌面会话 = 无 deadline，行为逐字节不变）",
  );
});

function createPermissionBrokerRequest(): PermissionBrokerRequest {
  return {
    requestId: "req-perm-wiring",
    sessionId: "sess-perm-wiring" as PermissionBrokerRequest["sessionId"],
    traceId: "trace-perm-wiring" as PermissionBrokerRequest["traceId"],
    toolCallId: "call-perm-wiring" as PermissionBrokerRequest["toolCallId"],
    toolName: "bash",
    input: {},
    mode: "build",
    ruleId: "rule-1",
    reason: "run command",
    riskLevel: "medium",
    requestedAt: new Date(),
  };
}

test("buildPermissionInteractionRegistrationOptions：kind permission + 会话 deadline；缺省不携带；恢复态透传", () => {
  const request = createPermissionBrokerRequest();
  const withDeadline = buildPermissionInteractionRegistrationOptions(request, {
    permissionAutoDenyMs: 600_000,
  });
  assert.equal(withDeadline.kind, "permission", "权限交互必须按 kind permission 注册");
  assert.equal(withDeadline.sessionId, String(request.sessionId));
  assert.equal(
    withDeadline.autoResolutionMs,
    600_000,
    "会话 deadline 必须作为 per-entry autoResolutionMs 传入登记表（spec §3a.3/§3b.1）",
  );

  const withoutDeadline = buildPermissionInteractionRegistrationOptions(request);
  assert.equal(withoutDeadline.kind, "permission");
  assert.equal(
    withoutDeadline.autoResolutionMs,
    undefined,
    "无 deadline（桌面会话/未配置 bot）不得携带该键 = 无倒计时",
  );

  const initialAutoResolution: V4InteractionAutoResolution = {
    state: "visibleCountdown",
    startedAt: 1_000,
    visibleAt: 1_000,
    deadlineAt: 601_000,
  };
  const restored = buildPermissionInteractionRegistrationOptions(request, {
    permissionAutoDenyMs: 600_000,
    initialAutoResolution,
  });
  assert.deepEqual(
    restored.initialAutoResolution,
    initialAutoResolution,
    "持久化恢复的倒计时必须原样透传（登记表恢复同一 deadlineAt，不重置时钟，spec §3b.4）",
  );
});

test("边界 guard：askUserQuestion gate 关闭不武装；permission 倒计时不受 gate 影响（且不排队头）", async () => {
  const registry = new V4InteractionRegistry();
  await registry.setAskUserQuestionAutoResolutionEnabled(false);

  const questionAnswers: V4InteractionAnswer[] = [];
  const questionStates: V4InteractionAutoResolution[] = [];
  registry.register(
    "q-gate-off",
    (answer) => {
      questionAnswers.push(answer);
    },
    {
      sessionId: "sess-guard",
      kind: "askUserQuestion",
      onAutoResolutionUpdated: (state) => {
        questionStates.push(state);
      },
    },
  );
  // 同 session、排在问题之后注册的 permission：gate 关闭 + 非队头，仍必须注册即武装。
  const permissionAnswers: V4InteractionAnswer[] = [];
  const unregister = registry.register(
    "perm-gate-off",
    (answer) => {
      permissionAnswers.push(answer);
    },
    {
      sessionId: "sess-guard",
      kind: "permission",
      autoResolutionMs: 120,
    },
  );
  try {
    await sleep(400);
    assert.equal(questionAnswers.length, 0, "gate 关闭时问题类不得自动 resolve（既有语义）");
    assert.equal(questionStates.length, 0, "gate 关闭时问题类不得武装倒计时（既有语义）");
    assert.equal(
      permissionAnswers.length,
      1,
      "permission 倒计时必须独立于 askUserQuestion 全局 gate（spec §3b.5）",
    );
    assert.equal(permissionAnswers[0]?.optionId, undefined, "到期代答 deny-shaped：无 optionId");
    assert.equal(permissionAnswers[0]?.action, undefined, "到期代答 deny-shaped：无 action");
  } finally {
    unregister();
  }
});
