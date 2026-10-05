import assert from "node:assert/strict";
import test from "node:test";
import { createDecipheriv } from "node:crypto";
import type { IDisposable } from "@zcode/rpc";
import {
  buildWeixinMediaItem,
  buildWeixinUploadRequestBody,
  encodeWeixinMediaAesKey,
  encryptWeixinCdnMediaForTest,
  getWeixinUpdates,
  weixinCdnPaddedSize,
} from "../src/bots/providers/weixinProvider.js";
import { createBotProviderRequester } from "../src/bots/providers/providerRequest.js";
import { parseBotCommand } from "../src/bots/commandParser.js";
import { formatBotToolCallSummaryLine } from "../src/bots/replyFormatter.js";
import {
  botAllowedCommandsSchema,
  botsConfigFileSchema,
  ZCODE_AGENT_PROVIDER,
  type BotActor,
  type BotConfig,
  type BotOutboundAttachment,
  type BotOutboundMessage,
  type ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import {
  BOTS_CONFIG_FILE,
  BOTS_STATE_FILE,
  normalizeBotCommandPolicy,
} from "../src/bots/config.js";
import { isUserCommandAllowed } from "../src/bots/botConfigHelpers.js";
import {
  createBotShareFileQuotaTracker,
  createBotTaskDeliveryRegistry,
  createBotsService,
  inferOutboundAttachmentKind,
  inferOutboundAttachmentMime,
  mergeWeixinContextTokens,
  resolveWorkspaceFilePath,
  revalidateWorkspaceFileForDelivery,
} from "../src/bots/botsService.js";
import { zcodeBotsShareFileParamsSchema } from "@zcode/shared";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";
import type { IBotsService } from "../src/bots/bots.js";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import type { BotProviderAdapter } from "../src/bots/providers/types.js";
import type { V4BotWorkspaceFileReadResult } from "@zcode/shared/zcode-protocol-v4";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";

// specs/bot-file-delivery.md §5：出站媒体协议不变量（2026-09-29 生产环境实测）。

test("weixinCdnPaddedSize: PKCS7 补齐到 16 字节边界", () => {
  assert.equal(weixinCdnPaddedSize(0), 16);
  assert.equal(weixinCdnPaddedSize(1), 16);
  assert.equal(weixinCdnPaddedSize(15), 16);
  assert.equal(weixinCdnPaddedSize(16), 32);
  assert.equal(weixinCdnPaddedSize(70), 80);
  assert.equal(weixinCdnPaddedSize(93), 96);
  assert.equal(weixinCdnPaddedSize(1_048_576), 1_048_592);
});

test("协议不变量：aes_key 是 hex 字符串的 base64（双重编码），不是原始 key 的 base64", () => {
  const aesKeyHex = "00112233445566778899aabbccddeeff";
  const encoded = encodeWeixinMediaAesKey(aesKeyHex);
  assert.equal(encoded, Buffer.from(aesKeyHex, "utf8").toString("base64"));
  // 原始 16 字节 key 的 base64（错误形态）长度 24；正确形态长度 44。
  assert.equal(encoded.length, 44);
  assert.notEqual(encoded, Buffer.from(aesKeyHex, "hex").toString("base64"));
});

test("encryptWeixinCdnMediaForTest 与 AES-128-ECB 解密互逆", () => {
  const aesKeyHex = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const plaintext = Buffer.from("Zodex iLink outbound media probe payload", "utf8");
  const ciphertext = encryptWeixinCdnMediaForTest(plaintext, aesKeyHex);
  assert.equal(ciphertext.length, weixinCdnPaddedSize(plaintext.length));
  const key = Buffer.from(aesKeyHex, "hex");
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.deepEqual(decrypted, plaintext);
});

test("parseBotCommand 解析 /file 与 /文件", () => {
  assert.deepEqual(parseBotCommand("/file reports/result.png"), {
    type: "file",
    value: "reports/result.png",
  });
  assert.deepEqual(parseBotCommand("/文件 报告.pdf"), { type: "file", value: "报告.pdf" });
  // 缺参数：不构成 file 命令，落到 unknown，由服务层回复帮助语义。
  assert.equal(parseBotCommand("/file").type, "unknown");
  // 前缀相同但更长的命令不受影响。
  assert.equal(parseBotCommand("/filesync a").type, "unknown");
});

test("inferOutboundAttachmentKind 按扩展名路由 image/video/file", () => {
  assert.equal(inferOutboundAttachmentKind("a.png"), "image");
  assert.equal(inferOutboundAttachmentKind("b.JPG"), "image");
  assert.equal(inferOutboundAttachmentKind("c.mp4"), "video");
  assert.equal(inferOutboundAttachmentKind("d.mov"), "video");
  assert.equal(inferOutboundAttachmentKind("report.pdf"), "file");
  assert.equal(inferOutboundAttachmentKind("archive.tar.gz"), "file");
});

// ---- Alpha 7（specs/bot-file-delivery.md「Outbound attachment naming & inline kinds」§5.7/§5.6/§5.8）：
// 内联图片扩展扩容 + Windows 保留名中和 + 审计字段去重——红测先行，W3 实现后转绿。
// 计划依据：../ZCode-alpha6-plan.md Part 1 items 7-8 + 附录 C。

test("A7 §5.7 inferOutboundAttachmentKind 把 heic/heif/tiff/avif 路由为 image（今天 file → 红）", () => {
  // §5.7：这些格式的图片出站应按图片发送（直接内联显示），不再落成"文件"气泡。
  // rig B3 负责真机内联渲染确认（tiff/avif 未验证，渲染坏则按 spec 回落条款回 file）。
  assert.equal(inferOutboundAttachmentKind("photo.heic"), "image");
  assert.equal(inferOutboundAttachmentKind("photo.heif"), "image");
  assert.equal(inferOutboundAttachmentKind("scan.tiff"), "image");
  assert.equal(inferOutboundAttachmentKind("next-gen.avif"), "image");
  // 大小写与已覆盖格式回归钉。
  assert.equal(inferOutboundAttachmentKind("Photo.HEIC"), "image");
  assert.equal(inferOutboundAttachmentKind("clip.mp4"), "video");
  assert.equal(inferOutboundAttachmentKind("report.pdf"), "file");
});

test("A7 §5.7 weixin 入站推断：heif/tiff/avif 文件名识别为 image（heic 已覆盖作对照；今天 file → 红）", async () => {
  // §5.7 双侧扩容的 weixin 侧：inferWeixinAttachmentKind 为模块私有，经导出的
  // getWeixinUpdates（假 requester 只喂 /getupdates 应答）驱动真实解析路径。
  // heic 今天已识别（对照锚，绿）；heif/tiff/avif 今天落入 file → 红。
  const weixinInferBot = { credentialRef: "cred-alpha7" } as BotConfig;
  async function inferWeixinKindByFilename(filename: string): Promise<string> {
    const payload = {
      ret: 0,
      data: {
        msgs: [
          {
            from_user_id: "wx-user-1",
            item_list: [{ file_item: { filename, file_id: `f-${filename}`, size: 10 } }],
          },
        ],
      },
    };
    const requester = createBotProviderRequester(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    );
    const updates = await getWeixinUpdates({
      bot: weixinInferBot,
      deps: { loadCredential: async () => "test-token", requester },
    });
    const attachment = updates.messages[0]?.attachments?.[0];
    assert.ok(attachment, `必须解析出附件：${filename}`);
    return attachment.kind;
  }
  assert.equal(await inferWeixinKindByFilename("pic.heic"), "image", "heic 已覆盖（对照锚）");
  assert.equal(await inferWeixinKindByFilename("pic.heif"), "image");
  assert.equal(await inferWeixinKindByFilename("pic.tiff"), "image");
  assert.equal(await inferWeixinKindByFilename("pic.avif"), "image");
  // 非图片扩展不误伤。
  assert.equal(await inferWeixinKindByFilename("doc.pdf"), "file");
});

test("inferOutboundAttachmentMime 已知扩展名映射，未知回退按 kind", () => {
  assert.equal(inferOutboundAttachmentMime("a.png", "image"), "image/png");
  assert.equal(inferOutboundAttachmentMime("a.md", "file"), "text/markdown");
  assert.equal(inferOutboundAttachmentMime("weird.xyz", "file"), "application/octet-stream");
  assert.equal(inferOutboundAttachmentMime("weird2", "image"), "image/jpeg");
});

test("resolveWorkspaceFilePath: workspace 树内文件解析成功并返回大小", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-bot-file-"));
  try {
    await writeFile(join(root, "result.txt"), "hello zodex");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "image.png"), Buffer.from([1, 2, 3]));
    const direct = await resolveWorkspaceFilePath(root, "result.txt");
    assert.equal(direct.ok, true);
    if (direct.ok) {
      assert.equal(direct.sizeBytes, "hello zodex".length);
      assert.equal(direct.absolutePath, join(root, "result.txt"));
    }
    const nested = await resolveWorkspaceFilePath(root, "nested/image.png");
    assert.equal(nested.ok, true);
    const absoluteInside = await resolveWorkspaceFilePath(root, join(root, "result.txt"));
    assert.equal(absoluteInside.ok, true);
    // “..” 逃逸与绝对路径逃逸都必须拒绝。
    const escapeRelative = await resolveWorkspaceFilePath(root, "../outside.txt");
    assert.equal(escapeRelative.ok, false);
    if (!escapeRelative.ok) assert.equal(escapeRelative.reason, "outside");
    const escapeAbsolute = await resolveWorkspaceFilePath(
      root,
      join(tmpdir(), "zcode-elsewhere.txt"),
    );
    assert.equal(escapeAbsolute.ok, false);
    if (!escapeAbsolute.ok) assert.equal(escapeAbsolute.reason, "outside");
    const missing = await resolveWorkspaceFilePath(root, "no-such-file.bin");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceFilePath: 目录与指向树外的符号链接均被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-bot-file-symlink-"));
  try {
    const outsideRoot = await mkdtemp(join(tmpdir(), "zcode-bot-file-outside-"));
    try {
      await writeFile(join(outsideRoot, "secret.txt"), "secret");
      await mkdir(join(root, "sub"));
      await symlink(join(root, "sub"), join(root, "dir-link"), "dir");
      await symlink(join(outsideRoot, "secret.txt"), join(root, "escape-link"), "file");
      // 目录不是可发送文件。
      const directory = await resolveWorkspaceFilePath(root, "dir-link");
      assert.equal(directory.ok, false);
      // realpath 归一化后指向 workspace 之外的符号链接必须按 outside 拒绝。
      const symlinkEscape = await resolveWorkspaceFilePath(root, "escape-link");
      assert.equal(symlinkEscape.ok, false);
      if (!symlinkEscape.ok) assert.equal(symlinkEscape.reason, "outside");
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeWeixinContextTokens: 更新排序并裁剪到上限", () => {
  const initial = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `peer-${index}`,
      { token: `token-${index}`, updatedAt: 1_000 + index },
    ]),
  );
  const merged = mergeWeixinContextTokens(initial, "peer-new", "token-new", 9_999);
  assert.equal(Object.keys(merged).length, 20);
  assert.deepEqual(merged["peer-new"], { token: "token-new", updatedAt: 9_999 });
  // 最旧的 peer-0 被裁掉。
  assert.equal(merged["peer-0"], undefined);
  // 既有 peer 更新时间戳后保留。
  const refreshed = mergeWeixinContextTokens(merged, "peer-5", "token-5b", 10_000);
  assert.equal(Object.keys(refreshed).length, 20);
  assert.deepEqual(refreshed["peer-5"], { token: "token-5b", updatedAt: 10_000 });
});

