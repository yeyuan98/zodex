import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAppRuntimeLayerToEnv,
  applyAppRuntimePrependToEnv,
  applyMirrorEnvDefaults,
  readAppRuntimeCurrent,
  resolveAppRuntimeBinDir,
  resolveAppRuntimeRoot,
  type AppRuntimeFsAccessor,
} from "../src/mcp/app-runtime-prepend.ts";
import { applyPathPrependToEnv } from "../src/mcp/path-prepend.ts";

// specs/agent-runtimes.md §2.5 L3（C3 app 级前插 + 镜像缺省填空）/§4.3（CURRENT 读端
// 容错）红测：W1 先红（adapters/src/mcp/app-runtime-prepend.ts 为零行为桩），W6
// 接线 createTransport 缝后转绿。
//
// 断言面 = 纯函数层：<config> 根解析（ZCODE_DATA_BASE_DIR 优先 + homedir fallback）、
// CURRENT 读取（有效 → 版本串；缺失/垃圾/悬空 → null 且禁止目录扫描回退）、PATH
// 前插（L5→L3→L2 序）、镜像缺省填空（effective decision + 大小写不敏感存在性 +
// 已存在不覆盖）。

const HOME = "/home/zcode-user";
const POSIX_DELIMITER = ":";

interface Sandbox {
  root: string;
  dispose: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "zcode-app-runtime-prepend-"));
  const root = join(base, ".zcode", ".runtime");
  await mkdir(join(root, "node"), { recursive: true });
  return { root, dispose: () => rm(base, { recursive: true, force: true }) };
}

test("L3 根解析：ZCODE_DATA_BASE_DIR 优先于 homedir（与 services paths.ts 同源）", () => {
  const root = resolveAppRuntimeRoot({ ZCODE_DATA_BASE_DIR: "/data-base" }, HOME);
  assert.equal(
    root,
    join("/data-base", ".zcode", ".runtime"),
    "设置 ZCODE_DATA_BASE_DIR 时必须以其为 base 拼 .zcode/.runtime",
  );
});

test("L3 根解析：无 env 时 homedir fallback 必须保留（desktop 默认不注入）", () => {
  const root = resolveAppRuntimeRoot({}, HOME);
  assert.equal(
    root,
    join(HOME, ".zcode", ".runtime"),
    "无 ZCODE_DATA_BASE_DIR 时必须回落 homedir 并拼 .zcode/.runtime",
  );
});

test("CURRENT 读取：有效指针 → 版本目录名（红：桩恒 null）", async () => {
  const sandbox = await makeSandbox();
  try {
    await mkdir(join(sandbox.root, "node", "v22.14.0"), { recursive: true });
    await writeFile(join(sandbox.root, "node", "CURRENT"), "v22.14.0");
    assert.equal(
      readAppRuntimeCurrent(sandbox.root, "node"),
      "v22.14.0",
      "CURRENT 内容 = 版本目录名，有效时必须返回该版本串",
    );
  } finally {
    await sandbox.dispose();
  }
});

