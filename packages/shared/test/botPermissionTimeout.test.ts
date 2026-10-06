import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_PERMISSION_TIMEOUT_DEFAULT_MINUTES,
  botCurrentOptionsSchema,
  normalizePermissionTimeoutMinutes,
} from "../src/bots.ts";

/**
 * specs/bot-permissions.md §3a.1（3.15.0 Track B，验收 E.19）：
 * `currentOptions.permissionTimeoutMinutes` 读取时归一 helper——
 * undefined/非法/缺席 ⇒ 10；数值字符串照常解析；小数截断；NaN ⇒ 10；clamp [1, 1440]。
 * 写入侧（schema/normalizer）不注入默认：读取时默认只活在消费方（W2 先例）。
 */

test("E.19：normalizePermissionTimeoutMinutes 读取时归一矩阵", () => {
  assert.equal(normalizePermissionTimeoutMinutes(undefined), 10, "undefined ⇒ 默认 10");
  assert.equal(normalizePermissionTimeoutMinutes("7"), 7, '数值字符串 "7" ⇒ 7');
  assert.equal(normalizePermissionTimeoutMinutes(0), 1, "0 ⇒ clamp 到 1");
  assert.equal(normalizePermissionTimeoutMinutes(99999), 1440, "99999 ⇒ clamp 到 1440");
  // 小数口径钉住：向零截断（2.5 ⇒ 2），不四舍五入。
  assert.equal(normalizePermissionTimeoutMinutes(2.5), 2, "2.5 ⇒ 2（截断，非四舍五入）");
  assert.equal(normalizePermissionTimeoutMinutes(Number.NaN), 10, "NaN ⇒ 10");
  assert.equal(normalizePermissionTimeoutMinutes(null), 10, "null ⇒ 10");
  assert.equal(normalizePermissionTimeoutMinutes(""), 10, "空字符串 ⇒ 10");
  assert.equal(normalizePermissionTimeoutMinutes("abc"), 10, "非数值字符串 ⇒ 10");
  assert.equal(normalizePermissionTimeoutMinutes(true), 10, "布尔 ⇒ 10");
  assert.equal(normalizePermissionTimeoutMinutes(-3), 1, "-3 ⇒ clamp 到 1");
  assert.equal(normalizePermissionTimeoutMinutes(" 12 "), 12, "带空白数值字符串 ⇒ 12");
  assert.equal(normalizePermissionTimeoutMinutes(1), 1, "边界 1 保持 1");
  assert.equal(normalizePermissionTimeoutMinutes(1440), 1440, "边界 1440 保持 1440");
});

test("E.19：botCurrentOptionsSchema 接受合法 permissionTimeoutMinutes、拒绝越界值（写入侧不注入默认）", () => {
  assert.equal(
    botCurrentOptionsSchema.parse({ permissionTimeoutMinutes: 7 }).permissionTimeoutMinutes,
    7,
    "合法整数 7 原样通过",
  );
  assert.equal(
    botCurrentOptionsSchema.parse({}).permissionTimeoutMinutes,
    undefined,
    "缺省不注入默认（读取时默认在消费方）",
  );
  assert.equal(
    botCurrentOptionsSchema.safeParse({ permissionTimeoutMinutes: 0 }).success,
    false,
    "0 越界被 strict schema 拒绝",
  );
  assert.equal(
    botCurrentOptionsSchema.safeParse({ permissionTimeoutMinutes: 1441 }).success,
    false,
    "1441 越界被拒绝",
  );
  assert.equal(
    botCurrentOptionsSchema.safeParse({ permissionTimeoutMinutes: 1.5 }).success,
    false,
    "非整数被拒绝（写入只收整数；读取侧小数经 helper 截断）",
  );
  assert.equal(BOT_PERMISSION_TIMEOUT_DEFAULT_MINUTES, 10, "默认常量 = 10（D2 ruling）");
});
