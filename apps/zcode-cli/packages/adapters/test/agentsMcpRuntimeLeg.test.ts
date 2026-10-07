import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggerFactory } from "@zcode/contracts";
import { createConfig } from "../src/config/config-factory.ts";

// specs/agent-runtimes.md §5.1-§5.3（alpha.1 `.agents` 运行时腿）红测：
// CLI 运行时今日从不读 `.agents/mcp.json`（workspace 发现候选硬编码 zcode.json/
// .zcode/config.json，user 默认 ~/.zcode/cli——handoff §2m 根因）。
// 以下断言全部在 createConfig 公共缝上表达 W2 目标语义（四源逐名合并 + 全序 +
// strict 逐 server 丢警告），今日 assertion-red；W2 转绿后保持绿。
// 唯一例外 = hook digest 契约钉测（§5.3）：今绿，钉住 `.agents` 永不进入
// hook 发现链（否则信任记录失效），W2 后必须保持绿。
//
// 隔离：HOME/USERPROFILE 重定向到临时目录（防真实 ~/.zcode 与 ~/.agents 泄入），
// env 传 {}（防 ZCODE_* 环境变量干扰），loggerFactory 传 no-op（防诊断写盘）。

const noopLoggerFactory: LoggerFactory = {
  createLogger: () =>
    ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () =>
        ({
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () =>
            ({
              debug: () => {},
              info: () => {},
              warn: () => {},
              error: () => {},
              child: function child() {
                return child();
              },
            }) as never,
        }) as never,
    }) as never,
  withContext: () => ({}) as never,
  setLevel: () => {},
};

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

function loadConfig(sandbox: Sandbox) {
  return createConfig({
    workingDirectory: sandbox.workspacePath,
    env: {},
    loggerFactory: noopLoggerFactory,
  });
}

test("alpha.1 loader 腿：`.agents` workspace 条目进入运行时配置（今日红：CLI 从不读 `.agents/mcp.json`）", async () => {
  const sandbox = await createSandbox("agents-mcp-leg");
  try {
    await writeJson(join(sandbox.workspacePath, ".agents", "mcp.json"), {
      mcpServers: {
        "agents-only-server": {
          type: "stdio",
          command: "npx",
          args: ["-y", "agents-server"],
        },
      },
    });

    const result = loadConfig(sandbox);
    const server = result.config.mcp.servers["agents-only-server"];
    assert.ok(server, "`.agents/mcp.json` 独有条目必须进入 config.mcp.servers（spec §5.1 四源）");
    assert.equal(server.command, "npx", "`.agents` 条目字段必须原样装载");
    assert.equal(
      result.sources.mcp.serverSources["agents-only-server"],
      "project",
      "workspace `.agents` 条目来源 scope 必须是 project（§5.1 全序最底层）",
    );
  } finally {
    await sandbox.restore();
  }
});

test("alpha.1 loader 腿：同名双文件 `.zcode` 逐名胜出 + `.agents` 独有名共存（今日红：`.agents` 独有名缺席）", async () => {
  const sandbox = await createSandbox("agents-mcp-merge");
  try {
    await writeJson(join(sandbox.workspacePath, ".zcode", "config.json"), {
      mcp: {
        servers: {
          "shared-server": { type: "stdio", command: "node", args: ["zcode-leg.js"] },
          "zcode-only-server": { type: "stdio", command: "node", args: ["zcode-only.js"] },
        },
      },
    });
    await writeJson(join(sandbox.workspacePath, ".agents", "mcp.json"), {
      mcpServers: {
        "shared-server": { type: "stdio", command: "npx", args: ["agents-leg"] },
        "agents-only-server": { type: "stdio", command: "npx", args: ["agents-only"] },
      },
    });

    const servers = loadConfig(sandbox).config.mcp.servers;
    // 以下两条今日即绿（`.agents` 被忽略时 `.zcode` 自然胜出）——契约钉，W2 后必须
    // 因「逐名合并」这条新理由保持绿（merge-not-fallback，spec §5.1）。
    assert.equal(
      servers["shared-server"]?.command,
      "node",
      "同 scope 同名条目 `.zcode` 腿必须胜出",
    );
    assert.ok(servers["zcode-only-server"], "`.zcode` 独有条目必须保留");
    // 今日红：文件级忽略使 `.agents` 独有名缺席。
    assert.ok(
      servers["agents-only-server"],
      "同 scope `.zcode` 非空时 `.agents` 独有名仍必须共存（逐名合并而非文件级 fallback）",
    );
  } finally {
    await sandbox.restore();
  }
});

