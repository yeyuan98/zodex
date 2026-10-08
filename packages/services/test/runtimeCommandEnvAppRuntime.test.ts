import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppRuntimeBashAppend,
  resolveAppRuntimeBashAppendFromDisk,
} from "../src/runtime-tools/local-runtime/bash-append.js";

// specs/agent-runtimes.md §2.5（Bash 工具腿：app 级 host 侧追加）红测：W1 先红
// （bash-append.ts 为零行为桩），W6 把 seam 接进 buildRuntimeProcessEnvPatch +
// agent spawn 缝后转绿。注意：runtimeCommandEnv.ts 本批**不改**（test 4 只钉
// seam 纯函数契约）。
//
// 断言面：app 运行时在场（CURRENT 有效 + bin 目录存在）→ 追加 bin 目录（append
// 语义）+ 镜像缺省填空；缺席 → null（patch 不变）；填空对 baseEnv 已有键（大小写
// 不敏感）不覆盖。

const ROOT = join("/", "opt", "zcode-data", ".zcode", ".runtime");

test("Bash 腿：app 运行时在场 → 追加 bin 目录 + 镜像填空（红：桩恒 null）", () => {
  const result = buildAppRuntimeBashAppend(
    { PATH: "/usr/bin:/bin" },
    {
      root: ROOT,
      current: { node: "v22.14.0", uv: null },
      binDirExists: () => true,
      decisions: {
        npmRegistry: "https://registry.npmmirror.com",
        pypiIndex: "https://pypi.tuna.tsinghua.edu.cn/simple",
        pbsMirror: "https://registry.npmmirror.com/-/binary/python-build-standalone",
      },
      platform: "linux",
    },
  );
  assert.notEqual(result, null, "app 运行时在场时 Bash 腿必须产出追加段");
  assert.deepEqual(
    result?.pathAppend,
    [join(ROOT, "node", "v22.14.0", "bin")],
    "追加段 = 版本化 bin 目录（unix 形态 bin/ 子目录）",
  );
  assert.equal(
    result?.envFill.npm_config_registry,
    "https://registry.npmmirror.com",
    "填空 = effective decision 投影（npm_config_registry）",
  );
  assert.equal(
    result?.envFill.UV_DEFAULT_INDEX,
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "填空 = effective decision 投影（UV_DEFAULT_INDEX）",
  );
});

test("Bash 腿：node 与 uv 均在场 → 两组 bin 目录都在追加段（红：桩恒 null）", () => {
  const result = buildAppRuntimeBashAppend(
    { PATH: "/usr/bin" },
    {
      root: ROOT,
      current: { node: "v22.14.0", uv: "0.8.6" },
      binDirExists: () => true,
      decisions: {},
      platform: "linux",
    },
  );
  assert.notEqual(result, null, "双运行时在场时必须产出追加段");
  assert.equal(result?.pathAppend.length, 2, "两类运行时各贡献一个 bin 目录");
  assert.ok(
    result?.pathAppend.includes(join(ROOT, "node", "v22.14.0", "bin")),
    "node 版本化 bin 目录须在追加段（追加段内 node/uv 相对序不作约束）",
  );
  assert.ok(
    // spec §4.3：uv unix 剥掉 uv-<triple>/ 顶层后平铺于 v<ver>/（uvx 与 uv 同
    // 目录）——W1 初稿误写 /bin 形态，与安装布局/技能矛盾，按 spec 修正。
    result?.pathAppend.includes(join(ROOT, "uv", "0.8.6")),
    "uv 版本化 bin 目录（v<ver>/ 平铺，uvx 与 uv 同目录）须在追加段",
  );
});

test("Bash 腿：baseEnv 已有 NPM_CONFIG_REGISTRY（大小写不敏感）→ 填空不覆盖", () => {
  const result = buildAppRuntimeBashAppend(
    { PATH: "/usr/bin", NPM_CONFIG_REGISTRY: "https://custom.example.com" },
    {
      root: ROOT,
      current: { node: "v22.14.0", uv: null },
      binDirExists: () => true,
      decisions: { npmRegistry: "https://registry.npmmirror.com" },
      platform: "linux",
    },
  );
  assert.notEqual(result, null, "运行时在场即有追加段（与填空键是否已存在无关）");
  assert.equal(
    result?.envFill.npm_config_registry,
    undefined,
    "baseEnv 已有键（任意大小写形态）不得进入填空段",
  );
});