test("协议不变量：getuploadurl 请求体字段与实测线上形状一致", () => {
  const body = buildWeixinUploadRequestBody({
    filekey: "a".repeat(32),
    mediaType: 3,
    toUserId: "peer@im.wechat",
    rawSize: 93,
    rawFileMd5: "d41d8cd98f00b204e9800998ecf8427e",
    ciphertextSize: 96,
    aesKeyHex: "0".repeat(32),
  });
  assert.deepEqual(body, {
    filekey: "a".repeat(32),
    media_type: 3,
    to_user_id: "peer@im.wechat",
    rawsize: 93,
    rawfilemd5: "d41d8cd98f00b204e9800998ecf8427e",
    // filesize 是补齐后的密文大小，不是明文大小。
    filesize: 96,
    no_need_thumb: true,
    // aeskey 是 hex 字符串，不做 base64。
    aeskey: "0".repeat(32),
  });
});

test("协议不变量：媒体 item 形状（len 字符串明文大小；mid_size/video_size 密文大小；aes_key 双重编码）", () => {
  const base = {
    filename: "report.md",
    rawSize: 93,
    ciphertextSize: 96,
    downloadParam: "download-param-value",
    aesKeyHex: "ab".repeat(16),
  };
  const fileItem = buildWeixinMediaItem({ ...base, kind: "file" });
  assert.deepEqual(fileItem, {
    type: 4,
    file_item: {
      media: {
        encrypt_query_param: "download-param-value",
        aes_key: Buffer.from("ab".repeat(16), "utf8").toString("base64"),
        encrypt_type: 1,
      },
      file_name: "report.md",
      // len 必须是字符串形式的明文大小。
      len: "93",
    },
  });
  const imageItem = buildWeixinMediaItem({ ...base, kind: "image", filename: "shot.png" });
  assert.deepEqual(imageItem, {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: "download-param-value",
        aes_key: Buffer.from("ab".repeat(16), "utf8").toString("base64"),
        encrypt_type: 1,
      },
      // mid_size 是密文大小。
      mid_size: 96,
    },
  });
  const videoItem = buildWeixinMediaItem({ ...base, kind: "video", filename: "clip.mp4" });
  assert.deepEqual(videoItem, {
    type: 5,
    video_item: {
      media: {
        encrypt_query_param: "download-param-value",
        aes_key: Buffer.from("ab".repeat(16), "utf8").toString("base64"),
        encrypt_type: 1,
      },
      video_size: 96,
    },
  });
});

test("file 命令开关：schema 接受显式 false 且策略归一化不丢开关", () => {
  // botAllowedCommandsSchema 是 strict 的；缺了 file 字段时显式 false 会让整个配置解析失败。
  const parsed = botAllowedCommandsSchema.parse({
    status: true,
    new: true,
    workspace: true,
    model: true,
    thoughtLevel: true,
    reply: true,
    file: false,
  });
  assert.equal(parsed.file, false);
  const bot = {
    id: "bot-1",
    provider: "weixin",
    enabled: true,
    allowedCommands: normalizeBotCommandPolicy(parsed),
  } as Parameters<typeof isUserCommandAllowed>[0];
  assert.equal(isUserCommandAllowed(bot, "file"), false);
  assert.equal(isUserCommandAllowed(bot, "message"), true);
  // 缺省（未配置）视为允许。
  const defaultBot = {
    id: "bot-2",
    provider: "weixin",
    enabled: true,
    allowedCommands: normalizeBotCommandPolicy(),
  } as Parameters<typeof isUserCommandAllowed>[0];
  assert.equal(isUserCommandAllowed(defaultBot, "file"), true);
});

// ---- Phase B：对话式 share_file（specs/bot-file-delivery.md Phase B）----
// 服务级测试统一通过 createBotsService 真实装配：临时 data 目录（setDataBaseDir）+
// providerOverrides 注入可观测 adapter + 预置 taskDeliveryRegistry，走与生产一致的
// 入站 → watchTaskStream 注册 → shareFileForTask 裁决链路。

type StreamEnqueue = (event: unknown) => Promise<void>;

interface SendAttachmentCall {
  botId: string;
  message: BotOutboundMessage;
  attachment: BotOutboundAttachment;
  /** 调用时刻 localPath 的真实内容（不存在 → null）：远程物料化断言用。 */
  localFileBytes: Buffer | null;
  /** 调用时刻 localPath 的 mode（不存在 → null；POSIX 才有意义）：Review 修复断言用。 */
  localFileMode: number | null;
}

/** Phase C Alpha 2：可注入的远端 workspace 文件 reader fake（结构对齐 IBotWorkspaceFileService）。 */
interface FakeRemoteWorkspaceFileReader {
  readWorkspaceFile(params: {
    workspacePath: string;
    workspaceIdentity: string;
    relativePath: string;
    offset: number;
    limit: number;
  }): Promise<V4BotWorkspaceFileReadResult>;
}

interface FakeReaderControl {
  /** 让每次 read 直接返回 typed 拒绝（测试中途可翻转）。 */
  fail?: "outside-workspace" | "not-found" | "too-large" | "unavailable";
  /** 每次 read 前的人为延迟（deadline/预算测试）。 */
  delayMs?: number;
}

interface FakeRemoteReaderOptions {
  filename: string;
  content: Buffer;
  control?: FakeReaderControl;
  /** 永不置 eof（累积上限/空块守卫测试）。 */
  neverEof?: boolean;
  /** 每块返回的字节数（缺省 = 请求 limit；远端允许返回比请求更少的块）。 */
  chunkSize?: number;
  /** 覆盖第 N 块（1 起）回传的整文件大小（分块间增长测试）。 */
  sizeBytesAtChunk?: (chunkIndex: number) => number | undefined;
  /** 捕获每次 read 的入参（offset/limit/workspaceIdentity 透传断言）。 */
  calls?: Array<{
    workspacePath: string;
    workspaceIdentity: string;
    relativePath: string;
    offset: number;
    limit: number;
  }>;
}

function createFakeRemoteReader(options: FakeRemoteReaderOptions): FakeRemoteWorkspaceFileReader {
  let chunkIndex = 0;
  return {
    async readWorkspaceFile(params) {
      options.calls?.push({ ...params });
      if (options.control?.delayMs && options.control.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.control!.delayMs));
      }
      if (options.control?.fail) {
        return {
          ok: false,
          reason: options.control.fail,
          ...(options.control.fail === "too-large" ? { detail: "remote stat exceeded cap" } : {}),
        };
      }
      const chunkSize = options.chunkSize ?? params.limit;
      const end = Math.min(params.offset + chunkSize, options.content.length);
      const data = options.content.subarray(params.offset, end);
      chunkIndex += 1;
      return {
        ok: true as const,
        filename: options.filename,
        sizeBytes: options.sizeBytesAtChunk?.(chunkIndex) ?? options.content.length,
        dataBase64: Buffer.from(data).toString("base64"),
        eof: options.neverEof === true ? false : end >= options.content.length,
      };
    },
  };
}

const WEIXIN_BOT_ID = "bot-wx";
const FEISHU_BOT_ID = "bot-fs";
const TELEGRAM_BOT_ID = "bot-tg";
const WEBHOOK_BOT_ID = "bot-wh";
const CONVERSATIONAL_TASK_ID = "task-conv-1";
/** messages.ts fileFetchStarted（zh）——A3a ack 钉住值：/file 通过快速门槛后的立即回复。 */
const FILE_FETCH_STARTED_ZH = "正在获取并发送文件…";

