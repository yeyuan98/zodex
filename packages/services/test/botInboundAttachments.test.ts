import assert from "node:assert/strict";
import test from "node:test";
import type { IDisposable } from "@zcode/rpc";
import {
  ZCODE_AGENT_PROVIDER,
  type BotActor,
  type BotInboundAttachment,
  type BotOutboundAttachment,
  type BotOutboundMessage,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { BOTS_CONFIG_FILE, BOTS_STATE_FILE } from "../src/bots/config.js";
import { createBotsService } from "../src/bots/botsService.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";
import type { IBotsService } from "../src/bots/bots.js";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import type {
  BotProviderAdapter,
  BotProviderDownloadedAttachment,
} from "../src/bots/providers/types.js";
import { mkdtemp, mkdir, writeFile, rm, utimes, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// specs/bot-file-delivery.md「Inbound remote workspaces (3.14.5 Alpha 0)」：
// A1 —— 入站 file/pdf/video 也必须成为真实 prompt attachments（localPath + sizeBytes，
// 无 dataBase64），image/audio 行为逐字节不变；远程上下文消息携带 attachments 进入
// sendPrompt（desktop host 包装器的输入）。A3a —— /file 先回 ack，投递在后台执行，
// 不阻塞同一 actor 的后续入站命令；后台失败经 sendOutbound 回复且绝不抛入 polling loop。

const WEIXIN_BOT_ID = "bot-wx";
const CONVERSATIONAL_TASK_ID = "task-conv-1";
/** messages.ts fileFetchStarted（zh）——A3a ack 文案的钉住值。 */
const FILE_FETCH_STARTED_ZH = "正在获取并发送文件…";

type StreamEnqueue = (event: unknown) => Promise<void>;

interface SendPromptCapture {
  taskId: string;
  content: string;
  attachments: ZCodePromptAttachment[] | undefined;
  botDeliveryTarget: ZCodeAutomationBotDeliveryTarget | undefined;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function inboundAttachment(
  kind: BotInboundAttachment["kind"],
  filename: string,
  mimeType: string,
  data: Buffer,
): BotInboundAttachment {
  return {
    id: `att-${filename}`,
    kind,
    filename,
    mimeType,
    dataBase64: data.toString("base64"),
  };
}

interface HarnessOptions {
  /** 远程 workspace 上下文（isConnected=true + fake runtime services 全注入）。 */
  workspaceIdentity?: string;
  /** sendAttachment 等在一个手动 deferred 上（A3a 慢投递测试）。 */
  gateDelivery?: boolean;
  /**
   * weixin stub adapter 的 downloadAttachment 钩子——resolveAttachmentBytes 的
   * provider 下载路径（Alpha 6 R1/R2a/R4/R5 红测的 spy 接缝）。
   */
  downloadAttachment?: (
    attachment: BotInboundAttachment,
  ) => Promise<BotProviderDownloadedAttachment | null>;
}

interface Harness {
  service: IBotsService & { disposeAllAndWait(): Promise<void> };
  sendPromptCalls: SendPromptCapture[];
  sendAttachmentCalls: Array<{ botId: string; attachment: BotOutboundAttachment }>;
  /** adapter.send（后台 sendOutbound 回复）捕获序列。 */
  sentMessages: BotOutboundMessage[];
  /** adapter.downloadAttachment 被 resolveAttachmentBytes 调用的附件序列（spy）。 */
  downloadAttachmentCalls: BotInboundAttachment[];
  /** 本 harness 的附件缓存根目录（<dataRoot>/.zcode/v2/bot-attachments）。 */
  attachmentCacheDir: string;
  deliveryGate: Deferred | undefined;
  triggerMessage(options: {
    text?: string;
    attachments?: BotInboundAttachment[];
  }): Promise<BotOutboundMessage[]>;
  dispose(): Promise<void>;
}

let inboundMessageCounter = 0;

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), "zcode-bot-inbound-"));
  setDataBaseDir(dataRoot);
  const workspace = await mkdtemp(join(tmpdir(), "zcode-bot-inbound-ws-"));
  await mkdir(join(workspace, "out"), { recursive: true });
  await writeFile(join(workspace, "out", "result.txt"), "hello zodex");
  const configDir = getAppConfigDir();
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, BOTS_CONFIG_FILE),
    JSON.stringify({
      version: 3,
      bots: [
        {
          id: WEIXIN_BOT_ID,
          name: "WeChat Bot",
          provider: "weixin",
          enabled: true,
          providerUserId: "wx-user-1",
          allowedWorkspaces: ["*"],
          allowedCommands: {
            status: true,
            new: true,
            workspace: true,
            model: true,
            thoughtLevel: true,
            reply: true,
            file: true,
          },
          currentOptions: {},
          replyMode: "assistant_changes",
        },
      ],
    }),
  );
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
      },
    }),
  );

  const sendPromptCalls: SendPromptCapture[] = [];
  const sendAttachmentCalls: Array<{ botId: string; attachment: BotOutboundAttachment }> = [];
  const sentMessages: BotOutboundMessage[] = [];
  const downloadAttachmentCalls: BotInboundAttachment[] = [];
  const attachmentCacheDir = join(getAppConfigDir(), "bot-attachments");
  const deliveryGate = options.gateDelivery ? createDeferred() : undefined;
  const weixinAdapter: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "stub" }),
    send: async (_bot, message) => {
      sentMessages.push(message);
    },
    sendAttachment: async (bot, _message, attachment) => {
      if (deliveryGate) {
        await deliveryGate.promise;
      }
      sendAttachmentCalls.push({ botId: bot.id, attachment });
    },
    ...(options.downloadAttachment
      ? {
          downloadAttachment: async (
            _bot: Parameters<NonNullable<BotProviderAdapter["downloadAttachment"]>>[0],
            attachment: BotInboundAttachment,
          ): Promise<BotProviderDownloadedAttachment | null> => {
            downloadAttachmentCalls.push(attachment);
            return options.downloadAttachment!(attachment);
          },
        }
      : {}),
  };

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
    getTaskSnapshot: async () => null,
    sendPrompt: async (request: {
      taskId: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
    }) => {
      sendPromptCalls.push({
        taskId: request.taskId,
        content: request.content,
        attachments: request.attachments,
        botDeliveryTarget: request.botDeliveryTarget,
      });
    },
    setMode: async () => undefined,
    onDynamicStreamEvent:
      (taskId: string) =>
      (_enqueue: StreamEnqueue): IDisposable => {
        assert.ok(
          taskId === CONVERSATIONAL_TASK_ID || taskId === "task-created",
          `unexpected stream taskId: ${taskId}`,
        );
        return { dispose: () => undefined };
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

  const service = createBotsService({
    credentialService,
    zcodeTaskService: fakeTaskService as unknown as IZCodeTaskService,
    modelSelectionService,
    runStartupBackgroundTasks: false,
    providerOverrides: { weixin: weixinAdapter },
    ...(options.workspaceIdentity
      ? {
          remoteWorkspaceService: {
            isConnected: async () => true,
            getZCodeTaskService: async () => fakeTaskService,
            getModelSelectionService: async () => modelSelectionService,
          },
        }
      : {}),
  });

  const buildInbound = (overrides: { text?: string; attachments?: BotInboundAttachment[] }) => {
    inboundMessageCounter += 1;
    const actor: BotActor = {
      provider: "weixin",
      botId: WEIXIN_BOT_ID,
      providerUserId: "wx-user-1",
      chatType: "private",
      chatId: "wx-chat-1",
      providerMessageId: `msg-${inboundMessageCounter}`,
    };
    return {
      botId: actor.botId,
      actor,
      text: overrides.text ?? "继续分析",
      ...(overrides.attachments ? { attachments: overrides.attachments } : {}),
      receivedAt: Date.now(),
    };
  };

  return {
    service,
    sendPromptCalls,
    sendAttachmentCalls,
    sentMessages,
    downloadAttachmentCalls,
    attachmentCacheDir,
    deliveryGate,
    async triggerMessage(overrides = {}) {
      const replies = await service.handleInboundMessage(buildInbound(overrides));
      // sendPromptInBackground 是 fire-and-forget；等待微任务与定时器稳定。
      await new Promise((resolve) => setTimeout(resolve, 25));
      return replies;
    },
    async dispose() {
      await service.disposeAllAndWait().catch(() => undefined);
      setDataBaseDir(null);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

function lastSendPrompt(harness: Harness): SendPromptCapture {
  const capture = harness.sendPromptCalls.at(-1);
  assert.ok(capture, "sendPrompt 必须被调用");
  return capture;
}

// ---- A1：file/pdf/video 成为真实 prompt attachments ----

test("A1 入站 file/pdf/video 附件成为 prompt attachments（localPath + kind + sizeBytes，无 dataBase64）", async () => {
  const harness = await createHarness();
  try {
    const fileData = Buffer.from("plain text notes");
    const pdfData = Buffer.from("%PDF-1.4 fake pdf body");
    const videoData = Buffer.from("fake-mp4-bytes-0123456789");
    await harness.triggerMessage({
      attachments: [
        inboundAttachment("file", "notes.txt", "text/plain", fileData),
        inboundAttachment("file", "report.pdf", "application/pdf", pdfData),
        // 评审补充：分号参数 + 大小写混合的 pdf mime 也必须按同一形式识别（与 CLI mapper 一致）。
        inboundAttachment("file", "scan.pdf", "Application/PDF; charset=binary", pdfData),
        inboundAttachment("video", "clip.mp4", "video/mp4", videoData),
      ],
    });
    const capture = lastSendPrompt(harness);
    assert.ok(capture.attachments, "file/pdf/video 必须产出 prompt attachments");
    assert.equal(capture.attachments.length, 4);

    const fileAttachment = capture.attachments.find((item) => item.filename === "notes.txt");
    assert.ok(fileAttachment, "file 附件必须存在");
    assert.equal(fileAttachment.kind, "file");
    assert.equal(fileAttachment.mimeType, "text/plain");
    assert.equal(fileAttachment.sizeBytes, fileData.byteLength);
    assert.ok(fileAttachment.localPath, "file 附件必须携带缓存 localPath");
    assert.equal("dataBase64" in fileAttachment, false, "新 kind 不得携带 dataBase64");

    // pdf 由 mimeType 推导（BotInboundAttachmentKind 无 pdf；CLI mapper 对 pdf 有专门处理）。
    const pdfAttachment = capture.attachments.find((item) => item.filename === "report.pdf");
    assert.ok(pdfAttachment, "pdf 附件必须存在");
    assert.equal(pdfAttachment.kind, "pdf");
    assert.equal(pdfAttachment.mimeType, "application/pdf");
    assert.equal(pdfAttachment.sizeBytes, pdfData.byteLength);
    assert.ok(pdfAttachment.localPath);
    assert.equal("dataBase64" in pdfAttachment, false);

    const videoAttachment = capture.attachments.find((item) => item.filename === "clip.mp4");
    assert.ok(videoAttachment, "video 附件必须存在");
    assert.equal(videoAttachment.kind, "video");
    assert.equal(videoAttachment.mimeType, "video/mp4");
    assert.equal(videoAttachment.sizeBytes, videoData.byteLength);
    assert.ok(videoAttachment.localPath);
    assert.equal("dataBase64" in videoAttachment, false);

    // 既有 prompt 行仍在（远程包装器会改写其中的路径子串）。
    assert.match(capture.content, /附件：notes\.txt \(text\/plain, \d+B\)，已保存到：/u);
    for (const item of capture.attachments) {
      assert.ok(
        capture.content.includes(item.localPath ?? ""),
        `prompt 文本必须包含缓存路径：${item.filename}`,
      );
    }
  } finally {
    await harness.dispose();
  }
});

test("A1 回归：image/audio prompt attachments 行为逐字节不变（dataBase64 + localPath 保留）", async () => {
  const harness = await createHarness();
  try {
    const imageData = Buffer.from([1, 2, 3, 4]);
    const audioData = Buffer.from("fake-audio-bytes");
    await harness.triggerMessage({
      attachments: [
        inboundAttachment("image", "shot.png", "image/png", imageData),
        inboundAttachment("audio", "voice.mp3", "audio/mpeg", audioData),
      ],
    });
    const capture = lastSendPrompt(harness);
    assert.ok(capture.attachments);
    assert.equal(capture.attachments.length, 2);

    const imageAttachment = capture.attachments.find((item) => item.filename === "shot.png");
    assert.ok(imageAttachment);
    assert.equal(imageAttachment.kind, "image");
    assert.equal(imageAttachment.mimeType, "image/png");
    assert.equal(imageAttachment.dataBase64, imageData.toString("base64"));
    assert.ok(imageAttachment.localPath);

    const audioAttachment = capture.attachments.find((item) => item.filename === "voice.mp3");
    assert.ok(audioAttachment);
    assert.equal(audioAttachment.kind, "audio");
    assert.equal(audioAttachment.mimeType, "audio/mpeg");
    assert.equal(audioAttachment.dataBase64, audioData.toString("base64"));
    assert.ok(audioAttachment.localPath);

    assert.match(capture.content, /已作为图片输入提供/u);
    assert.match(capture.content, /已作为音频输入提供/u);
  } finally {
    await harness.dispose();
  }
});

test("A1 远程上下文：消息携带 attachments 进入 sendPrompt（desktop 远程包装器的输入）", async () => {
  const harness = await createHarness({ workspaceIdentity: "remote-identity-a1" });
  try {
    const pdfData = Buffer.from("%PDF-1.7 remote pdf");
    await harness.triggerMessage({
      attachments: [inboundAttachment("file", "remote-report.pdf", "application/pdf", pdfData)],
    });
    const capture = lastSendPrompt(harness);
    // 修复前：远程上下文的 file 附件不产生 prompt attachment，desktop 路径原样进入远端 prompt。
    assert.ok(capture.attachments, "远程上下文消息必须携带 attachments");
    assert.equal(capture.attachments.length, 1);
    assert.equal(capture.attachments[0].kind, "pdf");
    assert.ok(capture.attachments[0].localPath);
    assert.equal(capture.attachments[0].sizeBytes, pdfData.byteLength);
  } finally {
    await harness.dispose();
  }
});

// ---- A3a：/file ack-first 后台投递 ----

test("A3a /file 不阻塞队列：ack 立即返回，/status 在投递在途时完成，结果在投递结束后到达", async () => {
  const harness = await createHarness({ gateDelivery: true });
  try {
    const gate = harness.deliveryGate;
    assert.ok(gate, "gateDelivery 必须创建 deferred");
    const ackReplies = await withTimeout(
      harness.service.handleInboundMessage({
        botId: WEIXIN_BOT_ID,
        actor: {
          provider: "weixin",
          botId: WEIXIN_BOT_ID,
          providerUserId: "wx-user-1",
          chatType: "private",
          chatId: "wx-chat-1",
          providerMessageId: "msg-file-slow",
        },
        text: "/file out/result.txt",
        receivedAt: Date.now(),
      }),
      1000,
      "/file ack 必须立即返回（不被慢投递阻塞）",
    );
    assert.equal(ackReplies.length, 1);
    assert.equal(ackReplies[0].text, FILE_FETCH_STARTED_ZH);
    assert.equal(harness.sendAttachmentCalls.length, 0, "投递仍在途");
    assert.equal(harness.sentMessages.length, 0, "结果回复不得早于投递完成");

    // 同一 actor 的第二条入站命令在投递在途时必须完成（修复前会被串行队列阻塞）。
    const statusReplies = await withTimeout(
      harness.service.handleInboundMessage({
        botId: WEIXIN_BOT_ID,
        actor: {
          provider: "weixin",
          botId: WEIXIN_BOT_ID,
          providerUserId: "wx-user-1",
          chatType: "private",
          chatId: "wx-chat-1",
          providerMessageId: "msg-status-during-file",
        },
        text: "/status",
        receivedAt: Date.now(),
      }),
      1000,
      "/status 不得排在慢 /file 之后",
    );
    assert.ok(statusReplies.length > 0);
    assert.notEqual(statusReplies[0].text, FILE_FETCH_STARTED_ZH);
    assert.equal(harness.sentMessages.length, 0, "投递未完成前不得有结果回复");

    // 评审补充：/stop 同样必须在投递在途时完成——用户必须能随时终止会话任务，
    // 不被慢 /file 挂住（队列解除与命令类型无关，这里钉住 /stop 这一关键命令）。
    const stopReplies = await withTimeout(
      harness.service.handleInboundMessage({
        botId: WEIXIN_BOT_ID,
        actor: {
          provider: "weixin",
          botId: WEIXIN_BOT_ID,
          providerUserId: "wx-user-1",
          chatType: "private",
          chatId: "wx-chat-1",
          providerMessageId: "msg-stop-during-file",
        },
        text: "/stop",
        receivedAt: Date.now(),
      }),
      1000,
      "/stop 不得排在慢 /file 之后",
    );
    assert.ok(stopReplies.length > 0);
    assert.notEqual(stopReplies[0].text, FILE_FETCH_STARTED_ZH);
    assert.equal(harness.sentMessages.length, 0, "投递未完成前不得有结果回复");

    gate.resolve();
    await waitForCondition(
      () => harness.sendAttachmentCalls.length >= 1,
      2000,
      "投递在 deferred resolve 后完成",
    );
    await waitForCondition(() => harness.sentMessages.length >= 1, 2000, "fileSent 结果回复到达");
    assert.equal(harness.sentMessages[0].text, "已发送 result.txt（11B）。");
  } finally {
    await harness.dispose();
  }
});

test("A3a 后台失败：not-found 结果经 sendOutbound 回复本地化文案，无 unhandled rejection", async () => {
  const harness = await createHarness();
  const rejections: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    rejections.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const ackReplies = await withTimeout(
      harness.service.handleInboundMessage({
        botId: WEIXIN_BOT_ID,
        actor: {
          provider: "weixin",
          botId: WEIXIN_BOT_ID,
          providerUserId: "wx-user-1",
          chatType: "private",
          chatId: "wx-chat-1",
          providerMessageId: "msg-file-missing",
        },
        text: "/file missing.bin",
        receivedAt: Date.now(),
      }),
      1000,
      "/file ack 必须立即返回",
    );
    assert.equal(ackReplies.length, 1);
    assert.equal(ackReplies[0].text, FILE_FETCH_STARTED_ZH);
    await waitForCondition(() => harness.sentMessages.length >= 1, 2000, "后台失败回复必须到达");
    assert.equal(harness.sentMessages[0].text, "文件不存在或不可读：missing.bin");
    assert.equal(harness.sendAttachmentCalls.length, 0);
    // 后台腿的任何异常都不得泄漏为 unhandled rejection。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await harness.dispose();
  }
});

// ---- Alpha 6（specs/bot-file-delivery.md「Inbound attachment gates (3.14.5 Alpha 6)」）：
// 红测先行。以下测试在 alpha.5 代码上必然失败，失败点即待实现语义；W2 实现后转绿。
// 计划依据：../ZCode-alpha6-plan.md 附录 B（§5.1/§5.2/§5.15/§5.3）+ handoff §7.32
// owner 裁定（单次检查语义；sniff 而非硬编码后缀）。

/** >4 通知的钉住文案（spec Behavior 1：attachmentCountLimited，zh）。 */
const ATTACHMENT_COUNT_LIMITED_ZH = "一条消息最多处理前 4 个附件，已跳过其余 2 个附件。";
/** 逐文件超限拒绝通知的钉住文案（spec Behavior 2：attachmentTooLargeSkipped，zh）。 */
const ATTACHMENT_TOO_LARGE_SKIPPED_ZH = "附件 {filename} 超过 5MB 上限，已跳过。";

const FIVE_MB = 5 * 1024 * 1024;

/**
 * provider 文件型附件：只带 providerFileId（无 dataBase64/localPath/downloadUrl），
 * resolveAttachmentBytes 只能走 adapter.downloadAttachment 下载路径——
 * 这正是 Alpha 6 pre-download 检查（R1/R2a/R4/R5）需要 spy 的接缝。
 */
function providerFileAttachment(params: {
  index: number;
  filename?: string;
  kind?: BotInboundAttachment["kind"];
  mimeType?: string;
  sizeBytes?: number;
}): BotInboundAttachment {
  return {
    id: `provider-file-${params.index}`,
    kind: params.kind ?? "file",
    filename: params.filename ?? `provider-file-${params.index}.bin`,
    mimeType: params.mimeType ?? "application/octet-stream",
    ...(params.sizeBytes !== undefined ? { sizeBytes: params.sizeBytes } : {}),
    providerFileId: `wx-provider-file-id-${params.index}`,
  };
}

/** 递归列出 root 下所有普通文件（R4 零缓存断言 / R6 修剪观察）。 */
async function listFilesRecursively(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("A6 R1 >4 附件：立即通知 + 超出者绝不下载 + prompt 告知跳过", async () => {
  // §5.1：一条消息 6 个附件只处理前 4 个。红点：今天 slice 是静默的——
  // 对话消息返回 []（无通知），prompt 也只含 4 个附件的行、无任何"已跳过"提示。
  const harness = await createHarness({
    downloadAttachment: async (attachment) => ({
      attachment,
      data: Buffer.from(`downloaded-bytes:${attachment.id}`),
    }),
  });
  try {
    const attachments = Array.from({ length: 6 }, (_, index) =>
      providerFileAttachment({ index: index + 1 }),
    );
    const replies = await harness.triggerMessage({
      text: "请分析这些文件",
      attachments,
    });
    assert.ok(
      replies.some((reply) => reply.text === ATTACHMENT_COUNT_LIMITED_ZH),
      `必须立即回复 >4 本地化通知，实际 replies：${JSON.stringify(replies.map((reply) => reply.text))}`,
    );
    // 第 5、6 个附件绝不能进入解析/下载（slice 必须先于任何 per-attachment IO）。
    assert.equal(
      harness.downloadAttachmentCalls.length,
      4,
      "仅前 4 个附件可被下载，超出者绝不解析",
    );
    // 既有 slice 行为的回归钉：前 4 个照常成为 prompt attachments。
    const capture = lastSendPrompt(harness);
    assert.equal(capture.attachments?.length, 4);
    assert.equal(capture.attachments?.[0].filename, "provider-file-1.bin");
    assert.equal(capture.attachments?.[3].filename, "provider-file-4.bin");
    // 模型也必须知道附件被略过（prompt line）。
    assert.match(capture.content, /仅处理前 4 个/u);
    assert.match(capture.content, /已跳过|未接收/u);
  } finally {
    await harness.dispose();
  }
});

test("A6 R2a metadata 超限（sizeBytes 已知 >5MB）：逐文件拒绝，valid 附件照常进 prompt", async () => {
  // §5.2 单次检查语义（§7.32）：sizeBytes 已知且超限 → 下载前 typed reject。
  // 红点：今天 sizeBytes 元数据被无视——adapter 返回的小字节通过 byteLength 检查，
  // 超限文件照样被缓存并附给 prompt，用户也收不到逐文件拒绝通知。
  const harness = await createHarness({
    downloadAttachment: async (attachment) => ({
      attachment,
      data: Buffer.alloc(1024, 1),
    }),
  });
  try {
    const replies = await harness.triggerMessage({
      text: "帮我看下这两个文件",
      attachments: [
        providerFileAttachment({
          index: 1,
          filename: "huge-meta.bin",
          sizeBytes: FIVE_MB + 1024 * 1024,
        }),
        inboundAttachment("file", "small.txt", "text/plain", Buffer.from("hello alpha6")),
      ],
    });
    const capture = lastSendPrompt(harness);
    assert.equal(
      capture.attachments?.length,
      1,
      "metadata 超限文件必须被逐文件拒绝，只有 valid 附件进 prompt",
    );
    assert.equal(capture.attachments?.[0].filename, "small.txt");
    assert.ok(
      replies.some(
        (reply) =>
          reply.text === ATTACHMENT_TOO_LARGE_SKIPPED_ZH.replace("{filename}", "huge-meta.bin"),
      ),
      `必须收到点名 huge-meta.bin 的逐文件拒绝通知，实际 replies：${JSON.stringify(replies.map((reply) => reply.text))}`,
    );
    // prompt 行同样标注被拒文件与上限。
    assert.match(capture.content, /huge-meta\.bin/u);
    assert.match(capture.content, /5MB/u);
  } finally {
    await harness.dispose();
  }
});

test("A6 R2b 无 metadata 超限（byteLength fallback）：逐文件拒绝，valid 附件仍进 prompt", async () => {
  // §5.2 fallback 分支：sizeBytes 缺失 → 下载后 byteLength 检查仍只拒那一个文件。
  // 红点：今天 1 个超限文件令整条消息 throw（attachmentRejected），
  // sendPrompt 根本不会被调用，valid 附件与文字全部陪葬。
  const harness = await createHarness();
  try {
    const replies = await harness.triggerMessage({
      text: "帮我看下这两个文件",
      attachments: [
        inboundAttachment(
          "file",
          "huge-bytes.bin",
          "application/octet-stream",
          Buffer.alloc(FIVE_MB + 1024 * 1024, 7),
        ),
        inboundAttachment("file", "small.txt", "text/plain", Buffer.from("hello alpha6")),
      ],
    });
    const capture = lastSendPrompt(harness);
    assert.equal(
      capture.attachments?.length,
      1,
      "byteLength 超限只拒那一个文件，valid 附件必须照常进 prompt",
    );
    assert.equal(capture.attachments?.[0].filename, "small.txt");
    assert.ok(
      replies.some(
        (reply) =>
          reply.text === ATTACHMENT_TOO_LARGE_SKIPPED_ZH.replace("{filename}", "huge-bytes.bin"),
      ),
      `必须收到点名 huge-bytes.bin 的逐文件拒绝通知，实际 replies：${JSON.stringify(replies.map((reply) => reply.text))}`,
    );
    assert.match(capture.content, /huge-bytes\.bin/u);
  } finally {
    await harness.dispose();
  }
});

test("A6 R3 全拒且无文字：整条拒绝且逐个点名，不产生任何 prompt/任务", async () => {
  // §5.2 边界：所有附件被拒且消息无文字 → 仍整条拒绝（不能凭空开空任务）。
  // 红点：今天第一个抛错文件（big1）之外的文件从不被点名——big2 不会出现在
  // 任何回复里；新语义要求整条拒绝的回复逐个列出每个被拒文件。
  const harness = await createHarness();
  try {
    const replies = await harness.triggerMessage({
      text: "",
      attachments: [
        inboundAttachment(
          "file",
          "big1.bin",
          "application/octet-stream",
          Buffer.alloc(FIVE_MB + 1024 * 1024, 1),
        ),
        inboundAttachment(
          "file",
          "big2.bin",
          "application/octet-stream",
          Buffer.alloc(FIVE_MB + 1024 * 1024, 2),
        ),
      ],
    });
    assert.equal(harness.sendPromptCalls.length, 0, "全拒且无文字不得创建任何 prompt/任务");
    const rejectionText = replies.map((reply) => reply.text).join("\n");
    assert.match(rejectionText, /big1\.bin/u, "被拒文件 big1.bin 必须被逐个点名");
    assert.match(
      rejectionText,
      /big2\.bin/u,
      "被拒文件 big2.bin 必须被逐个点名（今天只有第一个抛错者被点名）",
    );
  } finally {
    await harness.dispose();
  }
});

test("A6 R4 全拒 ⇒ 零缓存写入（今天 metadata 超限者先被缓存留下孤儿文件）", async () => {
  // §5.2 不变量：整条拒绝的消息不得留下任何缓存写入。红点：今天循环逐个
  // resolve→byteLength→cache，metadata 超限者（实际字节仅 2KB）先通过 byteLength
  // 检查被写入缓存，随后 byteLength 超限的兄弟附件 throw 整条拒绝——缓存里
  // 留下 1 个孤儿文件。新语义：前者在下载前被拒（零下载零写入），后者 fallback
  // 拒绝，全拒且无文字 → 整条拒绝 + 零缓存。
  const harness = await createHarness({
    downloadAttachment: async (attachment) => ({
      attachment,
      data: Buffer.alloc(2048, 3),
    }),
  });
  try {
    const replies = await harness.triggerMessage({
      text: "",
      attachments: [
        providerFileAttachment({
          index: 1,
          filename: "meta-oversize.bin",
          sizeBytes: FIVE_MB + 1024 * 1024,
        }),
        inboundAttachment(
          "file",
          "bytes-oversize.bin",
          "application/octet-stream",
          Buffer.alloc(FIVE_MB + 1024 * 1024, 4),
        ),
      ],
    });
    assert.equal(harness.sendPromptCalls.length, 0, "全拒且无文字必须整条拒绝");
    assert.ok(replies.length > 0, "整条拒绝必须有可见回复");
    const cachedFiles = await listFilesRecursively(harness.attachmentCacheDir);
    assert.equal(
      cachedFiles.length,
      0,
      `全拒消息不得写入任何缓存文件，实际残留：${cachedFiles.map((path) => basename(path)).join(", ")}`,
    );
  } finally {
    await harness.dispose();
  }
});

test("A6 R5 sizeBytes 已知超限：下载路径绝不触发（秒拒）", async () => {
  // §5.2 核心收益：provider 推送消息时自带文件大小，已知超限就不该白下载。
  // 红点：今天 resolveAttachmentBytes 无条件先走 adapter.downloadAttachment
  // （spy 记到 1 次调用），下载完成后才由 byteLength 检查兜住。
  const harness = await createHarness({
    downloadAttachment: async (attachment) => ({
      attachment,
      data: Buffer.alloc(4096, 5),
    }),
  });
  try {
    const replies = await harness.triggerMessage({
      text: "处理下这个文件",
      attachments: [
        providerFileAttachment({
          index: 1,
          filename: "instant-reject.bin",
          sizeBytes: FIVE_MB + 1024 * 1024,
        }),
      ],
    });
    assert.equal(
      harness.downloadAttachmentCalls.length,
      0,
      "sizeBytes 已知超限必须在下载前拒绝（今天：先下载了才检查）",
    );
    assert.ok(
      replies.some(
        (reply) =>
          reply.text ===
          ATTACHMENT_TOO_LARGE_SKIPPED_ZH.replace("{filename}", "instant-reject.bin"),
      ),
      `必须收到即时逐文件拒绝通知，实际 replies：${JSON.stringify(replies.map((reply) => reply.text))}`,
    );
  } finally {
    await harness.dispose();
  }
});

test("A6 R6 缓存惰性修剪：>7 天文件与清空目录被删，新鲜文件保留", async () => {
  // §5.3：24h 内存门 piggyback 在 cacheResolvedAttachment（不 await）+ 启动单趟。
  // harness 关闭了 runStartupBackgroundTasks，启动趟在此不可用，因此用一条带附件的
  // 入站消息触发 cacheResolvedAttachment seam（服务生命期内首次触发即开门）。
  // 红点：今天 cacheResolvedAttachment 只写不清，没有任何修剪逻辑——aged 文件
  // 永远残留。该断言在 W2 实现修剪前保持红。
  const harness = await createHarness();
  try {
    const agedDir = join(harness.attachmentCacheDir, "bot-wx", "aged-msg");
    const agedPath = join(agedDir, "aged.bin");
    const freshPath = join(harness.attachmentCacheDir, "bot-wx", "fresh-msg", "fresh.bin");
    const onlyAgedDir = join(harness.attachmentCacheDir, "bot-wx", "only-aged");
    const onlyAgedPath = join(onlyAgedDir, "old.bin");
    await mkdir(agedDir, { recursive: true });
    await writeFile(agedPath, "aged");
    await mkdir(dirname(freshPath), { recursive: true });
    await writeFile(freshPath, "fresh");
    await mkdir(onlyAgedDir, { recursive: true });
    await writeFile(onlyAgedPath, "old");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(agedPath, eightDaysAgo, eightDaysAgo);
    await utimes(onlyAgedPath, eightDaysAgo, eightDaysAgo);
    await utimes(onlyAgedDir, eightDaysAgo, eightDaysAgo);

    await harness.triggerMessage({
      text: "看下这个文件",
      attachments: [inboundAttachment("file", "trigger.txt", "text/plain", Buffer.from("trigger"))],
    });

    // 修剪是 fire-and-forget：轮询最多 2s 等待 aged 文件消失（今天永不消失 → 红）。
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (await pathExists(agedPath))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      await pathExists(agedPath),
      false,
      "mtime 8 天的缓存文件必须被修剪删除（今天：只写不清）",
    );
    assert.equal(await pathExists(onlyAgedPath), false, "仅含过期文件的目录应连同删除");
    assert.equal(await pathExists(onlyAgedDir), false, "清空后的空目录应被移除");
    assert.equal(await pathExists(freshPath), true, "新鲜文件必须保留");
  } finally {
    await harness.dispose();
  }
});

// ---- §5.15 无名附件容器 sniff（§7.32：按文件头指纹识别，不硬编码 per-kind 后缀）----

/** ftyp 容器（mp4：非 qt brand；mov：qt brand）。 */
function ftypBytes(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from("ftyp"),
    Buffer.from(brand, "ascii"),
    Buffer.from("mp42isom"),
    Buffer.from("container-payload"),
  ]);
}

