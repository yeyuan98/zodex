// §5.14 pending 仪表红测假 Agent（packages/services/test/agentPendingGauge.test.ts）：
// 与 host 以 stdio 换行 JSON 帧通信（ZCode Protocol 无 jsonrpc 字段），装配与
// offPeakAutoDeclineFakeAgent.mjs 同款。行为契约（供断言）：
// 1. 收到 host 首个请求（session/list、session/subscribe 等）时回复合法结果，并按
//    FAKE_AGENT_MODE 一次性驱动一个反向 interaction/requestPermission（id 9101）：
//    - mode=respond（主用例）：等 host 经 v4/command(resolveInteraction) 应答 →
//      回 accepted ack；FAKE_AGENT_RESEND=1 时再以新协议 id 9102 重发同一业务
//      requestId（墓碑守护钉：解决后不得重新广播）。【隔离设计】本模式不推送
//      permission.resolved 会话事件——红测主用例只允许"应答成功清理"这一条路径生效。
//    - mode=resolved（deny-on-stop 变体）：发出反向请求 1200ms 后推送
//      permission.resolved 会话事件（decision=deny），全程无 host 命令参与——
//      对应 deny-on-stop：没有 UI 应答也有终局。
// 2. v4/command 一律回 accepted ack（commandId 原样回带 + revisionAtDecision=1）。
// 3. stdin EOF（host 回收进程树）后静默退出；清理未决定时器。
import readline from "node:readline";

const mode = process.env.FAKE_AGENT_MODE ?? "respond";
const resend = process.env.FAKE_AGENT_RESEND === "1";
const sessionId = process.env.FAKE_AGENT_SESSION_ID ?? "gauge-session-1";
const requestId = process.env.FAKE_AGENT_REQUEST_ID ?? "perm-gauge-1";

function permissionParams() {
  return {
    requestId,
    sessionId,
    turnId: "turn-1",
    toolCallId: "call-gauge-1",
    toolName: "Bash",
    reason: "run repository tests",
    riskLevel: "medium",
    input: { command: "pnpm test" },
    options: [
      {
        optionId: "allow-once",
        kind: "allow_once",
        name: "Allow",
        response: { decision: "allow" },
      },
    ],
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reverseRequest = {
  id: 9101,
  method: "interaction/requestPermission",
  params: permissionParams(),
};
let reverseFired = false;
const timers = new Set();
function fireReverseRequestsOnce() {
  if (reverseFired) return;
  reverseFired = true;
  send(reverseRequest);
  if (mode === "resolved") {
    // deny-on-stop：反向请求注册（host set→emit 顺序保证广播前 map 已有键）之后，
    // 延迟推送系统侧终局事件；本地 stdio 下 1200ms 足以让测试先观察到 gauge=1。
    const timer = setTimeout(() => {
      send({
        method: "session/event",
        params: {
          eventId: "evt-perm-resolved-1",
          sessionId,
          seq: 1,
          timestamp: Date.now(),
          type: "permission.resolved",
          payload: {
            requestId,
            toolCallId: "call-gauge-1",
            toolName: "Bash",
            decision: "deny",
            reason: "stopped by user",
          },
        },
      });
    }, 1200);
    timers.add(timer);
  }
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
    // host→agent 请求：只回本测试会触发的方法，其余给空结果兜底。
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
      if (mode === "respond" && resend) {
        // 墓碑守护钉：应答成功后 agent 以新协议 id 重发同一业务 requestId。
        send({ ...reverseRequest, id: 9102 });
      }
    } else {
      send({ id: message.id, result: {} });
    }
    fireReverseRequestsOnce();
    return;
  }
  // host 对反向请求的响应：本测试不依赖其内容，静默丢弃。
});
rl.on("close", () => {
  for (const timer of timers) clearTimeout(timer);
  process.exit(0);
});