/** 3.14.5 Alpha 0（A3a）：/file 结果回复由后台腿经 sendOutbound 发出；轮询捕获到新增回复即返回。 */
async function waitForSentMessages(
  sentMessages: BotOutboundMessage[],
  sentBefore: number,
  label: string,
): Promise<BotOutboundMessage[]> {
  const deadline = Date.now() + 2000;
  while (sentMessages.length <= sentBefore) {
    if (Date.now() > deadline) {
      assert.fail(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return sentMessages.slice(sentBefore);
}

function baseAllowedCommands() {
  return {
    status: true,
    new: true,
    workspace: true,
    model: true,
    thoughtLevel: true,
    reply: true,
  };
}

function buildWeixinBotConfig() {
  return {
    id: WEIXIN_BOT_ID,
    name: "WeChat Bot",
    provider: "weixin",
    enabled: true,
    providerUserId: "wx-user-1",
    allowedWorkspaces: ["*"],
    allowedCommands: baseAllowedCommands(),
    currentOptions: {},
    replyMode: "assistant_changes",
  };
}

function buildFeishuBotConfig() {
  return {
    id: FEISHU_BOT_ID,
    name: "Feishu Bot",
    provider: "feishu",
    enabled: true,
    providerUserId: "fs-user-1",
    allowedWorkspaces: ["*"],
    allowedCommands: baseAllowedCommands(),
    currentOptions: {},
    replyMode: "assistant_changes",
  };
}

function buildTelegramBotConfig() {
  return {
    id: TELEGRAM_BOT_ID,
    name: "Telegram Bot",
    provider: "telegram",
    enabled: true,
    providerUserId: "tg-user-1",
    allowedWorkspaces: ["*"],
    allowedCommands: baseAllowedCommands(),
    currentOptions: {},
    replyMode: "assistant_changes",
  };
}

function buildWebhookBotConfig() {
  return {
    id: WEBHOOK_BOT_ID,
    name: "Webhook Bot",
    provider: "webhook",
    enabled: true,
    providerUserId: "wh-user-1",
    allowedWorkspaces: ["*"],
    allowedCommands: baseAllowedCommands(),
    currentOptions: {},
    replyMode: "assistant_changes",
  };
}

interface HarnessOptions {
  weixinBot?: ReturnType<typeof buildWeixinBotConfig>;
  feishuBot?: ReturnType<typeof buildFeishuBotConfig> | null;
  /** Phase C Alpha 5：可选注入 telegram bot（默认不含，producer 目标产出测试需要）。 */
  telegramBot?: ReturnType<typeof buildTelegramBotConfig> | null;
  /** Phase C Alpha 5 场景 5：可选注入 webhook bot——真实 webhook adapter 没有
   * sendAttachment，unsupported-provider 负例自 feishu re-base 到这里。 */
  webhookBot?: ReturnType<typeof buildWebhookBotConfig> | null;
  workspaceIdentity?: string;
  sendAttachmentError?: Error;
  /** 故意放慢 adapter.sendAttachment（quota TOCTOU 并发测试需要在途重叠窗口）。 */
  sendAttachmentDelayMs?: number;
  /** 注入 isConnected=true 的远端服务，模拟「已连接的远程 workspace」。 */
  remoteConnected?: boolean;
  /** Phase C Alpha 2：注入远端文件 reader；null 表示 getWorkspaceFileReader 返回 null。 */
  remoteReader?: FakeRemoteWorkspaceFileReader | null;
  /** 让 getWorkspaceFileReader 本身 throw（runtime 初始化失败 → remote-unavailable）。 */
  remoteReaderInitThrows?: boolean;
  /** 缩短远端读取 deadline/总预算，避免测试真实等待 20s/120s。 */
  remoteFileTimeouts?: { chunkDeadlineMs?: number; totalBudgetMs?: number };
  /** 让 fake zcodeTaskService.sendPrompt 拒绝（sendPromptInBackground 失败终态路径）。 */
  sendPromptError?: Error;
  /** 让 getTaskSnapshot 返回终态 meta（isContextActiveTaskRunning 漏检终态路径）。 */
  taskSnapshotMetaStatus?: "completed" | "error";
}

interface Harness {
  service: IBotsService & { disposeAllAndWait(): Promise<void> };
  registry: ReturnType<typeof createBotTaskDeliveryRegistry>;
  sendAttachmentCalls: SendAttachmentCall[];
  /** A3a：adapter.send 捕获的出站文本消息（/file 后台结果回复等）。 */
  sentMessages: BotOutboundMessage[];
  /** fake zcodeTaskService.sendPrompt 捕获的 (taskId, botDeliveryTarget) 序列。 */
  sendPromptCalls: Array<{
    taskId: string;
    botDeliveryTarget: ZCodeAutomationBotDeliveryTarget | undefined;
  }>;
  /** 测试中可变的 adapter 行为（切换错误/延迟），生产装配不受影响。 */
  adapterControl: { error: Error | undefined; delayMs: number };
  workspacePath: string;
  outsideFilePath: string;
  getStreamEnqueue: () => StreamEnqueue | undefined;
  conversationalActor: BotActor;
  triggerConversationalMessage(options?: {
    text?: string;
    token?: string;
    messageId?: string;
    chatType?: "private" | "group";
    provider?: "weixin" | "feishu" | "telegram" | "webhook";
  }): Promise<BotOutboundMessage[]>;
  sendFileCommand(
    value: string,
    options?: { token?: string; messageId?: string; provider?: "weixin" | "feishu" | "webhook" },
  ): Promise<BotOutboundMessage[]>;
  readRawConfig(): Promise<string>;
  readRawState(): Promise<string>;
  writeRawConfig(config: unknown): Promise<void>;
  dispose(): Promise<void>;
}

let inboundMessageCounter = 0;

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), "zcode-bot-share-"));
  setDataBaseDir(dataRoot);
  const workspace = await mkdtemp(join(tmpdir(), "zcode-bot-ws-"));
  await mkdir(join(workspace, "out"), { recursive: true });
  await writeFile(join(workspace, "out", "result.txt"), "hello zodex");
  const outsideRoot = await mkdtemp(join(tmpdir(), "zcode-bot-outside-"));
  const outsideFilePath = join(outsideRoot, "secret.txt");
  await writeFile(outsideFilePath, "secret");
  const configDir = getAppConfigDir();
  await mkdir(configDir, { recursive: true });
  const bots = [
    options.weixinBot ?? buildWeixinBotConfig(),
    ...(options.feishuBot === null ? [] : [options.feishuBot ?? buildFeishuBotConfig()]),
    ...(options.telegramBot ? [options.telegramBot] : []),
    ...(options.webhookBot ? [options.webhookBot] : []),
  ];
  await writeFile(join(configDir, BOTS_CONFIG_FILE), JSON.stringify({ version: 3, bots }));
  await writeFile(
    join(configDir, BOTS_STATE_FILE),
    JSON.stringify({
      version: 3,
      bots: {
        [WEIXIN_BOT_ID]: {
          botId: WEIXIN_BOT_ID,
          workspacePath: workspace,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          mode: "task",
          activeTaskId: CONVERSATIONAL_TASK_ID,
          weixinActivatedAt: 1,
          updatedAt: 1,
        },
        // feishu 同 workspace 的上下文：/file 渠道门槛测试需要已绑定 workspace 的 feishu 会话。
        ...(options.feishuBot === null
          ? {}
          : {
              [FEISHU_BOT_ID]: {
                botId: FEISHU_BOT_ID,
                workspacePath: workspace,
                mode: "task",
                activeTaskId: null,
                updatedAt: 1,
              },
            }),
        // telegram 上下文镜像 weixin：续跑既有会话，走 producer 目标产出路径。
        ...(options.telegramBot
          ? {
              [TELEGRAM_BOT_ID]: {
                botId: TELEGRAM_BOT_ID,
                workspacePath: workspace,
                mode: "task",
                activeTaskId: CONVERSATIONAL_TASK_ID,
                updatedAt: 1,
              },
            }
          : {}),
        // webhook 上下文（Alpha 5 场景 5）：/file 渠道门槛负例需要已绑定 workspace 的会话。
        ...(options.webhookBot
          ? {
              [WEBHOOK_BOT_ID]: {
                botId: WEBHOOK_BOT_ID,
                workspacePath: workspace,
                mode: "task",
                activeTaskId: null,
                updatedAt: 1,
              },
            }
          : {}),
      },
    }),
  );

  const registry = createBotTaskDeliveryRegistry();
  const sendAttachmentCalls: SendAttachmentCall[] = [];
  const sentMessages: BotOutboundMessage[] = [];
  const adapterControl = {
    error: options.sendAttachmentError as Error | undefined,
    delayMs: options.sendAttachmentDelayMs ?? 0,
  };
  const weixinAdapter: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "stub" }),
    send: async (_bot, message) => {
      // A3a：/file 后台结果回复经 sendOutbound → adapter.send 发出，这里捕获供断言。
      sentMessages.push(message);
    },
    sendAttachment: async (bot, message, attachment) => {
      if (adapterControl.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, adapterControl.delayMs));
      }
      if (adapterControl.error) throw adapterControl.error;
      // 捕获调用时刻 localPath 的文件事实：远程物料化断言（存在 + 内容已重组）依赖它。
      const localFileBytes = await readFile(attachment.localPath).then(
        (data) => data,
        () => null,
      );
      const localFileMode = await stat(attachment.localPath).then(
        (info) => info.mode & 0o777,
        () => null,
      );
      sendAttachmentCalls.push({
        botId: bot.id,
        message,
        attachment,
        localFileBytes,
        localFileMode,
      });
    },
  };
  // feishu/telegram 覆盖为惰性 stub：producer 目标产出与解绑守卫测试不触发出站媒体，
  // 避免真实 adapter 触碰网络路径。Alpha 5 场景 5 起 unsupported-provider 负例已
  // re-base 到 webhook（真实 feishu/telegram adapter 已具备 sendAttachment，各自的
  // 出站媒体行为由 botFileDeliveryFeishu/Telegram.test.ts 直接锁定）。
  const feishuAdapter: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "stub" }),
    send: async () => undefined,
  };
  // telegram 同样覆盖为惰性 stub：producer 测试只关心 sendPrompt 的目标产出，
  // 避免真实 adapter 触碰网络路径。
  const telegramAdapter: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "stub" }),
    send: async () => undefined,
  };
  // webhook 是当前真实没有 sendAttachment 的 provider（discord/wecom 为 null 注册）：
  // unsupported-provider 判定负例以它为载体，stub 只保证零网络。
  const webhookAdapter: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "stub" }),
    send: async () => undefined,
  };

  let streamEnqueue: StreamEnqueue | undefined;
  const sendPromptCalls: Array<{
    taskId: string;
    botDeliveryTarget: ZCodeAutomationBotDeliveryTarget | undefined;
  }> = [];
  const fakeTaskService = {
    listDeletedTaskIds: async () => [] as string[],
    resumeTask: async () => undefined,
    createTask: async () => ({ taskId: "task-created" }),
    deleteTask: async () => undefined,
    getTaskModelSelection: async () => ({
      providerId: ZCODE_AGENT_PROVIDER,
      modelId: "glm-test",
    }),
    getTaskConfigOptions: async () => [],
    listTasks: async () => [],
    getTaskSnapshot: async () =>
      options.taskSnapshotMetaStatus
        ? {
            meta: {
              taskId: CONVERSATIONAL_TASK_ID,
              status: options.taskSnapshotMetaStatus,
              title: "terminal task",
            },
          }
        : null,
    sendPrompt: async (request: {
      taskId: string;
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
    }) => {
      sendPromptCalls.push({
        taskId: request.taskId,
        botDeliveryTarget: request.botDeliveryTarget,
      });
      if (options.sendPromptError) throw options.sendPromptError;
    },
    setMode: async () => undefined,
    onDynamicStreamEvent:
      (taskId: string) =>
      (enqueue: StreamEnqueue): IDisposable => {
        // 既有 weixin 续跑流固定 CONVERSATIONAL_TASK_ID；Phase C Alpha 5 的 producer
        // parity 行走 feishu 首建路径（activeTaskId 为 null 的上下文）产生 task-created。
        assert.ok(
          taskId === CONVERSATIONAL_TASK_ID || taskId === "task-created",
          `unexpected stream taskId: ${taskId}`,
        );
        streamEnqueue = enqueue;
        return {
          dispose: () => {
            streamEnqueue = undefined;
          },
        };
      },
  };
  const modelSelection = { providerId: ZCODE_AGENT_PROVIDER, modelId: "glm-test" };
  const modelSelectionService = {
    getView: async () =>
      ({
        revision: 1,
        providers: [],
        preferredSelection: modelSelection,
        effectiveSelection: modelSelection,
      }) as unknown as Awaited<ReturnType<IModelSelectionService["getView"]>>,
  };
  const credentialService = {
    load: async () => null,
  } as unknown as ICredentialService;

  const needsRemoteService =
    options.remoteConnected ||
    options.remoteReader !== undefined ||
    options.remoteReaderInitThrows === true;
  const service = createBotsService({
    credentialService,
    zcodeTaskService: fakeTaskService as unknown as IZCodeTaskService,
    modelSelectionService,
    runStartupBackgroundTasks: false,
    providerOverrides: {
      weixin: weixinAdapter,
      feishu: feishuAdapter,
      telegram: telegramAdapter,
      webhook: webhookAdapter,
    },
    taskDeliveryRegistry: registry,
    ...(needsRemoteService
      ? {
          remoteWorkspaceService: {
            isConnected: async () => options.remoteConnected === true,
            ensureConnected: async () => ({ ok: true as const }),
            ...(options.remoteReader !== undefined || options.remoteReaderInitThrows === true
              ? {
                  getWorkspaceFileReader: async () => {
                    if (options.remoteReaderInitThrows) {
                      throw new Error("remote runtime init failed");
                    }
                    return options.remoteReader ?? null;
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(options.remoteFileTimeouts
      ? { remoteFileDeliveryTimeouts: options.remoteFileTimeouts }
      : {}),
  });

  const conversationalActor: BotActor = {
    provider: "weixin",
    botId: WEIXIN_BOT_ID,
    providerUserId: "wx-user-1",
    chatType: "private",
    chatId: "wx-chat-1",
  };

  const buildInbound = (
    overrides: {
      text?: string;
      token?: string;
      messageId?: string;
      chatType?: "private" | "group";
      provider?: "weixin" | "feishu" | "telegram" | "webhook";
    } = {},
  ) => {
    const provider = overrides.provider ?? "weixin";
    inboundMessageCounter += 1;
    const actor: BotActor = {
      provider,
      botId:
        provider === "telegram"
          ? TELEGRAM_BOT_ID
          : provider === "feishu"
            ? FEISHU_BOT_ID
            : provider === "webhook"
              ? WEBHOOK_BOT_ID
              : WEIXIN_BOT_ID,
      providerUserId:
        provider === "telegram"
          ? "tg-user-1"
          : provider === "feishu"
            ? "fs-user-1"
            : provider === "webhook"
              ? "wh-user-1"
              : "wx-user-1",
      chatType: overrides.chatType ?? "private",
      chatId:
        provider === "telegram"
          ? "tg-chat-1"
          : provider === "feishu"
            ? "fs-chat-1"
            : provider === "webhook"
              ? "wh-chat-1"
              : "wx-chat-1",
      providerMessageId: overrides.messageId ?? `msg-${inboundMessageCounter}`,
      ...(overrides.token === undefined ? {} : { providerContextToken: overrides.token }),
    };
    return {
      botId: actor.botId,
      actor,
      text: overrides.text ?? "继续分析",
      receivedAt: Date.now(),
    };
  };

  return {
    service,
    registry,
    sendAttachmentCalls,
    sentMessages,
    sendPromptCalls,
    adapterControl,
    workspacePath: workspace,
    outsideFilePath,
    getStreamEnqueue: () => streamEnqueue,
    conversationalActor,
    async triggerConversationalMessage(overrides = {}) {
      const replies = await service.handleInboundMessage(buildInbound(overrides));
      // sendPromptInBackground 是 fire-and-forget；等待微任务与定时器稳定。
      await new Promise((resolve) => setTimeout(resolve, 25));
      return replies;
    },
    async sendFileCommand(value: string, overrides = {}) {
      const replies = await service.handleInboundMessage(
        buildInbound({ text: `/file ${value}`, ...overrides }),
      );
      // A3a：快速门槛失败 → 同步失败回复（无 ack、无后台腿）；通过 → ack + 后台结果回复。
      const isAck = replies.length === 1 && replies[0].text === FILE_FETCH_STARTED_ZH;
      if (!isAck) {
        return replies;
      }
      const background = await waitForSentMessages(
        sentMessages,
        sentMessages.length,
        "/file 后台结果回复",
      );
      return [...replies, ...background];
    },
    readRawConfig: () => readFile(join(configDir, BOTS_CONFIG_FILE), "utf8"),
    readRawState: () => readFile(join(configDir, BOTS_STATE_FILE), "utf8"),
    async writeRawConfig(config: unknown) {
      await writeFile(join(configDir, BOTS_CONFIG_FILE), JSON.stringify(config));
    },
    async dispose() {
      await service.disposeAllAndWait().catch(() => undefined);
      setDataBaseDir(null);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    },
  };
}

function readRegistryActorToken(call: SendAttachmentCall): string | undefined {
  return call.message.providerContextToken;
}

test("taskDeliveryRegistry：remember 有界 200 淘汰最旧，重写刷新顺序，forget/clear 生效", () => {
  const registry = createBotTaskDeliveryRegistry();
  const buildEntry = (botId: string) => ({
    botId,
    actor: { provider: "weixin", botId, providerUserId: "u", chatType: "private" },
    workspacePath: "/ws",
  });
  registry.remember("task-0", buildEntry("bot-0"));
  for (let index = 1; index <= 200; index += 1) {
    registry.remember(`task-${index}`, buildEntry(`bot-${index}`));
  }
  assert.equal(registry.size, 200);
  // task-0 是最旧条目，第 201 次写入后应被淘汰。
  assert.equal(registry.get("task-0"), undefined);
  assert.notEqual(registry.get("task-1"), undefined);
  assert.notEqual(registry.get("task-200"), undefined);
  // 重写既有 taskId 刷新插入顺序：task-1 不再是最旧。
  registry.remember("task-1", buildEntry("bot-1"));
  registry.remember("task-new", buildEntry("bot-new"));
  assert.equal(registry.get("task-2"), undefined);
  assert.notEqual(registry.get("task-1"), undefined);
  registry.forget("task-new");
  assert.equal(registry.get("task-new"), undefined);
  registry.clear();
  assert.equal(registry.size, 0);
});

test("normalizeBotConfig 剥离未知顶层字段：携带 resolveNameError 的配置经 saveConfig 往返不被 strict schema 拒绝", async () => {
  // Review alpha.6 FIX2：saveBot 返回 additive 的 resolveNameError；旧 UI 把返回的 bot
  // 合并回配置再整份 saveConfig 时，未知顶层键必须被 normalizeBotConfig 丢弃，
  // 否则 botConfigSchema 的 strict 解析会拒绝整份配置（old-UI/new-host 兼容）。
  const harness = await createHarness();
  try {
    const bots = await harness.service.listBots();
    const weixinBot = bots.find((bot) => bot.id === WEIXIN_BOT_ID);
    const feishuBot = bots.find((bot) => bot.id === FEISHU_BOT_ID);
    assert.ok(weixinBot && feishuBot);
    // 模拟旧 UI 合并：additive 字段（resolveNameError）+ 一个任意未知键一起带进配置。
    const legacyMerged = {
      ...weixinBot,
      resolveNameError: "fetch failed: ETIMEDOUT (api.telegram.org)",
      someFutureAdditiveField: { nested: true },
    } as BotConfig;
    const saved = await harness.service.saveConfig({
      version: 3,
      bots: [legacyMerged, feishuBot],
    });
    assert.equal(saved.bots.find((bot) => bot.id === WEIXIN_BOT_ID)?.name, weixinBot.name);
    const persisted = JSON.parse(await harness.readRawConfig()) as {
      bots: Array<Record<string, unknown>>;
    };
    const persistedWeixin = persisted.bots.find((bot) => bot.id === WEIXIN_BOT_ID);
    assert.ok(persistedWeixin, "微信 bot 必须仍被保存");
    assert.equal(
      "resolveNameError" in persistedWeixin,
      false,
      "additive 的 resolveNameError 必须在归一化时丢弃",
    );
    assert.equal(
      "someFutureAdditiveField" in persistedWeixin,
      false,
      "任意未知顶层键必须在归一化时丢弃",
    );
    // 落盘文件必须原样通过 strict schema（旧配置再读入不得炸）。
    assert.equal(botsConfigFileSchema.safeParse(persisted).success, true);
    // 已知字段不得被误删：weixin 归一化语义（webhookUrl 清理）与权限边界保持不变。
    assert.deepEqual(persistedWeixin.allowedWorkspaces, ["*"]);
    assert.equal("webhookUrl" in persistedWeixin, false, "weixin 保存后不得残留 webhookUrl");
    // 保存后的服务视角仍能列出两个 bot（读写往返完整）。
    assert.equal((await harness.service.listBots()).length, 2);
  } finally {
    await harness.dispose();
  }
});

test("shareFile 配额：10 分钟窗口 3 次上限，按 (botId, peerKey) 隔离", () => {
  const quota = createBotShareFileQuotaTracker();
  const t0 = 1_000_000;
  for (let index = 0; index < 3; index += 1) {
    quota.record("bot-1", "peer-1", t0 + index);
  }
  assert.equal(quota.allows("bot-1", "peer-1", t0 + 10), false);
  // 不同 (botId, peerKey) 互不影响。
  assert.equal(quota.allows("bot-1", "peer-2", t0 + 10), true);
  assert.equal(quota.allows("bot-2", "peer-1", t0 + 10), true);
  // 滚动窗口：最早一条滑出 10 分钟后恢复（此处窗口内仍有 2 条，未达 3 上限）。
  assert.equal(quota.allows("bot-1", "peer-1", t0 + 600_000 + 1), true);
});

test("shareFile 配额：1 小时窗口 20 次上限独立生效（10 分钟窗口未满时）", () => {
  const quota = createBotShareFileQuotaTracker();
  // 合成时间线：20 条记录落在 [100, 2893]，查询时刻 10 分钟窗口为空、1 小时窗口全满。
  const queryAt = 3_600_000;
  for (let index = 0; index < 20; index += 1) {
    quota.record("bot-1", "peer-1", 100 + index * 147);
  }
  assert.equal(quota.allows("bot-1", "peer-1", queryAt), false);
  // 全部记录滑出 1 小时窗口后恢复。
  assert.equal(quota.allows("bot-1", "peer-1", 100 + 3_600_000 + 20), true);
});

test("shareFile 配额：reserve 原子判定+占位，release 按时间戳精确归还（review TOCTOU 修复）", () => {
  const quota = createBotShareFileQuotaTracker();
  const t0 = 2_000_000;
  // 连续 3 次预留全部成功；第 4 次被 10 分钟窗口拒绝。
  for (let index = 0; index < 3; index += 1) {
    assert.equal(quota.reserve("bot-1", "peer-1", t0 + index), true);
  }
  assert.equal(quota.reserve("bot-1", "peer-1", t0 + 5), false);
  // 释放一个具体预留时间戳后，同窗口内又能预留一次。
  quota.release("bot-1", "peer-1", t0 + 1);
  assert.equal(quota.reserve("bot-1", "peer-1", t0 + 6), true);
  // 释放不存在的时间戳 / 陌生 key 是 no-op。
  quota.release("bot-1", "peer-1", t0 + 999);
  quota.release("bot-1", "peer-unknown", t0);
  assert.equal(quota.reserve("bot-1", "peer-1", t0 + 7), false);
  // 全部归还后窗口完全恢复。
  for (const at of [t0, t0 + 6]) quota.release("bot-1", "peer-1", at);
  assert.equal(quota.allows("bot-1", "peer-1", t0 + 8), true);
});

test("revalidateWorkspaceFileForDelivery：读取前重校验大小增长（stat 与读取之间膨胀 → too-large）", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-bot-revalidate-"));
  try {
    const growing = join(root, "growing.bin");
    await writeFile(growing, Buffer.alloc(4 * 1024 * 1024));
    const first = await revalidateWorkspaceFileForDelivery(root, growing);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.sizeBytes, 4 * 1024 * 1024);
    }
    // 首次 stat 后文件增长超限：读取前必须以最新大小拒绝。
    const handle = await readFile(growing);
    assert.ok(handle.byteLength > 0);
    await writeFile(growing, Buffer.concat([handle, Buffer.alloc(2 * 1024 * 1024)]));
    const second = await revalidateWorkspaceFileForDelivery(root, growing);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, "too-large");
      assert.equal(second.sizeBytes, 6 * 1024 * 1024);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revalidateWorkspaceFileForDelivery：符号链接被替换指向树外（TOCTOU）→ outside-workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-bot-toctou-"));
  try {
    const outsideRoot = await mkdtemp(join(tmpdir(), "zcode-bot-toctou-out-"));
    try {
      await writeFile(join(outsideRoot, "leak.txt"), "leak");
      const linkPath = join(root, "swap-link");
      await symlink(join(root, "result.txt"), linkPath, "file");
      await writeFile(join(root, "result.txt"), "safe");
      // 首次校验时链接仍在树内。
      const before = await revalidateWorkspaceFileForDelivery(root, linkPath);
      assert.equal(before.ok, true);
      // 链接被替换为指向 workspace 外（symlink swap）。
      await rm(linkPath, { force: true });
      await symlink(join(outsideRoot, "leak.txt"), linkPath, "file");
      const after = await revalidateWorkspaceFileForDelivery(root, linkPath);
      assert.equal(after.ok, false);
      if (!after.ok) {
        assert.equal(after.reason, "outside-workspace");
      }
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("对话式入站消息填充 taskDeliveryRegistry（仅对话路径）", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage({ token: "token-captured" });
    const entry = harness.registry.get(CONVERSATIONAL_TASK_ID);
    assert.ok(entry, "对话式消息触发的任务必须登记投递目标");
    assert.equal(entry.botId, WEIXIN_BOT_ID);
    assert.equal(entry.workspacePath, harness.workspacePath);
    assert.equal(entry.actor.chatId, "wx-chat-1");
    assert.equal(entry.workspaceIdentity, undefined);
  } finally {
    await harness.dispose();
  }
});

test("resolveAutomationBotDeliveryTarget（sendPrompt 可见面）：telegram 仅私聊产出，群聊永不产出", async () => {
  // Phase C Alpha 5（spec §2c/验收场景 2）：telegram 私聊 → sendPrompt 收到
  // provider "telegram" 的投递目标（chatId 优先作为 providerUserId）。
  const telegramHarness = await createHarness({ telegramBot: buildTelegramBotConfig() });
  try {
    await telegramHarness.triggerConversationalMessage({ provider: "telegram" });
    assert.equal(telegramHarness.sendPromptCalls.length, 1);
    assert.deepEqual(telegramHarness.sendPromptCalls[0]!.botDeliveryTarget, {
      provider: "telegram",
      botId: TELEGRAM_BOT_ID,
      providerUserId: "tg-chat-1",
      chatType: "private",
    });

    // 群聊入站在授权层即被 privateChatOnly 拒绝，永远到不了 producer——
    // telegram 群聊绝不产生投递目标（owner decision 的可观察不变量）。
    const groupReplies = await telegramHarness.triggerConversationalMessage({
      provider: "telegram",
      chatType: "group",
    });
    assert.equal(groupReplies.length, 1);
    assert.equal(telegramHarness.sendPromptCalls.length, 1, "telegram 群聊不得产出投递目标");
  } finally {
    await telegramHarness.dispose();
  }

  // feishu/weixin 既有行为 parity：私聊照常产出（weixin 走续跑、feishu 走首建，
  // 两者 runningTasks 槽位不同，可在同一 harness 内先后触发）。
  const parityHarness = await createHarness();
  try {
    await parityHarness.triggerConversationalMessage({ provider: "weixin" });
    await parityHarness.triggerConversationalMessage({ provider: "feishu" });
    assert.equal(parityHarness.sendPromptCalls.length, 2);
    assert.deepEqual(
      parityHarness.sendPromptCalls.map((call) => call.botDeliveryTarget?.provider),
      ["weixin", "feishu"],
    );
    assert.equal(parityHarness.sendPromptCalls[1]!.botDeliveryTarget?.chatType, "private");
  } finally {
    await parityHarness.dispose();
  }
});

test("watchAutomationRun 删除既有投递目标（automation 复用 → no-target）", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage({ token: "token-captured" });
    assert.ok(harness.registry.get(CONVERSATIONAL_TASK_ID));
    await harness.service.watchAutomationRun({
      target: {
        provider: "weixin",
        botId: WEIXIN_BOT_ID,
        providerUserId: "wx-user-1",
        chatType: "private",
      },
      taskId: CONVERSATIONAL_TASK_ID,
      workspacePath: harness.workspacePath,
    });
    assert.equal(harness.registry.get(CONVERSATIONAL_TASK_ID), undefined);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "no-target" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("流终态清理投递目标（晚到 RPC → no-target）", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage({ token: "token-captured" });
    const enqueue = harness.getStreamEnqueue();
    assert.ok(enqueue, "对话式任务必须已订阅任务流");
    await enqueue({ type: "task_complete", taskId: CONVERSATIONAL_TASK_ID });
    assert.equal(harness.registry.get(CONVERSATIONAL_TASK_ID), undefined);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "no-target" });
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask：注册表未命中（未知任务）→ no-target", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.shareFileForTask({
      taskId: "task-unknown",
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "no-target" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask：happy path 走单一写出核心，adapter 恰好投递一次", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage({ token: "token-captured" });
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: true, filename: "result.txt", sizeBytes: "hello zodex".length });
    assert.equal(harness.sendAttachmentCalls.length, 1);
    assert.equal(
      harness.sendAttachmentCalls[0].attachment.localPath,
      join(harness.workspacePath, "out", "result.txt"),
    );
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：bot 中途禁用 → not-allowed", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    const rawConfig = JSON.parse(await harness.readRawConfig());
    rawConfig.bots[0].enabled = false;
    await harness.writeRawConfig(rawConfig);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "not-allowed" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：allowedCommands.file 中途关闭 → not-allowed", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    const rawConfig = JSON.parse(await harness.readRawConfig());
    rawConfig.bots[0].allowedCommands.file = false;
    await harness.writeRawConfig(rawConfig);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "not-allowed" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：用户解绑（providerUserId 变更）→ not-allowed", async () => {
  const harness = await createHarness();
  try {
    // 直接登记 feishu 会话目标，随后改绑 providerUserId，模拟中途解绑。
    harness.registry.remember(CONVERSATIONAL_TASK_ID, {
      botId: FEISHU_BOT_ID,
      actor: {
        provider: "feishu",
        botId: FEISHU_BOT_ID,
        providerUserId: "fs-user-1",
        chatType: "private",
      },
      workspacePath: harness.workspacePath,
    });
    const rawConfig = JSON.parse(await harness.readRawConfig());
    rawConfig.bots[1].providerUserId = "fs-someone-else";
    await harness.writeRawConfig(rawConfig);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "not-allowed" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：群聊 actor → not-allowed", async () => {
  const harness = await createHarness();
  try {
    harness.registry.remember(CONVERSATIONAL_TASK_ID, {
      botId: WEIXIN_BOT_ID,
      actor: { ...harness.conversationalActor, chatType: "group" },
      workspacePath: harness.workspacePath,
    });
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "not-allowed" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：adapter 无 sendAttachment（webhook）→ unsupported-provider", async () => {
  // Alpha 5 场景 5：真实 feishu adapter 已具备 sendAttachment，unsupported-provider
  // 负例 re-base 到 webhook——当前真实没有 sendAttachment 的 provider。
  const harness = await createHarness({ webhookBot: buildWebhookBotConfig() });
  try {
    harness.registry.remember(CONVERSATIONAL_TASK_ID, {
      botId: WEBHOOK_BOT_ID,
      actor: {
        provider: "webhook",
        botId: WEBHOOK_BOT_ID,
        providerUserId: "wh-user-1",
        chatType: "private",
      },
      workspacePath: harness.workspacePath,
    });
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "unsupported-provider" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：远程 workspace 且 bridge 缺席 → remote-unavailable，无本地读取兜底", async () => {
  const harness = await createHarness();
  try {
    harness.registry.remember(CONVERSATIONAL_TASK_ID, {
      botId: WEIXIN_BOT_ID,
      actor: harness.conversationalActor,
      workspacePath: harness.workspacePath,
      workspaceIdentity: "remote-identity-1",
    });
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    // Phase C Alpha 2 取代 remote-workspace 拒绝：远程已连接时走远端取回；bridge 缺席
    // （未注入 remoteWorkspaceService）如实映射 remote-unavailable，绝不回退读本地路径。
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "remote-unavailable");
    }
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：词法 ..、绝对路径、符号链接逃逸 → outside-workspace", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    await symlink(harness.outsideFilePath, join(harness.workspacePath, "escape-link"), "file");
    const paths = [`../${join(tmpdir(), "not-relevant")}`, harness.outsideFilePath, "escape-link"];
    for (const path of paths) {
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path,
      });
      assert.equal(result.ok, false, `path=${path}`);
      if (!result.ok) {
        assert.equal(result.reason, "outside-workspace", `path=${path}`);
      }
    }
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：文件不存在 → not-found；超过 5MB → too-large", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    const missing = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "no-such-file.bin",
    });
    assert.deepEqual(missing, { ok: false, reason: "not-found" });
    await writeFile(join(harness.workspacePath, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    const tooLarge = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "big.bin",
    });
    assert.equal(tooLarge.ok, false);
    if (!tooLarge.ok) {
      assert.equal(tooLarge.reason, "too-large");
    }
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFileForTask 守卫矩阵：adapter 抛错 → send-failed（仅一次调用）", async () => {
  const harness = await createHarness({ sendAttachmentError: new Error("provider down") });
  try {
    await harness.triggerConversationalMessage();
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "send-failed");
      assert.equal(result.detail, "provider down");
    }
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("shareFile quota：10 分钟内第 4 次 tool 投递被拒；/file 不受限", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    for (let index = 0; index < 3; index += 1) {
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/result.txt",
      });
      assert.equal(result.ok, true, `delivery ${index + 1}`);
    }
    assert.equal(harness.sendAttachmentCalls.length, 3);
    const fourth = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(fourth, { ok: false, reason: "quota-exceeded" });
    // 配额拒绝发生在任何文件 IO 之前：adapter 调用数不变。
    assert.equal(harness.sendAttachmentCalls.length, 3);
    // /file 永不受配额限制：连续 25 次全部尝试投递（A3a：ack 后后台结果回复到达）。
    for (let index = 0; index < 25; index += 1) {
      const replies = await harness.sendFileCommand("out/result.txt");
      assert.match(replies.at(-1)!.text, /^已发送 result\.txt（\d+B）。$/);
    }
    assert.equal(harness.sendAttachmentCalls.length, 28);
  } finally {
    await harness.dispose();
  }
});

