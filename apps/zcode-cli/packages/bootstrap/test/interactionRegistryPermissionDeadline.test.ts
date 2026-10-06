import assert from "node:assert/strict";
import test from "node:test";
import { v4AnswerToPermissionResponse } from "../src/zcode-protocol/interaction-broker.js";
import {
  V4InteractionRegistry,
  type V4InteractionAnswer,
  type V4InteractionAutoResolution,
} from "../src/zcode-protocol-v4/interaction-registry.js";
import { buildProtocolPermissionOptions } from "../src/zcode-protocol/permission-options.js";

/**
 * 契约（specs/bot-permissions.md §3b / §7.4-§7.5，Track B W1 红测 → W3 转绿）：
 *
 * V4InteractionRegistry 注册选项扩展 per-entry 权限 deadline：kind "permission"
 * 语义 = 注册即武装倒计时（不排队头）、无 hiddenGrace（首个状态即
 * visibleCountdown）、到期 resolve 无 optionId/action 的 deny-shaped 应答
 * （落 v4AnswerToPermissionResponse 既有 deny 兜底）；恢复已过期的倒计时
 * （initialAutoResolution）必须立即 resolve deny；任何真实应答先到 ⇒ 注销登记
 * 并清除 timer（恰一次 resolve）。
 *
 * 场景 D 是 guard（W3 落地后必须保持绿）。
 */

const bashPermissionOptions = buildProtocolPermissionOptions({ toolName: "bash" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(20);
  }
  return condition();
}

test("A（红·到期 deny）：permission kind + per-entry deadline 注册 ⇒ 到期自动 resolve deny-shaped 应答并落 deny 兜底", async () => {
  const registry = new V4InteractionRegistry();
  const answers: V4InteractionAnswer[] = [];
  const unregister = registry.register(
    "perm-1",
    (answer) => {
      answers.push(answer);
    },
    {
      sessionId: "sess-perm-a",
      kind: "permission",
      autoResolutionMs: 120,
    },
  );
  try {
    assert.ok(
      await waitFor(() => answers.length > 0, 2000),
      "permission 注册携带 deadline 后，到期必须自动 resolve（非 askUserQuestion kind 武装倒计时，spec §3b.1）",
    );
    const answer = answers[0]!;
    assert.equal(answer.optionId, undefined, "到期应答必须 deny-shaped：无 optionId");
    assert.equal(answer.action, undefined, "到期应答必须 deny-shaped：无 action");
    assert.equal(
      v4AnswerToPermissionResponse(answer, bashPermissionOptions, "bash")?.decision,
      "deny",
      "deny-shaped 应答经 v4AnswerToPermissionResponse 必须落既有 deny 兜底（buildPermissionDeniedContent）",
    );
  } finally {
    unregister();
  }
});

test("B（红·无隐藏宽限）：permission 注册 ⇒ 首个 autoResolution 状态即 visibleCountdown（永不 hiddenGrace）", async () => {
  const registry = new V4InteractionRegistry();
  const states: V4InteractionAutoResolution[] = [];
  const unregister = registry.register(
    "perm-grace",
    () => {},
    {
      sessionId: "sess-perm-b",
      kind: "permission",
      // deadline 足够长：本场景只观察首个状态，不触发到期。
      autoResolutionMs: 5_000,
      onAutoResolutionUpdated: (state) => {
        states.push(state);
      },
    },
  );
  try {
    assert.ok(
      await waitFor(() => states.length > 0, 2000),
      "permission 注册必须立即发布 autoResolution 状态（注册即武装，回调即刻触发）",
    );
    assert.equal(
      states[0]?.state,
      "visibleCountdown",
      "首个状态必须是 visibleCountdown——权限提示无 hiddenGrace（spec §3b.1，与 askUserQuestion 60s 隐藏宽限明确不同）",
    );
    assert.ok(
      !states.some((state) => state.state === "hiddenGrace"),
      "permission 生命周期内不得出现 hiddenGrace 状态",
    );
  } finally {
    unregister();
  }
});

test("C（红·过期恢复）：initialAutoResolution 已过期 + permission kind ⇒ 恢复时立即 resolve deny-shaped", async () => {
  const registry = new V4InteractionRegistry();
  const answers: V4InteractionAnswer[] = [];
  const now = Date.now();
  const unregister = registry.register(
    "perm-overdue",
    (answer) => {
      answers.push(answer);
    },
    {
      sessionId: "sess-perm-c",
      kind: "permission",
      autoResolutionMs: 120,
      initialAutoResolution: {
        state: "visibleCountdown",
        startedAt: now - 1000,
        visibleAt: now - 1000,
        deadlineAt: now - 100,
      },
    },
  );
  try {
    assert.ok(
      await waitFor(() => answers.length > 0, 2000),
      "已过期的 permission 倒计时恢复时必须立即 resolve（spec §3b.4 复用 resumeAutoResolution overdue 分支）",
    );
    const answer = answers[0]!;
    assert.equal(
      answer.optionId,
      undefined,
      "过期恢复 resolve 必须是 deny-shaped：无 optionId（askUserQuestion 的 overdue 分支才回 {action:'accept', content:{answers:{}}}）",
    );
    assert.equal(answer.action, undefined, "过期恢复 resolve 必须是 deny-shaped：无 action");
    assert.equal(
      v4AnswerToPermissionResponse(answer, bashPermissionOptions, "bash")?.decision,
      "deny",
      "经 v4AnswerToPermissionResponse 必须落 deny 兜底",
    );
  } finally {
    unregister();
  }
});