test("CURRENT 读取：目录缺失 → null（容错，不抛）", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-app-runtime-missing-"));
  try {
    assert.equal(
      readAppRuntimeCurrent(join(base, ".zcode", ".runtime"), "node"),
      null,
      "runtime 目录整体缺失时 CURRENT 视为缺席",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("CURRENT 读取：垃圾内容 → null，且禁止回退扫描最高 v<ver> 目录（§4.3）", async () => {
  const sandbox = await makeSandbox();
  try {
    await mkdir(join(sandbox.root, "node", "v1.0.0"), { recursive: true });
    await mkdir(join(sandbox.root, "node", "v2.0.0"), { recursive: true });
    await writeFile(join(sandbox.root, "node", "CURRENT"), "not-a-version");
    const version = readAppRuntimeCurrent(sandbox.root, "node");
    assert.equal(version, null, "CURRENT 不可解析 → null（不许猜）");
    assert.notEqual(version, "v2.0.0", "禁止回退扫描最高 v<ver>（会复活待 GC 版本）");
  } finally {
    await sandbox.dispose();
  }
});

test("CURRENT 读取：悬空指针（指向已 GC 目录）→ null", async () => {
  const sandbox = await makeSandbox();
  try {
    await mkdir(join(sandbox.root, "node", "v22.14.0"), { recursive: true });
    await writeFile(join(sandbox.root, "node", "CURRENT"), "v9.9.9");
    assert.equal(
      readAppRuntimeCurrent(sandbox.root, "node"),
      null,
      "CURRENT 指向不存在的版本目录 = 悬空 → null",
    );
  } finally {
    await sandbox.dispose();
  }
});

test("bin 目录解析：node unix 取 bin/、uv 两平台平铺于 v<ver>/（spec §4.3）", () => {
  const root = join("/", "opt", "runtime");
  assert.equal(
    resolveAppRuntimeBinDir(root, "node", "v22.14.0", "linux"),
    join(root, "node", "v22.14.0", "bin"),
    "node unix 保持 bin/ 子目录",
  );
  assert.equal(
    resolveAppRuntimeBinDir(root, "node", "v22.14.0", "win32"),
    join(root, "node", "v22.14.0"),
    "node win 平铺",
  );
  assert.equal(
    resolveAppRuntimeBinDir(root, "uv", "0.8.6", "linux"),
    join(root, "uv", "0.8.6"),
    "uv unix 平铺（剥 uv-<triple>/ 顶层后 uvx 与 uv 同目录，勿用 /bin 形态）",
  );
  assert.equal(
    resolveAppRuntimeBinDir(root, "uv", "0.8.6", "win32"),
    join(root, "uv", "0.8.6"),
    "uv win 平铺",
  );
});

test("L3 前插：app bin 目录前插到 PATH 最左（L3 > L2），POSIX 分隔符", () => {
  const nodeBin = join("/", "opt", "runtime", "node", "v22.14.0", "bin");
  const next = applyAppRuntimePrependToEnv({ PATH: "/usr/bin:/bin" }, [nodeBin], {
    platform: "linux",
    pathDelimiter: POSIX_DELIMITER,
  });
  assert.equal(
    next.PATH,
    `${nodeBin}:/usr/bin:/bin`,
    "L3 语义 = app 级 bin 目录前插到既有 PATH（L2 输出）最左",
  );
});

test("L3 前插：Windows 形态 Path 键大小写不敏感命中", () => {
  const nodeBin = join("C:", "runtime", "node", "v22.14.0");
  const next = applyAppRuntimePrependToEnv({ Path: "C:\\Windows" }, [nodeBin], {
    platform: "win32",
    pathDelimiter: ";",
  });
  assert.equal(
    next.Path,
    `${nodeBin};C:\\Windows`,
    "win 下须命中既有 Path 键（大小写不敏感）并以 ; 连接",
  );
});

test("L3 前插：bin 目录缺席 → env 原样返回（L3 缺席不改变 PATH）", () => {
  const env = { PATH: "/usr/bin" };
  const next = applyAppRuntimePrependToEnv(env, [], { platform: "linux" });
  assert.deepEqual(next, env, "无 app 运行时目录时 L3 为 no-op");
});

test("L3×L5 组合序：pathPrepend（L5）在 app bin（L3）之前、系统 PATH（L2）最后", () => {
  const nodeBin = join("/", "opt", "runtime", "node", "v22.14.0", "bin");
  const afterL3 = applyAppRuntimePrependToEnv({ PATH: "/usr/bin" }, [nodeBin], {
    platform: "linux",
    pathDelimiter: POSIX_DELIMITER,
  });
  const afterL5 = applyPathPrependToEnv(afterL3, ["/ws/.zcode/.runtime/node/v20.0.0/bin"], {
    homeDir: HOME,
    pathSeparator: POSIX_DELIMITER,
  });
  assert.equal(
    afterL5.PATH,
    `/ws/.zcode/.runtime/node/v20.0.0/bin:${nodeBin}:/usr/bin`,
    "最终序必须为 L5 → L3 → L2（无 L4 分支，spec §2.5）",
  );
});

test("镜像缺省填空：effective decision 填三个键（红：桩不填）", () => {
  const next = applyMirrorEnvDefaults(
    { PATH: "/usr/bin" },
    {
      npmRegistry: "https://registry.npmmirror.com",
      pypiIndex: "https://pypi.tuna.tsinghua.edu.cn/simple",
      pbsMirror: "https://registry.npmmirror.com/-/binary/python-build-standalone",
    },
  );
  assert.equal(
    next.npm_config_registry,
    "https://registry.npmmirror.com",
    "npm registry 缺省填空键 = npm_config_registry（小写优先，§4.4）",
  );
  assert.equal(
    next.UV_DEFAULT_INDEX,
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "PyPI 缺省填空键 = UV_DEFAULT_INDEX",
  );
  assert.equal(
    next.UV_PYTHON_INSTALL_MIRROR,
    "https://registry.npmmirror.com/-/binary/python-build-standalone",
    "PBS 缺省填空键 = UV_PYTHON_INSTALL_MIRROR",
  );
});

test("镜像缺省填空：env 已有 NPM_CONFIG_REGISTRY（大小写不敏感）→ 不填不覆盖", () => {
  const next = applyMirrorEnvDefaults(
    { NPM_CONFIG_REGISTRY: "https://custom.example.com" },
    { npmRegistry: "https://registry.npmmirror.com" },
  );
  assert.equal(
    next.NPM_CONFIG_REGISTRY,
    "https://custom.example.com",
    "已存在键（任意大小写形态）不覆盖",
  );
  assert.equal(next.npm_config_registry, undefined, "不得另加小写键副本（大小写不敏感存在性检查）");
});

test("镜像缺省填空：键已存在（同形小写）→ 不覆盖", () => {
  const next = applyMirrorEnvDefaults(
    { npm_config_registry: "https://custom.example.com" },
    { npmRegistry: "https://registry.npmmirror.com" },
  );
  assert.equal(next.npm_config_registry, "https://custom.example.com", "同形键已存在时不覆盖");
});

// [ulw] MINOR-6 seam 红测：L3 编排（applyAppRuntimeLayerToEnv）经注入 fs 消费
// runtime.json——overrides 胜 decisions；缺失/损坏 → 不填空、不抛错；并按
// mcp/index.ts createTransport 的组合形制钉 §2.5 L4 结构性覆盖（...config.env
// spread 后到即胜、显式 env.PATH 整串替换）。

function fakeFs(
  files: Readonly<Record<string, string>>,
  dirs: readonly string[],
): AppRuntimeFsAccessor {
  const dirSet = new Set(dirs);
  return {
    readTextFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    statDirectory: (path) => dirSet.has(path),
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path) || dirSet.has(path),
  };
}

const L3_BASE = join("/", "data-base");
const L3_ROOT = join(L3_BASE, ".zcode", ".runtime");
const L3_ENV = { ZCODE_DATA_BASE_DIR: L3_BASE };

function l3LayerJson(overrides?: Record<string, string>, decisions?: Record<string, string>) {
  return JSON.stringify({
    probedAt: "2026-10-08T00:00:00.000Z",
    ttlDays: 7,
    decisions: {
      nodeDist: "nodejs.org",
      uvRelease: "github.com",
      pypiIndex: "pypi.org",
      npmRegistry: "registry.npmjs.org",
      pbsMirror: "registry.npmmirror.com",
      ...decisions,
    },
    ...(overrides ? { overrides } : {}),
    measurements: [],
    pinned: { node: "v22.14.0", uv: "" },
  });
}

const L3_INSTALLED_FS = () =>
  fakeFs({ [join(L3_ROOT, "node", "CURRENT")]: "v22.14.0\n" }, [join(L3_ROOT, "node", "v22.14.0")]);

test("MINOR-6：runtime.json overrides.npmRegistry → 填空值胜过 decisions", () => {
  const fs = fakeFs(
    {
      [join(L3_ROOT, "node", "CURRENT")]: "v22.14.0\n",
      [join(L3_ROOT, "runtime.json")]: l3LayerJson({ npmRegistry: "registry.npmmirror.com" }),
    },
    [join(L3_ROOT, "node", "v22.14.0")],
  );
  const env = applyAppRuntimeLayerToEnv(
    { PATH: "/usr/bin" },
    {
      env: L3_ENV,
      homeDir: HOME,
      platform: "linux",
      fs,
    },
  );
  assert.equal(
    env.npm_config_registry,
    "https://registry.npmmirror.com",
    "填空值 = effective decision（override ?? probed，§4.7），override 胜出",
  );
  assert.equal(
    env.PATH,
    `${join(L3_ROOT, "node", "v22.14.0", "bin")}:/usr/bin`,
    "CURRENT 有效 → app bin 目录前插（L3 > L2）",
  );
});

test("MINOR-6：runtime.json 缺席 → 不填空、不抛错（前插仍按 CURRENT 进行）", () => {
  const env = applyAppRuntimeLayerToEnv(
    { PATH: "/usr/bin" },
    {
      env: L3_ENV,
      homeDir: HOME,
      platform: "linux",
      fs: L3_INSTALLED_FS(),
    },
  );
  assert.equal(env.npm_config_registry, undefined, "runtime.json 缺席 → 镜像填空缺席");
  assert.equal(env.UV_DEFAULT_INDEX, undefined, "不猜、不填默认镜像");
  assert.equal(
    env.PATH,
    `${join(L3_ROOT, "node", "v22.14.0", "bin")}:/usr/bin`,
    "前插与 runtime.json 无关，照常进行",
  );
});

test("MINOR-6：runtime.json 损坏 → 不填空、不抛错", () => {
  const fs = fakeFs(
    {
      [join(L3_ROOT, "node", "CURRENT")]: "v22.14.0\n",
      [join(L3_ROOT, "runtime.json")]: "not-json{",
    },
    [join(L3_ROOT, "node", "v22.14.0")],
  );
  const env = applyAppRuntimeLayerToEnv(
    { PATH: "/usr/bin" },
    {
      env: L3_ENV,
      homeDir: HOME,
      platform: "linux",
      fs,
    },
  );
  assert.equal(env.npm_config_registry, undefined, "损坏 = treat-as-absent，不猜");
  assert.equal(
    env.PATH,
    `${join(L3_ROOT, "node", "v22.14.0", "bin")}:/usr/bin`,
    "损坏不影响 CURRENT 前插（两读腿独立容错）",
  );
});

test("MINOR-6 seam：L3 填空后 ...config.env spread 覆盖填空键 + env.PATH 整串替换（§2.5 L4）", () => {
  const fs = fakeFs(
    {
      [join(L3_ROOT, "node", "CURRENT")]: "v22.14.0\n",
      [join(L3_ROOT, "runtime.json")]: l3LayerJson({ npmRegistry: "registry.npmmirror.com" }),
    },
    [join(L3_ROOT, "node", "v22.14.0")],
  );
  // mcp/index.ts createTransport 组合形制（无 pathPrepend 时 L5 为 no-op）：
  // applyPathPrependToEnv({ ...applyAppRuntimeLayerToEnv(l2), ...config.env }, pathPrepend, ...)
  const afterL3 = applyAppRuntimeLayerToEnv(
    { PATH: "/usr/bin" },
    {
      env: L3_ENV,
      homeDir: HOME,
      platform: "linux",
      fs,
    },
  );
  assert.equal(afterL3.npm_config_registry, "https://registry.npmmirror.com", "L3 后填空在场");
  const configEnv = {
    npm_config_registry: "https://custom.example.com",
    PATH: "/explicit/path",
  };
  const finalEnv = applyPathPrependToEnv({ ...afterL3, ...configEnv }, undefined, {
    homeDir: HOME,
    pathSeparator: POSIX_DELIMITER,
  });
  assert.equal(
    finalEnv.npm_config_registry,
    "https://custom.example.com",
    "config.env 键后到即胜（L4 结构性覆盖，§2.5）",
  );
  assert.equal(
    finalEnv.PATH,
    "/explicit/path",
    "显式 env.PATH = 整串替换（L3/L2 段被消灭——既有逃逸口语义）",
  );
});
