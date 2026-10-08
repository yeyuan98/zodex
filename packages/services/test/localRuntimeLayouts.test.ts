import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRuntimeArchive,
  mapArchiveMemberToTargetPath,
  resolveExtractionTool,
} from "../src/runtime-tools/local-runtime/layouts.js";

// specs/agent-runtimes.md §4.3（解压归一化布局矩阵）红测：W1 先红（layouts.ts 为
// 零行为桩），W5 实现后转绿。
//
// 布局矩阵：node win `.zip` 与 unix `.tar.xz` 均含 `node-v<ver>-<os>-<arch>/`
// 顶层需剥离后落 `v<ver>/`；uv win `.zip` 平铺、unix `uv-<triple>/` 顶层剥离；
// Windows 用系统自带 tar.exe（bsdtar）解 `.zip`/`.tar.xz`。

test("布局矩阵：node unix tar 成员剥离 node-v<ver>-<os>-<arch>/ 顶层（红：桩恒 null）", () => {
  assert.equal(
    mapArchiveMemberToTargetPath({
      kind: "node-unix-tar",
      memberPath: "node-v22.14.0-linux-x64/bin/node",
      topLevelDir: "node-v22.14.0-linux-x64",
    }),
    "bin/node",
    "unix tarball 顶层目录剥离后落 v<ver>/ 内相对路径",
  );
  assert.equal(
    mapArchiveMemberToTargetPath({
      kind: "node-unix-tar",
      memberPath: "node-v22.14.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js",
      topLevelDir: "node-v22.14.0-linux-x64",
    }),
    "lib/node_modules/npm/bin/npm-cli.js",
    "深层成员同样剥离顶层",
  );
});

test("布局矩阵：node win zip 成员剥离顶层目录（node.exe 落 v<ver>/ 平铺）", () => {
  assert.equal(
    mapArchiveMemberToTargetPath({
      kind: "node-win-zip",
      memberPath: "node-v22.14.0-win-x64/node.exe",
      topLevelDir: "node-v22.14.0-win-x64",
    }),
    "node.exe",
    "win zip 顶层目录剥离，可执行平铺进版本目录",
  );
});

test("布局矩阵：uv unix tar 成员剥离 uv-<triple>/ 顶层", () => {
  assert.equal(
    mapArchiveMemberToTargetPath({
      kind: "uv-unix-tar",
      memberPath: "uv-x86_64-unknown-linux-gnu/uv",
      topLevelDir: "uv-x86_64-unknown-linux-gnu",
    }),
    "uv",
    "uv unix tarball 剥离 uv-<triple>/ 顶层（uvx 与 uv 同目录）",
  );
});

test("布局矩阵：uv win zip 平铺（无顶层剥离）", () => {
  assert.equal(
    mapArchiveMemberToTargetPath({
      kind: "uv-win-zip",
      memberPath: "uv.exe",
      topLevelDir: "",
    }),
    "uv.exe",
    "uv win zip 成员平铺，原样落位",
  );
});

test("布局矩阵：不在预期顶层目录下的成员 → null（跳过，不落位）", () => {
  assert.equal(
    mapArchiveMemberToTargetPath({
      kind: "node-unix-tar",
      memberPath: "other-dir/bin/node",
      topLevelDir: "node-v22.14.0-linux-x64",
    }),
    null,
    "成员不在预期顶层目录下 = 跳过（防错位落盘）",
  );
});

test("解压工具选择：win 平台 .zip 与 .tar.xz 均 = tar.exe（bsdtar 兼容）（红：桩空串）", () => {
  assert.equal(
    resolveExtractionTool("node-v22.14.0-win-x64.zip", "win32"),
    "tar.exe",
    "win 用系统自带 tar.exe 解 .zip",
  );
  assert.equal(
    resolveExtractionTool("node-v22.14.0-win-x64.tar.xz", "win32"),
    "tar.exe",
    "win 用系统自带 tar.exe 解 .tar.xz（Win10+ bsdtar）",
  );
});

