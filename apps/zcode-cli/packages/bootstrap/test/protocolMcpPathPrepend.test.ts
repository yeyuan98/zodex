import assert from "node:assert/strict";
import test from "node:test";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.ts";

// specs/agent-runtimes.md §2.3 面4（C1 pathPrepend 下行 mapper）红测：
// protocolMcpServersToRuntimeMcpConfig 是 desktop→CLI 下行的逐字段拷贝缝
// （今日只拷 type/command/args/env/timeoutMs/isolation/protocolVersion——带
// pathPrepend 的下行会被静默剥除，spawn 侧永远看不到该字段）。W2 必须补拷
// pathPrepend；timeoutMs 的保留注释（:19-21）是同型前科。
//
// 输入用普通对象字面量 + as unknown 收窄（协议类型尚未含该字段，红测不得在
// 类型位置引用）；结果侧以 Record<string, unknown> 读取。

type MapperInput = Parameters<typeof protocolMcpServersToRuntimeMcpConfig>[0];

const protocolServerWithPathPrepend = {
  name: "runtime-server",
  command: "npx",
  args: ["-y", "server"],
  env: [{ name: "FOO", value: "bar" }],
  pathPrepend: ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
} as unknown as NonNullable<MapperInput>[number];

test("C1 下行 mapper：带 pathPrepend 的 protocol server → 运行时配置保留字段（今日红：逐字段拷贝静默剥除）", () => {
  const result = protocolMcpServersToRuntimeMcpConfig([
    protocolServerWithPathPrepend,
  ] as unknown as MapperInput);
  assert.ok(result, "mapper 必须返回运行时 MCP 配置");
  const server = result.servers["runtime-server"] as Record<string, unknown> | undefined;
  assert.ok(server, "server 条目必须保留");
  assert.deepEqual(
    server?.pathPrepend,
    ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
    "下行 mapper 必须逐字段拷贝 pathPrepend（spec §2.3 面4：不开则 desktop 下行静默剥除；~ 展开属于 CLI 运行时职责）",
  );
});

test("C1 下行 mapper：不带 pathPrepend → 字段保持 undefined（今绿，W2 后保持绿——不得凭空注入）", () => {
  const bare = {
    name: "plain-server",
    command: "node",
    args: ["server.js"],
    env: [],
  } as unknown as NonNullable<MapperInput>[number];
  const result = protocolMcpServersToRuntimeMcpConfig([bare] as unknown as MapperInput);
  const server = result?.servers["plain-server"] as Record<string, unknown> | undefined;
  assert.ok(server, "前置：server 条目存在");
  assert.equal(
    server?.pathPrepend,
    undefined,
    "未携带 pathPrepend 的下行不得被 mapper 凭空注入该字段",
  );
});