/** EBML 头（webm/mkv）：magic 1A45DFA3 + DocType 元素（ID 0x4282）。 */
function ebmlBytes(docType: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8f, 0x42, 0x82, docType.length]),
    Buffer.from(docType, "ascii"),
    Buffer.from("ebml-payload"),
  ]);
}

function wavBytes(): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x30, 0x00, 0x00, 0x00]),
    Buffer.from("WAVE"),
    Buffer.from("fmt "),
    Buffer.from("wav-payload"),
  ]);
}

async function triggerUnnamedAttachment(
  harness: Harness,
  kind: BotInboundAttachment["kind"],
  fallbackFilename: string,
  fallbackMimeType: string,
  data: Buffer,
): Promise<ZCodePromptAttachment> {
  await harness.triggerMessage({
    text: "看下这个文件",
    attachments: [inboundAttachment(kind, fallbackFilename, fallbackMimeType, data)],
  });
  const capture = lastSendPrompt(harness);
  const attachment = capture.attachments?.[0];
  assert.ok(attachment, "无名附件必须产出 prompt attachment");
  return attachment;
}

test("A6 R8 sniff：无名 mp4 字节 → 缓存补 .mp4 且 mimeType 修正为 video/mp4", async () => {
  // §5.15：微信视频常不带文件名（兜底 weixin-attachment-N，无扩展名）。红点：
  // 今天缓存文件名原样无后缀（AI 得自己复制一份加 .mp4 再读）、mimeType 用
  // provider 瞎猜的兜底值。新语义：按 ftyp 指纹补正确后缀 + 修正 mimeType。
  const harness = await createHarness();
  try {
    const attachment = await triggerUnnamedAttachment(
      harness,
      "video",
      "weixin-attachment-1",
      "video/mp4",
      ftypBytes("isom"),
    );
    assert.equal(attachment.filename, "weixin-attachment-1.mp4");
    assert.equal(attachment.mimeType, "video/mp4");
    assert.ok(attachment.localPath?.endsWith(".mp4"), "缓存路径必须带 .mp4 后缀");
  } finally {
    await harness.dispose();
  }
});