test("解压工具选择：unix 平台 .tar.xz = tar", () => {
  assert.equal(
    resolveExtractionTool("node-v22.14.0-linux-x64.tar.xz", "linux"),
    "tar",
    "unix 解 .tar.xz 用 tar",
  );
});

// [ulw] MINOR-5 红测：解压执行器必须先 `tar -tf` 全量列表 + 逐成员穿越校验
// （`..` 段/绝对路径/意外顶层形状 = 拒绝整个归档），通过后才 `-xf`——
// mapArchiveMemberToTargetPath 不再是死代码，安全不单独依赖 sha256+tar 默认。

interface ToolCall {
  readonly op: string;
  readonly args: readonly string[];
}

function fakeRunTool(listing: string) {
  const calls: ToolCall[] = [];
  const runTool = async (
    _command: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ op: args[0] ?? "", args });
    if (args[0] === "-tf") {
      return { stdout: listing, stderr: "" };
    }
    if (args[0] === "-xf") {
      // 模拟解压落盘：向 -C 目录写一个条目（保证「非空」检查通过、rename 可行）。
      const targetDirIndex = args.indexOf("-C");
      const extractDir = args[targetDirIndex + 1] ?? "";
      await mkdir(extractDir, { recursive: true });
      await writeFile(join(extractDir, "node"), "fake-binary");
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, runTool };
}

test("MINOR-5：恶意 `../` 成员 → 列表校验拒绝，不执行实际解压", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-layout-traversal-"));
  try {
    const { calls, runTool } = fakeRunTool(
      "node-v22.14.0-linux-x64/bin/node\n../evil.sh\nnode-v22.14.0-linux-x64/bin/npm\n",
    );
    await assert.rejects(
      extractRuntimeArchive({
        archivePath: join(base, "fake.tar.xz"),
        targetDir: join(base, "v22.14.0"),
        kind: "node-unix-tar",
        topLevelDir: "node-v22.14.0-linux-x64",
        stripComponents: 1,
        platform: "linux",
        runTool,
      }),
      /evil\.sh|layout contract/u,
      "含 `../` 成员的归档必须整体拒绝",
    );
    assert.equal(
      calls.filter((call) => call.op === "-xf").length,
      0,
      "校验失败后不得执行实际解压（-xf）",
    );
    assert.ok(
      calls.some((call) => call.op === "-tf"),
      "解压前必须先 `tar -tf` 列表校验",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("MINOR-5：绝对路径成员 → 同样拒绝（布局契约）", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-layout-absolute-"));
  try {
    const { calls, runTool } = fakeRunTool("node-v22.14.0-linux-x64/bin/node\n/etc/passwd\n");
    await assert.rejects(
      extractRuntimeArchive({
        archivePath: join(base, "fake.tar.xz"),
        targetDir: join(base, "v22.14.0"),
        kind: "node-unix-tar",
        topLevelDir: "node-v22.14.0-linux-x64",
        stripComponents: 1,
        platform: "linux",
        runTool,
      }),
      /etc\/pass|layout contract/u,
      "绝对路径成员 = 意外形状，整体拒绝",
    );
    assert.equal(calls.filter((call) => call.op === "-xf").length, 0, "不执行解压");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("MINOR-5：合法列表（含顶层目录条目）→ 校验通过并执行解压", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-layout-legit-"));
  try {
    const { calls, runTool } = fakeRunTool(
      "node-v22.14.0-linux-x64/\nnode-v22.14.0-linux-x64/bin/\nnode-v22.14.0-linux-x64/bin/node\n",
    );
    await extractRuntimeArchive({
      archivePath: join(base, "fake.tar.xz"),
      targetDir: join(base, "v22.14.0"),
      kind: "node-unix-tar",
      topLevelDir: "node-v22.14.0-linux-x64",
      stripComponents: 1,
      platform: "linux",
      runTool,
    });
    assert.ok(
      calls.some((call) => call.op === "-tf") && calls.some((call) => call.op === "-xf"),
      "先列表校验后解压",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