test("alpha.1 loader 腿：user 级 `~/.agents/mcp.json` 生效（今日红：user 默认只读 `~/.zcode/cli`）", async () => {
  const sandbox = await createSandbox("agents-mcp-user");
  try {
    await writeJson(join(sandbox.homePath, ".agents", "mcp.json"), {
      mcpServers: {
        "user-agents-server": { type: "stdio", command: "npx", args: ["user-agents"] },
      },
    });

    const result = loadConfig(sandbox);
    const server = result.config.mcp.servers["user-agents-server"];
    assert.ok(server, "user 级 `~/.agents/mcp.json` 条目必须进入运行时配置（spec §5.1 四源）");
    assert.equal(
      result.sources.mcp.serverSources["user-agents-server"],
      "user",
      "user `.agents` 条目来源 scope 必须是 user",
    );
  } finally {
    await sandbox.restore();
  }
});

test("alpha.1 loader 腿：user `.agents` 同名遮蔽 project `.zcode`（全序：user .agents < user .zcode 但 > project .zcode）（今日红：project 胜出）", async () => {
  const sandbox = await createSandbox("agents-mcp-order");
  try {
    await writeJson(join(sandbox.workspacePath, ".zcode", "config.json"), {
      mcp: {
        servers: {
          "shared-server": { type: "stdio", command: "node", args: ["project-zcode"] },
        },
      },
    });
    await writeJson(join(sandbox.homePath, ".agents", "mcp.json"), {
      mcpServers: {
        "shared-server": { type: "stdio", command: "npx", args: ["user-agents"] },
      },
    });

    const result = loadConfig(sandbox);
    assert.equal(
      result.config.mcp.servers["shared-server"]?.args?.[0],
      "user-agents",
      "user `.agents` 同名条目必须遮蔽 project `.zcode` 条目（spec §5.1 全序）",
    );
    assert.equal(
      result.sources.mcp.serverSources["shared-server"],
      "user",
      "胜出条目来源必须是 user（沿既有 user-shadows-project）",
    );
  } finally {
    await sandbox.restore();
  }
});

test("alpha.1 loader 腿：坏 `.agents` 条目（isolation 未知键）逐 server 丢警告，其余条目照常（今日红：整文件被忽略、无任何诊断）", async () => {
  const sandbox = await createSandbox("agents-mcp-strict");
  try {
    const agentsMcpPath = join(sandbox.workspacePath, ".agents", "mcp.json");
    await writeJson(agentsMcpPath, {
      mcpServers: {
        // alpha.0 S2 曾教写的 isolation 键：两条文件腿 strict schema 均不接受（§5.2）。
        "agents-bad-isolation": {
          type: "stdio",
          command: "npx",
          isolation: "session",
        },
        "agents-good-server": { type: "stdio", command: "npx", args: ["good"] },
      },
    });

    const result = loadConfig(sandbox);
    assert.equal(
      result.config.mcp.servers["agents-bad-isolation"],
      undefined,
      "schema-invalid `.agents` 条目必须按既有 per-server invalid 机制丢弃（spec §5.2）",
    );
    assert.ok(
      result.config.mcp.servers["agents-good-server"],
      "同文件其余合法条目必须照常装载（逐 server 丢弃，不整文件拒绝）",
    );
    const invalid = result.sources.project.diagnostics.filter(
      (diagnostic) => diagnostic.code === "config_mcp_server_invalid",
    );
    assert.equal(invalid.length, 1, "必须恰好产生一条 per-server invalid warning 诊断");
    assert.ok(
      invalid[0]?.path?.includes("agents-bad-isolation"),
      "诊断 path 必须点名被丢弃的 server（loud 而非静默）",
    );
    assert.equal(
      invalid[0]?.filePath,
      agentsMcpPath,
      "诊断必须归属 `.agents/mcp.json` 文件（filePath 指向源文件）",
    );
  } finally {
    await sandbox.restore();
  }
});

