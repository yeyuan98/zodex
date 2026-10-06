import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { commandPayloadSchemas as commandPayloadSchemasType } from "../src/zcode-protocol-v4/command.ts";

/**
 * 契约（specs/bot-permissions.md §3a.2 / §7.6，Track B W1 红测）：
 *
 * v4 createSession payload 新增 additive 字段 `permissionAutoDenyMs`（bot 权限
 * 无应答 deadline，分钟×60000，与 offPeakToolEnabled 同模式）。schema 必须保持
 * 非 strict z.object 语义：携带该键 ⇒ 可解析且值往返；不携带 ⇒ 旧形状行为不变
 * （旧 CLI 静默丢弃该键 = 优雅降级为「无 deadline，提示照旧等待」）。
 *
 * 现状（红）：createSession schema 尚无该键，非 strict z.object 把未知键静默
 * strip ⇒ parsed.permissionAutoDenyMs === undefined ⇒ 场景一必红；场景二是
 * guard（今绿，W3 落地后必须保持绿——不得引入 strict-reject 向量，§6 不变量）。
 */

// [加载边界] 本包单测环境是 strip-only（不支持 TS 参数属性），而 command.ts 经
// zcode-protocol barrel 连带加载 @zcode/model-option-map 源码（P4 测试注释已记录
// 同一限制，其以源码扫描绕开；本测试必须断言真实 parse 行为）。这里注册一个只
// 作用于 model-option-map 子树的同步 transpile 加载钩子（typescript 为本包既有
// devDependency）；node --test 每个测试文件独立进程，钩子不外溢。
const MODEL_OPTION_MAP_SRC_PREFIX = new URL("../../model-option-map/src/", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(MODEL_OPTION_MAP_SRC_PREFIX) && url.endsWith(".ts")) {
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

type CommandPayloadSchemas = typeof commandPayloadSchemasType;

let schemasPromise: Promise<CommandPayloadSchemas> | undefined;
function loadCommandPayloadSchemas(): Promise<CommandPayloadSchemas> {
  schemasPromise ??= import("../src/zcode-protocol-v4/command.ts");
  return schemasPromise;
}

// 今天 z.infer 尚无该字段；用宽化注解访问，避免为红测引入 as 断言。W3 落地真实
// 字段后此注解可收紧为直接属性访问。
interface CreateSessionParsedShape {
  workspaceId: string;
  permissionAutoDenyMs?: number;
}

test("createSession 携带 permissionAutoDenyMs ⇒ 解析后值往返（红：今被非 strict z.object strip）", async () => {
  const { commandPayloadSchemas } = await loadCommandPayloadSchemas();
  const parsed: CreateSessionParsedShape = commandPayloadSchemas.createSession.parse({
    workspaceId: "w1",
    permissionAutoDenyMs: 600_000,
  });
  assert.equal(
    parsed.permissionAutoDenyMs,
    600_000,
    "permissionAutoDenyMs 必须随 createSession payload 可解析并往返（spec §7.6；今天该键被非 strict z.object 静默 strip 为 undefined）",
  );
});

test("createSession 不携带 permissionAutoDenyMs ⇒ 旧形状照常解析（guard：缺省 = 无 deadline）", async () => {
  const { commandPayloadSchemas } = await loadCommandPayloadSchemas();
  const parsed: CreateSessionParsedShape = commandPayloadSchemas.createSession.parse({
    workspaceId: "w1",
  });
  assert.equal(parsed.workspaceId, "w1", "旧形状必须继续解析（additive 字段不得破坏既有发送端）");
  assert.equal(
    parsed.permissionAutoDenyMs,
    undefined,
    "缺省时不得凭空造值（旧 CLI 降级为无 deadline，提示照旧等待）",
  );
});
