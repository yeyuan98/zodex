import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.ts";
import zhCN from "../src/i18n/locales/zh-CN.ts";

// specs/agent-runtimes.md §3（C2 runtime_unavailable）+ alpha2-plan D4（C2 文案改写）
// 红测：failureKind runtime_unavailable 的 i18n 文案必须同时指路两处——
// 1. bundled skill zcode-workspace-runtimes（ws 级/remote 仍是正解；alpha.1 落地，
//    今绿钉，W6 后必须保持绿）；
// 2. 设置页 MCP 区「运行时环境」卡（alpha.2 A2′ 产物；今日红——文案尚未指路卡，
//    W6 改写 locale 后转绿，spec §3「PR2 落地时再改写指路」记账兑现）。

const SKILL_POINTER = "zcode-workspace-runtimes";
const CARD_POINTER_ZH = "运行时环境";
const CARD_POINTER_EN = "Runtime Environment";

test("C2 文案：en-US runtime_unavailable 指路 zcode-workspace-runtimes 技能（今绿钉）", () => {
  const value = enUS["settings.mcp.failure.runtime_unavailable"];
  assert.equal(typeof value, "string", "前置：键必须存在（枚举 + i18n 键已在前批落地）");
  assert.ok(
    (value ?? "").includes(SKILL_POINTER),
    `en-US runtime_unavailable 文案必须包含可行动指路 ${SKILL_POINTER}（实际：${value}）`,
  );
});

test("C2 文案：zh-CN runtime_unavailable 指路 zcode-workspace-runtimes 技能（今绿钉）", () => {
  const value = zhCN["settings.mcp.failure.runtime_unavailable"];
  assert.equal(typeof value, "string", "前置：键必须存在（枚举 + i18n 键已在前批落地）");
  assert.ok(
    (value ?? "").includes(SKILL_POINTER),
    `zh-CN runtime_unavailable 文案必须包含可行动指路 ${SKILL_POINTER}（实际：${value}）`,
  );
});

test("C2 文案：en-US runtime_unavailable 同时指路设置运行时环境卡（今日红：文案未指路卡）", () => {
  const value = enUS["settings.mcp.failure.runtime_unavailable"];
  assert.equal(typeof value, "string", "前置：键必须存在");
  assert.ok(
    (value ?? "").includes(CARD_POINTER_EN),
    `en-US runtime_unavailable 文案必须同时指路设置页运行时环境卡（含 ${CARD_POINTER_EN}；实际：${value}）`,
  );
});

test("C2 文案：zh-CN runtime_unavailable 同时指路设置运行时环境卡（今日红：文案未指路卡）", () => {
  const value = zhCN["settings.mcp.failure.runtime_unavailable"];
  assert.equal(typeof value, "string", "前置：键必须存在");
  assert.ok(
    (value ?? "").includes(CARD_POINTER_ZH),
    `zh-CN runtime_unavailable 文案必须同时指路设置页运行时环境卡（含「${CARD_POINTER_ZH}」；实际：${value}）`,
  );
});
