// Track B alpha.1 F1 红测假 Agent（packages/services/test/botPermissionDualChannel.test.ts）：
// 与 host 以 stdio 换行 JSON 帧通信（装配同 agentPendingGaugeFakeAgent.mjs）。行为契约
// （FAKE_AGENT_MODE 供断言选择）：
// - mode=dual（主红测，D1 复现）：收到 host 首个请求时，对同一 requestId 先推 (A) CLI
//   会话事件流 permission.requested（session/event 通知——permission-flow.ts 在 broker
//   调用前发射的同款通道），再发 (B) 反向 RPC interaction/requestPermission——两条通道
//   各自到达 host；观察 adapter 订阅方的 permission_request 流事件次数。
// - mode=single（桌面/单通道回归 pin）：只发 (B) 反向 RPC，一次。
// - mode=auq（F1 陷阱 guard）：先推 (A) permission.requested 等待态标记
//   （toolName=AskUserQuestion，requestId 与后续问题不同），再发反向 RPC
//   interaction/requestUserInput（真正的问题）。钉住：user-input-backed 标记不得
//   污染 pendingPermissions 登记表（agent.pendingPermissions 仪表恒 0）。
// v4/command 一律回 accepted ack；stdin EOF 后静默退出。
import readline from "node:readline";

const mode = process.env.FAKE_AGENT_MODE ?? "dual";
const sessionId = process.env.FAKE_AGENT_SESSION_ID ?? "dual-channel-session-1";
const requestId = process.env.FAKE_AGENT_REQUEST_ID ?? "perm-dual-1";

function permissionOptions() {
  return [
    {
      optionId: "allow-once",
      kind: "allow_once",
      name: "Allow",
      response: { decision: "allow" },
    },
    {
      optionId: "deny",
      kind: "deny",
      name: "Deny",
      response: { decision: "deny" },
    },
  ];
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let fired = false;
function fireOnce() {
  if (fired) return;
  fired = true;
  if (mode === "auq") {
    // (A) AskUserQuestion 的等待态标记：permission.requested 会话事件，requestId 是
    // 权限语义的独立标记 id（与后续 requestUserInput 的业务 requestId 不同）。
    send({
      method: "session/event",
      params: {
        eventId: "evt-auq-marker-1",
        sessionId,
        seq: 1,
        timestamp: Date.now(),
        type: "permission.requested",
        payload: {
          requestId: "perm-auq-marker-1",
          toolCallId: "call-auq-marker-1",
          toolName: "AskUserQuestion",
          riskLevel: "low",
          reason: "AskUserQuestion waiting marker",
          input: {},
          options: permissionOptions(),
        },
      },
    });
    // (B) 真正的问题经 interaction/requestUserInput 反向 RPC 到达。
    send({
      id: 9201,
      method: "interaction/requestUserInput",
      params: {
        requestId: "auq-question-1",
        sessionId,
        toolCallId: "call-auq-marker-1",
        toolName: "AskUserQuestion",
        prompt: "Pick a color",
        questions: [
          {
            question: "Pick a color",
            header: "Color",
            options: [
              { value: "red", label: "Red" },
              { value: "blue", label: "Blue" },
            ],
          },
        ],
      },
    });
    return;
  }
  if (mode === "dual") {
    // (A) CLI 会话事件流：permission-flow.ts 在 broker 调用前发射（E1 双发的前一条）。
    send({
      method: "session/event",
      params: {
        eventId: "evt-perm-requested-1",
        sessionId,
        seq: 1,
        timestamp: Date.now(),
        type: "permission.requested",
        payload: {
          requestId,
          toolCallId: "call-dual-1",
          toolName: "Bash",
          riskLevel: "medium",
          reason: "run repository tests",
          input: { command: "pnpm test" },
          options: permissionOptions(),
        },
      },
    });
  }
  // (B) 反向 RPC：interaction/requestPermission（E1 双发的后一条，~330-650ms 间隔在
  // 测试中压缩为紧跟；host 侧收口不依赖间隔）。
  send({
    id: 9101,
    method: "interaction/requestPermission",
    params: {
      requestId,
      sessionId,
      turnId: "turn-1",
      toolCallId: "call-dual-1",
      toolName: "Bash",
      reason: "run repository tests",
      riskLevel: "medium",
      input: { command: "pnpm test" },
      options: permissionOptions(),
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message && "method" in message && "id" in message) {
    if (message.method === "session/list") {
      send({ id: message.id, result: { sessions: [] } });
    } else if (message.method === "session/subscribe") {
      const subscribeSessionId =
        typeof message.params?.sessionId === "string" ? message.params.sessionId : sessionId;
      send({ id: message.id, result: { sessionId: subscribeSessionId, eventSeq: 0, events: [] } });
    } else if (message.method === "v4/command") {
      const commandId =
        message.params && typeof message.params.commandId === "string"
          ? message.params.commandId
          : "";
      send({
        id: message.id,
        result: { commandId, status: "accepted", revisionAtDecision: 1 },
      });
    } else {
      send({ id: message.id, result: {} });
    }
    fireOnce();
    return;
  }
  // host 对反向请求的响应：本测试不依赖其内容，静默丢弃。
});
rl.on("close", () => {
  process.exit(0);
});
