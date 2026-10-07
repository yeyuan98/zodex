import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.ts";
import zhCN from "../src/i18n/locales/zh-CN.ts";

// specs/agent-runtimes.md §3（C2 runtime_unavailable）红测：failureKind
// runtime_unavailable 的 i18n 文案必须升级为可行动指引——指向 bundled skill
// zcode-workspace-runtimes（issue #27 的 UX 闭环：用户从泛化「启动失败」变成
// 知道让 agent 跑哪个技能补运行时）。PR2 A2（设置页运行时卡）落地后再改写指路
// （本测试届时随文案同步更新）。今天是泛化文案 ⇒ 两 locale 均红。

const SKILL_POINTER = "zcode-workspace-runtimes";

test("C2 文案：en-US runtime_unavailable 指路 zcode-workspace-runtimes 技能（今日红：泛化文案无指路）", () => {
  const value = enUS["settings.mcp.failure.runtime_unavailable"];
  assert.equal(typeof value, "string", "前置：键必须存在（枚举 + i18n 键已在前批落地）");
  assert.ok(
    (value ?? "").includes(SKILL_POINTER),
    `en-US runtime_unavailable 文案必须包含可行动指路 ${SKILL_POINTER}（实际：${value}）`,
  );
});

test("C2 文案：zh-CN runtime_unavailable 指路 zcode-workspace-runtimes 技能（今日红：泛化文案无指路）", () => {
  const value = zhCN["settings.mcp.failure.runtime_unavailable"];
  assert.equal(typeof value, "string", "前置：键必须存在（枚举 + i18n 键已在前批落地）");
  assert.ok(
    (value ?? "").includes(SKILL_POINTER),
    `zh-CN runtime_unavailable 文案必须包含可行动指路 ${SKILL_POINTER}（实际：${value}）`,
  );
});