test("D（guard·绿）：deadline 前真实 resolve() 先到 ⇒ 注销登记并取消 timer，resolve 回调恰一次且为手动应答", async () => {
  const registry = new V4InteractionRegistry();
  const answers: V4InteractionAnswer[] = [];
  const unregister = registry.register(
    "perm-guard",
    (answer) => {
      answers.push(answer);
    },
    {
      sessionId: "sess-perm-d",
      kind: "permission",
      autoResolutionMs: 120,
    },
  );
  try {
    const delivered = registry.resolve("perm-guard", { optionId: "allow_once" });
    assert.equal(delivered, true, "真实应答必须命中登记");
    assert.equal(registry.has("perm-guard"), false, "resolve 后登记必须注销");
    // 跨过 120ms deadline，确认 auto-resolution timer 已随注销清除（无二次 resolve）。
    await sleep(300);
    assert.equal(answers.length, 1, "resolve 回调必须恰好一次（先到先得，迟到自动拒绝无害）");
    assert.equal(answers[0]?.optionId, "allow_once", "回调应答必须是手动答案本身");
  } finally {
    unregister();
  }
});

// ---- [ulw] 评审 R2 pin：snooze 拒绝 + 未到期恢复不重置时钟（spec §7.4/§7.5 前半） ----

test("E（guard·snooze 拒绝）：permission 条目 snoozeAutoResolution 返回 false（不可休眠，spec §3b.1/§7.4）", async () => {
  const registry = new V4InteractionRegistry();
  const unregister = registry.register("perm-snooze", () => {}, {
    sessionId: "sess-perm-e",
    kind: "permission",
    // deadline 足够长：本场景只验证 snooze 拒绝，不触发到期。
    autoResolutionMs: 5_000,
  });
  try {
    assert.equal(
      await registry.snoozeAutoResolution("perm-snooze"),
      false,
      "permission kind 的 snoozeAutoResolution 必须返回 false（snooze 只属于 askUserQuestion；自动拒绝语义不受用户暂停影响）",
    );
    assert.equal(registry.has("perm-snooze"), true, "snooze 拒绝不得注销登记");
  } finally {
    unregister();
  }
});

test("F（恢复·未到期）：initialAutoResolution 未到期 ⇒ 同一 deadlineAt 恢复、不提前 resolve、原时刻 deny-shaped 到期", async () => {
  const registry = new V4InteractionRegistry();
  const answers: V4InteractionAnswer[] = [];
  const states: V4InteractionAutoResolution[] = [];
  const now = Date.now();
  const originalDeadlineAt = now + 1000;
  const unregister = registry.register(
    "perm-restore",
    (answer) => {
      answers.push(answer);
    },
    {
      sessionId: "sess-perm-f",
      kind: "permission",
      // 重注册携带新的 autoResolutionMs：恢复路径必须忽略该值（不重置时钟）。
      autoResolutionMs: 5_000,
      initialAutoResolution: {
        state: "visibleCountdown",
        startedAt: now - 500,
        visibleAt: now - 500,
        deadlineAt: originalDeadlineAt,
      },
      onAutoResolutionUpdated: (state) => {
        states.push(state);
      },
    },
  );
  try {
    assert.ok(states.length > 0, "恢复注册必须立即发布 autoResolution 状态");
    const firstState = states[0];
    assert.ok(
      firstState !== undefined &&
        firstState.state === "visibleCountdown" &&
        firstState.deadlineAt === originalDeadlineAt,
      "未到期恢复必须保持原 deadlineAt（spec §3b.4/§7.5：不重置时钟）",
    );
    // 剩余 ~1s：等 300ms 不得提前 resolve。
    await sleep(300);
    assert.equal(answers.length, 0, "未到期恢复不得提前 resolve（重启不得吃掉剩余等待时间）");
    assert.ok(
      await waitFor(() => answers.length > 0, 2_000),
      "必须在 ORIGINAL deadline（~1s，而非重注册 +5s）到期 resolve——若被 autoResolutionMs 重置，2s 窗口内不会触发",
    );
    assert.equal(answers[0]?.optionId, undefined, "到期应答必须 deny-shaped：无 optionId");
    assert.equal(answers[0]?.action, undefined, "到期应答必须 deny-shaped：无 action");
  } finally {
    unregister();
  }
});
