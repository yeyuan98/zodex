import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// specs/agent-runtimes.md §2（C1 pathPrepend）+ §2.4（capability 门）红测：
// 下行协议 strict schema 必须以 additive-optional 方式接受并保留 stdio server 的
// pathPrepend 字段；runtime/capabilities 响应 schema 必须保留 mcpPathPrepend flag。
// 今日（W2 前）：zcodeProtocolMcpServerSchema strict 未知键 → 解析失败；
// zcodeRuntimeCapabilitiesSchema 非 strict 剥未知 flag → 解析成功但 flag 消失。
// 以下断言全部红（assertion 失败，非 import/compile 错误）；W2 落地后转绿。
//
// 输入一律用普通对象字面量（schema.parse 入参本就是 unknown），结果侧用
// Record<string, unknown> 收窄读取，避免在类型位置引用尚未存在的字段。
//
// [加载边界] 本包单测环境是 strip-only（不支持 TS 参数属性），而 zcode-protocol
// barrel 连带加载 model-option-map 源码与 zcode-protocol-v4/wire-codec.ts（两处
// 参数属性）。沿 createSessionPermissionDeadline.test.ts 先例：注册只作用于这两处
// 子树的同步 transpile 加载钩子（typescript 为本包既有 devDependency），并用惰性
// 动态 import 保证钩子先于 barrel 求值（静态 import 会被提升到 registerHooks 之前）；
// node --test 每个测试文件独立进程，钩子不外溢。

const MODEL_OPTION_MAP_SRC_PREFIX = new URL("../../model-option-map/src/", import.meta.url).href;
const WIRE_CODEC_URL = new URL("../src/zcode-protocol-v4/wire-codec.ts", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (
      (url.startsWith(MODEL_OPTION_MAP_SRC_PREFIX) || url === WIRE_CODEC_URL) &&
      url.endsWith(".ts")
    ) {
      const transpiled = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      });
      return {
        format: "module",
        shortCircuit: true,
        source: transpiled.outputText,
      };
    }
    return nextLoad(url, context);
  },
});

type ProtocolModule = typeof import("../src/zcode-protocol/index.ts");

let modulePromise: Promise<ProtocolModule> | undefined;
function loadProtocolModule(): Promise<ProtocolModule> {
  modulePromise ??= import("../src/zcode-protocol/index.ts");
  return modulePromise;
}

function stdioServerWithPathPrepend(pathPrepend: string[]): unknown {
  return {
    name: "runtime-probe",
    command: "npx",
    args: ["-y", "server"],
    env: [{ name: "FOO", value: "bar" }],
    pathPrepend,
  };
}

test("C1：zcodeProtocolMcpServerSchema 接受并保留 stdio pathPrepend（今日红：strict 未知键拒绝）", async () => {
  const { zcodeProtocolMcpServerSchema } = await loadProtocolModule();
  const result = zcodeProtocolMcpServerSchema.safeParse(
    stdioServerWithPathPrepend(["/opt/rt/bin"]),
  );
  assert.equal(result.success, true, "stdio server 带 pathPrepend 必须通过 strict 协议校验");
  if (!result.success) return;
  const retained = (result.data as Record<string, unknown>).pathPrepend;
  assert.deepEqual(
    retained,
    ["/opt/rt/bin"],
    "解析结果必须原样保留 pathPrepend（不得剥除、不得改写元素顺序）",
  );
});

test("C1：zcodeSessionCreateParamsSchema 携带 pathPrepend 的 mcpServers 整体解析通过（今日红：-32602 源头）", async () => {
  const { zcodeSessionCreateParamsSchema } = await loadProtocolModule();
  const params: unknown = {
    workspace: {
      workspacePath: "/tmp/zcode-path-prepend-ws",
      workspaceKey: "/tmp/zcode-path-prepend-ws",
    },
    mcpServers: [stdioServerWithPathPrepend(["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"])],
  };
  const result = zcodeSessionCreateParamsSchema.safeParse(params);
  assert.equal(
    result.success,
    true,
    "session create 参数携带 pathPrepend 必须整体解析通过（server-types.ts parseParams 对 strict 失败抛 -32602 硬拒整次请求——spec §2.4）",
  );
  if (!result.success) return;
  const servers = (result.data as Record<string, unknown>).mcpServers as unknown[];
  assert.equal(servers.length, 1, "mcpServers 必须保留该 server 条目");
  assert.deepEqual(
    (servers[0] as Record<string, unknown>).pathPrepend,
    ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
    "session create 参数必须保留 pathPrepend 原值（~ 展开属于 CLI 运行时职责，协议层原样透传）",
  );
});

test("C1 capability 门：zcodeRuntimeCapabilitiesSchema 解析保留 mcpPathPrepend flag（今日红：非 strict 剥未知 flag）", async () => {
  const { zcodeRuntimeCapabilitiesSchema } = await loadProtocolModule();
  const parsed = zcodeRuntimeCapabilitiesSchema.parse({ mcpPathPrepend: true });
  assert.equal(
    (parsed as Record<string, unknown>).mcpPathPrepend,
    true,
    "新 CLI 上报的 mcpPathPrepend:true 必须在解析后保留（旧 CLI 不报 → falsy → desktop 关闭下发；spec §2.4）",
  );
});

test("C1 capability 门（guard·旧 CLI 形）：capabilities 响应不含 flag 时解析结果无 mcpPathPrepend（今绿，W2 后保持绿）", async () => {
  const { zcodeRuntimeCapabilitiesSchema } = await loadProtocolModule();
  const parsed = zcodeRuntimeCapabilitiesSchema.parse({ independentPlanState: true });
  assert.equal(
    (parsed as Record<string, unknown>).mcpPathPrepend,
    undefined,
    "旧 CLI 的 capabilities 响应解析后不得凭空出现 mcpPathPrepend（门控语义的反向守卫）",
  );
});
