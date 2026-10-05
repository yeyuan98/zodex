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

// alpha.7 §5.14（specs/log-diagnostics-hygiene.md Amendment (3.14.5-alpha.7)）：
// agent.pendingPermissions / agent.pendingUserInputs 仪表归零——红测先行，W3 实现
// 后转绿。计划依据：../ZCode-alpha6-plan.md Part 1 item 10 + 附录 C §5.14（陷阱：
// map 兼任 wasPending 防重复广播；墓碑 vs 删除由红测裁定——spec 已裁定墓碑）。
// Harness：真 createZCodeAgentService + 真 zcodeTaskServiceAdapter（真服务 +
// 最小 repo/syncer 桩，nonCliAcpRetirement 同款）+ 假 Agent 子进程
// （agentPendingGaugeFakeAgent.mjs，offPeak wiring harness 同款 stdio 装配）。

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agentPendingGaugeFakeAgent.mjs",
);

const SESSION_ID = "gauge-session-1";
const PERMISSION_REQUEST_ID = "perm-gauge-1";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pendingPermissionsGauge(): number {
  return collectServiceMemoryDiagnostics()["agent.pendingPermissions"] ?? 0;
}

async function waitForGauge(target: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = pendingPermissionsGauge();
  while (Date.now() < deadline) {
    last = pendingPermissionsGauge();
    if (last === target) return last;
    await sleep(25);
  }
  return last;
}

interface GaugeHarness {
  service: ReturnType<typeof createZCodeAgentService>;
  taskService: { respondPermission(params: unknown): Promise<boolean>; disposeAll(): void };
  events: Array<{ type: string }>;
  /** 假 Agent 所在 workspace 路径（respondPermission 显式 target，避免依赖 adapter 的 taskTargets 登记）。 */
  workspacePath: string;
  dispose(): Promise<void>;
}

async function createGaugeHarness(options: {
  fakeAgentMode: "respond" | "resolved";
  resendAfterRespond?: boolean;
}): Promise<GaugeHarness> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-agent-gauge-"));
  const service = createZCodeAgentService({
    commandResolver: () => ({
      command: process.execPath,
      args: [FIXTURE],
      cwd: dir,
      env: {
        FAKE_AGENT_MODE: options.fakeAgentMode,
        ...(options.resendAfterRespond ? { FAKE_AGENT_RESEND: "1" } : {}),
        FAKE_AGENT_SESSION_ID: SESSION_ID,
        FAKE_AGENT_REQUEST_ID: PERMISSION_REQUEST_ID,
      },
    }),
    // sendConversationCommandV4（respondPermission 的 v4 resolveInteraction 腿）经
    // getClient 的 provider/model 就绪门禁——注入恒 ready 视图（offPeak harness 的
    // 订阅路径无此门禁，本测试需要命令路径可用）。
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
  const events: Array<{ type: string }> = [];
  const subscription = service.onDynamicSessionEvent({
    workspacePath: dir,
    sessionId: SESSION_ID,
    deliveryKind: "desktop-continuous",
  })((event) => events.push(event as { type: string }));
  return {
    service,
    taskService,
    events,
    workspacePath: dir,
    async dispose() {
      subscription.dispose();
      service.disposeAll();
      taskService.disposeAll();
      await service.disposeAllAndWait().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("§5.14 应答路径：requestPermission → respondPermission 成功 → pendingPermissions 归零（今天恒 1 → 红）", async () => {
  const harness = await createGaugeHarness({ fakeAgentMode: "respond", resendAfterRespond: true });
  try {
    // 1) 反向权限请求注册进 map 并广播（gauge=1 是 harness 正确性锚，今天即绿）。
    const registered = await waitForGauge(1, 10_000);
    assert.equal(registered, 1, "harness 锚：反向权限请求必须已注册（pendingPermissions=1）");
    assert.equal(
      harness.events.some((event) => event.type === "permission.request"),
      true,
      "harness 锚：permission.request 必须广播给订阅者",
    );

    // 2) 真实用户路径应答：adapter.respondPermission（v4 resolveInteraction）成功。
    const responded = await harness.taskService.respondPermission({
      taskId: SESSION_ID,
      requestId: PERMISSION_REQUEST_ID,
      optionId: "allow-once",
      workspacePath: harness.workspacePath,
    });
    assert.equal(responded, true, "respondPermission 必须成功（假 Agent 回 accepted ack）");

    // 3) 墓碑守护钉（今天即绿；裁定 tombstone vs delete）：解决后 agent 以新协议
    //    id 重发同一业务 requestId（fixture 已在 v4 ack 后重发）→ 不得重新广播。
    //    先于归零断言执行：今天 map 未清理，wasPending 去重天然生效——本钉今天
    //    必绿；W3 若选"删除"而非"墓碑"，此钉转红强制墓碑语义。
    await sleep(500);
    assert.equal(
      harness.events.filter((event) => event.type === "permission.request").length,
      1,
      "解决后重发同 requestId 不得重新广播（wasPending 去重依赖 map 键存在——墓碑语义）",
    );

    // 4) 红点：仪表必须归零——今天 map 只增不减（仅断连/dispose 清理），恒 1。
    const gauge = await waitForGauge(0, 2_000);
    assert.equal(
      gauge,
      0,
      "respondPermission 成功后 agent.pendingPermissions 必须归零（specs §5.14 归约契约路径 a；今天恒 1）",
    );
  } finally {
    await harness.dispose();
  }
});

test("§5.14 deny-on-stop 变体：permission.resolved 会话事件 → pendingPermissions 归零（今天恒 1 → 红）", async () => {
  // 系统侧解决（无 UI 应答）：agent 推送 permission.resolved（decision=deny）——
  // 覆盖 deny-on-stop / deadline 类终局。今天该事件只被转发、不触碰 map → 恒 1。
  const harness = await createGaugeHarness({ fakeAgentMode: "resolved" });
  try {
    const registered = await waitForGauge(1, 10_000);
    assert.equal(registered, 1, "harness 锚：反向权限请求必须已注册");
    assert.equal(
      harness.events.some((event) => event.type === "permission.request"),
      true,
      "harness 锚：permission.request 必须广播",
    );
    // 假 Agent 在反向请求 1200ms 后推送 resolved 事件；归零等待窗覆盖它。
    const gauge = await waitForGauge(0, 8_000);
    assert.equal(
      gauge,
      0,
      "permission.resolved 会话事件到达后 agent.pendingPermissions 必须归零（specs §5.14 归约契约路径 b；今天恒 1）",
    );
  } finally {
    await harness.dispose();
  }
});
