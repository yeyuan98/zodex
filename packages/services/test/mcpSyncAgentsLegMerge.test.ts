import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

// specs/agent-runtimes.md §5.4/§5.5(a)（alpha.1 desktop 三位点逐名合并）红测：
// mcpSyncService 的三个公开读缝今日都是文件级 fallback——同 scope `.zcode`
// 非空 → 整个 `.agents` 文件被遮蔽（readDirectoryServersFromPreferredSources/
// collectEffectiveUserMcpRecords）。W2 统一为共享纯函数 helper 逐名合并后转绿。
// 缝选择 = 公开行为面：loadMcpFromUserDirectory（设置页目录列表路径）、
// listLocalUserMcpCandidates / exportMcpServers（collectEffectiveUserMcpRecords）、
// importMcpServers（collectEffectiveUserMcpRecordByName 去重缝，§5.5(a) 互动①）。

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

test("mcpSync 三位点：loadMcpFromUserDirectory workspace 逐名合并——`.zcode` 非空时 `.agents` 独有名可见、同名 `.zcode` 胜出（今日红：文件级遮蔽）", async () => {
  const sandbox = await createSandbox("mcp-sync-ws-merge");
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

    const { servers } = await createMcpSyncService().loadMcpFromUserDirectory({
      workspacePath: sandbox.workspacePath,
    });
    const workspaceServers = servers.filter((server) => server.scope === "workspace");
    const byName = new Map(workspaceServers.map((server) => [server.name, server]));
    // 今日即绿的契约钉：`.zcode` 逐名胜出（今日因文件级遮蔽自然成立；W2 后必须因
    // 逐名合并语义保持成立，spec §5.4）。
    assert.equal(
      byName.get("shared-server")?.config.command,
      "node",
      "同 scope 同名条目 `.zcode` 腿必须胜出",
    );
    // 今日红：`.agents` 独有名被整个文件遮蔽。
    assert.ok(
      byName.get("agents-only-server"),
      "workspace `.zcode` 非空时 `.agents` 独有名仍必须在设置页目录列表可见（逐名合并）",
    );
    assert.equal(
      byName.get("agents-only-server")?.config.command,
      "npx",
      "`.agents` 独有条目配置必须原样读取",
    );
  } finally {
    await sandbox.restore();
  }
});

test("mcpSync 三位点：listLocalUserMcpCandidates user 逐名合并——`.zcode` 非空时 `.agents` 独有名可见（今日红：collectEffectiveUserMcpRecords 文件级遮蔽）", async () => {
  const sandbox = await createSandbox("mcp-sync-user-merge");
  try {
    await writeJson(join(sandbox.homePath, ".zcode", "cli", "config.json"), {
      mcp: { servers: { "shared-server": stdioServer("node", "zcode-leg") } },
    });
    await writeJson(join(sandbox.homePath, ".agents", "mcp.json"), {
      mcpServers: {
        "shared-server": stdioServer("npx", "agents-leg"),
        "user-agents-only": stdioServer("npx", "user-agents-only"),
      },
    });

    const { candidates } = await createMcpSyncService().listLocalUserMcpCandidates();
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    assert.equal(
      byName.get("shared-server")?.config.command,
      "node",
      "user 同名条目 `.zcode` 腿必须胜出（今日绿契约钉，W2 后保持绿）",
    );
    assert.equal(byName.get("shared-server")?.source, "zcode", "胜出条目 source 必须是 zcode 腿");
    // 今日红：user `.zcode` 非空 → `.agents` 文件整体被遮蔽。
    assert.ok(
      byName.get("user-agents-only"),
      "user `.zcode` 非空时 `.agents` 独有名仍必须是本地候选（逐名合并）",
    );
    assert.equal(
      byName.get("user-agents-only")?.source,
      "agents",
      "`.agents` 独有条目 source 必须保留 agents 溯源",
    );
  } finally {
    await sandbox.restore();
  }
});

test("mcpSync 三位点：exportMcpServers 可导出 `.agents` 独有条目（今日红：候选缝文件级遮蔽）", async () => {
  const sandbox = await createSandbox("mcp-sync-export");
  try {
    await writeJson(join(sandbox.homePath, ".zcode", "cli", "config.json"), {
      mcp: { servers: { "zcode-user-server": stdioServer("node", "zcode") } },
    });
    await writeJson(join(sandbox.homePath, ".agents", "mcp.json"), {
      mcpServers: { "agents-export-server": stdioServer("npx", "agents") },
    });

    const { candidates } = await createMcpSyncService().listLocalUserMcpCandidates();
    const agentsCandidate = candidates.find(
      (candidate) => candidate.name === "agents-export-server",
    );
    assert.ok(agentsCandidate, "前置：`.agents` 独有条目必须出现在本地候选列表（今日红在此断言）");

    const exported = await createMcpSyncService().exportMcpServers({
      serverIds: [agentsCandidate.id],
    });
    assert.equal(exported.servers[0]?.name, "agents-export-server");
    assert.equal(exported.servers[0]?.source, "agents");
  } finally {
    await sandbox.restore();
  }
});

test("mcpSync import 去重缝：user `.agents` 条目在 user `.zcode` 非空时仍去重可见（§5.5(a) 互动①；今日红：被遮蔽 → 误 synced）", async () => {
  const sandbox = await createSandbox("mcp-sync-import");
  try {
    await writeJson(join(sandbox.homePath, ".zcode", "cli", "config.json"), {
      mcp: { servers: { "zcode-user-server": stdioServer("node", "zcode") } },
    });
    const agentsMcpPath = join(sandbox.homePath, ".agents", "mcp.json");
    await writeJson(agentsMcpPath, {
      mcpServers: { "agents-existing-server": stdioServer("npx", "agents") },
    });

    const result = await createMcpSyncService().importMcpServers({
      overwrite: false,
      localHomeDir: sandbox.homePath,
      servers: [
        {
          id: "import-agents-existing",
          name: "agents-existing-server",
          config: stdioServer("npx", "agents"),
          enabled: true,
          source: "agents",
          path: agentsMcpPath,
        },
      ],
    });
    assert.equal(result.results.length, 1, "前置：必须返回一条导入结果");
    assert.equal(
      result.results[0]?.status,
      "skipped",
      "与 user `.agents` 条目同名的导入必须 skipped（合并后去重缝对其可见，spec §5.5(a)）",
    );
    assert.equal(
      result.results[0]?.path,
      agentsMcpPath,
      "skipped 结果必须指回 `.agents` 源文件路径",
    );
  } finally {
    await sandbox.restore();
  }
});
