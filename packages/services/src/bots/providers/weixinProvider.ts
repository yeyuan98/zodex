/* eslint-disable max-lines -- 微信 iLink provider 集中处理轮询、文本/媒体解析、发送和 typing 协议。 */
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundAttachment,
  BotOutboundMessage,
} from "@zcode/shared";
import type { BotProviderAdapter, BotTypingTarget } from "./types.js";
import type { BotProviderRequester } from "#src/bots/providers/providerRequest.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

// F10（specs/bot-message-delivery.md）：ret=-2 无 token 重试等 provider 侧关键事件可观测。
const weixinLogger = createServiceLogger("bots");

export const DEFAULT_WEIXIN_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_BOT_API_PREFIX = "/ilink/bot";
const WEIXIN_CHANNEL_VERSION = "2.0.0";
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_MESSAGE_STATE_FINISH = 2;
const WEIXIN_CDN_AES_ALGORITHM = "aes-128-ecb";
const WEIXIN_GET_UPDATES_TIMEOUT_MS = 90_000;
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const WEIXIN_CDN_UPLOAD_MAX_RETRIES = 3;
const WEIXIN_CDN_UPLOAD_TIMEOUT_MS = 60_000;
// 与服务层 BOT_MAX_ATTACHMENT_SIZE_BYTES 对齐；provider 侧读取时兜底校验。
const WEIXIN_OUTBOUND_MAX_BYTES = 5 * 1024 * 1024;
// 出站媒体链路（getuploadurl/CDN/sendmessage 媒体项）按 2026-09-29 生产环境实测值声明：
// 官方参考实现 @tencent-weixin/openclaw-weixin@2.4.2 的协议版本与 bot_agent（specs/bot-file-delivery.md §5）。
const WEIXIN_MEDIA_CHANNEL_VERSION = "2.4.2";
const WEIXIN_MEDIA_BOT_AGENT = "Zodex/1.0";
const WEIXIN_UPLOAD_MEDIA_TYPE = { image: 1, video: 2, file: 3 } as const;
const WEIXIN_MESSAGE_ITEM_TYPE = { text: 1, image: 2, file: 4, video: 5 } as const;
// 文本 /sendmessage 与其它调用对齐的显式 deadline（specs/bot-provider-network.md Alpha 1 F4）：
// 无界请求会占住 actor 串行队列。
const WEIXIN_SEND_TEXT_TIMEOUT_MS = 15_000;

interface WeixinProviderDeps {
  loadCredential(key: string): Promise<string | null>;
  /** 全部微信 iLink/CDN 出站请求的唯一出口（specs/bot-provider-network.md F1）。 */
  requester: BotProviderRequester;
}

interface WeixinGetUpdatesResult {
  messages: BotInboundMessage[];
  rawMessageDiagnostics?: string[];
  rawMessageCount?: number;
  buf?: string;
}

interface WeixinTestResponse {
  contact?: unknown;
  self?: unknown;
  profile?: unknown;
  ret?: number;
  typing_ticket?: string;
  /** alpha.2 探针观测点：getconfig 响应是否携带 context_token（只记布尔，永不记值）。 */
  context_token?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberOrString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = record?.[key];
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function parseWeixinAesKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (/^[a-f0-9]{32}$/iu.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 16) {
      return decoded;
    }
    const decodedText = decoded.toString("utf8").trim();
    if (/^[a-f0-9]{32}$/iu.test(decodedText)) {
      return Buffer.from(decodedText, "hex");
    }
  } catch {
    return null;
  }
  return null;
}