test("alpha.1 loader 腿：`.agents` 条目 pathPrepend 保留进入运行时 spawn 配置（今日红：条目缺席）", async () => {
  const sandbox = await createSandbox("agents-mcp-prepend");
  try {
    await writeJson(join(sandbox.workspacePath, ".agents", "mcp.json"), {
      mcpServers: {
        "agents-runtime-server": {
          type: "stdio",
          command: "npx",
          args: ["-y", "server"],
          pathPrepend: ["/opt/rt/bin"],
        },
      },
    });

    const server = loadConfig(sandbox).config.mcp.servers["agents-runtime-server"];
    assert.ok(server, "前置：`.agents` 条目必须装载");
    assert.deepEqual(
      server?.pathPrepend,
      ["/opt/rt/bin"],
      "`.agents` 条目的 pathPrepend 必须原样进入运行时配置（C1 spawn 漏斗唯一输入；spec §5.1 + §2.5 L5）",
    );
  } finally {
    await sandbox.restore();
  }
});

test("alpha.1 loader 腿：`.agents` 条目 enabled:false 装载保留（运行时跳过沿既有语义）（今日红：条目缺席）", async () => {
  const sandbox = await createSandbox("agents-mcp-disabled");
  try {
    await writeJson(join(sandbox.workspacePath, ".agents", "mcp.json"), {
      mcpServers: {
        "agents-disabled-server": { type: "stdio", command: "npx", enabled: false },
      },
    });

    const server = loadConfig(sandbox).config.mcp.servers["agents-disabled-server"];
    assert.ok(server, "`.agents` 条目必须装载保留（enabled:false 不在装载层丢弃）");
    assert.equal(
      server?.enabled,
      false,
      "enabled:false 必须原样保留（运行时不 spawn 由既有 mcp/pool 语义承担，spec §5.1）",
    );
  } finally {
    await sandbox.restore();
  }
});

test("alpha.1 hook 接缝钉测：加/删 `.agents/mcp.json` 前后 hook bundleDigest 不变（§5.3 契约钉，今绿须保持绿）", async () => {
  const sandbox = await createSandbox("agents-mcp-digest");
  try {
    // hooks 声明使 workspaceHookSnapshot 真实存在（无 hooks 时 snapshot 为 undefined，
    // digest 比较会退化为平凡通过）。
    await writeJson(join(sandbox.workspacePath, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "echo hook-alive" }],
            },
          ],
        },
      },
    });

    const before = loadConfig(sandbox);
    const snapshotBefore = before.sources.project.workspaceHookSnapshot;
    assert.ok(snapshotBefore, "前置：hooks 声明必须产出 workspaceHookSnapshot");

    const agentsMcpPath = join(sandbox.workspacePath, ".agents", "mcp.json");
    await writeJson(agentsMcpPath, {
      mcpServers: {
        "agents-digest-server": { type: "stdio", command: "npx" },
      },
    });

    const after = loadConfig(sandbox);
    assert.equal(
      after.sources.project.workspaceHookSnapshot?.bundleDigest,
      snapshotBefore?.bundleDigest,
      "加 `.agents/mcp.json` 不得改变 hook bundleDigest（`.agents` 发现 = MCP 专用平行发现，spec §5.3）",
    );
    assert.deepEqual(
      after.sources.project.paths,
      before.sources.project.paths,
      "`.agents/mcp.json` 不得进入 project 配置路径列表（hookCandidates 同源）",
    );
    assert.equal(
      after.sources.project.paths.includes(agentsMcpPath),
      false,
      "project paths 必须不含 `.agents/mcp.json`（进入即信任记录失效）",
    );
  } finally {
    await sandbox.restore();
  }
});
