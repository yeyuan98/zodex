import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../src/config/schema.ts";

// specs/agent-runtimes.md §2.2 层(1)/§2.3 面3（C1 pathPrepend CLI 配置装载腿）红测：
// `.zcode/config.json` 的 mcp.servers 条目带 pathPrepend 时——
// - 绝对路径元素：schema 必须新增 additive 字段接受，server 连同字段保留（今日红：
//   mcpStdioServerSchema strict 未知键 → :486-500 环整 server 连警告被丢弃）；
// - 相对路径元素：server 必须按既有 per-server invalid 机制丢弃 + warning 诊断，
//   且诊断消息必须点名 pathPrepend/绝对路径语义（今日红：消息是「unrecognized key」
//   措辞，语义是未知字段而非非法值——两红均须 W2 转绿）。
//
// 输入用普通对象字面量（parse 入参为 unknown）；结果侧以 Record<string, unknown>
// 收窄读取，避免在类型位置引用尚未存在的字段。

function configWithServer(pathPrepend: string[]): unknown {
  return {
    mcp: {
      servers: {
        "runtime-server": {
          type: "stdio",
          command: "npx",
          args: ["-y", "server"],
          env: { FOO: "bar" },
          pathPrepend,
        },
      },
    },
  };
}

function readRetainedServer(config: unknown): Record<string, unknown> | undefined {
  const mcp = (config as Record<string, unknown> | undefined)?.mcp as
    | Record<string, unknown>
    | undefined;
  const servers = mcp?.servers as Record<string, Record<string, unknown>> | undefined;
  return servers?.["runtime-server"];
}

test("C1 配置装载：绝对路径 pathPrepend 的 server 连同字段保留（今日红：strict 未知键整 server 丢弃）", () => {
  const { config, diagnostics } = parseConfigFileToRuntimePatchWithDiagnostics(
    configWithServer(["/opt/rt/bin"]),
  );
  const server = readRetainedServer(config);
  assert.ok(server, "带绝对 pathPrepend 的 server 必须保留在解析结果中（不得整条丢弃）");
  assert.deepEqual(
    server?.pathPrepend,
    ["/opt/rt/bin"],
    "pathPrepend 必须原样保留（元素顺序不变）",
  );
  assert.equal(
    diagnostics.filter((d) => d.code === "config_mcp_server_invalid").length,
    0,
    "合法 pathPrepend 不得产生任何 config_mcp_server_invalid 诊断",
  );
});

test("C1 配置装载：相对路径 pathPrepend 元素 → server 丢弃 + 诊断点名绝对路径语义（今日红：消息为 unrecognized key 措辞）", () => {
  const { config, diagnostics } = parseConfigFileToRuntimePatchWithDiagnostics(
    configWithServer(["relative/dir"]),
  );
  // 丢弃本身沿既有 per-server invalid 机制（今日因未知键同样丢弃——这条断言今日即绿，
  // W2 后必须因「相对路径」这条新理由保持绿）。
  assert.equal(
    readRetainedServer(config),
    undefined,
    "相对路径元素 = server 配置无效，必须按既有 per-server invalid 机制丢弃该 server",
  );
  const invalid = diagnostics.filter((d) => d.code === "config_mcp_server_invalid");
  assert.equal(invalid.length, 1, "必须恰好产生一条 per-server invalid warning 诊断");
  const message = invalid[0]?.message ?? "";
  assert.ok(
    /pathPrepend/i.test(message) && /绝对路径|absolute/i.test(message),
    `诊断消息必须点名 pathPrepend 与绝对路径语义（spec §2.2 层(1)：loud 而非静默），实际消息：${message}`,
  );
});

test("C1 配置装载（guard）：不带 pathPrepend 的 server 不受影响（今绿，W2 后保持绿）", () => {
  const input: unknown = {
    mcp: {
      servers: {
        "runtime-server": {
          type: "stdio",
          command: "npx",
          args: ["-y", "server"],
          env: { FOO: "bar" },
        },
      },
    },
  };
  const { config, diagnostics } = parseConfigFileToRuntimePatchWithDiagnostics(input);
  const server = readRetainedServer(config);
  assert.ok(server, "不带 pathPrepend 的既有 server 必须照常保留");
  assert.equal(
    diagnostics.filter((d) => d.code === "config_mcp_server_invalid").length,
    0,
    "无 pathPrepend 时不得产生 invalid 诊断",
  );
});