test("A6 R8 sniff：qt brand ftyp → .mov + video/quicktime（不猜 mp4）", async () => {
  // §5.15（owner §7.32 修订：视频不一定是 mp4——iPhone 的 mov）。红点：今天
  // 无扩展名兜底不区分容器；新语义按 brand 区分 qt → .mov。
  const harness = await createHarness();
  try {
    const attachment = await triggerUnnamedAttachment(
      harness,
      "video",
      "weixin-attachment-2",
      "video/mp4",
      ftypBytes("qt  "),
    );
    assert.equal(attachment.filename, "weixin-attachment-2.mov");
    assert.equal(attachment.mimeType, "video/quicktime");
    assert.ok(attachment.localPath?.endsWith(".mov"));
  } finally {
    await harness.dispose();
  }
});

test("A6 R8 sniff：EBML/webm 字节 → .webm + video/webm", async () => {
  // §5.15 magic 表：EBML 头 + DocType=webm。红点：今天保持无扩展名。
  const harness = await createHarness();
  try {
    const attachment = await triggerUnnamedAttachment(
      harness,
      "video",
      "weixin-attachment-3",
      "video/mp4",
      ebmlBytes("webm"),
    );
    assert.equal(attachment.filename, "weixin-attachment-3.webm");
    assert.equal(attachment.mimeType, "video/webm");
    assert.ok(attachment.localPath?.endsWith(".webm"));
  } finally {
    await harness.dispose();
  }
});

