import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planVersionDirGc,
  readCurrentPointer,
  writeCurrentPointer,
} from "../src/runtime-tools/local-runtime/current.js";

// specs/agent-runtimes.md §4.3（CURRENT 原子指针）/§4.6（GC 重试归属）红测：
// W1 先红（current.ts 为零行为桩），W5 实现后转绿。
// 使用真实临时目录（hermetic fs）：tmp+rename 原子换指针（读者无半写）+
// GC 决策纯函数（含 Windows 文件锁模拟 → 保留 + 标记重试）。

interface Sandbox {
  nodeDir: string;
  dispose: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "zcode-local-runtime-current-"));
  const nodeDir = join(base, "node");
  await mkdir(nodeDir, { recursive: true });
  return { nodeDir, dispose: () => rm(base, { recursive: true, force: true }) };
}

test("CURRENT 原子写：write 后文件存在且内容 = 版本目录名（红：桩 no-op）", async () => {
  const sandbox = await makeSandbox();
  try {
    writeCurrentPointer(sandbox.nodeDir, "v22.14.0");
    assert.equal(
      existsSync(join(sandbox.nodeDir, "CURRENT")),
      true,
      "writeCurrentPointer 必须落盘 CURRENT 指针文件",
    );
    assert.equal(readCurrentPointer(sandbox.nodeDir), "v22.14.0", "写后读回 = 版本目录名");
  } finally {
    await sandbox.dispose();
  }
});

test("CURRENT 原子写：不残留 CURRENT.tmp* 半写文件（rename 原子语义）", async () => {
  const sandbox = await makeSandbox();
  try {
    writeCurrentPointer(sandbox.nodeDir, "v22.14.0");
    const leftovers = (await readdir(sandbox.nodeDir)).filter((name) =>
      name.startsWith("CURRENT.tmp"),
    );
    assert.deepEqual(
      leftovers,
      [],
      "tmp+rename 完成后不得残留 CURRENT.tmp*（读者只见旧或新、无半写）",
    );
  } finally {
    await sandbox.dispose();
  }
});

test("CURRENT 原子写：重复写 = 换指针（后写胜）", async () => {
  const sandbox = await makeSandbox();
  try {
    await mkdir(join(sandbox.nodeDir, "v22.14.0"), { recursive: true });
    await mkdir(join(sandbox.nodeDir, "v23.0.0"), { recursive: true });
    writeCurrentPointer(sandbox.nodeDir, "v22.14.0");
    writeCurrentPointer(sandbox.nodeDir, "v23.0.0");
    assert.equal(
      readCurrentPointer(sandbox.nodeDir),
      "v23.0.0",
      "update 换指针 = 后写原子替换（读者无中间态）",
    );
  } finally {
    await sandbox.dispose();
  }
});

test("CURRENT 读端容错：缺失 → null；垃圾 → null；悬空 → null（禁目录扫描回退）", async () => {
  const sandbox = await makeSandbox();
  try {
    await mkdir(join(sandbox.nodeDir, "v1.0.0"), { recursive: true });
    await mkdir(join(sandbox.nodeDir, "v2.0.0"), { recursive: true });
    assert.equal(readCurrentPointer(sandbox.nodeDir), null, "CURRENT 缺失 → null");
    await writeFile(join(sandbox.nodeDir, "CURRENT"), "garbage");
    assert.equal(readCurrentPointer(sandbox.nodeDir), null, "CURRENT 垃圾 → null（不猜）");
    await writeFile(join(sandbox.nodeDir, "CURRENT"), "v9.9.9");
    const version = readCurrentPointer(sandbox.nodeDir);
    assert.equal(version, null, "CURRENT 悬空（指向不存在目录）→ null");
    assert.notEqual(version, "v2.0.0", "禁止回退扫描最高 v<ver>（会复活待 GC 版本）");
  } finally {
    await sandbox.dispose();
  }
});

test("GC 决策：未被 CURRENT 引用且过宽限期 → remove；被引用 → keep（红：桩不删）", () => {
  const now = 1_000_000_000;
  const plan = planVersionDirGc(
    [
      { dirName: "v1.0.0", lastTouchedMs: now - 10 * 24 * 3600_000 },
      { dirName: "v2.0.0", lastTouchedMs: now - 10 * 24 * 3600_000 },
    ],
    { currentVersion: "v2.0.0", nowMs: now, graceMs: 7 * 24 * 3600_000 },
  );
  assert.ok(plan.remove.includes("v1.0.0"), "无引用 + 已过宽限期的版本目录必须进入 remove");
  assert.ok(plan.keep.includes("v2.0.0"), "被 CURRENT 引用的版本目录必须保留");
  assert.equal(plan.remove.includes("v2.0.0"), false, "被引用目录不得进入 remove");
});

test("GC 决策：未引用但在宽限期内 → keep（不删）", () => {
  const now = 1_000_000_000;
  const plan = planVersionDirGc([{ dirName: "v1.0.0", lastTouchedMs: now - 24 * 3600_000 }], {
    currentVersion: "v2.0.0",
    nowMs: now,
    graceMs: 7 * 24 * 3600_000,
  });
  assert.ok(plan.keep.includes("v1.0.0"), "宽限期内未引用目录保留");
  assert.equal(plan.remove.includes("v1.0.0"), false, "宽限期内不得删除");
});

test("GC 决策：Windows 文件锁模拟（locked + 已过宽限期）→ 保留 + 标记 retryLater（红：桩不标记）", () => {
  const now = 1_000_000_000;
  const plan = planVersionDirGc(
    [{ dirName: "v1.0.0", lastTouchedMs: now - 10 * 24 * 3600_000, locked: true }],
    { currentVersion: "v2.0.0", nowMs: now, graceMs: 7 * 24 * 3600_000 },
  );
  assert.ok(
    plan.retryLater.includes("v1.0.0"),
    "win 锁定目录 = 保留 + 标记 retryLater（启动 GC 重试）",
  );
  assert.equal(plan.remove.includes("v1.0.0"), false, "锁定目录不得本轮强删");
  assert.equal(plan.keep.includes("v1.0.0"), true, "锁定目录保留在 keep（运行中进程续命）");
});
