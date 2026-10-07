import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_FORM,
  formToConfig,
  jsonDraftToForm,
  serverToForm,
} from "../src/settings/mcpSettingsShared.ts";

// specs/agent-runtimes.md §2.3 面6（C1 pathPrepend 设置表单往返）红测：
// mcpSettingsShared 的 FormState 是固定形状、formToConfig 从 FormState 重建配置，
// 未知键在「粘贴 JSON → FormState → 保存」链路上全丢（timeoutMs/oauth/
// protocolVersion 三条保留注释 = 同型前科实证 :197-205）。S1 技能写入的
// pathPrepend 若不被 FormState 显式承载，用户在设置页改一次 args 保存即剥掉。
// 今日（W2 前）：jsonDraftToForm 不读 pathPrepend、formToConfig 不写 ⇒ 往返丢失；
// W2 落地 FormState 显式承载后转绿。
//
// 输入走 jsonDraftToForm 的真实粘贴入口（对象字面量序列化），断言只盯运行时结果，
// 不在类型位置引用尚未存在的 FormState 字段。

const DRAFT_WITH_PATH_PREPEND = JSON.stringify(
  {
    mcpServers: {
      "runtime-server": {
        type: "stdio",
        command: "npx",
        args: ["-y", "server"],
        env: { FOO: "bar" },
        timeoutMs: 30000,
        pathPrepend: ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
      },
    },
  },
  null,
  2,
);

test("C1 表单往返：粘贴 JSON → FormState → formToConfig 保留 pathPrepend（今日红：固定 FormState 重建丢未知键）", () => {
  const form = jsonDraftToForm(DRAFT_WITH_PATH_PREPEND, EMPTY_FORM);
  const config = formToConfig(form) as Record<string, unknown>;
  assert.deepEqual(
    config.pathPrepend,
    ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
    "表单保存链路必须保留 pathPrepend（spec §2.3 面6：否则设置页一次保存即剥掉 S1 写入的 PATH 注入；timeoutMs/oauth/protocolVersion 为同型前科）",
  );
});

test("C1 表单往返（guard）：无 pathPrepend 的粘贴 JSON 保存后不凭空注入字段（今绿，W2 后保持绿）", () => {
  const draft = JSON.stringify(
    {
      mcpServers: {
        "plain-server": {
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
    },
    null,
    2,
  );
  const form = jsonDraftToForm(draft, EMPTY_FORM);
  const config = formToConfig(form) as Record<string, unknown>;
  assert.equal(
    config.pathPrepend,
    undefined,
    "未携带 pathPrepend 的配置经表单保存后不得凭空出现该字段",
  );
});

test("C1 表单往返：设置页编辑既有 server（serverToForm → formToConfig）保留 pathPrepend（[ulw] MAJOR-2 钉测）", () => {
  // 真实设置页编辑路径：serverToForm 从既有 server 构建 FormState，用户改一次
  // args 保存后 formToConfig 重建配置——pathPrepend 若不被 serverToForm 承载，
  // 该保存链路同样剥掉 S1 写入（与 jsonDraftToForm 腿同型，分开钉死）。
  const server = {
    name: "runtime-server",
    scope: "workspace",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { FOO: "bar" },
      pathPrepend: ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
    },
  };
  const form = serverToForm(server as never);
  const config = formToConfig(form) as Record<string, unknown>;
  assert.deepEqual(
    config.pathPrepend,
    ["/opt/rt/bin", "~/.zcode/.runtime/node/v22.0.0/bin"],
    "设置页编辑保存链路（serverToForm → formToConfig）必须保留 pathPrepend（spec §2.3 面6）",
  );
});