test("A6 R8 sniff：RIFF/WAVE 字节 → .wav + audio/wav", async () => {
  // §5.15 magic 表：RIFF..WAVE。红点：今天保持无扩展名。
  const harness = await createHarness();
  try {
    const attachment = await triggerUnnamedAttachment(
      harness,
      "audio",
      "weixin-attachment-4",
      "audio/mpeg",
      wavBytes(),
    );
    assert.equal(attachment.filename, "weixin-attachment-4.wav");
    assert.equal(attachment.mimeType, "audio/wav");
    assert.ok(attachment.localPath?.endsWith(".wav"));
  } finally {
    await harness.dispose();
  }
});

test("A6 R8 sniff 守护：乱码字节 → 维持无扩展名（识别不出不得乱补）", async () => {
  // §5.15：sniff 识别不出 → 维持无扩展名（不比今天更糟）。注意：本用例在
  // alpha.5 上即为绿——它是防止 W2 过度补后缀的守护钉，不是红点。
  const harness = await createHarness();
  try {
    const attachment = await triggerUnnamedAttachment(
      harness,
      "video",
      "weixin-attachment-5",
      "video/mp4",
      Buffer.from("definitely-not-a-media-container-payload!!"),
    );
    assert.equal(attachment.filename, "weixin-attachment-5");
    assert.equal(attachment.filename.includes("."), false, "不得为未知容器捏造扩展名");
  } finally {
    await harness.dispose();
  }
});
