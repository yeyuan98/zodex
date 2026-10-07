import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliMcpFromUserDirectory } from "../src/main/mcpUserDirectory/index.js";

// specs/agent-runtimes.md §5.4（alpha.1 desktop 三位点之 desktop main 孪生）红测：
// desktop main 的 mcpUserDirectory.readDirectoryServersFromPreferredSources 今日
// 与 services 侧同为文件级 fallback（同 scope `.zcode` 非空 → 整个 `.agents`
// 文件遮蔽，index.ts:334-348）。W2 与 services 侧统一为共享纯函数 helper 逐名
// 合并后转绿（禁止孪生再分叉——本 bug 类成因，[ulw] m3）。

interface Sandbox {
  workspacePath: string;
  homePath: string;
  restore(): Promise<void>;
}

async function createSandbox(prefix: string): Promise<Sandbox> {
  const homePath = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
  const workspacePath = await mkdtemp(join(tmpdir(), `${prefix}-ws-`));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homePath;
  process.env.USERPROFILE = homePath;
  return {
    homePath,
    workspacePath,
    async restore() {
      process.env.HOME = previousHome;
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      await rm(homePath, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const stdioServer = (command: string, marker: string) => ({
  type: "stdio",
  command,
  args: [marker],
});

test("mcpUserDirectory 孪生：workspace 双文件逐名合并——`.zcode` 非空时 `.agents` 独有名可见、同名 `.zcode` 胜出（今日红：文件级遮蔽）", async () => {
  const sandbox = await createSandbox("mcp-dir-ws");
  try {
    await writeJson(join(sandbox.workspacePath, ".zcode", "config.json"), {
      mcp: { servers: { "shared-server": stdioServer("node", "zcode-leg") } },
    });
    await writeJson(join(sandbox.workspacePath, ".agents", "mcp.json"), {
      mcpServers: {
        "shared-server": stdioServer("npx", "agents-leg"),
        "agents-only-server": stdioServer("npx", "agents-only"),
      },
    });

    const { servers } = await loadCliMcpFromUserDirectory({
      workspacePath: sandbox.workspacePath,
    });
    const workspaceServers = servers.filter((server) => server.scope === "workspace");
    const byName = new Map(workspaceServers.map((server) => [server.name, server]));
    // 今日即绿的契约钉：`.zcode` 逐名胜出；W2 后必须因逐名合并保持（spec §5.4）。
    assert.equal(
      byName.get("shared-server")?.config.command,
      "node",
      "同 scope 同名条目 `.zcode` 腿必须胜出",
    );
    // 今日红：`.agents` 独有名被整个文件遮蔽。
    assert.ok(
      byName.get("agents-only-server"),
      "workspace `.zcode` 非空时 `.agents` 独有名仍必须可见（desktop main 孪生与服务侧同语义）",
    );
  } finally {
    await sandbox.restore();
  }
});

test("mcpUserDirectory 孪生：user 级双文件逐名合并——`.zcode` 非空时 `.agents` 独有名可见（今日红：文件级遮蔽）", async () => {
  const sandbox = await createSandbox("mcp-dir-user");
  try {
    await writeJson(join(sandbox.homePath, ".zcode", "cli", "config.json"), {
      mcp: { servers: { "zcode-user-server": stdioServer("node", "zcode-user") } },
    });
    await writeJson(join(sandbox.homePath, ".agents", "mcp.json"), {
      mcpServers: { "user-agents-only": stdioServer("npx", "user-agents") },
    });

    const { servers } = await loadCliMcpFromUserDirectory();
    const userServers = servers.filter((server) => server.scope === "user");
    const byName = new Map(userServers.map((server) => [server.name, server]));
    assert.ok(byName.get("zcode-user-server"), "前置：user `.zcode` 条目照常读取");
    // 今日红：user `.zcode` 非空 → `.agents` 文件整体被遮蔽。
    assert.ok(
      byName.get("user-agents-only"),
      "user `.zcode` 非空时 `.agents` 独有名仍必须可见（spec §5.4 逐名合并）",
    );
  } finally {
    await sandbox.restore();
  }
});
