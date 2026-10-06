import assert from "node:assert/strict";
import test from "node:test";
import { createRootTraceContext, type SessionId, type TurnId } from "@zcode/contracts";
import {
  resolveInlineMediaAttachment,
  resolveLocalMediaAttachment,
} from "../src/runtime/helpers/attachment-media-resolver.js";
import type { FileSystemPort, TurnAttachment } from "../src/runtime/deps.js";
import type { ResolvedTurnAttachment } from "../src/runtime/types.js";

// specs/bot-file-delivery.md「Pseudo-extension sniff, feishu kind-aware keys &
// prompt inline video validation (3.14.5 Alpha 9)」fix 4b 红测试：
// prompt 内联 video 分支必须做字节正判——非已知视频容器（按共享 sniff 表
// mp4/mov/webm/mkv）绝不发射 video 块，降级为文本路径注记
// （resolvedPathReferenceAttachment 形态）。证据：§2j F1 飞书视频消息被
// image_key 优先 bug 下载成 62,710B WebP 封面，prompt 路径以 video/mp4 内联，
// GLM 对垃圾字节回 [1210][视频输入格式/解析错误]，且毒块滞留会话历史继续毒害
// 后续真视频。先例 = PDF 分支 isPdfBytes 守卫（本地 :295 + inline
// parseInlinePdfDataUrl）。
//
// 驱动方式（alpha.5 clamp-test 先例）：直接驱动两个被测分支的导出入口，断言
// 【可观测的解析产物】——contentBlock 形态与 storageKind——不导入尚不存在的
// isVideoContainerBytes（那是 W2 的实现面）。今天的代码对任何非零字节都发射
// video 块 ⇒ (a)/(b)/(d) 必红；(c)/(e) 是守护钉（防 W2 过度降级）。

const WORKING_DIRECTORY = "/tmp/zcode-alpha9-video-guard";

/** ftyp 容器（isom brand → sniff 表命中 mp4）。 */
function mp4Bytes(): Uint8Array {
  return Uint8Array.from([0x00, 0x00, 0x00, 0x20, ...ascii("ftypisommp42isomcontainer-payload")]);
}

/** WebP：RIFF 头 + WEBP 标识——§2j 实锤的「封面字节」形状，不在 sniff 表。 */
function webpBytes(): Uint8Array {
  return Uint8Array.from([
    ...ascii("RIFF"),
    0x24,
    0x00,
    0x00,
    0x00,
    ...ascii("WEBPVP8 fake-cover"),
  ]);
}

/** AVI：RIFF 头 + AVI 标识——真实视频容器，但不在 sniff 表（披露成本 a）。 */
function aviBytes(): Uint8Array {
  return Uint8Array.from([
    ...ascii("RIFF"),
    0x24,
    0x00,
    0x00,
    0x00,
    ...ascii("AVI LISTmovi-payload"),
  ]);
}

function pdfBytes(): Uint8Array {
  return ascii("%PDF-1.4 fake pdf body for guard");
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text.split("").map((char) => char.charCodeAt(0)));
}

/** 仅实现被测路径所需的最小 FileSystemPort（stat + readBinaryFile）。 */
function fakeFileSystemPort(bytes: Uint8Array): FileSystemPort {
  return {
    stat: async (request: { path: string }) => ({
      path: request.path,
      kind: "file",
      sizeBytes: bytes.byteLength,
    }),
    readBinaryFile: async (request: { path: string }) => ({
      path: request.path,
      content: bytes,
      bytesRead: bytes.byteLength,
      sizeBytes: bytes.byteLength,
    }),
  } as unknown as FileSystemPort;
}

function traceOptionsForCall(): { traceContext: ReturnType<typeof createRootTraceContext> } {
  return {
    traceContext: createRootTraceContext({
      sessionId: "sess_alpha9_video" as SessionId,
      turnId: "turn_alpha9_video" as TurnId,
    }),
  };
}

function localResolveOptions(bytes: Uint8Array) {
  return {
    fileSystemPort: fakeFileSystemPort(bytes),
    workingDirectory: WORKING_DIRECTORY,
    ...traceOptionsForCall(),
  };
}

function inlineResolveOptions() {
  return traceOptionsForCall();
}

/** 降级产物必须是「文本路径注记」形态：text 块 + local_ref 存储 + 路径措辞。 */
function assertPathNote(result: ResolvedTurnAttachment, label: string): void {
  assert.equal(
    result.contentBlock.type,
    "text",
    `${label}：非已知视频容器不得发射 video 块，必须降级为文本路径注记`,
  );
  assert.equal(
    result.metadata.storageKind,
    "local_ref",
    `${label}：降级形态 = resolvedPathReferenceAttachment（local_ref），不是占位符`,
  );
  if (result.contentBlock.type === "text") {
    assert.match(
      result.contentBlock.text,
      /sent by local path/u,
      `${label}：必须是路径注记文案（指路 agent 用读文件工具），不是占位符文案`,
    );
  }
}

