import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  zcodePermissionRequestedEventPayloadSchema,
  zcodeSessionEventSchema,
  zcodeToolUpdatedEventPayloadSchema,
  zcodeTurnCompletedEventPayloadSchema,
  zcodeTurnStartedEventPayloadSchema,
} from "@zcode/shared";
import { mapSessionEvent } from "../src/zcode-protocol/session-mapper.js";

// M3（3.14.5-alpha.4）契约测试矩阵：钉 MAPPER OUTPUT vs HOST SCHEMA。
// 背景（specs/bot-provider-network.md「Amendment (3.14.5-alpha.4)」）：新 CLI emitter
// 字段经 v3 session-mapper 的 ToolCall* raw-spread / default 透传 / permission 解构遗漏
// 漏上 v3 线，桌面端打包的 strict zod schema 会把整条事件 safeParse 丢弃
// （2026-10-03 单日 553× tool.updated + 8× turn.started + 4× permission.requested；
// permission 丢失 = bot 权限提示彻底消失，Track-B 阻塞）。
// 六键闭合集（两天日志实测，无其他键）：
const TOOL_UPDATED_DRIFT_KEYS = [
  "readOnly",
  "sideEffectScope",
  "display",
  "skillMetadata",
] as const;
const TURN_STARTED_DRIFT_KEYS = ["executionStartedAt"] as const;
const PERMISSION_REQUESTED_DRIFT_KEYS = ["fullAccessSupported"] as const;

// emitter 实际形状的最小样本（core/src/tool/executor/events.ts、runtime/methods/turn.ts）。
const SAMPLE_DISPLAY = { kind: "bash_output", output: "ls -la", truncated: false } as const;
const SAMPLE_SKILL_METADATA = {
  qualifiedName: "pdf-report",
  pluginId: "docs",
  source: "project",
} as const;
const SAMPLE_ERROR_DETAIL = { type: "tool_execution_error", message: "boom" } as const;

const EVENT_TIMESTAMP_MS = 1760000000000;

function rawSessionEvent(type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: "evt_contract_test_1",
    sessionId: "sess_contract_test",
    turnId: "turn_contract_test",
    sequenceNumber: 3,
    timestamp: new Date(EVENT_TIMESTAMP_MS),
    traceId: "trace_contract_test",
    type,
    payload,
  } as SessionEvent;
}

function mapPayload(event: SessionEvent): Record<string, unknown> {
  return mapSessionEvent(event).payload as Record<string, unknown>;
}

function mapAndValidateEnvelope(event: SessionEvent): void {
  const parsed = zcodeSessionEventSchema.safeParse(mapSessionEvent(event));
  assert.ok(
    parsed.success,
    `mapper 输出必须通过 host 严格 schema（整事件丢弃即线上 bug 重现）：${JSON.stringify(
      parsed.success ? [] : parsed.error.issues,
    )}`,
  );
}

function assertKeysAbsent(payload: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    assert.ok(
      !(key in payload),
      `mapper 输出必须剥除漂移键 "${key}"（实际键：${Object.keys(payload).join(", ")}）`,
    );
  }
}

