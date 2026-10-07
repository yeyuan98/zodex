import assert from "node:assert/strict";
import test from "node:test";

// specs/agent-runtimes.md §2.4（C1 capability 门）红测：W2 新缝，先红后绿。
// 今日 `src/zcode-agent/mcpPathPrependSupport.ts` 不存在 → 动态 import 捕获
// MODULE_NOT_FOUND 后以 typeof 断言 + 明确失败信息表达红态。
//
// 三下发点（session create / session resume / mcp/list）的门控语义收敛为：
// 1) 纯 strip 工具：capability flag 关闭时从每个 stdio mcpServers 条目剥除 pathPrepend；
// 2) capability helper：沿 independentPlanSupport 先例 per-client 缓存，探测失败
//    fail-closed（按未支持处理）且不缓存失败结果。

interface StdioServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
  pathPrepend?: string[];
}

interface GateModule {
  supportsMcpPathPrepend?: (client: unknown) => Promise<boolean>;
  stripMcpServersPathPrepend?: (servers: unknown) => unknown;
  gateMcpServersPathPrepend?: (client: unknown, servers: unknown) => Promise<unknown>;
}

async function loadGateModule(): Promise<GateModule | undefined> {
  try {
    return (await import("../src/zcode-agent/mcpPathPrependSupport.js")) as GateModule;
  } catch {
    return undefined;
  }
}

function stdioServerWithPathPrepend(): StdioServer {
  return {
    name: "runtime-server",
    command: "npx",
    args: ["-y", "server"],
    env: [{ name: "FOO", value: "bar" }],
    pathPrepend: ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
  };
}

test("C1 门控：strip 工具剥除 stdio 条目的 pathPrepend，其余字段与无字段条目不动（今日红：模块不存在）", async () => {
  const mod = await loadGateModule();
  assert.equal(
    typeof mod?.stripMcpServersPathPrepend,
    "function",
    "services/src/zcode-agent/mcpPathPrependSupport.ts 必须导出 strip 工具（spec §2.4：三个下发点共用的单一下发路径）",
  );
  const strip = mod!.stripMcpServersPathPrepend!;
  const stripped = strip([stdioServerWithPathPrepend()]) as StdioServer[];
  assert.equal(
    "pathPrepend" in stripped[0]!,
    false,
    "flag 关闭时 stdio 条目的 pathPrepend 键必须被整体剥除（不得留下 undefined 值键）",
  );
  assert.equal(stripped[0]!.command, "npx", "剥除不得影响其余字段");
  assert.equal(stripped[0]!.env.length, 1, "剥除不得影响 env");
  const bare = [{ name: "plain", command: "node", args: [], env: [] }];
  assert.deepEqual(strip(bare), bare, "无 pathPrepend 的条目必须原样返回");
  const http = [{ name: "web", type: "http" as const, url: "https://example", headers: [] }];
  assert.deepEqual(strip(http), http, "http 形态条目必须原样返回");
  assert.equal(strip(undefined), undefined, "undefined 输入必须返回 undefined");
});

test("C1 门控：gate 组合——flag true 透传、flag false 剥除（今日红：模块不存在）", async () => {
  const mod = await loadGateModule();
  assert.equal(
    typeof mod?.gateMcpServersPathPrepend,
    "function",
    "mcpPathPrependSupport 必须导出 gate 组合函数（三个下发点的单一门控路径，不得复制三份）",
  );
  const gate = mod!.gateMcpServersPathPrepend!;

  const supportedClient = {
    request: async () => ({ mcpPathPrepend: true }),
  };
  const kept = (await gate(supportedClient, [stdioServerWithPathPrepend()])) as StdioServer[];
  assert.deepEqual(
    kept[0]!.pathPrepend,
    ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
    "新 CLI 上报 flag:true 时 pathPrepend 必须透传",
  );

  const legacyClient = {
    request: async () => ({ independentPlanState: true }),
  };
  const stripped = (await gate(legacyClient, [stdioServerWithPathPrepend()])) as StdioServer[];
  assert.equal(
    "pathPrepend" in stripped[0]!,
    false,
    "旧 CLI 不上报 flag 时必须剥除 pathPrepend（避免 strict schema -32602 硬拒整次请求）",
  );
});

test("C1 门控：supportsMcpPathPrepend 探测失败 fail-closed 为 false 且不缓存失败（今日红：模块不存在）", async () => {
  const mod = await loadGateModule();
  assert.equal(
    typeof mod?.supportsMcpPathPrepend,
    "function",
    "mcpPathPrependSupport 必须导出 supportsMcpPathPrepend（沿 independentPlanSupport per-client WeakMap 先例）",
  );
  const supports = mod!.supportsMcpPathPrepend!;

  assert.equal(
    await supports({ request: async () => ({ mcpPathPrepend: true }) }),
    true,
    "flag:true → true",
  );
  assert.equal(
    await supports({ request: async () => ({ independentPlanState: true }) }),
    false,
    "旧 CLI 响应无 flag → false（falsy 即关闭下发）",
  );

  let attempts = 0;
  const failingClient = {
    request: async () => {
      attempts += 1;
      throw new Error("connection reset");
    },
  };
  assert.equal(
    await supports(failingClient),
    false,
    "runtime/capabilities 探测失败必须 fail-closed 为 false（spec §2.4 降级语义）",
  );
  assert.equal(
    await supports(failingClient),
    false,
    "失败后的再次调用仍须 false（且不把失败缓存成永久状态——重试语义与 independentPlanSupport 一致）",
  );
  assert.equal(attempts, 2, "失败结果不得进 per-client 缓存：第二次调用必须重新探测");

  let successCalls = 0;
  const okClient = {
    request: async () => {
      successCalls += 1;
      return { mcpPathPrepend: true };
    },
  };
  await supports(okClient);
  await supports(okClient);
  assert.equal(successCalls, 1, "成功结果必须按 per-client WeakMap 缓存（不重复探测）");
});