test("Bash 腿：CURRENT 双缺席 → null（patch 不变）（今绿钉）", () => {
  const result = buildAppRuntimeBashAppend(
    { PATH: "/usr/bin" },
    {
      root: ROOT,
      current: { node: null, uv: null },
      binDirExists: () => true,
      decisions: { npmRegistry: "https://registry.npmmirror.com" },
      platform: "linux",
    },
  );
  assert.equal(result, null, "无 app 运行时 → Bash 腿无追加（fail-closed 回落现状）");
});

test("Bash 腿：CURRENT 有效但 bin 目录不存在（悬空/半装）→ null", () => {
  const result = buildAppRuntimeBashAppend(
    { PATH: "/usr/bin" },
    {
      root: ROOT,
      current: { node: "v22.14.0", uv: null },
      binDirExists: () => false,
      decisions: {},
      platform: "linux",
    },
  );
  assert.equal(result, null, "bin 目录不存在 = 运行时不在场，不得追加幽灵路径");
});

// specs/agent-runtimes.md §2.5/§4.7（alpha.3 F5/D1：OFF = 用官方源）红测：
// runtime.json 带 useMirrors:false → Bash 腿填空填 origin 官方值
// （registry.npmjs.org / pypi.org / origin PBS）——「不用镜像」=「用官方」而非
// 「不填」；useMirrors:true（或字段缺席）→ 维持镜像决策（今绿钉）。
// 计划锚点：../ZCode-runtime-alpha3-plan.md §2 F5 L3/Bash 填空同义 / §5 D1。

function makeDiskSandbox(runtimeJsonText: string): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zcode-bash-append-mirrors-"));
  mkdirSync(join(root, "node", "v22.14.0", "bin"), { recursive: true });
  writeFileSync(join(root, "node", "CURRENT"), "v22.14.0");
  writeFileSync(join(root, "runtime.json"), runtimeJsonText);
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function mirrorDecisionsRuntimeJson(useMirrors: boolean): string {
  return `{
  "probedAt": "2026-10-08T00:00:00.000Z",
  "ttlDays": 7,
  "decisions": {
    "nodeDist": "npmmirror",
    "uvRelease": "github.com",
    "pypiIndex": "tuna",
    "npmRegistry": "registry.npmmirror.com",
    "pbsMirror": "registry.npmmirror.com"
  },
  "measurements": [],
  "pinned": { "node": "v22.14.0", "uv": "" },
  "useMirrors": ${useMirrors ? "true" : "false"}
}`;
}

test("Bash 腿 OFF（D1）：useMirrors:false → 填官方源值而非镜像决策（红：今日填镜像值）", async () => {
  const sandbox = makeDiskSandbox(mirrorDecisionsRuntimeJson(false));
  try {
    const result = resolveAppRuntimeBashAppendFromDisk(
      { PATH: "/usr/bin" },
      { runtimeRootDir: sandbox.root, platform: "linux" },
    );
    assert.notEqual(result, null, "运行时在场 → Bash 腿仍有追加段");
    assert.equal(
      result?.envFill.npm_config_registry,
      "https://registry.npmjs.org",
      "OFF → npm registry 填官方值 registry.npmjs.org（D1：不用镜像 = 用官方）",
    );
    assert.equal(
      result?.envFill.UV_DEFAULT_INDEX,
      "https://pypi.org/simple",
      "OFF → PyPI 填官方值 pypi.org",
    );
    assert.equal(
      result?.envFill.UV_PYTHON_INSTALL_MIRROR,
      "https://github.com/astral-sh/python-build-standalone/releases/download",
      "OFF → PBS 填 origin（github.com）值",
    );
  } finally {
    sandbox.dispose();
  }
});

test("Bash 腿 ON：useMirrors:true → 维持镜像决策填空（今绿钉）", async () => {
  const sandbox = makeDiskSandbox(mirrorDecisionsRuntimeJson(true));
  try {
    const result = resolveAppRuntimeBashAppendFromDisk(
      { PATH: "/usr/bin" },
      { runtimeRootDir: sandbox.root, platform: "linux" },
    );
    assert.equal(
      result?.envFill.npm_config_registry,
      "https://registry.npmmirror.com",
      "ON → 填空值 = effective decision（镜像决策照常生效）",
    );
    assert.equal(
      result?.envFill.UV_DEFAULT_INDEX,
      "https://pypi.tuna.tsinghua.edu.cn/simple",
      "ON → PyPI 镜像决策照常",
    );
  } finally {
    sandbox.dispose();
  }
});
