import assert from "node:assert/strict";
import test from "node:test";
import {
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