// ---- (a)/(c)/(d)/(e)：本地字节分支 resolveLocalVideoAttachment / PDF 分支 ----

test("A9 8a 本地分支：WebP 字节命名 .mp4 且 kind=video → 不得内联为 video 块，降级文本路径注记（今天内联垃圾字节 → 红）", async () => {
  // §2j F1 的确切形状：文件名/扩展名与 mimeType 都说是视频，字节却是 WebP 封面。
  const attachment: TurnAttachment = { type: "video", path: `${WORKING_DIRECTORY}/clip.mp4` };
  const result = await resolveLocalMediaAttachment(attachment, 0, localResolveOptions(webpBytes()));
  assertPathNote(result, "本地分支 WebP-as-mp4");
});

test("A9 8c 本地分支守护：真 MP4 字节 + kind=video → 照常内联 video 块（与今天一致）", async () => {
  const attachment: TurnAttachment = { type: "video", path: `${WORKING_DIRECTORY}/real.mp4` };
  const result = await resolveLocalMediaAttachment(attachment, 0, localResolveOptions(mp4Bytes()));
  assert.equal(result.contentBlock.type, "video", "真容器视频必须照常内联");
  if (result.contentBlock.type === "video") {
    assert.equal(result.contentBlock.mediaType, "video/mp4");
  }
});

test("A9 8d 本地分支：AVI 字节（RIFF/AVI，不在 sniff 表）→ 降级路径注记（披露成本 a 的守护钉；今天内联 → 红）", async () => {
  // spec 披露成本 (a)：表外【真】视频容器同样走路径注记——agent Read 工具
  //（read-video + transform 自行识别扩展名/字节）晚一跳仍可读。此用例钉住
  // 该【有意】行为，防止 W2 只对「乱码」降级而漏掉表外真容器。
  const attachment: TurnAttachment = { type: "video", path: `${WORKING_DIRECTORY}/clip.avi` };
  const result = await resolveLocalMediaAttachment(attachment, 0, localResolveOptions(aviBytes()));
  assertPathNote(result, "本地分支 AVI");
});

test("A9 8e 本地分支守护：PDF 路径行为不变（真 PDF 字节 → file 块照常内联）", async () => {
  // 守卫不过度 reach：视频字节守卫不得影响既有 PDF isPdfBytes 分支。
  const attachment: TurnAttachment = { type: "pdf", path: `${WORKING_DIRECTORY}/doc.pdf` };
  const result = await resolveLocalMediaAttachment(attachment, 0, localResolveOptions(pdfBytes()));
  assert.equal(result.contentBlock.type, "file", "PDF 分支必须照常内联 file 块");
  if (result.contentBlock.type === "file") {
    assert.equal(result.contentBlock.mediaType, "application/pdf");
  }
});

// ---- (b)：inline/dataUrl 分支 resolveInlineMediaAttachment（resume/replay 形状）----
// 该分支覆盖恢复/重放与 dataBase64 透传；不设守卫则毒块经 replay 通道继续入模。

test("A9 8b inline 分支：dataUrl 载荷为 WebP 字节（video/mp4 头）→ 同样降级路径注记（今天内联 → 红）", async () => {
  const dataUrl = `data:video/mp4;base64,${Buffer.from(webpBytes()).toString("base64")}`;
  const attachment: TurnAttachment = { type: "video", content: dataUrl };
  const result = await resolveInlineMediaAttachment(
    attachment,
    0,
    "video/mp4",
    inlineResolveOptions(),
  );
  assert.ok(result, "inline video 分支必须产出解析结果");
  assertPathNote(result, "inline 分支 WebP-as-video/mp4");
});

test("A9 8b inline 分支守护：真 MP4 字节 dataUrl → 照常内联 video 块（与今天一致）", async () => {
  const dataUrl = `data:video/mp4;base64,${Buffer.from(mp4Bytes()).toString("base64")}`;
  const attachment: TurnAttachment = { type: "video", content: dataUrl };
  const result = await resolveInlineMediaAttachment(
    attachment,
    0,
    "video/mp4",
    inlineResolveOptions(),
  );
  assert.ok(result, "inline video 分支必须产出解析结果");
  assert.equal(result.contentBlock.type, "video", "真容器视频 dataUrl 必须照常内联");
  if (result.contentBlock.type === "video") {
    assert.equal(result.contentBlock.mediaType, "video/mp4");
  }
});
