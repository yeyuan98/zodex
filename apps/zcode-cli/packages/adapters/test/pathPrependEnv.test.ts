import assert from "node:assert/strict";
import test from "node:test";

// specs/agent-runtimes.md §2.1/§2.5 L5（C1 pathPrepend env 纯函数）+ §2.2 层(3)
// （传输防御腿）+ §3（C2 ENOENT→runtime_unavailable 分类）红测：W2 新缝，先红后绿。
// 今日 `src/mcp/path-prepend.ts` 与 `classifyStdioProcessStartFailure` 导出均不存在 →
// 动态 import 捕获 MODULE_NOT_FOUND 后以 typeof 断言 + 明确失败信息表达红态
// （实现落地后同一批断言转绿，不改测试）。

interface PathPrependValidation {
  ok: boolean;
  invalidElement?: string;
}

interface PathPrependModule {
  expandPathPrependElement?: (element: string, homeDir: string) => string;
  validatePathPrepend?: (elements: string[], homeDir: string) => PathPrependValidation;
  applyPathPrependToEnv?: (
    env: Record<string, string>,
    pathPrepend: string[] | undefined,
    opts: { homeDir: string; pathSeparator: string },
  ) => Record<string, string>;
}

async function loadPathPrependModule(): Promise<PathPrependModule | undefined> {
  try {
    return (await import("../src/mcp/path-prepend.js")) as PathPrependModule;
  } catch {
    return undefined;
  }
}

interface McpIndexModule {
  classifyStdioProcessStartFailure?: (
    command: string,
    error: unknown,
  ) => "runtime_unavailable" | "process_start_failed";
}

async function loadMcpIndexModule(): Promise<McpIndexModule | undefined> {
  try {
    return (await import("../src/mcp/index.js")) as McpIndexModule;
  } catch {
    return undefined;
  }
}

function enoentError(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
}

test("C1 纯函数：expandPathPrependElement 展开 ~ 与 ~/ 前缀、其余原样（今日红：模块不存在）", async () => {
  const mod = await loadPathPrependModule();
  assert.equal(
    typeof mod?.expandPathPrependElement,
    "function",
    "adapters/src/mcp/path-prepend.ts 必须导出 expandPathPrependElement（spec §2.1：CLI 与 desktop 同一展开规则）",
  );
  const expand = mod!.expandPathPrependElement!;
  const home = "/home/zcode-user";
  assert.equal(expand("~", home), home, "~ 必须展开为 homeDir 本身");
  assert.equal(expand("~/lib", home), `${home}/lib`, "~/lib 必须展开为 homeDir/lib");
  assert.equal(
    expand("~/.zcode/.runtime/node/v22.0.0/bin", home),
    `${home}/.zcode/.runtime/node/v22.0.0/bin`,
    "~/ 嵌套相对段必须照常拼接",
  );
  assert.equal(expand("/opt/rt/bin", home), "/opt/rt/bin", "非 ~ 前缀元素必须原样返回");
  assert.equal(expand("relative/dir", home), "relative/dir", "相对元素不得在展开阶段被改写");
});

test("C1 纯函数：validatePathPrepend 展开后必须绝对（今日红：模块不存在）", async () => {
  const mod = await loadPathPrependModule();
  assert.equal(
    typeof mod?.validatePathPrepend,
    "function",
    "adapters/src/mcp/path-prepend.ts 必须导出 validatePathPrepend（spec §2.2 绝对路径不变量的共享判定）",
  );
  const validate = mod!.validatePathPrepend!;
  const home = "/home/zcode-user";
  assert.deepEqual(
    validate(["/opt/rt/bin", "~/.zcode/.runtime/uv/v0.2.0/bin"], home),
    { ok: true },
    "绝对元素与展开后绝对的 ~ 元素必须整体通过",
  );
  const invalid = validate(["/opt/rt/bin", "relative/dir"], home);
  assert.equal(invalid.ok, false, "含相对元素时必须判失败");
  assert.equal(
    (invalid as { invalidElement?: string }).invalidElement,
    "relative/dir",
    "失败结果必须点名非法元素（loud，不静默截断该元素）",
  );
});