test("shareFile quota TOCTOU（review 修复）：6 个并行 share_file 只放行 3 个到达 adapter", async () => {
  // 故意放慢 adapter，制造在途重叠窗口；share_file 是 concurrentSafe 工具，调度器并行执行。
  const harness = await createHarness({ sendAttachmentDelayMs: 40 });
  try {
    await harness.triggerConversationalMessage();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        harness.service.shareFileForTask({
          taskId: CONVERSATIONAL_TASK_ID,
          path: "out/result.txt",
        }),
      ),
    );
    // 全新窗口内：恰好 3 个成功、3 个 quota-exceeded；只有 3 个调用到达 adapter.sendAttachment。
    // 修复前（allows 判定 + 投递后 record 落账）6 个并行调用会在彼此落账前全部通过判定。
    const okCount = results.filter((result) => result.ok).length;
    const quotaRejected = results.filter(
      (result) => !result.ok && result.reason === "quota-exceeded",
    ).length;
    assert.equal(okCount, 3);
    assert.equal(quotaRejected, 3);
    assert.equal(harness.sendAttachmentCalls.length, 3);
  } finally {
    await harness.dispose();
  }
});

test("shareFile quota 释放语义（review 修复）：投递失败归还槽位，只有成功投递消耗配额", async () => {
  const harness = await createHarness({ sendAttachmentError: new Error("provider down") });
  try {
    await harness.triggerConversationalMessage();
    // 3 次 send-failed：每次失败都必须归还预留槽位（否则第 3 次就会 quota-exceeded）。
    for (let index = 0; index < 3; index += 1) {
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/result.txt",
      });
      assert.equal(result.ok, false, `attempt ${index + 1}`);
      if (!result.ok) {
        assert.equal(result.reason, "send-failed");
      }
    }
    // 失败全部释放后窗口为空：清除错误，下一次应成功而非 quota-exceeded。
    harness.adapterControl.error = undefined;
    const recovered = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.equal(recovered.ok, true, "失败投递不得消耗配额槽位");
    assert.equal(harness.sendAttachmentCalls.length, 1);
  } finally {
    await harness.dispose();
  }
});

