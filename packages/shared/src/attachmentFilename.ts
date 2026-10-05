/**
 * 出站/入站文件名的共享字节预算消毒 helper（specs/bot-file-delivery.md
 * 「Outbound attachment naming & inline kinds (3.14.5 Alpha 7)」§5.6）。
 *
 * 纯函数、零 IO、零时钟。三个法定消费点（各自预算由调用方传入，spec §5.6 表）：
 * - botsService 入站附件缓存文件名段（120 字节；`<digest>-` 前缀在预算段之外）；
 * - botsService 远端取回的出站临时物料化文件名（120 字节；无前缀——这是保留名
 *   真正裸奔的点，红测钉在 `CON.txt`）；
 * - desktop `remotePromptAttachments` staging 路径三段（trace 80 / nonce 64 /
 *   filename 160 字节；`01-` 序号前缀在预算段之外）。
 *
 * 契约：
 * - Unicode 基名保留：不做 ASCII-only 剥离（`程曦简历.pdf` 端到端保真——修复
 *   handoff §2h 发现②：desktop 旧 `[^A-Za-z0-9._-]+ → "-"` 把 CJK 基名清光）。
 * - 截断按 UTF-8 字节、绝不劈开多字节码点；扩展名（最后一个点起的尾段）在预算内
 *   原样保留——stem 在 (预算 − 扩展名字节) 内截断（修复 botsService 旧 slice(0,120)
 *   字符口径：125 个 CJK 字符 = 360 字节击穿文件系统单段上限且丢扩展名）。
 * - Windows 保留名中和（含带扩展形态）：CON/PRN/AUX/NUL/COM1-9/LPT1-9——判定取
 *   输出首段（第一个点之前，先剥离段尾空格/点，与 Windows 匹配规则同构），命中则
 *   前置 `_`；判定必须在截断之后（截断可能新造保留名，如 "configuration" 截到
 *   "con"）。中和不依赖调用方前缀（缓存 digest 前缀只是偶合安全）。
 * - 控制字符（C0/C1/DEL）与路径分隔符及 Windows 禁用字符 `\/:*?"<>|` 逐字符替换
 *   为 `_`（botsService 旧行为口径，ASCII 预算内名字逐字节不变——零漂移）。
 * - 输出为空时回退 fallback（默认 "attachment"）。
 */

const UTF8_ENCODER = new TextEncoder();

/** Windows 保留设备名（大小写不敏感）：CON/PRN/AUX/NUL/COM1-9/LPT1-9。 */
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/** 控制字符（C0 U+0000-001F、DEL U+007F、C1 U+0080-009F）。 */
function isControlCodePoint(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** 路径分隔符 + Windows 禁用字符（botsService 旧消毒集，逐字符 `_` 替换）。 */
const NEUTRALIZED_FILENAME_CHARS = '\\/:*?"<>|';

function isNeutralizedFilenameChar(char: string): boolean {
  const code = char.codePointAt(0);
  return (
    code === undefined || isControlCodePoint(code) || NEUTRALIZED_FILENAME_CHARS.includes(char)
  );
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

/** 按码点累积截断，绝不劈开多字节码点、绝不超过字节预算。 */
function truncateByUtf8Bytes(value: string, byteBudget: number): string {
  let result = "";
  let usedBytes = 0;
  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (usedBytes + charBytes > byteBudget) {
      break;
    }
    result += char;
    usedBytes += charBytes;
  }
  return result;
}

/**
 * Windows 保留名中和：输出首段（第一个点之前，剥离段尾空格/点后）命中保留名 →
 * 前置 `_`。前置后如超出预算，先按 (预算 − 1) 截断原名再前置（病态角落允许
 * 伤及扩展名，硬上界是输出总字节数 ≤ 预算）。
 */
function neutralizeWindowsReservedName(name: string, byteBudget: number): string {
  const firstDotIndex = name.indexOf(".");
  const firstSegment = firstDotIndex === -1 ? name : name.slice(0, firstDotIndex);
  const matchTarget = firstSegment.replace(/[ .]+$/u, "");
  if (!WINDOWS_RESERVED_NAME_PATTERN.test(matchTarget)) {
    return name;
  }
  const prefixed = `_${name}`;
  if (utf8ByteLength(prefixed) <= byteBudget) {
    return prefixed;
  }
  return `_${truncateByUtf8Bytes(name, byteBudget - 1)}`;
}

export interface ByteBudgetedFilenameOptions {
  /** 输出文件名段的 UTF-8 字节预算（含扩展名；≥1，非整数向下取整）。 */
  byteBudget: number;
  /** 输入全部被消毒/截断为空时的兜底名（默认 "attachment"；自身也受预算约束）。 */
  fallback?: string;
}

/** 把原始文件名消毒为 ≤ byteBudget UTF-8 字节的安全文件名段（契约见文件头）。 */
export function sanitizeByteBudgetedFilename(
  raw: string,
  options: ByteBudgetedFilenameOptions,
): string {
  const byteBudget = Math.max(1, Math.floor(options.byteBudget));
  const fallback = truncateByUtf8Bytes(options.fallback?.trim() || "attachment", byteBudget);
  const neutralized = Array.from(raw.trim())
    .map((char) => (isNeutralizedFilenameChar(char) ? "_" : char))
    .join("");
  if (!neutralized) {
    return fallback;
  }
  // 扩展名 = 最后一个点起的尾段（点不在首位、点后非空）；否则整名视为 stem。
  const lastDotIndex = neutralized.lastIndexOf(".");
  const extension =
    lastDotIndex > 0 && lastDotIndex < neutralized.length - 1
      ? neutralized.slice(lastDotIndex)
      : "";
  const stem = extension ? neutralized.slice(0, lastDotIndex) : neutralized;
  const stemByteBudget = byteBudget - utf8ByteLength(extension);
  let budgeted: string;
  if (stemByteBudget < 1) {
    // 病态形态：扩展名自身占满预算——整名按字节预算截断（扩展名可能被截，
    // 硬上界仍是输出 ≤ 预算字节）。
    budgeted = truncateByUtf8Bytes(neutralized, byteBudget);
  } else {
    budgeted = truncateByUtf8Bytes(stem, stemByteBudget) + extension;
  }
  if (!budgeted) {
    return fallback;
  }
  return neutralizeWindowsReservedName(budgeted, byteBudget);
}
