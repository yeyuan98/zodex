/**
 * 入站附件容器 sniff（specs/bot-file-delivery.md「Inbound attachment gates
 * (3.14.5 Alpha 6)」§5.15；§7.32 owner 裁定：按文件头指纹识别，不硬编码 per-kind
 * 扩展名）。
 *
 * 纯函数、零 IO：输入已在本内存中的文件字节（下载完成、写缓存前），输出识别出的
 * 容器 `{extension, mimeType}`；识别不出返回空对象（调用方维持无扩展名现状，
 * 不比今天更糟）。magic 表：
 *
 * | container | fingerprint                                  | extension | mimeType           |
 * | --------- | -------------------------------------------- | --------- | ------------------ |
 * | mp4       | `ftyp` at offset 4, brand ≠ qt               | `.mp4`    | `video/mp4`        |
 * | mov       | `ftyp` at offset 4, brand `qt  `             | `.mov`    | `video/quicktime`  |
 * | webm      | EBML header (`1A 45 DF A3`) + DocType `webm` | `.webm`   | `video/webm`       |
 * | mkv       | EBML header + DocType `matroska`             | `.mkv`    | `video/x-matroska` |
 * | m4a       | `ftyp` at offset 4, brand `M4A `             | `.m4a`    | `audio/mp4`        |
 * | mp3       | `ID3` at offset 0 or MPEG audio frame sync   | `.mp3`    | `audio/mpeg`       |
 * | wav       | `RIFF` at offset 0 + `WAVE` at offset 8      | `.wav`    | `audio/wav`        |
 * | ogg       | `OggS` at offset 0                           | `.ogg`    | `audio/ogg`        |
 */

/** 识别结果：两个键同时出现或同时缺席（缺席 = 未知容器，维持现状）。 */
export interface SniffedAttachmentContainer {
  extension?: string;
  mimeType?: string;
}

/** EBML DocType 元素（ID 0x4282）在文件头部的扫描窗口：真实 webm/mkv 均落在前 64 字节内。 */
const EBML_DOCTYPE_SCAN_LIMIT = 64;

function readAscii(data: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length && offset + index < data.length; index += 1) {
    text += String.fromCharCode(data[offset + index]!);
  }
  return text;
}

function hasAsciiPrefix(data: Uint8Array, offset: number, text: string): boolean {
  if (data.length < offset + text.length) {
    return false;
  }
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/** 在 EBML 头部扫描窗内读取 DocType（元素 ID 0x4282 + 1 字节长度 + 值）；读不到返回 null。 */
function readEbmlDocType(data: Uint8Array): string | null {
  const scanEnd = Math.min(data.length, EBML_DOCTYPE_SCAN_LIMIT);
  for (let offset = 4; offset + 3 < scanEnd; offset += 1) {
    if (data[offset] !== 0x42 || data[offset + 1] !== 0x82) {
      continue;
    }
    const size = data[offset + 2]!;
    if (size === 0 || size > 32 || offset + 3 + size > data.length) {
      return null;
    }
    return readAscii(data, offset + 3, size);
  }
  return null;
}

/**
 * 按文件头 magic 指纹识别常见媒体容器。仅做指纹判定，不解析结构——
 * 结果用于「无扩展名兜底命名的入站附件」补扩展名 + 修正兜底 mimeType。
 */
export function sniffAttachmentContainer(data: Uint8Array): SniffedAttachmentContainer {
  // EBML 家族（webm/mkv）必须先于其它判定：4 字节 magic + DocType 区分。
  if (
    data.length >= 4 &&
    data[0] === 0x1a &&
    data[1] === 0x45 &&
    data[2] === 0xdf &&
    data[3] === 0xa3
  ) {
    const docType = readEbmlDocType(data);
    if (docType === "webm") {
      return { extension: ".webm", mimeType: "video/webm" };
    }
    if (docType === "matroska") {
      return { extension: ".mkv", mimeType: "video/x-matroska" };
    }
    return {};
  }
  // ISO BMFF 家族：ftyp box 在 offset 4，major brand 在 offset 8（qt → mov、M4A → m4a、其余 → mp4）。
  if (data.length >= 12 && hasAsciiPrefix(data, 4, "ftyp")) {
    const brand = readAscii(data, 8, 4);
    if (brand === "qt  ") {
      return { extension: ".mov", mimeType: "video/quicktime" };
    }
    if (brand === "M4A ") {
      return { extension: ".m4a", mimeType: "audio/mp4" };
    }
    return { extension: ".mp4", mimeType: "video/mp4" };
  }
  if (hasAsciiPrefix(data, 0, "RIFF") && hasAsciiPrefix(data, 8, "WAVE")) {
    return { extension: ".wav", mimeType: "audio/wav" };
  }
  if (hasAsciiPrefix(data, 0, "OggS")) {
    return { extension: ".ogg", mimeType: "audio/ogg" };
  }
  if (hasAsciiPrefix(data, 0, "ID3")) {
    return { extension: ".mp3", mimeType: "audio/mpeg" };
  }
  // MPEG audio 帧同步：首字节 0xFF + 次字节高 3 位全 1（11 个连续 1 的 frame sync）。
  if (data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0) {
    return { extension: ".mp3", mimeType: "audio/mpeg" };
  }
  return {};
}