test("shareFile quota 释放语义：投递前置拒绝（not-found）同样归还槽位", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    // 3 次路径不存在的失败投递：全部归还。
    for (let index = 0; index < 3; index += 1) {
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "no-such-file.bin",
      });
      assert.deepEqual(result, { ok: false, reason: "not-found" });
    }
    // 若槽位泄漏，这次成功投递会变成 quota-exceeded。
    const delivered = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.equal(delivered.ok, true);
    assert.equal(harness.sendAttachmentCalls.length, 1);
  } finally {
    await harness.dispose();
  }
});

test("sendPrompt 失败终态（review 修复）：taskDeliveryRegistry 遗忘 → share_file no-target", async () => {
  const harness = await createHarness({ sendPromptError: new Error("session gone") });
  try {
    await harness.triggerConversationalMessage();
    // sendPromptInBackground 的失败 catch 是任务终态：注册表必须遗忘该 taskId。
    assert.equal(harness.registry.get(CONVERSATIONAL_TASK_ID), undefined);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "no-target" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("isContextActiveTaskRunning 漏检终态（review 修复）：registry 遗忘 → share_file no-target", async () => {
  const harness = await createHarness({ taskSnapshotMetaStatus: "completed" });
  try {
    await harness.triggerConversationalMessage();
    // 没有流终态事件：注册表仍持有投递目标。
    assert.ok(harness.registry.get(CONVERSATIONAL_TASK_ID));
    // /task 触发 missed-terminal 检测：持久化状态已是 completed → 遗忘注册表条目。
    const replies = await harness.triggerConversationalMessage({ text: "/task" });
    assert.ok(Array.isArray(replies));
    assert.equal(harness.registry.get(CONVERSATIONAL_TASK_ID), undefined);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.deepEqual(result, { ok: false, reason: "no-target" });
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("/file 门槛顺序（review 修复）：webhook 渠道门槛先于路径解析", async () => {
  // Alpha 5 场景 5：负例自 feishu re-base 到 webhook（真实 feishu 已支持文件投递）。
  // 即使路径不存在，webhook 也必须回复渠道不支持（Alpha 0 优先级：adapter → 远程 → 路径）。
  const harness = await createHarness({ webhookBot: buildWebhookBotConfig() });
  try {
    const replies = await harness.sendFileCommand("no-such-file.bin", { provider: "webhook" });
    assert.equal(replies[0].text, "该渠道暂不支持发送文件，会在后续版本提供。");
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("/file 远程 happy path（Phase C Alpha 2）：已连接远程取回分块并投递临时文件", async () => {
  const content = Buffer.from("remote-file-payload-0123456789");
  const readerCalls: Parameters<FakeRemoteWorkspaceFileReader["readWorkspaceFile"]>[0][] = [];
  const reader = createFakeRemoteReader({
    filename: "remote-result.bin",
    content,
    chunkSize: 10,
    calls: readerCalls,
  });
  const harness = await createHarness({
    workspaceIdentity: "remote-identity-1",
    remoteConnected: true,
    remoteReader: reader,
  });
  try {
    const replies = await harness.sendFileCommand("out/remote-result.bin");
    assert.match(replies.at(-1)!.text, /^已发送 remote-result\.bin（\d+B）。$/);
    assert.equal(harness.sendAttachmentCalls.length, 1);
    const call = harness.sendAttachmentCalls[0];
    // 调用时刻临时文件存在且内容按序重组。
    assert.ok(call.localFileBytes, "sendAttachment 执行时临时文件必须存在");
    assert.deepEqual(call.localFileBytes, content);
    // 临时文件在 OS tmpdir 的 zcode-bot-outbound 下，且不在 workspace 内（不可经 /file 再见）。
    assert.ok(
      call.attachment.localPath.startsWith(join(tmpdir(), "zcode-bot-outbound")),
      `temp path should live under tmpdir/zcode-bot-outbound: ${call.attachment.localPath}`,
    );
    assert.ok(!call.attachment.localPath.startsWith(harness.workspacePath));
    assert.equal(call.attachment.sizeBytes, content.length);
    assert.equal(call.attachment.kind, "file");
    // 3 块（chunkSize=10 < 内容 30 字节）按 offset 顺序取回，limit 是 wire 上限 512KiB。
    assert.deepEqual(
      readerCalls.map((item) => item.offset),
      [0, 10, 20],
    );
    assert.ok(readerCalls.every((item) => item.limit === 512 * 1024));
    assert.ok(readerCalls.every((item) => item.workspaceIdentity === "remote-identity-1"));
    assert.ok(readerCalls.every((item) => item.workspacePath === harness.workspacePath));
    assert.ok(readerCalls.every((item) => item.relativePath === "out/remote-result.bin"));
    // 投递后临时目录被清理（文件 + 随机目录）。
    await assert.rejects(stat(call.attachment.localPath), /ENOENT/);
  } finally {
    await harness.dispose();
  }
});

test("/file 远程绝对路径平价（Phase C Alpha 3）：root 内绝对路径原样透传 reader；root 外由 reader 裁决拒绝", async () => {
  // 场景 1（绝对-inside）：desktop 不解析远端路径——requestedPath 原样进入 reader 的
  // relativePath（wire 字段名保持不变，additive 规则），containment 由远端机器按新
  // 词法策略（与本地 resolver 平价）裁决放行后照常投递。
  const content = Buffer.from("absolute-inside-payload");
  const readerCalls: Parameters<FakeRemoteWorkspaceFileReader["readWorkspaceFile"]>[0][] = [];
  const insideHarness = await createHarness({
    workspaceIdentity: "remote-identity-abs",
    remoteConnected: true,
    remoteReader: createFakeRemoteReader({
      filename: "remote-result.bin",
      content,
      calls: readerCalls,
    }),
  });
  try {
    const absoluteInside = join(insideHarness.workspacePath, "out/remote-result.bin");
    const replies = await insideHarness.sendFileCommand(absoluteInside);
    assert.match(replies.at(-1)!.text, /^已发送 remote-result\.bin（\d+B）。$/);
    assert.equal(insideHarness.sendAttachmentCalls.length, 1);
    // 钉住透传不变量：desktop 对远端路径不做任何重写/归一化。
    assert.ok(readerCalls.length > 0, "reader 必须被调用");
    assert.ok(readerCalls.every((item) => item.relativePath === absoluteInside));
    assert.ok(readerCalls.every((item) => item.workspaceIdentity === "remote-identity-abs"));
  } finally {
    await insideHarness.dispose();
  }

  // 场景 2（绝对-outside）：desktop 同样不预判（远端机器是 containment 的唯一裁决
  // 者）；reader fake 模拟远端新策略的 outside-workspace 裁决 → typed 拒绝 1:1 透传，
  // 如实拒绝、零投递。
  const outsideHarness = await createHarness({
    workspaceIdentity: "remote-identity-abs",
    remoteConnected: true,
    remoteReader: createFakeRemoteReader({
      filename: "a.bin",
      content: Buffer.from("abc"),
      control: { fail: "outside-workspace" },
    }),
  });
  try {
    const absoluteOutside = join(tmpdir(), "outside-secret.bin");
    const replies = await outsideHarness.sendFileCommand(absoluteOutside);
    assert.equal(outsideHarness.sendAttachmentCalls.length, 0);
    assert.equal(replies.at(-1)!.text, `只能发送当前 workspace 内的文件：${absoluteOutside}`);
  } finally {
    await outsideHarness.dispose();
  }
});

test("/file 无参数（review 修复附注）：parser 归为未知命令，与 Alpha 0 一致", async () => {
  const harness = await createHarness();
  try {
    // 事实核对：parseBotCommand 把无参数 /file 归为 unknown（Alpha 0 起如此），
    // fileMissingPath 空路径分支是防御代码，经 inbound 不可达；门槛顺序还原见上两测。
    const replies = await harness.sendFileCommand("", {});
    assert.equal(replies[0].text, "未知命令：**/file**");
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("A7 §5.6 Windows 保留名中和：远端 `CON.txt` 物料化的临时文件名不得是保留名（今天原样 CON.txt → 红）", async () => {
  // §5.6：远端 Linux workspace 可以存在名为 CON.txt 的文件（Windows 用户建不出，
  // 远端可以）；/file 取回后物料化到 os.tmpdir 的临时文件若沿用原名，在 Windows
  // 桌面上是非法设备名（测试表 B4 的 CON.txt 场景）。注：入站缓存文件段因
  // `<digest>-` 前缀而偶合安全；真正裸奔的是出站临时物料化点（无前缀）——
  // 红测钉在这里。新契约：helper 输出基名永不为保留名（含带扩展形态）。
  const content = Buffer.from("reserved-name-payload");
  const harness = await createHarness({
    workspaceIdentity: "remote-identity-con",
    remoteConnected: true,
    remoteReader: createFakeRemoteReader({ filename: "CON.txt", content }),
  });
  try {
    const replies = await harness.sendFileCommand("CON.txt");
    assert.equal(harness.sendAttachmentCalls.length, 1, "投递本身必须照常完成");
    const tempBasename = basename(harness.sendAttachmentCalls[0].attachment.localPath);
    assert.ok(replies.length > 0);
    assert.match(
      tempBasename,
      /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)/iu,
      `临时文件基名不得是 Windows 保留名（今天原样落 CON.txt，Windows 上非法）：${tempBasename}`,
    );
    // 带扩展形态也必须中和：CON.txt 的"首段"（第一个点之前）不得恰为保留名。
    const stem = tempBasename.split(".")[0]!;
    assert.match(
      stem,
      /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)/iu,
      `带扩展形态同样必须中和（stem=${stem}）`,
    );
  } finally {
    await harness.dispose();
  }
});

test("A7 §5.8 审计去重：file= 仅在与 path= 不同时输出（同值时只留 path=；今天恒双字段 → 红）", async () => {
  // §5.8（specs/bot-file-delivery.md Alpha 0 §9 amendment）：path= 是唯一路径
  // 字段；file= 仅当与 path= 取值不同（如物料化/消毒后文件名 vs 用户请求路径）
  // 才输出。红点：今天的成功线无条件双字段——顶层路径下 file= 与 path= 同值
  // 打两遍。子目录路径（file=basename ≠ path=相对路径）两字段都保留（契约钉）。
  const realLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const harness = await createHarness();
    try {
      await writeFile(join(harness.workspacePath, "top-level.txt"), "alpha7 audit");
      await harness.triggerConversationalMessage({ token: "token-captured" });

      // 场景 1（红点）：顶层路径——filename ≡ path → 只留 path=。
      const topLevel = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "top-level.txt",
      });
      assert.equal(topLevel.ok, true);
      const topLevelLine = logs.find(
        (line) =>
          line.includes("bot file delivery") &&
          line.includes("outcome=ok") &&
          line.includes("path=top-level.txt"),
      );
      assert.ok(topLevelLine, `必须存在成功审计线：\n${logs.join("\n")}`);
      assert.ok(
        !topLevelLine.includes("file=top-level.txt"),
        `file= 与 path= 同值时必须省略 file=（今天恒双字段重复打印）：${topLevelLine}`,
      );

      // 场景 2（契约钉）：子目录路径——file=basename ≠ path=相对路径 → 两字段都保留。
      const nested = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/result.txt",
      });
      assert.equal(nested.ok, true);
      const nestedLine = logs.find(
        (line) =>
          line.includes("bot file delivery") &&
          line.includes("outcome=ok") &&
          line.includes("path=out/result.txt"),
      );
      assert.ok(nestedLine, `子目录成功审计线必须存在：\n${logs.join("\n")}`);
      assert.ok(
        nestedLine.includes("file=result.txt") && nestedLine.includes("path=out/result.txt"),
        `file= 与 path= 不同值时两字段都保留（file=basename、path=workspace 相对路径）：${nestedLine}`,
      );
    } finally {
      await harness.dispose();
    }
  } finally {
    console.log = realLog;
  }
});

test("微信文字模式工具摘要行（review 修复）：share_file 状态词按输出散文如实分流", async () => {
  // 失败投递是正常 completed 工具结果：不能显示「完成」。
  const failed = formatBotToolCallSummaryLine({
    toolId: "tool-1",
    kind: "share_file",
    input: { path: "out/result.txt" },
    status: "completed",
    output: "The file exceeds the 5 MB delivery limit, so nothing was sent.",
  });
  assert.match(failed, /- 未发送 · /);
  assert.ok(!failed.includes("完成"));
  // 成功投递 → 已发送。
  const sent = formatBotToolCallSummaryLine({
    toolId: "tool-2",
    kind: "share_file",
    input: { path: "out/result.txt" },
    status: "completed",
    output:
      "File sent to the bot chat user: result.txt (11 bytes). They should have received it as a native media message.",
  });
  assert.match(sent, /- 已发送 · /);
  // unknown-outcome → 结果未知（不能误标成未发送）。
  const unknown = formatBotToolCallSummaryLine({
    toolId: "tool-3",
    kind: "share_file",
    input: { path: "out/result.txt" },
    status: "completed",
    output:
      "The delivery outcome is UNKNOWN: the request timed out and the file may or may not have been sent. Do NOT claim success or failure.",
  });
  assert.match(unknown, /- 结果未知 · /);
  // raw.result.content 兜底口径与 UI 渲染器一致。
  const fromRaw = formatBotToolCallSummaryLine({
    toolId: "tool-4",
    kind: "share_file",
    input: { path: "out/result.txt" },
    status: "completed",
    raw: { result: { content: "Sending to the provider failed." } },
  });
  assert.match(fromRaw, /- 未发送 · /);
});

test("单一写出核心：/file 失败零投递且回复文案保持既有本地化（pin 既有字符串）", async () => {
  const harness = await createHarness();
  try {
    // A3a：同步回复是 ack，结果文案（成功与失败）由后台腿发出——文案本身逐字保持。
    const outside = await harness.sendFileCommand("../../outside.txt");
    assert.equal(outside.at(-1)!.text, "只能发送当前 workspace 内的文件：../../outside.txt");
    const missing = await harness.sendFileCommand("missing.bin");
    assert.equal(missing.at(-1)!.text, "文件不存在或不可读：missing.bin");
    const sent = await harness.sendFileCommand("out/result.txt");
    assert.equal(sent.at(-1)!.text, "已发送 result.txt（11B）。");
    assert.equal(harness.sendAttachmentCalls.length, 1);
  } finally {
    await harness.dispose();
  }
});

test("严格 schema：携带 recipient/provider/peer 字段的请求在进入投递前被拒绝", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    const injected = zcodeBotsShareFileParamsSchema.safeParse({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
      provider: "weixin",
      botId: WEIXIN_BOT_ID,
      peerUserId: "attacker@im.wechat",
    });
    assert.equal(injected.success, false, "未知键必须被 strict schema 拒绝");
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("无上下文改写：一次 share_file 投递不产生任何 bot 状态/配置写入", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage({ token: "token-captured" });
    const stateBefore = await harness.readRawState();
    const configBefore = await harness.readRawConfig();
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.equal(result.ok, true);
    assert.equal(await harness.readRawState(), stateBefore);
    assert.equal(await harness.readRawConfig(), configBefore);
  } finally {
    await harness.dispose();
  }
});

test("token 偏好：tool 取最新持久化 token 覆盖陈旧捕获 token；/file 保持消息内 token 优先", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage({ token: "token-captured" });
    // 任务执行中的用户 ping（/status）刷新持久化 token 表，但不刷新注册表里的捕获 actor。
    await harness.sendFileCommand("out/result.txt", { token: "token-cmd" }).then(() => undefined);
    // 用一条无 token 的 /status ping 刷新持久化 token。
    await harness.service.handleInboundMessage({
      botId: WEIXIN_BOT_ID,
      actor: {
        provider: "weixin",
        botId: WEIXIN_BOT_ID,
        providerUserId: "wx-user-1",
        chatType: "private",
        chatId: "wx-chat-1",
        providerContextToken: "token-refreshed",
        providerMessageId: "msg-ping",
      },
      text: "/status",
    });
    const toolResult = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.equal(toolResult.ok, true);
    const toolCall = harness.sendAttachmentCalls.at(-1);
    assert.ok(toolCall);
    assert.equal(readRegistryActorToken(toolCall), "token-refreshed");
    // /file：消息自带 token 优先于持久化 token（此处持久化为 token-refreshed）。
    const commandReplies = await harness.sendFileCommand("out/result.txt", {
      token: "token-per-message",
    });
    assert.match(commandReplies.at(-1)!.text, /^已发送/);
    const commandCall = harness.sendAttachmentCalls.at(-1);
    assert.ok(commandCall);
    assert.equal(readRegistryActorToken(commandCall), "token-per-message");
    // /file：消息无 token 时回退到持久化 token。
    await harness.sendFileCommand("out/result.txt", { token: undefined });
    const fallbackCall = harness.sendAttachmentCalls.at(-1);
    assert.ok(fallbackCall);
    assert.equal(readRegistryActorToken(fallbackCall), "token-per-message");
  } finally {
    await harness.dispose();
  }
});

test("审计增强：tool 投递的 info 日志包含 source=tool、task 与 workspace 相对路径", async () => {
  const harness = await createHarness();
  const originalLog = console.log;
  const originalWarn = console.warn;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((item) => String(item)).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    captured.push(args.map((item) => String(item)).join(" "));
  };
  try {
    await harness.triggerConversationalMessage({ token: "token-captured" });
    captured.length = 0;
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/result.txt",
    });
    assert.equal(result.ok, true);
    const auditLine = captured.find((line) => line.includes("bot file delivery"));
    assert.ok(auditLine, "必须留下投递审计日志");
    assert.match(auditLine, /source=tool/);
    assert.match(auditLine, new RegExp(`task=${CONVERSATIONAL_TASK_ID}`));
    assert.match(auditLine, /path=out\/result\.txt/);
    assert.match(auditLine, /outcome=ok/);
    // 命令路径审计带 source=command。
    captured.length = 0;
    await harness.sendFileCommand("out/result.txt");
    const commandLine = captured.find((line) => line.includes("bot file delivery"));
    assert.ok(commandLine);
    assert.match(commandLine, /source=command/);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await harness.dispose();
  }
});

