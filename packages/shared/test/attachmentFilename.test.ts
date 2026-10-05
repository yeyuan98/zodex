import assert from "node:assert/strict";
import test from "node:test";
// §5.6（specs/bot-file-delivery.md「Outbound attachment naming & inline kinds
// (3.14.5 Alpha 7)」）共享字节预算文件名 helper 的纯函数矩阵——三个消费点
//（botsService 入站缓存 / 出站临时物料化 / desktop staging 段）的行为契约钉在此处；
// services/desktop 侧红测只钉端到端可观测点。
import { sanitizeByteBudgetedFilename } from "../src/attachmentFilename.js";

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

test("§5.6 Unicode 基名保留：CJK 名不塌缩、不劈码点、无替换符", () => {
  assert.equal(sanitizeByteBudgetedFilename("程曦简历.pdf", { byteBudget: 160 }), "程曦简历.pdf");
  assert.equal(sanitizeByteBudgetedFilename("程曦简历.pdf", { byteBudget: 120 }), "程曦简历.pdf");
});

test("§5.6 字节预算截断：stem 在预算-扩展名字节内截断、扩展名保留、绝不超预算", () => {
  // 70 个 CJK 字符 + .pdf = 214 字节 > 120 预算。
  const long = sanitizeByteBudgetedFilename(`${"报".repeat(70)}.pdf`, { byteBudget: 120 });
  assert.ok(utf8Bytes(long) <= 120, `${long} = ${utf8Bytes(long)}B`);
  assert.ok(long.endsWith(".pdf"));
  assert.ok(long.startsWith("报"));
  assert.ok(!long.includes("\uFFFD"), "不得劈开码点产生替换符");
  // 125 个 CJK 字符（今天字符口径产出 360 字节）同样收敛到 ≤120 字节。
  const huge = sanitizeByteBudgetedFilename(`${"报".repeat(125)}.pdf`, { byteBudget: 120 });
  assert.ok(utf8Bytes(huge) <= 120);
  assert.ok(huge.endsWith(".pdf") && huge.startsWith("报"));
});

test("§5.6 Windows 保留名中和：含带扩展形态与多段扩展；截断新造的保留名同样中和", () => {
  for (const reserved of ["CON", "con", "PRN", "Aux", "NUL", "COM3", "lpt9"]) {
    const neutralized = sanitizeByteBudgetedFilename(`${reserved}.txt`, { byteBudget: 120 });
    const stem = neutralized.split(".")[0]!;
    assert.match(
      stem,
      /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)/iu,
      `${reserved} → ${neutralized}`,
    );
  }
  // com1.tar.gz：首段中和，尾段扩展保留。
  assert.equal(sanitizeByteBudgetedFilename("com1.tar.gz", { byteBudget: 120 }), "_com1.tar.gz");
  // 裸保留名（无扩展）。
  assert.equal(sanitizeByteBudgetedFilename("CON", { byteBudget: 120 }), "_CON");
  // 段尾空格/点的 Windows 匹配形态（"CON .txt" 也命中）。
  const spaced = sanitizeByteBudgetedFilename("CON .txt", { byteBudget: 120 });
  assert.notEqual(spaced.split(".")[0]!.trim(), "CON");
  // 截断新造保留名："configuration" 在预算 7 内截到 "con" + ".txt" → 必须中和。
  const truncated = sanitizeByteBudgetedFilename("configuration.txt", { byteBudget: 7 });
  assert.ok(utf8Bytes(truncated) <= 7);
  assert.notEqual(truncated.split(".")[0]!.toLowerCase(), "con");
  // 中和后仍不超预算（stem 让位 1 字节给前缀 `_`）。
  const exact = sanitizeByteBudgetedFilename("con.txt", { byteBudget: 7 });
  assert.equal(exact, "_con.tx");
  assert.ok(utf8Bytes(exact) <= 7);
});

test("§5.6 控制字符与路径分隔符/Windows 禁用字符逐字符替换 `_`；ASCII 预算内零漂移", () => {
  // botsService 旧消毒口径逐字节保持（../../evil\u0007:name/<>.png 前缀形态：C0 控制符
  // BEL 与冒号都替换 `_`，穿越段 "../../" → ".._.._"）。
  const hostile = "../../evil\u0007:name/<>.png";
  assert.ok(sanitizeByteBudgetedFilename(hostile, { byteBudget: 120 }).startsWith(".._.._evil_"));
  assert.equal(
    sanitizeByteBudgetedFilename('a/b\\c:d*e?f"g<h>i|.txt', { byteBudget: 120 }),
    "a_b_c_d_e_f_g_h_i_.txt",
  );
  assert.equal(sanitizeByteBudgetedFilename("report.pdf", { byteBudget: 120 }), "report.pdf");
  assert.equal(sanitizeByteBudgetedFilename("a.b.c.txt", { byteBudget: 120 }), "a.b.c.txt");
  // C1 控制符（U+0085）同样中和。
  assert.ok(sanitizeByteBudgetedFilename("a\u0085b.txt", { byteBudget: 120 }).startsWith("a_b"));
});

test("§5.6 空输入/全消毒输入回退 fallback（fallback 自身受预算约束）", () => {
  assert.equal(sanitizeByteBudgetedFilename("", { byteBudget: 120 }), "attachment");
  assert.equal(sanitizeByteBudgetedFilename("   ", { byteBudget: 120 }), "attachment");
  assert.equal(sanitizeByteBudgetedFilename("  ", { byteBudget: 80, fallback: "trace" }), "trace");
  // 病态：扩展名自身占满预算 → 整名按预算截断，仍 ≤ 预算字节。
  const pathological = sanitizeByteBudgetedFilename(`a.${"x".repeat(300)}`, { byteBudget: 10 });
  assert.ok(utf8Bytes(pathological) <= 10, pathological);
});

test("§5.6 staging 段预算（trace 80 / nonce 64 / filename 160）：ASCII 安全集零漂移", () => {
  assert.equal(
    sanitizeByteBudgetedFilename("0192f3ab-cd45-6789-abcd-ef0123456789", { byteBudget: 80 }),
    "0192f3ab-cd45-6789-abcd-ef0123456789",
  );
  assert.equal(sanitizeByteBudgetedFilename("trace-abc", { byteBudget: 80 }), "trace-abc");
  assert.equal(sanitizeByteBudgetedFilename("notes.txt", { byteBudget: 160 }), "notes.txt");
});

test("§5.6 纯点号输入（./../…）→ fallback（[ulw] MINOR-1：无前缀段防 join 折叠）", () => {
  assert.equal(sanitizeByteBudgetedFilename(".", { byteBudget: 120 }), "attachment");
  assert.equal(sanitizeByteBudgetedFilename("..", { byteBudget: 120 }), "attachment");
  assert.equal(sanitizeByteBudgetedFilename("...", { byteBudget: 120 }), "attachment");
  assert.equal(sanitizeByteBudgetedFilename("  ..  ", { byteBudget: 120 }), "attachment");
  // 带正常 stem 的点号形态不受影响（扩展名语义保持）。
  assert.equal(sanitizeByteBudgetedFilename("..hidden", { byteBudget: 120 }), "..hidden");
});
