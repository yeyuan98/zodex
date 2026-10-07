import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { McpServerConfig } from "@zcode/shared";
import { logger } from "../src/logger.ts";
import { invalidateDeferredDraftSessionForRuntimeChange } from "../src/lib/zcodeDraftSkillInvalidation.ts";
import { useMcpStore } from "../src/store/mcpStore.ts";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.ts";

// specs/agent-runtimes.md §7.1（rider A）红测：draft-session-invalidation.md §6 披露的
// 观测缺口——ui logger 生产构建对普通 logger.* 全级 no-op，仅 logger.lifecycle.* 经
// 桌面桥落盘。三缝（mcpStore.ts:264 info、zcodeDraftSkillInvalidation.ts:39 info、
// :46 warn）今天走普通通道 ⇒ 生产不可见；W4 切到 logger.lifecycle.* 后转绿。
//
// scope widening 披露（spec §7.1 接受）：缝 2/3 位于共享 helper，切换后 skills-scope
// 调用方的同类行同样变为生产持久化——有意接受。
//
// 驱动方式 = node:test mock.method 替换 logger.lifecycle 上的方法（logger 为模块单例
// 对象，TS loader 对 "@/logger.js" 与本文件的 "../src/logger.ts" 解析到同一实例），
// 断言后 restore。断言只盯 lifecycle 通道是否收到行——不改任何生产行为。

const WORKSPACE_PATH = "/tmp/zcode-lifecycle-draft-ws";
const MINIMAL_CONFIG: McpServerConfig = { type: "stdio", command: "echo", args: [] };

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

function lifecycleMessages(spy: ReturnType<typeof mock.method>): string[] {
  return spy.mock.calls
    .map((call) => call.arguments[0])
    .filter((value): value is string => typeof value === "string");
}

test("rider A：helper 成功腿的 invalidation 行走 logger.lifecycle.info（今日红：走 logger.info 生产 no-op）", async () => {
  resetStores();
  // legacy v3 草稿形态：draftSessionId 非空才会进入 closeSession 成功后的 info 行（:39）。
  useZCodeSessionStore.getState().setDraftSessionId(WORKSPACE_PATH, "draft-lifecycle-1");
  const spy = mock.method(logger.lifecycle, "info");
  try {
    await invalidateDeferredDraftSessionForRuntimeChange({
      logScope: "mcpStore",
      reason: "settings-mcp-import",
      workspacePath: WORKSPACE_PATH,
      zcodeSessionService: {
        closeSession: async () => undefined,
      } as unknown as Parameters<
        typeof invalidateDeferredDraftSessionForRuntimeChange
      >[0]["zcodeSessionService"],
    });
    const messages = lifecycleMessages(spy);
    assert.ok(
      messages.some((message) => message.includes("[mcpStore]")),
      `lifecycle.info 必须收到带 [mcpStore] 前缀的 invalidation 行（spec §7.1；实际收到：${JSON.stringify(messages)}）`,
    );
  } finally {
    spy.mock.restore();
  }
});

test("rider A：helper 失败腿的 close 失败行走 logger.lifecycle.warn（今日红：走 logger.warn 生产 no-op）", async () => {
  resetStores();
  useZCodeSessionStore.getState().setDraftSessionId(WORKSPACE_PATH, "draft-lifecycle-2");
  const spy = mock.method(logger.lifecycle, "warn");
  try {
    await invalidateDeferredDraftSessionForRuntimeChange({
      logScope: "mcpStore",
      reason: "settings-mcp-import",
      workspacePath: WORKSPACE_PATH,
      zcodeSessionService: {
        closeSession: async () => {
          throw new Error("close rejected (test)");
        },
      } as unknown as Parameters<
        typeof invalidateDeferredDraftSessionForRuntimeChange
      >[0]["zcodeSessionService"],
    });
    const messages = lifecycleMessages(spy);
    assert.ok(
      messages.some((message) => message.includes("[mcpStore]")),
      `lifecycle.warn 必须收到带 [mcpStore] 前缀的 close 失败行（zcodeDraftSkillInvalidation.ts:46；实际收到：${JSON.stringify(messages)}）`,
    );
  } finally {
    spy.mock.restore();
  }
});

test("rider A：MCP 设置写 action 的 invalidation 行走 logger.lifecycle.info（今日红：mcpStore.ts:264 走 logger.info）", async () => {
  resetStores();
  const spy = mock.method(logger.lifecycle, "info");
  try {
    await useMcpStore
      .getState()
      .addScopedMcpServer("zcodeagentmcp", "lifecycle-probe", MINIMAL_CONFIG, undefined);
    const messages = lifecycleMessages(spy);
    assert.ok(
      messages.some((message) =>
        message.includes("[mcpStore] draft runtime invalidated after MCP settings change"),
      ),
      `lifecycle.info 必须收到 "[mcpStore] draft runtime invalidated" 判据行（rig D1 判据生产可达性；实际收到：${JSON.stringify(messages)}）`,
    );
  } finally {
    spy.mock.restore();
  }
});