test("disposeAllAndWait 清空投递注册表（Host 关闭后 fail-closed）", async () => {
  const harness = await createHarness();
  try {
    await harness.triggerConversationalMessage();
    assert.ok(harness.registry.get(CONVERSATIONAL_TASK_ID));
    await harness.service.disposeAllAndWait();
    assert.equal(harness.registry.size, 0);
  } finally {
    await harness.dispose();
  }
});

// ---- Phase C Alpha 2：远程 workspace 投递（specs/bot-file-delivery.md Phase C）----

function rememberRemoteDeliveryEntry(harness: Awaited<ReturnType<typeof createHarness>>) {
  harness.registry.remember(CONVERSATIONAL_TASK_ID, {
    botId: WEIXIN_BOT_ID,
    actor: harness.conversationalActor,
    workspacePath: harness.workspacePath,
    workspaceIdentity: "remote-identity-1",
  });
}

test("远程 tool happy path：分块取回 → 恰好一次 adapter 投递 + 审计 remote= + 临时文件清理", async () => {
  const content = Buffer.alloc(700_000);
  content.fill("z");
  const reader = createFakeRemoteReader({
    filename: "remote-tool.bin",
    content,
    chunkSize: 524_288,
  });
  const harness = await createHarness({ remoteReader: reader });
  const originalLog = console.log;
  const originalWarn = console.warn;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((item) => String(item)).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    captured.push(args.map((item) => String(item)).join(" "));
  };
  try {
    rememberRemoteDeliveryEntry(harness);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/remote-tool.bin",
    });
    assert.deepEqual(result, { ok: true, filename: "remote-tool.bin", sizeBytes: content.length });
    // 恰好一次 adapter 调用；sizeBytes 用 RPC 回传值；本地临时文件在调用时刻存在且重组正确。
    assert.equal(harness.sendAttachmentCalls.length, 1);
    const call = harness.sendAttachmentCalls[0];
    assert.ok(call.localFileBytes);
    assert.deepEqual(call.localFileBytes, content);
    assert.equal(call.attachment.sizeBytes, content.length);
    // 2 块（524288 + 175712）。
    assert.ok(call.attachment.localPath.startsWith(join(tmpdir(), "zcode-bot-outbound")));
    await assert.rejects(stat(call.attachment.localPath), /ENOENT/);
    // 审计：remote=<identity> + path= 用 workspace 相对路径（请求原样），不是本地绝对路径。
    const auditLine = captured.find((line) => line.includes("bot file delivery"));
    assert.ok(auditLine, "必须留下投递审计日志");
    assert.match(auditLine, /outcome=ok/);
    assert.match(auditLine, /remote=remote-identity-1/);
    assert.match(auditLine, /path=out\/remote-tool\.bin/);
    assert.ok(!auditLine?.includes(harness.workspacePath));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await harness.dispose();
  }
});