test("C1 纯函数：applyPathPrependToEnv 前插顺序与 separator 拼接（今日红：模块不存在）", async () => {
  const mod = await loadPathPrependModule();
  assert.equal(
    typeof mod?.applyPathPrependToEnv,
    "function",
    "adapters/src/mcp/path-prepend.ts 必须导出 applyPathPrependToEnv（spec §2.5 L5 前插点）",
  );
  const apply = mod!.applyPathPrependToEnv!;
  const env = { FOO: "bar", PATH: "/sys/bin" };
  const result = apply(env, ["/opt/rt/bin", "~/.zcode/rt/bin"], {
    homeDir: "/home/zcode-user",
    pathSeparator: ":",
  });
  assert.equal(
    result.PATH,
    "/opt/rt/bin:/home/zcode-user/.zcode/rt/bin:/sys/bin",
    "PATH 必须是展开元素按序 + separator + 既有 PATH（前插最左侧）",
  );
  assert.equal(result.FOO, "bar", "非 PATH 键必须原样保留");
});

test("C1 纯函数：applyPathPrependToEnv 无 PATH 键时仍设置；undefined 时 no-op（今日红：模块不存在）", async () => {
  const mod = await loadPathPrependModule();
  assert.equal(typeof mod?.applyPathPrependToEnv, "function", "前置：模块必须存在");
  const apply = mod!.applyPathPrependToEnv!;
  const noPath = apply({ FOO: "bar" }, ["/opt/rt/bin"], {
    homeDir: "/home/zcode-user",
    pathSeparator: ":",
  });
  assert.equal(noPath.PATH, "/opt/rt/bin", "env 无 PATH 键时必须仍写入前插目录");
  const noop = apply({ FOO: "bar" }, undefined, {
    homeDir: "/home/zcode-user",
    pathSeparator: ":",
  });
  assert.equal(noop.PATH, undefined, "pathPrepend 未定义时不得凭空注入 PATH");
  assert.equal(noop.FOO, "bar", "pathPrepend 未定义时 env 其余键不受影响");
});

test("C1 纯函数：applyPathPrependToEnv 大小写不敏感命中既有 Path 键（win 形态）（今日红：模块不存在）", async () => {
  const mod = await loadPathPrependModule();
  assert.equal(typeof mod?.applyPathPrependToEnv, "function", "前置：模块必须存在");
  const apply = mod!.applyPathPrependToEnv!;
  const result = apply({ Path: "C:\\sys\\bin" }, ["C:\\rt\\node\\bin"], {
    homeDir: "C:\\Users\\zcode",
    pathSeparator: ";",
  });
  assert.equal(
    result.Path,
    "C:\\rt\\node\\bin;C:\\sys\\bin",
    "Windows 形态的 Path 键必须按大小写不敏感命中并前插",
  );
  assert.equal(result.PATH, undefined, "不得额外再注入大写 PATH 键（重复键）");
});

test("C2 分类：npx/npm/node/uvx/python 系 ENOENT → runtime_unavailable（今日红：导出不存在）", async () => {
  const mod = await loadMcpIndexModule();
  assert.equal(
    typeof mod?.classifyStdioProcessStartFailure,
    "function",
    "adapters/src/mcp/index.ts 必须导出 classifyStdioProcessStartFailure（spec §3：runtime_unavailable producer 的可测分类缝）",
  );
  const classify = mod!.classifyStdioProcessStartFailure!;
  assert.equal(classify("npx", enoentError("npx")), "runtime_unavailable");
  assert.equal(classify("npx.cmd", enoentError("npx.cmd")), "runtime_unavailable");
  assert.equal(classify("npx.exe", enoentError("npx.exe")), "runtime_unavailable");
  assert.equal(classify("C:\\tools\\uvx.cmd", enoentError("uvx.cmd")), "runtime_unavailable");
  assert.equal(classify("python3", enoentError("python3")), "runtime_unavailable");
  assert.equal(classify("node", enoentError("node")), "runtime_unavailable");
});

test("C2 分类：非白名单命令 ENOENT / 非 ENOENT 错误 → process_start_failed（今日红：导出不存在）", async () => {
  const mod = await loadMcpIndexModule();
  assert.equal(typeof mod?.classifyStdioProcessStartFailure, "function", "前置：导出必须存在");
  const classify = mod!.classifyStdioProcessStartFailure!;
  assert.equal(classify("mybinary", enoentError("mybinary")), "process_start_failed");
  const eacces = Object.assign(new Error("spawn npx EACCES"), { code: "EACCES" });
  assert.equal(classify("npx", eacces), "process_start_failed");
  assert.equal(classify("npx", new Error("random failure")), "process_start_failed");
});
