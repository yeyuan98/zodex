import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ModelSelectionView } from "@zcode/provider";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { collectServiceMemoryDiagnostics } from "../src/memoryDiagnostics.js";
import type { ZCodeStreamEvent } from "@zcode/shared";

// specs/bot-permissions.md §8.1（alpha.1 F1）+ §7.16/§7.17/桌面回归 pin：
// rig-221723 D1——同一 requestId 的权限经两条通道到达 bot watcher（A：CLI 会话事件流
// permission.requested，adapter mapSessionEvent 映射；B：反向 RPC
// interaction/requestPermission → host emitSessionEvent("permission.request")，adapter
// mapServiceEvent 映射），watcher 无 requestId 去重 ⇒ 双发。Harness = 真
// createZCodeAgentService + 真 zcodeTaskServiceAdapter + 假 Agent 子进程
// （botPermissionDualChannelFakeAgent.mjs，agentPendingGauge.test.ts 同款 stdio 装配）。
//
// - 场景 16（红）：dual 模式（A→B 同 requestId）⇒ adapter 订阅方（bots watcher 同缝，
//   deliveryKind "bot-channel-continuous"）恰收一次 permission_request 流事件（今 2）。
// - 场景 17（guard）：auq 模式——AskUserQuestion 等待态标记（permission.requested，
//   user-input-backed 工具名）不得标记进 pendingPermissions 登记表
//   （agent.pendingPermissions 仪表恒 0；W2 host 侧标记必须过滤该类工具名）。
// - 桌面/单通道回归 pin（绿，必须保持）：single 模式（仅反向 RPC）⇒ adapter 恰一次
//   permission_request + host 恰一次 permission.request 广播（B 单独到达永不被收口
//   抑制——host 回归不得被「安全网」掩盖）。

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "botPermissionDualChannelFakeAgent.mjs",
);

const SESSION_ID = "dual-channel-session-1";
const PERMISSION_REQUEST_ID = "perm-dual-1";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pendingPermissionsGauge(): number {
  return collectServiceMemoryDiagnostics()["agent.pendingPermissions"] ?? 0;
}

async function waitFor<T>(condition: () => T, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = condition();
  while (Date.now() < deadline) {
    if (last) return last;
    await sleep(25);
    last = condition();
  }
  return last;
}

interface DualChannelHarness {
  service: ReturnType<typeof createZCodeAgentService>;
  taskService: ReturnType<typeof createZCodeTaskServiceAdapter>;
  /** adapter 层流事件（bots watcher 同缝：onDynamicTaskEvent + bot-channel-continuous）。 */
  streamEvents: ZCodeStreamEvent[];
  /** host 服务层事件（desktop-continuous 订阅；诊断 + 单通道回归 pin 断言用）。 */
  serviceEvents: Array<{ type: string }>;
  dispose(): Promise<void>;
}

