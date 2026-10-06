import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionBrokerRequest } from "@zcode/contracts";
import { createProtocolInteractionBroker } from "../src/zcode-protocol/interaction-broker.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";

/**
 * 契约（specs/bot-permissions.md §8.2 F2 CLI resume 缺口 / §7.20，Track B alpha.1 W1
 * 红测 → W3 转绿；permissionDeadlineWiring.test.ts 同款纯函数/契约风格）：
 *
 * CLI session record 在 resume 时经 materializeSessionRecord 重建且不携带
 * `permissionAutoDenyMs`（今天唯一写入点 = v4 createSession handler 建档后）。重启后
 * 该 session 的新权限提示将读不到权威倒计时。owner 决策（2026-10-06）：按 permission
 * 自动拒绝 session entry 同款机械持久化会话级 deadline——本测试钉住其读取侧契约：
 *
 * 1.（红）resume 形态 record（无 permissionAutoDenyMs）+ 持久化 session entry 携带
 *    会话级 deadline ⇒ broker 为新 requestId 注册权限交互时必须按该值武装倒计时
 *    （到期代答 deny-shaped）。今天 resolvePermissionDeadline 只读 record 字段 ⇒
 *    无倒计时，反向 RPC 悬挂等待。
 * 2.（guard）resume 形态 record 且无持久化 deadline entry ⇒ 保持无倒计时（桌面/未
 *    配置语义不变，不得凭空武装）。
 * 3.（guard）createSession 建档形态 record（字段在场）⇒ 倒计时照常（§3a.3 主源不变）。
 *
 * pinned 持久化形状（选择的最小修复形状，见 commit body）：session entry
 * `{ type: "permission-deadline", data: { permissionAutoDenyMs } }`，session 级、
 * 与既有 `permission-auto-resolution:<requestId>` per-interaction 条目并存。
 */

const RESUME_SESSION_ID = "sess-resume-deadline";
/** 观察窗：远大于武装 deadline（200ms），远小于测试超时；窗口过后仍无代答 = 悬挂。 */
const PENDING_OBSERVATION_MS = 1_200;

function permissionRequest(requestId: string): PermissionBrokerRequest {
  return {
    requestId,
    sessionId: RESUME_SESSION_ID as PermissionBrokerRequest["sessionId"],
    traceId: "trace-resume-deadline" as PermissionBrokerRequest["traceId"],
    toolCallId: "call-resume-deadline" as PermissionBrokerRequest["toolCallId"],
    toolName: "bash",
    input: { command: "pnpm test" },
    mode: "build",
    ruleId: "rule-1",
    reason: "run command",
    riskLevel: "medium",
    requestedAt: new Date(),
  };
}

interface BrokerContextOptions {
  /** v4 createSession 写入的 record 字段（resume 重建形态 = undefined）。 */
  recordPermissionAutoDenyMs?: number;
  /** 持久化 session entries（含 pinned 形状的会话级 deadline 条目）。 */
  persistedEntries?: Array<Record<string, unknown>>;
}

function createBrokerContext(options: BrokerContextOptions): {
  context: ZCodeProtocolAgentServerContext;
  savedEntries: Array<Record<string, unknown>>;
} {
  const savedEntries: Array<Record<string, unknown>> = [];
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    },
    v4Interactions: new V4InteractionRegistry(),
    sessions: new Map([
      [
        RESUME_SESSION_ID,
        options.recordPermissionAutoDenyMs !== undefined
          ? { permissionAutoDenyMs: options.recordPermissionAutoDenyMs }
          : {},
      ],
    ]),
    notify: () => {},
    // 反向 RPC 悬挂（宿主未应答）：只有登记表倒计时代答（abort 触发 reject）才能收口。
    requestClient: (_method: unknown, _params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("request aborted (test fake)"));
        });
      }),
    deps: {
      sessionStore: {
        sessionEntries: async (query: { sessionID?: unknown; type?: unknown }) =>
          (options.persistedEntries ?? []).filter(
            (entry) =>
              String(entry.sessionID) === String(query.sessionID) && entry.type === query.type,
          ),
        saveSessionEntry: async (entry: Record<string, unknown>) => {
          savedEntries.push(entry);
        },
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, savedEntries };
}

/** 竞速观察：到期代答（deny）or 观察窗内仍悬挂。 */
async function settleBrokerPermission(
  context: ZCodeProtocolAgentServerContext,
  requestId: string,
): Promise<{ kind: "denied"; reason?: string } | { kind: "pending" }> {
  const broker = createProtocolInteractionBroker(context);
  const outcome = await Promise.race([
    broker
      .requestPermission(permissionRequest(requestId))
      .then((result) => ({ kind: "denied" as const, reason: result.reason })),
    new Promise<{ kind: "pending" }>((resolve) => {
      setTimeout(() => resolve({ kind: "pending" }), PENDING_OBSERVATION_MS);
    }),
  ]);
  return outcome;
}

test("场景20（红·F2 CLI resume）：resume 重建 record（无 permissionAutoDenyMs）+ 持久化会话级 deadline ⇒ 新权限交互必须武装倒计时到期代答 deny", async () => {
  const { context } = createBrokerContext({
    // resume 重建形态：record 无 deadline 字段（今天 activateSessionForResume 的产物）。
    recordPermissionAutoDenyMs: undefined,
    persistedEntries: [
      {
        id: `permission-deadline:${RESUME_SESSION_ID}`,
        sessionID: RESUME_SESSION_ID,
        type: "permission-deadline",
        time: { created: 1_000, updated: 1_000 },
        data: { permissionAutoDenyMs: 200 },
      },
    ],
  });
  const outcome = await settleBrokerPermission(context, "req-resume-new-1");
  assert.equal(
    outcome.kind,
    "denied",
    "resume 后的新权限交互必须按持久化的会话级 deadline 武装倒计时并到期代答 deny-shaped（spec §8.2 F2/§7.20；今天 resolvePermissionDeadline 只读重建 record ⇒ 无倒计时 ⇒ 悬挂等待 = 观察窗内 pending）",
  );
});

test("场景20b（guard·无持久化不武装）：resume 形态 record 且无持久化 deadline entry ⇒ 保持无倒计时（悬挂等待，桌面/未配置语义不变）", async () => {
  const { context } = createBrokerContext({
    recordPermissionAutoDenyMs: undefined,
    persistedEntries: [],
  });
  const outcome = await settleBrokerPermission(context, "req-resume-nodeadline-1");
  assert.equal(
    outcome.kind,
    "pending",
    "无 record 字段且无持久化 entry ⇒ 不得凭空武装倒计时（桌面会话/未配置 bot 语义逐字节不变，spec §3a.2）",
  );
});

test("场景20c（guard·主源不变）：createSession 建档形态 record（permissionAutoDenyMs 在场）⇒ 倒计时照常到期代答 deny（§3a.3）", async () => {
  const { context } = createBrokerContext({
    recordPermissionAutoDenyMs: 200,
    persistedEntries: [],
  });
  const outcome = await settleBrokerPermission(context, "req-resume-fresh-1");
  assert.equal(
    outcome.kind,
    "denied",
    "record 携带 permissionAutoDenyMs 时倒计时必须照常（spec §3a.3 主事实源；resume 修复不得改变建档路径行为）",
  );
});