test("远程物料化卫生：恶意文件名消毒、0600（POSIX）、发送后临时目录整体清理", async () => {
  // Review 修复：钉住临时文件卫生矩阵——文件名攻击（路径穿越/控制字符/超长）、
  // 0600 mode、以及 finally 清理的是整个随机目录而不只是文件。
  const hostileName = `../../evil\u0007:name/<>.png${"x".repeat(200)}`;
  const harness = await createHarness({
    remoteReader: createFakeRemoteReader({
      filename: hostileName,
      content: Buffer.from("payload"),
    }),
  });
  try {
    rememberRemoteDeliveryEntry(harness);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/evil.bin",
    });
    assert.equal(result.ok, true);
    assert.equal(harness.sendAttachmentCalls.length, 1);
    const call = harness.sendAttachmentCalls[0];
    // localPath 必须留在 tmp 根内；basename 无路径分隔符、截断到 120、穿越段被消毒。
    assert.ok(call.attachment.localPath.startsWith(join(tmpdir(), "zcode-bot-outbound")));
    const base = basename(call.attachment.localPath);
    assert.ok(!base.includes("/") && !base.includes("\\"), "basename 不得含路径分隔符");
    assert.ok(base.length <= 120, "basename 截断到 120（Windows MAX_PATH 余量）");
    assert.ok(base.startsWith(".._.._evil"), "穿越段必须被消毒为安全字符");
    if (process.platform !== "win32") {
      assert.equal(call.localFileMode, 0o600);
    }
    assert.deepEqual(call.localFileBytes, Buffer.from("payload"));
    // 发送结束后临时目录（不只是文件）被整体清理。
    await assert.rejects(stat(dirname(call.attachment.localPath)), /ENOENT/);
  } finally {
    await harness.dispose();
  }
});