async function createDualChannelHarness(
  mode: "dual" | "auq" | "single",
): Promise<DualChannelHarness> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-agent-dual-"));
  const service = createZCodeAgentService({
    commandResolver: () => ({
      command: process.execPath,
      args: [FIXTURE],
      cwd: dir,
      env: {
        FAKE_AGENT_MODE: mode,
        FAKE_AGENT_SESSION_ID: SESSION_ID,
        FAKE_AGENT_REQUEST_ID: PERMISSION_REQUEST_ID,
      },
    }),
    modelSelectionReadinessSource: {
      getView: async () =>
        ({
          revision: 1,
          providers: [
            {
              providerId: "builtin-test",
              providerName: "Builtin Test",
              templateId: "builtin",
              config: {},
              models: [{ modelId: "glm-test", config: {} }],
            },
          ],
        }) as unknown as ModelSelectionView,
    },
  });
  const disposable = () => ({ dispose() {} });
  type AdapterOptions = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const taskService = createZCodeTaskServiceAdapter({
    zcodeAgentService: service,
    taskIndexRepo: {
      async getTaskMeta() {
        return null;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as AdapterOptions["taskIndexSyncer"],
  });
  const streamEvents: ZCodeStreamEvent[] = [];
  const streamDisposable = taskService.onDynamicTaskEvent({
    workspacePath: dir,
    taskId: SESSION_ID,
    deliveryKind: "bot-channel-continuous",
  })((event) => streamEvents.push(event));
  const serviceEvents: Array<{ type: string }> = [];
  const serviceDisposable = service.onDynamicSessionEvent({
    workspacePath: dir,
    sessionId: SESSION_ID,
    deliveryKind: "desktop-continuous",
  })((event) => serviceEvents.push(event as { type: string }));
  return {
    service,
    taskService,
    streamEvents,
    serviceEvents,
    async dispose() {
      streamDisposable.dispose();
      serviceDisposable.dispose();
      service.disposeAll();
      taskService.disposeAll();
      await service.disposeAllAndWait().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("场景16（红·F1 双通道收口）：同 requestId 经会话事件流(A)+反向RPC(B) ⇒ adapter 恰一次 permission_request 流事件（今两次）", async () => {
  const harness = await createDualChannelHarness("dual");
  try {
    // 今 alpha.0：A 与 B 各映射一次 ⇒ 2；等待稳定到达 2（今天的事实基线）再断言 1。
    await waitFor(
      () => harness.streamEvents.filter((event) => event.type === "permission_request").length >= 2,
      10_000,
    );
    const permissionEvents = harness.streamEvents.filter(
      (event) => event.type === "permission_request",
    );
    assert.equal(
      permissionEvents.length,
      1,
      "双通道同 requestId 必须在 host 收口为恰一次 permission_request 广播（spec §8.1； rigs-221723 D1/E1 双发、Telegram 双卡与 E9 僵尸卡根因；今天 A/B 各广播一次 = 2）",
    );
    assert.equal(
      permissionEvents[0]?.requestId,
      PERMISSION_REQUEST_ID,
      "收口后的唯一广播必须携带该 requestId",
    );
  } finally {
    await harness.dispose();
  }
});

test("场景17（guard·F1 标记陷阱）：AskUserQuestion 等待态标记不入 pendingPermissions 登记表（仪表恒 0），问题照常送达", async () => {
  const harness = await createDualChannelHarness("auq");
  try {
    // 前置：真正的问题（interaction/requestUserInput → userInput.request 服务事件 →
    // adapter elicitation_request 流事件）必须到达——问题类链路不受 F1 影响。
    assert.ok(
      await waitFor(
        () => harness.streamEvents.some((event) => event.type === "elicitation_request"),
        10_000,
      ),
      "前置：AskUserQuestion 问题必须经 elicitation_request 送达订阅方",
    );
    // 等待窗口拉平异步记账后断言仪表：user-input-backed 等待态标记（permission.requested,
    // toolName=AskUserQuestion）不得进入 permission 登记表——今天通道 A 不做任何标记
    // （恒 0 即绿）；W2 在 host 侧为通道 A 增加标记时必须过滤该类工具名，否则本钉转红。
    await sleep(300);
    assert.equal(
      pendingPermissionsGauge(),
      0,
      "AskUserQuestion/ExitPlanMode 等待态标记不得标记进 pendingPermissions（spec §8.1 陷阱 a：未过滤标记会污染权限登记表与 pending 仪表）",
    );
    assert.equal(
      harness.streamEvents.filter((event) => event.type === "permission_request").length,
      0,
      "user-input-backed 等待态标记不得投成普通权限提示（adapter 既有过滤，guard）",
    );
  } finally {
    await harness.dispose();
  }
});

test("桌面/单通道回归 pin（绿·必须保持）：仅反向 RPC(B) 一次 ⇒ adapter 恰一次流事件 + host 恰一次 permission.request 广播", async () => {
  const harness = await createDualChannelHarness("single");
  try {
    assert.ok(
      await waitFor(
        () =>
          harness.streamEvents.filter((event) => event.type === "permission_request").length >= 1,
        10_000,
      ),
      "前置：反向 RPC 单通道必须送达 adapter 订阅方",
    );
    await sleep(300);
    assert.equal(
      harness.streamEvents.filter((event) => event.type === "permission_request").length,
      1,
      "单通道（B 单独到达）必须保持恰一次 permission_request 流事件——host 收口不得把「首次且唯一」的到达误判为重复（spec §8.1）",
    );
    assert.equal(
      harness.serviceEvents.filter((event) => event.type === "permission.request").length,
      1,
      "host 的 permission.request 服务事件在无通道 A 竞争时必须照常广播恰一次（桌面消费方不因 F1 收口而丢失事件）",
    );
  } finally {
    await harness.dispose();
  }
});
