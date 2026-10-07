import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigResult } from "@zcode/adapters/config";
import { DefaultRuntimeConfig } from "@zcode/contracts";
import type { ZCodeAppOptions } from "../src/app/types.ts";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.ts";

// specs/agent-runtimes.md §5.1/§5.5(b)（alpha.1 fold-in：params.mcpServers 整替语义）
// 契约钉测：session create 显式携带非空 runtimeConfig.mcp.servers（真实非空路径 =
// CUA resolver 插件门）时，文件腿派生的 mcp 配置（含 W2 后将接入的 `.agents`
// 条目）被**整体替换**——`resolveAppRuntimeConfig` 的
// `options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers` 缝
// （bootstrap/src/app/runtime-config.ts:92-96）是 ?? 整替而非逐名合并。
// 今日该语义已成立 → 本测试今绿（契约钉）；W2 接入 `.agents` 文件腿后必须
// 保持绿（文件腿只 feeding configResult 一侧，不得反向泄入显式参数一侧）。

const fileLegServer = {
  type: "stdio",
  command: "node",
  args: ["file-leg-server.js"],
} as const;

const explicitServer = {
  type: "stdio",
  command: "npx",
  args: ["-y", "explicit-server"],
} as const;

function buildConfigResultWithFileLeg(fileServers: Record<string, unknown>): ConfigResult {
  return {
    config: {
      ...DefaultRuntimeConfig,
      mcp: { servers: fileServers },
    },
  } as unknown as ConfigResult;
}

function buildOptions(explicitServers: Record<string, unknown> | undefined): ZCodeAppOptions {
  return {
    env: {},
    ...(explicitServers ? { runtimeConfig: { mcp: { servers: explicitServers } } } : {}),
  } as unknown as ZCodeAppOptions;
}

const resolveInput = {
  cliStorageRoot: "/tmp/zcode-cli-storage",
  subagentOutputRootDir: "/tmp/zcode-subagents",
  workingDirectory: "/tmp/zcode-workspace",
};

test("params.mcpServers 契约钉：显式非空参数整体替换文件腿配置（今绿契约钉，W2 后保持绿）", () => {
  const resolved = resolveAppRuntimeConfig({
    ...resolveInput,
    configResult: buildConfigResultWithFileLeg({ "file-leg-server": fileLegServer }),
    options: buildOptions({ "explicit-server": explicitServer }),
  });

  assert.ok(resolved.configuredMcpServers["explicit-server"], "显式参数条目必须生效");
  assert.equal(
    resolved.configuredMcpServers["file-leg-server"],
    undefined,
    "显式非空 params.mcpServers 必须整替文件腿派生配置（非逐名合并，spec §5.1）",
  );
  assert.equal(
    resolved.runtimeConfig.mcp?.servers["file-leg-server"],
    undefined,
    "运行时 mcp.servers 同样不得残留文件腿条目",
  );
  assert.ok(
    resolved.runtimeConfig.mcp?.servers["explicit-server"],
    "运行时 mcp.servers 必须装载显式参数条目",
  );
});

test("params.mcpServers 契约钉（guard）：未携带显式参数时文件腿照常生效（今绿，W2 后保持绿）", () => {
  const resolved = resolveAppRuntimeConfig({
    ...resolveInput,
    configResult: buildConfigResultWithFileLeg({ "file-leg-server": fileLegServer }),
    options: buildOptions(undefined),
  });

  assert.ok(
    resolved.configuredMcpServers["file-leg-server"],
    "无显式参数时文件腿配置必须照常生效（?? 回落语义）",
  );
});
