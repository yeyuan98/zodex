import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig, NativeMcpServerRecord, ZCodeMcpServer } from "@zcode/shared";
import { useMcpStore } from "../src/store/mcpStore.ts";
import { makeServerId } from "../src/store/mcpStoreHelpers.ts";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.ts";

// 红测依据 = specs/draft-session-invalidation.md 变更源表 MCP 行（3.15.0-alpha.2 R1）：
// mcpStore 四写 action（add/update/delete/toggle）改变 agent 可用的 MCP 能力集，
// 必须经共享缝失效 pending draft session——唯一失效货币 =
// draftRuntimeInvalidationVersion（zcodeSessionStoreTypes.ts:166）。今日（W2 前）
// 四写 action 只落盘 + 改本地列表，零失效 ⇒ 下列 bump 断言全红；W2 在 store 层缝
// 接入 invalidateDeferredDraftSessionForRuntimeChange 后转绿。
//
// 测试环境说明：setMcpStorePlatform/setMcpStoreDirectoryService 模块默认即 null，
// persistScopedChange 的磁盘写入失败被 warn 吞掉（mcpStoreDesktop.ts
// persistCliMcpToUserDirectory：platform 缺失 → warn + return false，不 throw），
// 因此写 action 在无平台服务的 node --test 下仍完整走完，断言只盯版本号。
//
// 版本读取：getWorkspaceState 对未建桶 workspace 返回稳定默认态（版本 0，不落桶）；
// invalidateDraftRuntime 首次 bump 会经 updateWorkspaceState 落桶，before/after 对比
// 与桶是否已存在无关。每个用例前重置两个 store，避免用例间串台。

const WORKSPACE_PATH = "/tmp/zcode-mcp-draft-invalidation-ws";
const SERVER_NAME = "n1";
const MINIMAL_CONFIG: McpServerConfig = { type: "stdio", command: "echo", args: [] };

function seedNativeServer(name: string): NativeMcpServerRecord {
  return {
    source: "zcodeagentmcp",
    scope: "user",
    name,
    config: MINIMAL_CONFIG,
    enabled: true,
  };
}

function seedServerEntry(name: string): ZCodeMcpServer {
  return {
    id: makeServerId("zcodeagentmcp", name),
    name,
    config: MINIMAL_CONFIG,
    enabled: true,
    source: "zcodeagentmcp",
    scope: "user",
  };
}

function resetStores(): void {
  useMcpStore.setState({
    currentProjectPath: WORKSPACE_PATH,
    currentWorkspaceIdentity: undefined,
    nativeServers: [],
    servers: [],
    enabledStates: {},
  });
  useZCodeSessionStore.setState({ workspaces: {} });
}

function readInvalidationVersion(): number {
  return useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH, undefined)
    .draftRuntimeInvalidationVersion;
}

test("addScopedMcpServer 后 draftRuntimeInvalidationVersion +1（红：MCP 变更未失效草稿）", async () => {
  resetStores();
  const before = readInvalidationVersion();
  await useMcpStore
    .getState()
    .addScopedMcpServer("zcodeagentmcp", SERVER_NAME, MINIMAL_CONFIG, undefined);
  assert.equal(
    readInvalidationVersion(),
    before + 1,
    "新增 MCP server 改变 agent 能力集，必须 bump draftRuntimeInvalidationVersion",
  );
});

test("updateScopedMcpServer 后 draftRuntimeInvalidationVersion +1（红：MCP 变更未失效草稿）", async () => {
  resetStores();
  // 预置既有记录，构造「设置页保存既有 server」的真实前置（updateNativeServer upsert 腿）。
  useMcpStore.setState({ nativeServers: [seedNativeServer(SERVER_NAME)] });
  const before = readInvalidationVersion();
  await useMcpStore
    .getState()
    .updateScopedMcpServer("zcodeagentmcp", SERVER_NAME, MINIMAL_CONFIG, undefined);
  assert.equal(
    readInvalidationVersion(),
    before + 1,
    "保存既有 MCP server 配置改变 agent 能力集，必须 bump draftRuntimeInvalidationVersion",
  );
});

test("deleteScopedMcpServer 后 draftRuntimeInvalidationVersion +1（红：MCP 变更未失效草稿）", () => {
  resetStores();
  useMcpStore.setState({ nativeServers: [seedNativeServer(SERVER_NAME)] });
  const before = readInvalidationVersion();
  useMcpStore.getState().deleteScopedMcpServer("zcodeagentmcp", SERVER_NAME, undefined);
  assert.equal(
    readInvalidationVersion(),
    before + 1,
    "删除 MCP server 改变 agent 能力集，必须 bump draftRuntimeInvalidationVersion",
  );
});

test("toggleServer 后 draftRuntimeInvalidationVersion +1（红：MCP 变更未失效草稿）", async () => {
  resetStores();
  // 预置 servers 列表 + enabledStates，让 toggleServer 找到目标 server（:434-456 读取 servers）。
  const entry = seedServerEntry(SERVER_NAME);
  useMcpStore.setState({ servers: [entry], enabledStates: { [entry.id]: true } });
  const before = readInvalidationVersion();
  await useMcpStore.getState().toggleServer(entry.id, false);
  assert.equal(
    readInvalidationVersion(),
    before + 1,
    "关闭 MCP server 改变 agent 能力集，必须 bump draftRuntimeInvalidationVersion",
  );
});

test("guard：无能力变更的 updateServerStatus 不 bump draftRuntimeInvalidationVersion", () => {
  // 守卫（不变量反向）：updateServerStatus 只改健康状态投影、不改能力集，
  // 不得触发失效——今日绿，W2 落地后必须保持绿（否则失效缝被过度接线）。
  resetStores();
  const entry = seedServerEntry(SERVER_NAME);
  useMcpStore.setState({ servers: [entry], enabledStates: { [entry.id]: true } });
  const before = readInvalidationVersion();
  useMcpStore
    .getState()
    .updateServerStatus(entry.id, "unknown", undefined, { invalidateStatusListRequests: false });
  assert.equal(
    readInvalidationVersion(),
    before,
    "状态投影更新不属于运行时能力变更，不得 bump draftRuntimeInvalidationVersion",
  );
});