test("tool.updated/started：携带全部四个漂移键 ⇒ 剥除且 mapper 输出通过 host schema", () => {
  const event = rawSessionEvent(SessionEventType.ToolCallStarted, {
    toolCallId: "tc_1",
    toolName: "Write",
    startedAt: new Date(EVENT_TIMESTAMP_MS - 50),
    display: SAMPLE_DISPLAY,
    readOnly: false,
    sideEffectScope: "workspace",
    skillMetadata: SAMPLE_SKILL_METADATA,
  });
  const payload = mapPayload(event);
  assertKeysAbsent(payload, TOOL_UPDATED_DRIFT_KEYS);
  assert.equal(payload.kind, "started");
  assert.equal(payload.startedAt, EVENT_TIMESTAMP_MS - 50);
  assert.ok(zcodeToolUpdatedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("tool.updated/scheduled：emitter 携带 display ⇒ 剥除且通过 host schema", () => {
  const event = rawSessionEvent(SessionEventType.ToolCallScheduled, {
    toolCallId: "tc_2",
    assistantMessageId: "msg_1",
    toolName: "Write",
    input: { file_path: "a.ts" },
    display: SAMPLE_DISPLAY,
    schedule: { reason: "parallel_batch" },
  });
  const payload = mapPayload(event);
  assertKeysAbsent(payload, TOOL_UPDATED_DRIFT_KEYS);
  assert.equal(payload.kind, "scheduled");
  assert.ok(zcodeToolUpdatedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("tool.updated/progress：四个漂移键同样剥除（strip 覆盖所有 kind 分支）", () => {
  const event = rawSessionEvent(SessionEventType.ToolCallProgress, {
    toolCallId: "tc_3",
    elapsedMs: 120,
    readOnly: true,
    sideEffectScope: "none",
    display: SAMPLE_DISPLAY,
    skillMetadata: SAMPLE_SKILL_METADATA,
  });
  const payload = mapPayload(event);
  assertKeysAbsent(payload, TOOL_UPDATED_DRIFT_KEYS);
  assert.ok(zcodeToolUpdatedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("tool.updated/result：emitter 携带 skillMetadata ⇒ 剥除且通过 host schema", () => {
  const event = rawSessionEvent(SessionEventType.ToolCallResult, {
    toolCallId: "tc_4",
    skillMetadata: SAMPLE_SKILL_METADATA,
    result: { success: true, content: [] },
    duration: 42,
  });
  const payload = mapPayload(event);
  assertKeysAbsent(payload, TOOL_UPDATED_DRIFT_KEYS);
  assert.equal(payload.kind, "result");
  assert.ok(zcodeToolUpdatedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("tool.updated/error：emitter 携带 skillMetadata ⇒ 剥除且通过 host schema", () => {
  const event = rawSessionEvent(SessionEventType.ToolCallError, {
    toolCallId: "tc_5",
    error: SAMPLE_ERROR_DETAIL,
    skillMetadata: SAMPLE_SKILL_METADATA,
  });
  const payload = mapPayload(event);
  assertKeysAbsent(payload, TOOL_UPDATED_DRIFT_KEYS);
  assert.equal(payload.kind, "error");
  assert.ok(zcodeToolUpdatedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("tool.updated/batch：无漂移键 ⇒ 输出与既有行为逐字节一致", () => {
  const payload = mapPayload(
    rawSessionEvent(SessionEventType.ToolBatchComplete, {
      toolCallIds: ["tc_6", "tc_7"],
      successCount: 2,
      errorCount: 0,
    }),
  );
  assert.deepEqual(payload, {
    kind: "batch",
    toolCallIds: ["tc_6", "tc_7"],
    successCount: 2,
    errorCount: 0,
  });
});

test("turn.started：携带 executionStartedAt ⇒ 剥除且通过 host schema", () => {
  const event = rawSessionEvent(SessionEventType.TurnStarted, {
    executionStartedAt: EVENT_TIMESTAMP_MS - 137,
    turnNumber: 7,
    input: "帮我修这个 bug",
    inputId: "in_1",
  });
  const payload = mapPayload(event);
  assertKeysAbsent(payload, TURN_STARTED_DRIFT_KEYS);
  assert.ok(zcodeTurnStartedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("permission.requested：携带 fullAccessSupported/display/optionsPolicy ⇒ 剥除且通过 host schema", () => {
  const event = rawSessionEvent(SessionEventType.PermissionRequested, {
    requestId: "perm_1",
    toolCallId: "tc_8",
    toolName: "Bash",
    riskLevel: "medium",
    reason: "Bash requires approval",
    input: { command: "rm -rf /tmp/x" },
    display: SAMPLE_DISPLAY,
    optionsPolicy: "no-always-allow",
    // emitter（core/src/tool/executor/events.ts:165-167）只在支持时发 true。
    fullAccessSupported: true,
  });
  const payload = mapPayload(event);
  assertKeysAbsent(payload, PERMISSION_REQUESTED_DRIFT_KEYS);
  assertKeysAbsent(payload, ["display", "optionsPolicy"]);
  // options 由 mapper 重建，且 no-always-allow 策略裁掉 always-allow（≥1 项由 schema 保证）。
  assert.ok(Array.isArray(payload.options) && payload.options.length >= 1);
  assert.ok(zcodePermissionRequestedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("对照（default 分支不受影响）：非修复集事件类型原样透传，未知键不剥", () => {
  const rawPayload = { checkpointId: "cp_1", someFutureKey: { note: 1 } };
  const mapped = mapSessionEvent(rawSessionEvent(SessionEventType.CheckpointCreated, rawPayload));
  assert.equal(mapped.type, "checkpoint.created");
  // default 透传必须保持对象同一性：key 定向剥除只针对 turn.started/executionStartedAt。
  assert.equal(mapped.payload, rawPayload);
  mapAndValidateEnvelope(rawSessionEvent(SessionEventType.CheckpointCreated, rawPayload));
});

test("回归（无漂移键 ⇒ 行为不变）：payload 输出与修复前逐字节一致", () => {
  // tool.started：startedAt 归一化 + kind 追加，无新增删减。
  assert.deepEqual(
    mapPayload(
      rawSessionEvent(SessionEventType.ToolCallStarted, {
        toolCallId: "tc_9",
        toolName: "Read",
        startedAt: new Date(EVENT_TIMESTAMP_MS - 5),
      }),
    ),
    { toolCallId: "tc_9", toolName: "Read", startedAt: EVENT_TIMESTAMP_MS - 5, kind: "started" },
  );
  // tool.result：
  assert.deepEqual(
    mapPayload(
      rawSessionEvent(SessionEventType.ToolCallResult, {
        toolCallId: "tc_10",
        result: { success: true, content: [] },
        duration: 42,
      }),
    ),
    { toolCallId: "tc_10", result: { success: true, content: [] }, duration: 42, kind: "result" },
  );
  // turn.started（不带 executionStartedAt）：payload 原对象透传（同一性）。
  const turnPayload = { turnNumber: 1, input: "hi" };
  assert.equal(
    mapSessionEvent(rawSessionEvent(SessionEventType.TurnStarted, turnPayload)).payload,
    turnPayload,
  );
  // permission.requested（不带漂移键）：仅 options 重建，其余键原样。
  const permPayload = mapPayload(
    rawSessionEvent(SessionEventType.PermissionRequested, {
      requestId: "perm_2",
      toolCallId: "tc_11",
      toolName: "WebFetch",
      riskLevel: "low",
      reason: "network egress",
      input: "https://example.com",
    }),
  );
  assert.equal(permPayload.requestId, "perm_2");
  assert.equal(permPayload.toolCallId, "tc_11");
  assert.equal(permPayload.reason, "network egress");
  assert.ok(!("fullAccessSupported" in permPayload));
  assert.ok(Array.isArray(permPayload.options));
});

// ---- alpha.5 值类 guard（specs/bot-provider-network.md「值类漂移跟进（3.14.5-alpha.5）」）----
// turn.completed 此前在本矩阵中零用例——2026-10-02 远端链路两类整事件丢弃之一
// （7× turn.completed duration 负值 + 13× tool.updated elapsedMs 负值，host strict
// schema `too_small: expected number >=0`）。mapper 是纯透传（零数字变换），所以这里
// 是回归 guard：真实形态的非负样例经 mapper 后数值字段原样非负且通过 host schema；
// 负数 fixture 必须被 host schema 拒绝（schema 保持 strict 的 pin——修复在 CLI 发射端
// clamp，绝不放宽 schema；红测试在发射端单测，见 core/adapters test）。

const SAMPLE_TURN_COMPLETE_USAGE = {
  inputTokens: 12_345,
  outputTokens: 678,
  cacheWriteTokens: 0,
  cacheReadTokens: 2_048,
  totalTokens: 15_071,
} as const;

function realisticTurnCompletePayload(duration: number): Record<string, unknown> {
  // 形状对齐 core/src/runtime/methods/turn.ts:644-661 的成功分支发射。
  return {
    response: "任务已完成：负数 duration 发射端已 clamp。",
    tokenCount: 678,
    usage: SAMPLE_TURN_COMPLETE_USAGE,
    toolCallCount: 3,
    historyRoundCount: 2,
    duration,
    resultType: "success",
    cacheStats: {
      totalMessages: 12,
      cachedMessages: 5,
      lastCacheHit: true,
      cacheReadTokens: 2_048,
    },
    inputId: "in_turn_completed_1",
  };
}

test("turn.completed/success：真实形态非负样例经 mapper 透传，duration 原样非负且通过 host schema", () => {
  const event = rawSessionEvent(
    SessionEventType.TurnComplete,
    realisticTurnCompletePayload(45_123),
  );
  const payload = mapPayload(event);
  assert.equal(payload.duration, 45_123, "mapper 必须零数字变换（duration 原样透传）");
  assert.ok(typeof payload.duration === "number" && payload.duration >= 0);
  assert.ok(zcodeTurnCompletedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("turn.completed/cancelled：duration=0 边界样例通过 host schema（用户中断复用 turn.completed 上报）", () => {
  // 形状对齐 core/src/runtime/helpers/turn-errors.ts cancelled 分支的最小发射。
  const event = rawSessionEvent(SessionEventType.TurnComplete, {
    response: "",
    tokenCount: 0,
    toolCallCount: 0,
    historyRoundCount: 0,
    duration: 0,
    resultType: "cancelled",
    inputId: "in_turn_completed_2",
  });
  const payload = mapPayload(event);
  assert.equal(payload.duration, 0);
  assert.ok(zcodeTurnCompletedEventPayloadSchema.safeParse(payload).success);
  mapAndValidateEnvelope(event);
});

test("strictness pin：负数 duration/elapsedMs fixture 被 host schema 拒绝（schema 保持 strict，防未来误放宽）", () => {
  // (a) turn.completed 负 duration（10-02 实测丢弃类之一）。
  const negativeTurnCompleted = zcodeSessionEventSchema.safeParse(
    mapSessionEvent(
      rawSessionEvent(SessionEventType.TurnComplete, realisticTurnCompletePayload(-45_123)),
    ),
  );
  assert.equal(
    negativeTurnCompleted.success,
    false,
    "负 duration 的 turn.completed 必须被 host schema 拒绝（放宽 = 丢弃防护失效）",
  );
  // (b) tool.updated(progress) 负 elapsedMs（10-02 实测丢弃类之二）。
  const negativeProgress = zcodeSessionEventSchema.safeParse(
    mapSessionEvent(
      rawSessionEvent(SessionEventType.ToolCallProgress, {
        toolCallId: "tc_neg_progress",
        elapsedMs: -12_345,
        stdoutBytes: 0,
        stderrBytes: 0,
      }),
    ),
  );
  assert.equal(
    negativeProgress.success,
    false,
    "负 elapsedMs 的 tool.updated(progress) 必须被 host schema 拒绝",
  );
  // (c) tool.updated(result) 负 duration（同类向量）。
  const negativeResult = zcodeSessionEventSchema.safeParse(
    mapSessionEvent(
      rawSessionEvent(SessionEventType.ToolCallResult, {
        toolCallId: "tc_neg_result",
        result: { success: true, content: [] },
        duration: -42,
      }),
    ),
  );
  assert.equal(
    negativeResult.success,
    false,
    "负 duration 的 tool.updated(result) 必须被 host schema 拒绝",
  );
});

// 冻结的 legacy key 白名单 = 各 payload schema 在 widen 前接受的键集（ widened 的
// optional 字段刻意不在名单里：它们必须被 mapper 剥掉，绝不出现在 v3 输出上）。
// 未来 emitter 再新增字段而漏更新 strip 名单 ⇒ 输出键落在白名单外，这里直接红，
// 而不是等旧桌面运行时静默丢事件。
const FROZEN_TOOL_UPDATED_BASE_KEYS = new Set([
  "toolCallId",
  "toolName",
  "parentToolCallId",
  "source",
  "agentId",
  "agentType",
  "background",
  "childSessionId",
  "childToolCallId",
  "description",
]);
const FROZEN_TOOL_UPDATED_KIND_KEYS: Record<string, ReadonlySet<string>> = {
  scheduled: new Set([
    "kind",
    "assistantMessageId",
    "input",
    "inputByteLength",
    "inputOmitted",
    "inputRef",
    "dependencies",
    "parallelGroupIndex",
    "canRunParallel",
    "schedule",
  ]),
  started: new Set(["kind", "startedAt"]),
  progress: new Set([
    "kind",
    "elapsedMs",
    "pid",
    "stdoutBytes",
    "stderrBytes",
    "outputBytes",
    "outputPreview",
    "stdoutTail",
    "stderrTail",
  ]),
  result: new Set(["kind", "result", "duration"]),
  error: new Set(["kind", "error"]),
  batch: new Set(["kind", "toolCallIds", "successCount", "errorCount"]),
};
const FROZEN_PERMISSION_REQUESTED_KEYS = new Set([
  "requestId",
  "toolCallId",
  "toolName",
  "riskLevel",
  "reason",
  "input",
  "suggestedPermissionUpdates",
  "origin",
  "options",
  "childSessionId",
  "background",
]);
const FROZEN_TURN_STARTED_KEYS = new Set([
  "turnNumber",
  "input",
  "inputId",
  "queryId",
  "inputSource",
  "inputVisibility",
  "executionKind",
  "targetId",
  "messageId",
  "foregroundExecutionId",
  "intent",
  "originMeta",
  "backgroundSource",
  "attachments",
]);

function assertKeysWithinAllowlist(
  payload: Record<string, unknown>,
  allowlist: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(payload)) {
    assert.ok(
      allowlist.has(key),
      `${label} 输出键 "${key}" 不在冻结白名单内：emitter 新增字段漏进了 v3 线（旧桌面会整事件丢弃），请把它加进 mapper 的 strip 名单`,
    );
  }
}

test("冻结白名单：tool.updated 各 kind 的 mapper 输出键 ⊆ 旧桌面 schema 键集", () => {
  const samples: ReadonlyArray<[SessionEvent, string]> = [
    [
      rawSessionEvent(SessionEventType.ToolCallStarted, {
        toolCallId: "tc_a",
        toolName: "Write",
        startedAt: new Date(EVENT_TIMESTAMP_MS),
        display: SAMPLE_DISPLAY,
        readOnly: false,
        sideEffectScope: "workspace",
        skillMetadata: SAMPLE_SKILL_METADATA,
      }),
      "started",
    ],
    [
      rawSessionEvent(SessionEventType.ToolCallScheduled, {
        toolCallId: "tc_b",
        toolName: "Write",
        input: {},
        display: SAMPLE_DISPLAY,
        schedule: {},
      }),
      "scheduled",
    ],
    [
      rawSessionEvent(SessionEventType.ToolCallProgress, { toolCallId: "tc_c", elapsedMs: 1 }),
      "progress",
    ],
    [
      rawSessionEvent(SessionEventType.ToolCallResult, {
        toolCallId: "tc_d",
        result: { success: true, content: [] },
        duration: 1,
        skillMetadata: SAMPLE_SKILL_METADATA,
      }),
      "result",
    ],
    [
      rawSessionEvent(SessionEventType.ToolCallError, {
        toolCallId: "tc_e",
        error: SAMPLE_ERROR_DETAIL,
        skillMetadata: SAMPLE_SKILL_METADATA,
      }),
      "error",
    ],
    [
      rawSessionEvent(SessionEventType.ToolBatchComplete, {
        toolCallIds: ["tc_f"],
        successCount: 1,
        errorCount: 0,
      }),
      "batch",
    ],
  ];
  for (const [event, kind] of samples) {
    const payload = mapPayload(event);
    assert.equal(payload.kind, kind);
    assertKeysWithinAllowlist(
      payload,
      new Set([...FROZEN_TOOL_UPDATED_BASE_KEYS, ...(FROZEN_TOOL_UPDATED_KIND_KEYS[kind] ?? [])]),
      `tool.updated/${kind}`,
    );
  }
});

test("冻结白名单：permission.requested / turn.started 的 mapper 输出键 ⊆ 旧桌面 schema 键集", () => {
  assertKeysWithinAllowlist(
    mapPayload(
      rawSessionEvent(SessionEventType.PermissionRequested, {
        requestId: "perm_a",
        toolCallId: "tc_g",
        toolName: "Bash",
        riskLevel: "high",
        reason: "danger",
        input: "curl example.com",
        display: SAMPLE_DISPLAY,
        optionsPolicy: "no-always-allow",
        fullAccessSupported: true,
      }),
    ),
    FROZEN_PERMISSION_REQUESTED_KEYS,
    "permission.requested",
  );
  assertKeysWithinAllowlist(
    mapPayload(
      rawSessionEvent(SessionEventType.TurnStarted, {
        executionStartedAt: EVENT_TIMESTAMP_MS,
        turnNumber: 2,
        input: "hi",
        inputId: "in_2",
      }),
    ),
    FROZEN_TURN_STARTED_KEYS,
    "turn.started",
  );
});