function decryptWeixinCdnMedia(data: Uint8Array, aesKey: string): Uint8Array {
  const key = parseWeixinAesKey(aesKey);
  if (!key) {
    throw new Error("Weixin attachment AES key is invalid.");
  }
  // 微信 iLink CDN 返回 AES-128-ECB + PKCS7 padding 的密文字节；直接保存会得到不可识别的 data 文件。
  const decipher = createDecipheriv(WEIXIN_CDN_AES_ALGORITHM, key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function encryptWeixinCdnMedia(data: Uint8Array, aesKey: Buffer): Buffer {
  // 入站解密的镜像：出站媒体同样以 AES-128-ECB + PKCS7 密文上传 CDN（specs/bot-file-delivery.md §5.3）。
  const cipher = createCipheriv(WEIXIN_CDN_AES_ALGORITHM, aesKey, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** 供测试与协议校验使用：AES-ECB 密文长度（PKCS7 补齐到 16 字节边界）。 */
export function weixinCdnPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** 协议不变量（specs/bot-file-delivery.md §5.1）：aes_key 是 hex 字符串的 base64，不是原始 16 字节 key 的 base64。 */
export function encodeWeixinMediaAesKey(aesKeyHex: string): string {
  return Buffer.from(aesKeyHex, "utf8").toString("base64");
}

export function encryptWeixinCdnMediaForTest(data: Uint8Array, aesKeyHex: string): Buffer {
  const key = parseWeixinAesKey(aesKeyHex);
  if (!key) {
    throw new Error("Weixin attachment AES key is invalid.");
  }
  return encryptWeixinCdnMedia(data, key);
}

function encodeWeixinMediaClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function getWeixinApiBaseUrl(): string {
  // 微信 iLink 是内置通道地址，不应复用 webhookUrl，否则旧配置会把出站 Webhook 当成微信 API。
  return DEFAULT_WEIXIN_ILINK_BASE_URL.replace(/\/+$/u, "");
}

async function readAccessToken(bot: BotConfig, deps: WeixinProviderDeps): Promise<string | null> {
  return bot.credentialRef ? deps.loadCredential(bot.credentialRef) : null;
}

function buildRandomWechatUin(): string {
  return Buffer.from(String(randomInt(0, 0x1_0000_0000)), "utf8").toString("base64");
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": buildRandomWechatUin(),
  };
}

function appendBaseInfo(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  return {
    base_info: { channel_version: WEIXIN_CHANNEL_VERSION },
    ...body,
  };
}

async function requestWeixinJson(
  bot: BotConfig,
  deps: WeixinProviderDeps,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<unknown> {
  const token = await readAccessToken(bot, deps);
  if (!token?.trim()) {
    throw new Error("Weixin iLink bot token is missing. Scan the Weixin login QR code first.");
  }
  const response = await deps.requester.fetchBotProviderJson<unknown>(
    `${getWeixinApiBaseUrl()}${WEIXIN_BOT_API_PREFIX}${path}`,
    {
      method: "POST",
      headers: buildHeaders(token.trim()),
      body: JSON.stringify(appendBaseInfo(body ?? {})),
      signal,
    },
    timeoutMs,
  );
  if (!response.ok) {
    const error = new Error(`Weixin iLink ${path} failed: HTTP ${response.status}`);
    // alpha.2 观测（specs/bot-provider-network.md amendment）：HTTP 状态码打标，
    // 上层日志与分类器按字段读取，不解析 message 文本。
    (error as Error & { weixinHttpStatus?: number }).weixinHttpStatus = response.status;
    throw error;
  }
  const payload = response.payload;
  const data = isRecord(payload) ? payload : null;
  const ret = readNumber(data, "ret");
  const errcode = readNumber(data, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const message =
      readString(data, "errmsg") ||
      readString(data, "message") ||
      `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim();
    const error = new Error(`Weixin iLink ${path} failed: ${message}`);
    // Bugfix（specs/bot-provider-network.md Alpha 1 F4）：文本路径此前不带 weixinRet 标记，
    // 调用方无法按协议 ret 码分支；与 requestWeixinMediaJson 对齐打标，文本 /sendmessage
    // 的 ret=-2 无 token 重试依赖它。alpha.2 追加 weixinErrcode（此前只进 message）。
    (error as Error & { weixinRet?: number }).weixinRet = ret ?? undefined;
    (error as Error & { weixinErrcode?: number }).weixinErrcode = errcode ?? undefined;
    throw error;
  }
  return payload;
}

function unwrapData(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  if ("data" in payload) {
    return payload.data;
  }
  return payload;
}

function buildMediaHeaders(token: string): Record<string, string> {
  // 出站媒体链路按实测要求额外携带 iLink-App-Id / iLink-App-ClientVersion（specs/bot-file-delivery.md §5.6）。
  return {
    ...buildHeaders(token),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(encodeWeixinMediaClientVersion(WEIXIN_MEDIA_CHANNEL_VERSION)),
  };
}

function buildMediaBaseInfo(): Record<string, unknown> {
  return {
    channel_version: WEIXIN_MEDIA_CHANNEL_VERSION,
    bot_agent: WEIXIN_MEDIA_BOT_AGENT,
  };
}

async function requestWeixinMediaJson(
  bot: BotConfig,
  deps: WeixinProviderDeps,
  path: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const token = await readAccessToken(bot, deps);
  if (!token?.trim()) {
    throw new Error("Weixin iLink bot token is missing. Scan the Weixin login QR code first.");
  }
  const response = await deps.requester.fetchBotProviderJson<unknown>(
    `${getWeixinApiBaseUrl()}${WEIXIN_BOT_API_PREFIX}${path}`,
    {
      method: "POST",
      headers: buildMediaHeaders(token.trim()),
      body: JSON.stringify({
        base_info: buildMediaBaseInfo(),
        ...body,
      }),
    },
    timeoutMs,
  );
  if (!response.ok) {
    const error = new Error(`Weixin iLink ${path} failed: HTTP ${response.status}`);
    (error as Error & { weixinHttpStatus?: number }).weixinHttpStatus = response.status;
    throw error;
  }
  const payload = response.payload;
  const data = isRecord(payload) ? payload : null;
  const ret = readNumber(data, "ret");
  const errcode = readNumber(data, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const message =
      readString(data, "errmsg") ||
      readString(data, "message") ||
      `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim();
    const error = new Error(`Weixin iLink ${path} failed: ${message}`);
    (error as Error & { weixinRet?: number }).weixinRet = ret ?? undefined;
    (error as Error & { weixinErrcode?: number }).weixinErrcode = errcode ?? undefined;
    throw error;
  }
  return data ?? {};
}

/** getuploadurl 请求体（base_info 由 requestWeixinMediaJson 统一附加）。供测试校验线上协议形状。 */
export function buildWeixinUploadRequestBody(params: {
  filekey: string;
  mediaType: (typeof WEIXIN_UPLOAD_MEDIA_TYPE)[keyof typeof WEIXIN_UPLOAD_MEDIA_TYPE];
  toUserId: string;
  rawSize: number;
  rawFileMd5: string;
  /** AES-128-ECB + PKCS7 补齐后的密文大小。 */
  ciphertextSize: number;
  aesKeyHex: string;
}): Record<string, unknown> {
  return {
    filekey: params.filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: params.rawSize,
    rawfilemd5: params.rawFileMd5,
    filesize: params.ciphertextSize,
    no_need_thumb: true,
    aeskey: params.aesKeyHex,
  };
}

/** 媒体 item 形状（specs/bot-file-delivery.md §5）：len 是明文大小的字符串，mid_size/video_size 是密文大小。 */
export function buildWeixinMediaItem(params: {
  kind: BotOutboundAttachment["kind"];
  filename: string;
  rawSize: number;
  ciphertextSize: number;
  downloadParam: string;
  aesKeyHex: string;
}): Record<string, unknown> {
  const media = {
    encrypt_query_param: params.downloadParam,
    aes_key: encodeWeixinMediaAesKey(params.aesKeyHex),
    encrypt_type: 1,
  };
  if (params.kind === "image") {
    return {
      type: WEIXIN_MESSAGE_ITEM_TYPE.image,
      image_item: { media, mid_size: params.ciphertextSize },
    };
  }
  if (params.kind === "video") {
    return {
      type: WEIXIN_MESSAGE_ITEM_TYPE.video,
      video_item: { media, video_size: params.ciphertextSize },
    };
  }
  return {
    type: WEIXIN_MESSAGE_ITEM_TYPE.file,
    file_item: { media, file_name: params.filename, len: String(params.rawSize) },
  };
}

async function getWeixinUploadUrl(params: {
  bot: BotConfig;
  deps: WeixinProviderDeps;
  filekey: string;
  mediaType: (typeof WEIXIN_UPLOAD_MEDIA_TYPE)[keyof typeof WEIXIN_UPLOAD_MEDIA_TYPE];
  toUserId: string;
  rawSize: number;
  rawFileMd5: string;
  ciphertextSize: number;
  aesKeyHex: string;
}): Promise<{ uploadFullUrl?: string; uploadParam?: string }> {
  const payload = await requestWeixinMediaJson(
    params.bot,
    params.deps,
    "/getuploadurl",
    buildWeixinUploadRequestBody(params),
  );
  const uploadFullUrl = readString(payload, "upload_full_url").trim();
  const uploadParam = readString(payload, "upload_param").trim();
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`Weixin iLink getuploadurl returned no upload URL.`);
  }
  return {
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam || undefined,
  };
}

async function uploadWeixinCdnBuffer(params: {
  deps: WeixinProviderDeps;
  plaintext: Uint8Array;
  aesKey: Buffer;
  filekey: string;
  uploadFullUrl?: string;
  uploadParam?: string;
}): Promise<{ downloadParam: string; ciphertextSize: number }> {
  const ciphertext = encryptWeixinCdnMedia(params.plaintext, params.aesKey);
  const cdnUrl =
    params.uploadFullUrl ??
    `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam ?? "")}&filekey=${encodeURIComponent(params.filekey)}`;
  if (!params.uploadFullUrl && !params.uploadParam) {
    throw new Error("Weixin CDN upload URL missing.");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= WEIXIN_CDN_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const response = await params.deps.requester.fetchBotProviderWithHeaders(
        cdnUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
        },
        WEIXIN_CDN_UPLOAD_TIMEOUT_MS,
      );
      if (response.status >= 400 && response.status < 500) {
        // CDN 4xx 是协议/参数错误，重试只会重复失败；错误细节在 x-error-message 头里。
        throw new Error(
          `Weixin CDN upload client error: HTTP ${response.status} ${response.headers["x-error-message"] ?? ""}`.trim(),
        );
      }
      if (!response.ok) {
        throw new Error(`Weixin CDN upload server error: HTTP ${response.status}`);
      }
      const downloadParam = response.headers["x-encrypted-param"];
      if (!downloadParam) {
        throw new Error("Weixin CDN upload response missing x-encrypted-param header.");
      }
      return { downloadParam, ciphertextSize: ciphertext.length };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /client error/u.test(error.message)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Weixin CDN upload failed.");
}

async function sendWeixinMediaItem(params: {
  bot: BotConfig;
  deps: WeixinProviderDeps;
  toUserId: string;
  contextToken?: string;
  item: Record<string, unknown>;
}): Promise<void> {
  const buildBody = (contextToken: string | undefined): Record<string, unknown> => ({
    msg: {
      from_user_id: params.bot.providerUserId ?? "",
      to_user_id: params.toUserId,
      client_id: buildWeixinClientId(),
      message_type: WEIXIN_MESSAGE_TYPE_BOT,
      message_state: WEIXIN_MESSAGE_STATE_FINISH,
      ...(contextToken ? { context_token: contextToken } : {}),
      item_list: [params.item],
    },
  });
  try {
    await requestWeixinMediaJson(
      params.bot,
      params.deps,
      "/sendmessage",
      buildBody(params.contextToken),
    );
    return;
  } catch (error) {
    // ret=-2 prepare failed = context_token 过期（实测：约 40 分钟后失效）。
    // 参考实现的既定行为是去掉 token 重试一次；仍失败则上抛，由服务层降级为文本提示。
    const weixinRet = (error as { weixinRet?: number }).weixinRet;
    if (weixinRet === -2 && params.contextToken) {
      await requestWeixinMediaJson(params.bot, params.deps, "/sendmessage", buildBody(undefined));
      return;
    }
    throw error;
  }
}

async function uploadAndSendWeixinAttachment(params: {
  bot: BotConfig;
  deps: WeixinProviderDeps;
  toUserId: string;
  contextToken?: string;
  maxBytes: number;
  attachment: BotOutboundAttachment;
}): Promise<void> {
  const plaintext = await readFile(params.attachment.localPath);
  if (plaintext.length > params.maxBytes) {
    // resolveWorkspaceFilePath 的 stat 与 provider readFile 之间存在窗口；
    // 文件在窗口期增长时必须在读取侧再拦一次大小上限。
    throw new Error(
      `${params.attachment.filename} exceeds ${Math.floor(params.maxBytes / 1024 / 1024)}MB.`,
    );
  }
  const rawSize = plaintext.length;
  const rawFileMd5 = createHash("md5").update(plaintext).digest("hex");
  const ciphertextSize = weixinCdnPaddedSize(rawSize);
  const filekey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const upload = await getWeixinUploadUrl({
    bot: params.bot,
    deps: params.deps,
    filekey,
    mediaType: WEIXIN_UPLOAD_MEDIA_TYPE[params.attachment.kind],
    toUserId: params.toUserId,
    rawSize,
    rawFileMd5,
    ciphertextSize,
    aesKeyHex,
  });
  const { downloadParam } = await uploadWeixinCdnBuffer({
    deps: params.deps,
    plaintext,
    aesKey,
    filekey,
    uploadFullUrl: upload.uploadFullUrl,
    uploadParam: upload.uploadParam,
  });
  const item = buildWeixinMediaItem({
    kind: params.attachment.kind,
    filename: params.attachment.filename,
    rawSize,
    ciphertextSize,
    downloadParam,
    aesKeyHex,
  });
  await sendWeixinMediaItem({
    bot: params.bot,
    deps: params.deps,
    toUserId: params.toUserId,
    contextToken: params.contextToken,
    item,
  });
}

function readMessagesContainer(payload: unknown): Record<string, unknown> {
  const data = unwrapData(payload);
  return isRecord(data) ? data : {};
}

function readWeixinTextItem(item: unknown): string {
  if (!isRecord(item)) {
    return "";
  }
  const textItem = isRecord(item.text_item) ? item.text_item : null;
  return readString(textItem, "text") || readString(item, "text") || readString(item, "content");
}

function inferWeixinAttachmentKind(item: Record<string, unknown>): BotInboundAttachment["kind"] {
  if (isRecord(item.image_item)) {
    return "image";
  }
  const explicit =
    readString(item, "kind") ||
    readString(item, "media_type") ||
    readString(item, "mediaType") ||
    readString(item, "type_name");
  const mimeType = readString(item, "mime_type") || readString(item, "mimeType");
  const filename =
    readString(item, "filename") || readString(item, "file_name") || readString(item, "name");
  const normalized = `${explicit} ${mimeType} ${filename}`.toLowerCase();
  if (
    normalized.includes("image") ||
    normalized.includes("photo") ||
    normalized.includes("picture") ||
    /\.(svg|png|jpe?g|gif|webp|heic|bmp)$/iu.test(filename)
  ) {
    return "image";
  }
  if (normalized.includes("audio") || normalized.includes("voice")) {
    return "audio";
  }
  if (normalized.includes("video")) {
    return "video";
  }
  return "file";
}

function readWeixinAttachmentItem(item: unknown, index: number): BotInboundAttachment | null {
  if (!isRecord(item)) {
    return null;
  }
  if (readWeixinTextItem(item)) {
    return null;
  }
  const media = isRecord(item.image_item)
    ? item.image_item
    : isRecord(item.file_item)
      ? item.file_item
      : isRecord(item.video_item)
        ? item.video_item
        : isRecord(item.audio_item)
          ? item.audio_item
          : isRecord(item.media_item)
            ? item.media_item
            : item;
  const mediaPayload = isRecord(media.media) ? media.media : null;
  const mediaSource = mediaPayload ? { ...media, ...mediaPayload } : media;
  const providerFileId =
    readNumberOrString(mediaSource, "file_id") ||
    readNumberOrString(mediaSource, "fileId") ||
    readNumberOrString(mediaSource, "media_id") ||
    readNumberOrString(mediaSource, "mediaId") ||
    readNumberOrString(mediaSource, "id") ||
    readNumberOrString(mediaSource, "encrypt_query_param") ||
    readNumberOrString(mediaSource, "encryptQueryParam") ||
    // 微信图片消息的 image_item 只返回 media 字段，没有 file_id/md5；这里将 media 作为后续下载和去重的资源标识。
    readNumberOrString(mediaSource, "media") ||
    readNumberOrString(mediaSource, "md5");
  const downloadUrl =
    readString(mediaSource, "url") ||
    readString(mediaSource, "download_url") ||
    readString(mediaSource, "downloadUrl") ||
    // 微信 image_item.media 内的 full_url 是实际图片下载地址，旧逻辑只读 url/download_url 会把纯图片消息丢掉。
    readString(mediaSource, "full_url") ||
    readString(mediaSource, "fullUrl");
  const dataBase64 =
    readString(mediaSource, "data_base64") ||
    readString(mediaSource, "dataBase64") ||
    readString(mediaSource, "base64");
  if (!providerFileId && !downloadUrl && !dataBase64) {
    return null;
  }
  const kind = inferWeixinAttachmentKind({ ...item, ...mediaSource });
  // §5.15（§7.32）：兜底命名打标——容器 sniff 只允许改写兜底名，provider 给过的名不动。
  const providedFilename =
    readString(mediaSource, "filename") ||
    readString(mediaSource, "file_name") ||
    readString(mediaSource, "name");
  const filename =
    providedFilename ??
    (kind === "image" ? `weixin-image-${index + 1}.jpg` : `weixin-attachment-${index + 1}`);
  const mimeType =
    readString(mediaSource, "mime_type") ||
    readString(mediaSource, "mimeType") ||
    inferMimeTypeFromFilename(filename) ||
    (kind === "image"
      ? "image/jpeg"
      : kind === "audio"
        ? "audio/mpeg"
        : kind === "video"
          ? "video/mp4"
          : "application/octet-stream");
  const sizeBytes =
    readNumber(mediaSource, "size") ??
    readNumber(mediaSource, "sizeBytes") ??
    readNumber(mediaSource, "file_size") ??
    readNumber(mediaSource, "len") ??
    // image_item 没有通用 size 字段，mid_size 是实际图片资源大小，thumb_size 只用于缩略图预览。
    readNumber(mediaSource, "mid_size");
  const aesKey =
    readString(mediaSource, "aes_key") ||
    readString(mediaSource, "aesKey") ||
    readString(mediaSource, "aeskey");
  return {
    id: providerFileId || downloadUrl || `weixin-${index + 1}`,
    kind,
    filename,
    mimeType,
    ...(!providedFilename ? { filenameIsFallback: true } : {}),
    ...(sizeBytes ? { sizeBytes } : {}),
    ...(providerFileId ? { providerFileId } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(aesKey ? { providerMetadata: { weixinAesKey: aesKey } } : {}),
  };
}

function inferMimeTypeFromFilename(filename: string): string {
  if (/\.svg$/iu.test(filename)) {
    return "image/svg+xml";
  }
  if (/\.png$/iu.test(filename)) {
    return "image/png";
  }
  if (/\.jpe?g$/iu.test(filename)) {
    return "image/jpeg";
  }
  if (/\.gif$/iu.test(filename)) {
    return "image/gif";
  }
  if (/\.webp$/iu.test(filename)) {
    return "image/webp";
  }
  return "";
}

function readWeixinDirectAttachment(item: unknown, index: number): BotInboundAttachment | null {
  if (!isRecord(item)) {
    return null;
  }
  const kind = readString(item, "kind");
  if (kind !== "image" && kind !== "audio" && kind !== "video" && kind !== "file") {
    return null;
  }
  const id = readString(item, "id") || `weixin-${index + 1}`;
  const filename = readString(item, "filename") || `${id}.${kind}`;
  const mimeType =
    readString(item, "mimeType") ||
    readString(item, "mime_type") ||
    (kind === "image"
      ? "image/jpeg"
      : kind === "audio"
        ? "audio/mpeg"
        : kind === "video"
          ? "video/mp4"
          : "application/octet-stream");
  const sizeBytes = readNumber(item, "sizeBytes") ?? readNumber(item, "size");
  const providerFileId = readString(item, "providerFileId") || readString(item, "file_id");
  const downloadUrl = readString(item, "downloadUrl") || readString(item, "download_url");
  const dataBase64 = readString(item, "dataBase64") || readString(item, "data_base64");
  const providerMetadata = isRecord(item.providerMetadata)
    ? Object.fromEntries(
        Object.entries(item.providerMetadata).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : null;
  return {
    id,
    kind,
    filename,
    mimeType,
    ...(sizeBytes !== null ? { sizeBytes } : {}),
    ...(providerFileId ? { providerFileId } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(providerMetadata && Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {}),
  };
}

function readWeixinText(message: Record<string, unknown>): string {
  const text =
    readString(message, "text") || readString(message, "content") || readString(message, "message");
  if (text) {
    return text;
  }
  const inner = isRecord(message.msg)
    ? message.msg
    : isRecord(message.message)
      ? message.message
      : null;
  const itemList = Array.isArray(message.item_list)
    ? message.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  return (
    itemList.map(readWeixinTextItem).filter(Boolean).join("\n") ||
    readString(inner, "text") ||
    readString(inner, "content")
  );
}

function readWeixinAttachments(message: Record<string, unknown>): BotInboundAttachment[] {
  const inner = isRecord(message.msg)
    ? message.msg
    : isRecord(message.message)
      ? message.message
      : null;
  const itemList = Array.isArray(message.item_list)
    ? message.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  const directAttachments = Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(inner?.attachments)
      ? inner.attachments
      : [];
  return [
    ...itemList
      .map((item, index) => readWeixinAttachmentItem(item, index))
      .filter((attachment): attachment is BotInboundAttachment => attachment !== null),
    ...directAttachments
      .map((item, index) => readWeixinDirectAttachment(item, index))
      .filter((attachment): attachment is BotInboundAttachment => attachment !== null),
  ];
}

function readWeixinUserId(message: Record<string, unknown>): string {
  const from = isRecord(message.from) ? message.from : null;
  const sender = isRecord(message.sender) ? message.sender : null;
  return (
    readString(message, "from_user_id") ||
    readString(message, "from") ||
    readString(message, "from_user") ||
    readString(message, "fromUser") ||
    readString(message, "user") ||
    readString(message, "user_id") ||
    readString(message, "userId") ||
    readString(from, "id") ||
    readString(from, "wxid") ||
    readString(sender, "id") ||
    readString(sender, "wxid")
  );
}

function readWeixinChatId(message: Record<string, unknown>): string | undefined {
  return (
    readString(message, "room") ||
    readString(message, "room_id") ||
    readString(message, "roomId") ||
    readString(message, "chat") ||
    readString(message, "chat_id") ||
    readString(message, "chatId") ||
    undefined
  );
}

function readWeixinDisplayName(message: Record<string, unknown>): string | undefined {
  const from = isRecord(message.from) ? message.from : null;
  const sender = isRecord(message.sender) ? message.sender : null;
  const inner = isRecord(message.msg)
    ? message.msg
    : isRecord(message.message)
      ? message.message
      : null;
  return (
    readString(message, "name") ||
    readString(message, "displayName") ||
    readString(message, "nickname") ||
    readString(from, "name") ||
    readString(from, "nickname") ||
    readString(sender, "name") ||
    readString(sender, "nickname") ||
    readString(inner, "sender_name") ||
    undefined
  );
}

function readWeixinMessageId(message: Record<string, unknown>): string | undefined {
  const inner = isRecord(message.msg)
    ? message.msg
    : isRecord(message.message)
      ? message.message
      : null;
  const messageId =
    readString(message, "id") ||
    readString(message, "msgid") ||
    readString(message, "msgId") ||
    readNumberOrString(message, "message_id") ||
    readString(inner, "id") ||
    readString(inner, "msgid") ||
    readString(inner, "msgId") ||
    readNumberOrString(inner, "message_id");
  if (messageId) {
    return messageId;
  }
  const numericId =
    readNumber(message, "id") ??
    readNumber(message, "msgid") ??
    readNumber(message, "msgId") ??
    readNumber(inner, "id") ??
    readNumber(inner, "msgid") ??
    readNumber(inner, "msgId");
  return numericId === null ? undefined : String(numericId);
}

function readWeixinMessages(payload: unknown): Record<string, unknown>[] {
  const container = readMessagesContainer(payload);
  const rawMessages =
    container.msgs ?? container.messages ?? container.updates ?? container.items ?? container.list;
  if (Array.isArray(rawMessages)) {
    return rawMessages.filter(isRecord);
  }
  if (isRecord(rawMessages)) {
    return [rawMessages];
  }
  return [];
}

function readNextBuf(payload: unknown): string | undefined {
  const container = readMessagesContainer(payload);
  return (
    readString(container, "get_updates_buf") ||
    readString(container, "buf") ||
    readString(container, "next_buf") ||
    readString(container, "nextBuf") ||
    readString(container, "getUpdatesBuf") ||
    readString(container, "syncKey") ||
    undefined
  );
}

function readWeixinContextToken(message: Record<string, unknown>): string | undefined {
  const inner = isRecord(message.msg)
    ? message.msg
    : isRecord(message.message)
      ? message.message
      : null;
  return (
    readString(message, "context_token") ||
    readString(message, "contextToken") ||
    readString(message, "context") ||
    readString(inner, "context_token") ||
    undefined
  );
}

function buildWeixinClientId(): string {
  return `zcode-weixin-${randomUUID()}`;
}

function buildWeixinText(message: BotOutboundMessage): string {
  // Bugfix: 微信 iLink 纯文本在不同客户端上对 LF 的处理不完全一致。
  // 发送前统一成 CRLF，把业务层的多行回复表达为文本硬换行，避免 /status 这类状态行被折叠。
  return message.text.replace(/\r\n|\r|\n/g, "\r\n");
}

function buildInboundMessage(
  botId: string,
  rawMessage: Record<string, unknown>,
): BotInboundMessage | null {
  if (readNumber(rawMessage, "message_type") === 2) {
    return null;
  }
  const text = readWeixinText(rawMessage).trim();
  const attachments = readWeixinAttachments(rawMessage);
  const userId = readWeixinUserId(rawMessage).trim();
  if ((!text && attachments.length === 0) || !userId) {
    return null;
  }
  const chatId = readWeixinChatId(rawMessage);
  return {
    botId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    actor: {
      provider: "weixin",
      botId,
      providerUserId: userId,
      displayName: readWeixinDisplayName(rawMessage),
      chatType: chatId ? "group" : "private",
      chatId,
      providerMessageId: readWeixinMessageId(rawMessage),
      providerContextToken: readWeixinContextToken(rawMessage),
    },
  };
}

function summarizeWeixinRawMessage(rawMessage: Record<string, unknown>, index: number): string {
  const inner = isRecord(rawMessage.msg)
    ? rawMessage.msg
    : isRecord(rawMessage.message)
      ? rawMessage.message
      : null;
  const itemList = Array.isArray(rawMessage.item_list)
    ? rawMessage.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  const itemTypes = itemList
    .filter(isRecord)
    .map(
      (item) =>
        readNumber(item, "type") ??
        readNumber(item, "item_type") ??
        readNumber(item, "message_type") ??
        "unknown",
    )
    .slice(0, 6)
    .join(",");
  const firstItem = itemList.find(isRecord);
  const firstMedia = isRecord(firstItem?.image_item)
    ? firstItem.image_item
    : isRecord(firstItem?.file_item)
      ? firstItem.file_item
      : isRecord(firstItem?.video_item)
        ? firstItem.video_item
        : isRecord(firstItem?.audio_item)
          ? firstItem.audio_item
          : isRecord(firstItem?.media_item)
            ? firstItem.media_item
            : null;
  const mediaTypes = firstMedia
    ? Object.entries(firstMedia)
        .slice(0, 8)
        .map(([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`)
        .join(",")
    : "none";
  const nestedMedia = firstMedia && isRecord(firstMedia.media) ? firstMedia.media : null;
  const nestedMediaTypes = nestedMedia
    ? Object.entries(nestedMedia)
        .slice(0, 8)
        .map(([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`)
        .join(",")
    : "none";
  return [
    `index=${index}`,
    `messageType=${readNumber(rawMessage, "message_type") ?? "none"}`,
    `textLen=${readWeixinText(rawMessage).trim().length}`,
    `attachments=${readWeixinAttachments(rawMessage).length}`,
    `hasUserId=${readWeixinUserId(rawMessage).trim() ? "yes" : "no"}`,
    `itemList=${itemList.length}`,
    `itemTypes=${itemTypes || "none"}`,
    `itemKeys=${firstItem ? Object.keys(firstItem).slice(0, 12).join(",") : "none"}`,
    `mediaKeys=${firstMedia ? Object.keys(firstMedia).slice(0, 12).join(",") : "none"}`,
    `mediaTypes=${mediaTypes}`,
    `nestedMediaKeys=${nestedMedia ? Object.keys(nestedMedia).slice(0, 12).join(",") : "none"}`,
    `nestedMediaTypes=${nestedMediaTypes}`,
    `keys=${Object.keys(rawMessage).slice(0, 12).join(",")}`,
    `innerKeys=${inner ? Object.keys(inner).slice(0, 12).join(",") : "none"}`,
  ].join(" ");
}

export async function getWeixinUpdates(params: {
  bot: BotConfig;
  deps: WeixinProviderDeps;
  buf?: string;
  signal?: AbortSignal;
}): Promise<WeixinGetUpdatesResult> {
  const payload = await requestWeixinJson(
    params.bot,
    params.deps,
    "/getupdates",
    {
      get_updates_buf: params.buf ?? "",
    },
    params.signal,
    WEIXIN_GET_UPDATES_TIMEOUT_MS,
  );
  const rawMessages = readWeixinMessages(payload);
  return {
    rawMessageCount: rawMessages.length,
    rawMessageDiagnostics: rawMessages.map(summarizeWeixinRawMessage),
    messages: rawMessages
      .map((message) => buildInboundMessage(params.bot.id, message))
      .filter((message): message is BotInboundMessage => message !== null),
    buf: readNextBuf(payload) ?? params.buf,
  };
}

export function createWeixinBotProvider(deps: WeixinProviderDeps): BotProviderAdapter {
  // alpha.2 观测（specs/bot-provider-network.md amendment / log-diagnostics-hygiene.md）：
  // typing 每 4s 一次，成功走 debug（生产不落盘）；失败 warn 按 30s 限频（惰性时间戳
  // 比较，非 timer）——死窗内 typing 是否存活、getconfig 是否仍发新 context_token，
  // 是探针判定"通道死 vs 仅 token 死"的关键证据。token 值永不入日志。
  let lastTypingWarnAtMs = 0;
  let lastTypingTokenPresence: boolean | undefined;
  return {
    async test(bot) {
      if (!bot.enabled) {
        return { ok: false, message: "Weixin bot is disabled." };
      }
      if (!bot.credentialRef) {
        return {
          ok: false,
          message: "Weixin iLink bot token is missing. Scan the Weixin login QR code first.",
        };
      }
      await requestWeixinJson(bot, deps, "/getconfig");
      return {
        ok: true,
        message: "Weixin iLink API is reachable.",
      };
    },

    async send(bot, message) {
      // Bugfix: 微信 iLink 发送协议必须走 /ilink/bot/sendmessage，并把文本放进 msg.item_list。
      // 之前把 openclaw-weixin 当成本地 gateway 依赖，会导致 ZCode 不能独立完成微信接入。
      const buildBody = (contextToken: string | undefined): Record<string, unknown> => ({
        msg: {
          from_user_id: bot.providerUserId ?? "",
          to_user_id: message.providerUserId,
          client_id: buildWeixinClientId(),
          message_type: WEIXIN_MESSAGE_TYPE_BOT,
          message_state: WEIXIN_MESSAGE_STATE_FINISH,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [
            {
              type: 1,
              text_item: { text: buildWeixinText(message) },
            },
          ],
        },
      });
      try {
        await requestWeixinJson(
          bot,
          deps,
          "/sendmessage",
          buildBody(message.providerContextToken),
          undefined,
          WEIXIN_SEND_TEXT_TIMEOUT_MS,
        );
      } catch (error) {
        // Bugfix（specs/bot-provider-network.md Alpha 1 F4）：文本 /sendmessage 此前没有
        // ret=-2 处理——长任务（>40min 无入站）token 过期后完成消息直接丢失。与媒体路径
        // （sendWeixinMediaItem）对齐：ret=-2 = context_token 过期，去掉 token 重试一次；
        // 仍失败则上抛，由服务层按 F2 契约降级。
        const weixinRet = (error as { weixinRet?: number }).weixinRet;
        if (weixinRet === -2 && message.providerContextToken) {
          weixinLogger.info(undefined, "weixin text send tokenless retry fired");
          await requestWeixinJson(
            bot,
            deps,
            "/sendmessage",
            buildBody(undefined),
            undefined,
            WEIXIN_SEND_TEXT_TIMEOUT_MS,
          );
          return;
        }
        throw error;
      }
    },

    async sendAttachment(bot, message, attachment) {
      // 出站媒体链路（specs/bot-file-delivery.md）：getuploadurl → AES-128-ECB CDN 上传 → 媒体 item 发送。
      // maxBytes 由服务层传入，与入站附件共用 5MB 上限，读取侧兜底防止 stat/readFile 窗口期膨胀。
      await uploadAndSendWeixinAttachment({
        bot,
        deps,
        toUserId: message.providerUserId,
        contextToken: message.providerContextToken,
        maxBytes: WEIXIN_OUTBOUND_MAX_BYTES,
        attachment,
      });
    },

    async sendTyping(bot, target: BotTypingTarget) {
      const warnTypingFailure = (stage: string, error: unknown): void => {
        const now = Date.now();
        if (now - lastTypingWarnAtMs < 30_000) {
          return;
        }
        lastTypingWarnAtMs = now;
        const tagged = error as {
          weixinRet?: number;
          weixinErrcode?: number;
          weixinHttpStatus?: number;
        };
        const fields = [
          tagged.weixinRet !== undefined ? `ret=${tagged.weixinRet}` : "",
          tagged.weixinErrcode !== undefined ? `errcode=${tagged.weixinErrcode}` : "",
          tagged.weixinHttpStatus !== undefined ? `httpStatus=${tagged.weixinHttpStatus}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        weixinLogger.warn(
          undefined,
          `weixin typing ${stage} failed: ${error instanceof Error ? error.message : String(error)}${fields ? ` ${fields}` : ""}`,
        );
      };
      let stage = "getconfig";
      try {
        const config = (await requestWeixinJson(bot, deps, "/getconfig", {
          ilink_user_id: target.providerUserId,
          ...(target.providerContextToken ? { context_token: target.providerContextToken } : {}),
        })) as WeixinTestResponse;
        const tokenPresence =
          typeof config.context_token === "string" && config.context_token.length > 0;
        if (tokenPresence !== lastTypingTokenPresence) {
          lastTypingTokenPresence = tokenPresence;
          weixinLogger.info(
            undefined,
            `weixin typing getconfig context_token present=${tokenPresence}`,
          );
        }
        if (!config.typing_ticket) {
          return;
        }
        stage = "sendtyping";
        await requestWeixinJson(bot, deps, "/sendtyping", {
          ilink_user_id: target.providerUserId,
          typing_ticket: config.typing_ticket,
          status: 1,
        });
        weixinLogger.debug(undefined, "weixin typing send ok");
      } catch (error) {
        warnTypingFailure(stage, error);
        throw error;
      }
    },

    async downloadAttachment(_bot, attachment) {
      const aesKey = attachment.providerMetadata?.weixinAesKey;
      if (!attachment.downloadUrl || !aesKey) {
        return null;
      }
      // 修复原因：CDN 下载此前走裸 fetch，绕过应用代理；统一改走注入的 requester。
      const response = await deps.requester.fetch(attachment.downloadUrl);
      if (!response.ok) {
        throw new Error(`Weixin attachment download failed: HTTP ${response.status}`);
      }
      return {
        attachment,
        data: decryptWeixinCdnMedia(new Uint8Array(await response.arrayBuffer()), aesKey),
      };
    },

    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = readString(payload, "botId");
      if (!botId) {
        return [];
      }
      return readWeixinMessages(payload)
        .map((message) => buildInboundMessage(botId, message))
        .filter((message): message is BotInboundMessage => message !== null);
    },
  };
}
