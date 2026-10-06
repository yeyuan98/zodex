import assert from "node:assert/strict";
import test from "node:test";
import {
  isVideoContainerBytes,
  sniffAttachmentContainer,
} from "../src/attachmentContainerSniff.ts";

/**
 * 契约（specs/bot-file-delivery.md「Inbound attachment gates (3.14.5 Alpha 6)」§5.15，
 * §7.32 owner 裁定）：无名附件按文件头 magic 指纹识别真实容器——mp4/mov 按 ftyp@4
 * brand 区分、webm/mkv 按 EBML+DocType、m4a、mp3（ID3 | 帧同步）、wav（RIFF..WAVE）、
 * ogg（OggS）；识别不出返回空对象（调用方维持无扩展名，不比今天更糟）。
 */

/** ftyp 容器（mp4：非 qt brand；mov：qt brand；m4a：M4A brand）。 */
function ftypBytes(brand: string): Uint8Array {
  const boxSize = [0x00, 0x00, 0x00, 0x20];
  const body = `ftyp${brand}mp42isomcontainer-payload`;
  return Uint8Array.from([...boxSize, ...ascii(body)]);
}

/** EBML 头（webm/mkv）：magic 1A45DFA3 + DocType 元素（ID 0x4282，1 字节长度）。 */
function ebmlBytes(docType: string): Uint8Array {
  return Uint8Array.from([
    0x1a,
    0x45,
    0xdf,
    0xa3,
    0x8f,
    0x42,
    0x82,
    docType.length,
    ...docType.split("").map((char) => char.charCodeAt(0)),
    ..."ebml-payload".split("").map((char) => char.charCodeAt(0)),
  ]);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text.split("").map((char) => char.charCodeAt(0)));
}

test("ftyp 指纹：非 qt brand → mp4；qt brand → mov；M4A brand → m4a", () => {
  assert.deepEqual(sniffAttachmentContainer(ftypBytes("isom")), {
    extension: ".mp4",
    mimeType: "video/mp4",
  });
  assert.deepEqual(sniffAttachmentContainer(ftypBytes("mp42")), {
    extension: ".mp4",
    mimeType: "video/mp4",
  });
  assert.deepEqual(sniffAttachmentContainer(ftypBytes("qt  ")), {
    extension: ".mov",
    mimeType: "video/quicktime",
  });
  assert.deepEqual(sniffAttachmentContainer(ftypBytes("M4A ")), {
    extension: ".m4a",
    mimeType: "audio/mp4",
  });
});

test("EBML 指纹：DocType webm → webm；matroska → mkv；其它 DocType → 未知", () => {
  assert.deepEqual(sniffAttachmentContainer(ebmlBytes("webm")), {
    extension: ".webm",
    mimeType: "video/webm",
  });
  assert.deepEqual(sniffAttachmentContainer(ebmlBytes("matroska")), {
    extension: ".mkv",
    mimeType: "video/x-matroska",
  });
  assert.deepEqual(sniffAttachmentContainer(ebmlBytes("unknown-doctype-x")), {});
});

test("RIFF/WAVE → wav；OggS → ogg；ID3 → mp3；MPEG 帧同步 → mp3", () => {
  const wav = Uint8Array.from([
    ..."RIFF".split("").map((char) => char.charCodeAt(0)),
    0x30,
    0x00,
    0x00,
    0x00,
    ..."WAVE".split("").map((char) => char.charCodeAt(0)),
    ..."fmt ".split("").map((char) => char.charCodeAt(0)),
  ]);
  assert.deepEqual(sniffAttachmentContainer(wav), {
    extension: ".wav",
    mimeType: "audio/wav",
  });
  assert.deepEqual(sniffAttachmentContainer(ascii("OggS payload")), {
    extension: ".ogg",
    mimeType: "audio/ogg",
  });
  assert.deepEqual(sniffAttachmentContainer(ascii("ID3\u0003\u0000tagged-mp3")), {
    extension: ".mp3",
    mimeType: "audio/mpeg",
  });
  assert.deepEqual(sniffAttachmentContainer(Uint8Array.of(0xff, 0xfb, 0x90, 0x00)), {
    extension: ".mp3",
    mimeType: "audio/mpeg",
  });
});

test("RIFF 但非 WAVE（如 AVI 的 WAVE 未命中）→ 未知；乱码/空/截断 → 未知", () => {
  assert.deepEqual(sniffAttachmentContainer(ascii("RIFFxxxxAVI fmt")), {});
  assert.deepEqual(sniffAttachmentContainer(ascii("definitely-not-a-media-container")), {});
  assert.deepEqual(sniffAttachmentContainer(new Uint8Array(0)), {});
  assert.deepEqual(sniffAttachmentContainer(ascii("ID")), {});
  assert.deepEqual(sniffAttachmentContainer(ascii("ftyp")), {});
});

test("帧同步命中但 version/layer 为保留取值 → 未知（[ulw] 评审加固）", () => {
  // 0xE8 = sync 111 + version 01(reserved) + layer 10；0xE1 = sync 111 + version 00(2.5 合法) + layer 00(reserved)。
  // 随机二进制约 1/2048 会撞上裸帧同步——保留位校验把它们挡在门外。
  assert.deepEqual(sniffAttachmentContainer(Uint8Array.of(0xff, 0xe8, 0x00, 0x00)), {});
  assert.deepEqual(sniffAttachmentContainer(Uint8Array.of(0xff, 0xe1, 0x00, 0x00)), {});
});

test("isVideoContainerBytes（Alpha 9 fix 4b）：sniff 表视频容器 → true", () => {
  // 契约：prompt 内联 video 守卫只认正判的视频容器（mimeType video/*）。
  assert.equal(isVideoContainerBytes(ftypBytes("isom")), true);
  assert.equal(isVideoContainerBytes(ftypBytes("qt  ")), true);
  assert.equal(isVideoContainerBytes(ebmlBytes("webm")), true);
  assert.equal(isVideoContainerBytes(ebmlBytes("matroska")), true);
});

test("isVideoContainerBytes：音频容器（mp3/wav/ogg/m4a）→ false", () => {
  // 表内能识别但不是视频：音频容器绝不放过——video 块只承载视频字节。
  assert.equal(isVideoContainerBytes(ascii("ID3\u0003\u0000tagged-mp3")), false);
  assert.equal(
    isVideoContainerBytes(
      Uint8Array.from([
        ..."RIFF".split("").map((char) => char.charCodeAt(0)),
        0x30,
        0x00,
        0x00,
        0x00,
        ..."WAVE".split("").map((char) => char.charCodeAt(0)),
        ..."fmt ".split("").map((char) => char.charCodeAt(0)),
      ]),
    ),
    false,
  );
  assert.equal(isVideoContainerBytes(ascii("OggS payload")), false);
  assert.equal(isVideoContainerBytes(ftypBytes("M4A ")), false);
});

test("isVideoContainerBytes：AVI/RIFF（表外真容器）与乱码/空 → false", () => {
  // 披露成本 (a)：表外真视频容器（AVI）同样判 false，prompt 侧降级路径注记；
  // 乱码/空字节自然也是 false——守卫语义是「仅正判放行」。
  assert.equal(isVideoContainerBytes(ascii("RIFF\x24\x00\x00\x00AVI LISTmovi-payload")), false);
  assert.equal(isVideoContainerBytes(ascii("definitely-not-a-media-container")), false);
  assert.equal(isVideoContainerBytes(new Uint8Array(0)), false);
});