test("远程 reader typed 拒绝 1:1 映射：outside-workspace / not-found / too-large，零投递", async () => {
  const control: FakeReaderControl = {};
  const harness = await createHarness({
    remoteReader: createFakeRemoteReader({
      filename: "a.bin",
      content: Buffer.from("abc"),
      control,
    }),
  });
  try {
    rememberRemoteDeliveryEntry(harness);
    const fails = ["outside-workspace", "not-found", "too-large"] as const;
    for (const fail of fails) {
      control.fail = fail;
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/remote-tool.bin",
      });
      assert.equal(result.ok, false, `fail=${fail}`);
      if (!result.ok) {
        assert.equal(result.reason, fail, `fail=${fail}`);
      }
    }
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("远程不可用矩阵：reader null / 初始化 throw / 读取 throw / unavailable → remote-unavailable，零投递", async () => {
  // 1) getWorkspaceFileReader 返回 null（无 attachable route）。
  const nullReaderHarness = await createHarness({ remoteReader: null });
  // 2) getWorkspaceFileReader 本身 throw（runtime 初始化失败/超时）。
  const initThrowHarness = await createHarness({ remoteReaderInitThrows: true });
  // 3) readWorkspaceFile 中途 throw（mid-read RPC 失败）。
  const throwingReader: FakeRemoteWorkspaceFileReader = {
    readWorkspaceFile: async () => {
      throw new Error("rpc broken mid-read");
    },
  };
  const readThrowHarness = await createHarness({ remoteReader: throwingReader });
  // 4) reader typed unavailable（含旧远端 CLI 不认识 v4 方法）。
  const unavailableHarness = await createHarness({
    remoteReader: createFakeRemoteReader({
      filename: "a.bin",
      content: Buffer.from("abc"),
      control: { fail: "unavailable" },
    }),
  });
  try {
    for (const harness of [
      nullReaderHarness,
      initThrowHarness,
      readThrowHarness,
      unavailableHarness,
    ]) {
      rememberRemoteDeliveryEntry(harness);
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/remote-tool.bin",
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "remote-unavailable");
      }
      assert.equal(harness.sendAttachmentCalls.length, 0);
    }
  } finally {
    await Promise.all([
      nullReaderHarness.dispose(),
      initThrowHarness.dispose(),
      readThrowHarness.dispose(),
      unavailableHarness.dispose(),
    ]);
  }
});

test("/file 远程失败映射：remote-unavailable 回复新本地化文案", async () => {
  const harness = await createHarness({
    workspaceIdentity: "remote-identity-1",
    remoteConnected: true,
    remoteReader: null,
  });
  try {
    const replies = await harness.sendFileCommand("out/result.txt");
    assert.equal(replies.at(-1)!.text, "远程工作区当前不可用，请稍后重试或先 /重连。");
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("远程 5MB 硬上限：累积超限 / 分块间增长 → too-large；非 eof 空块 → remote-unavailable", async () => {
  // 1) 累积字节越过 5MB（neverEof 让远端一直喂块）。
  //    Review 修复：sizeBytesAtChunk 钉在 5MB 上限——否则 fake reader 缺省回传
  //    content.length=5.5MB，会先触发「单块整文件 stat > 上限」分支，累积分支永远走不到。
  const cumulativeHarness = await createHarness({
    remoteReader: createFakeRemoteReader({
      filename: "big.bin",
      content: Buffer.alloc(5_500_000),
      chunkSize: 524_288,
      neverEof: true,
      sizeBytesAtChunk: () => 5 * 1024 * 1024,
    }),
  });
  // 2) 分块间增长：第 2 块回传的整文件大小已越过上限（读取时刻 stat 增长）。
  const growthHarness = await createHarness({
    remoteReader: createFakeRemoteReader({
      filename: "growing.bin",
      content: Buffer.from("tiny"),
      chunkSize: 2,
      sizeBytesAtChunk: (chunkIndex) => (chunkIndex >= 2 ? 6 * 1024 * 1024 : undefined),
    }),
  });
  // 3) 非 eof 空块（远端协议违约）：守卫按不可用失败，不得死循环。
  const emptyChunkHarness = await createHarness({
    remoteReader: createFakeRemoteReader({
      filename: "stuck.bin",
      content: Buffer.from("ab"),
      chunkSize: 2,
      neverEof: true,
    }),
  });
  try {
    for (const [harness, expected] of [
      [cumulativeHarness, "too-large"],
      [growthHarness, "too-large"],
      [emptyChunkHarness, "remote-unavailable"],
    ] as const) {
      rememberRemoteDeliveryEntry(harness);
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/remote.bin",
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, expected);
      }
      assert.equal(harness.sendAttachmentCalls.length, 0);
    }
  } finally {
    await Promise.all([
      cumulativeHarness.dispose(),
      growthHarness.dispose(),
      emptyChunkHarness.dispose(),
    ]);
  }
});

test("远程时限：单块 deadline 超时 / 总预算耗尽 → remote-unavailable（注入缩短时限）", async () => {
  // 1) 单块 deadline：reader 每块延迟 120ms，注入 chunkDeadlineMs=25。
  const deadlineHarness = await createHarness({
    remoteFileTimeouts: { chunkDeadlineMs: 25 },
    remoteReader: createFakeRemoteReader({
      filename: "slow.bin",
      content: Buffer.from("payload"),
      control: { delayMs: 120 },
    }),
  });
  // 2) 总预算：chunk1（45ms）在 60ms 预算内完成，chunk2 只剩 15ms < 45ms → 判负。
  const budgetHarness = await createHarness({
    remoteFileTimeouts: { totalBudgetMs: 60 },
    remoteReader: createFakeRemoteReader({
      filename: "slow.bin",
      content: Buffer.from("payload-payload-payload"),
      chunkSize: 7,
      control: { delayMs: 45 },
    }),
  });
  try {
    for (const harness of [deadlineHarness, budgetHarness]) {
      rememberRemoteDeliveryEntry(harness);
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/remote.bin",
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "remote-unavailable");
        assert.ok(result.detail, "时限失败必须携带诊断 detail");
      }
      assert.equal(harness.sendAttachmentCalls.length, 0);
    }
  } finally {
    await Promise.all([deadlineHarness.dispose(), budgetHarness.dispose()]);
  }
});

test("断连远程：/file 先回 /重连 提示（pinned）；tool 路径 → remote-unavailable", async () => {
  // 断连远端不会有 attachable route：bridge 返回 null reader（/file 侧在触达 reader 前
  // 就被 blockDisconnectedRemoteWorkspace 拦截；tool 侧进入远程分支如实失败）。
  const harness = await createHarness({
    workspaceIdentity: "remote-identity-1",
    remoteConnected: false,
    remoteReader: null,
  });
  try {
    // /file：blockDisconnectedRemoteWorkspace 先行回复（Alpha 0 起 pinned，Phase C 不变）。
    const replies = await harness.sendFileCommand("out/remote.bin");
    assert.equal(
      replies[0].text,
      `当前远端项目 ${harness.workspacePath} 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。`,
    );
    assert.equal(harness.sendAttachmentCalls.length, 0);
    // tool：shareFileForTask 无断连拦截，走远程分支如实返回 remote-unavailable。
    rememberRemoteDeliveryEntry(harness);
    const result = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/remote.bin",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "remote-unavailable");
    }
    assert.equal(harness.sendAttachmentCalls.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("远程 tool 配额 parity：成功消耗配额（第 4 次 quota-exceeded）；typed 失败归还槽位", async () => {
  const reader = createFakeRemoteReader({
    filename: "quota.bin",
    content: Buffer.from("quota-bytes"),
    control: {},
  });
  const harness = await createHarness({ remoteReader: reader });
  try {
    rememberRemoteDeliveryEntry(harness);
    for (let index = 0; index < 3; index += 1) {
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/remote.bin",
      });
      assert.equal(result.ok, true, `delivery ${index + 1}`);
    }
    assert.equal(harness.sendAttachmentCalls.length, 3);
    const fourth = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/remote.bin",
    });
    assert.deepEqual(fourth, { ok: false, reason: "quota-exceeded" });
    assert.equal(harness.sendAttachmentCalls.length, 3);
  } finally {
    await harness.dispose();
  }
});

test("远程 tool 配额释放：not-found 失败不消耗槽位，后续远程投递仍可成功", async () => {
  const readerControl: FakeReaderControl = { fail: "not-found" };
  const harness = await createHarness({
    remoteReader: createFakeRemoteReader({
      filename: "quota.bin",
      content: Buffer.from("quota-bytes"),
      control: readerControl,
    }),
  });
  try {
    rememberRemoteDeliveryEntry(harness);
    for (let index = 0; index < 3; index += 1) {
      const result = await harness.service.shareFileForTask({
        taskId: CONVERSATIONAL_TASK_ID,
        path: "out/remote.bin",
      });
      assert.deepEqual(result, { ok: false, reason: "not-found" }, `failure ${index + 1}`);
    }
    readerControl.fail = undefined;
    const recovered = await harness.service.shareFileForTask({
      taskId: CONVERSATIONAL_TASK_ID,
      path: "out/remote.bin",
    });
    assert.equal(recovered.ok, true, "失败投递不得消耗配额槽位");
    assert.equal(harness.sendAttachmentCalls.length, 1);
  } finally {
    await harness.dispose();
  }
});
