import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { BotConfig, BotOutboundAttachment, BotOutboundMessage } from "@zcode/shared";
import { createTelegramBotProvider } from "../src/bots/providers/telegramProvider.js";
import { createBotProviderRequester } from "../src/bots/providers/providerRequest.js";

// specs/bot-file-delivery.md Phase C Alpha 5 验收场景 3：Telegram adapter
// sendAttachment —— 全程 stub 全局 fetch，无真实网络；只走 sendDocument 文档通道。

const TELEGRAM_TOKEN = "tg-token-1";
const TELEGRAM_CHAT_ID = "tg-chat-4242";

interface CapturedFetchCall {
  url: string;
  init: RequestInit;
}

/**
 * stub 全局 fetch 与 setTimeout：前者捕获 sendDocument 请求，后者捕获
 * providerRequest 施加的请求 deadline（默认 15s；Alpha 5 要求显式 60s）。
 */
function installProviderStub(respond: (call: CapturedFetchCall) => Response): {
  calls: CapturedFetchCall[];
  setTimeoutDelays: number[];
  restore(): void;
} {
  const calls: CapturedFetchCall[] = [];
  const setTimeoutDelays: number[] = [];
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout.bind(globalThis) as (
    ...args: Parameters<typeof setTimeout>
  ) => ReturnType<typeof setTimeout>;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    setTimeoutDelays.push(typeof args[1] === "number" ? args[1] : 0);
    return realSetTimeout(...args);
  }) as typeof globalThis.setTimeout;
  return {
    calls,
    setTimeoutDelays,
    restore() {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

function buildTelegramBot(): BotConfig {
  return {
    id: "bot-telegram-1",
    name: "Telegram Bot",
    provider: "telegram",
    enabled: true,
    credentialRef: "telegram-token-ref",
    allowedWorkspaces: ["*"],
    allowedCommands: {
      status: true,
      new: true,
      workspace: true,
      model: true,
      thoughtLevel: true,
      reply: true,
    },
    currentOptions: {},
    replyMode: "assistant_changes",
  };
}

function buildOutboundMessage(): BotOutboundMessage {
  return {
    botId: "bot-telegram-1",
    provider: "telegram",
    providerUserId: TELEGRAM_CHAT_ID,
    text: "",
  };
}

function buildOutboundAttachment(localPath: string, sizeBytes: number): BotOutboundAttachment {
  return {
    kind: "file",
    filename: "result.txt",
    mimeType: "text/plain",
    sizeBytes,
    localPath,
  };
}

async function writeAttachmentFile(): Promise<{ localPath: string; bytes: Buffer }> {
  const bytes = Buffer.from("Zodex telegram outbound document payload", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "zcode-tg-attach-"));
  const localPath = join(dir, "result.txt");
  await writeFile(localPath, bytes);
  return { localPath, bytes };
}

test("telegram sendAttachment：sendDocument multipart + 显式 60s 超时", async () => {
  const file = await writeAttachmentFile();
  const stub = installProviderStub(
    () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const provider = createTelegramBotProvider({
      loadCredential: async () => TELEGRAM_TOKEN,
      // Alpha 6 F1：adapter 出站改走注入 requester；stub 安装后构造即捕获 stub 后的 global fetch。
      requester: createBotProviderRequester(),
    });
    const sendAttachment = provider.sendAttachment;
    assert.ok(sendAttachment, "telegram adapter must implement sendAttachment");
    await sendAttachment(
      buildTelegramBot(),
      buildOutboundMessage(),
      buildOutboundAttachment(file.localPath, file.bytes.length),
    );

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.url, `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`);
    assert.equal(call.init.method, "POST");
    // 不手工设置 content-type：undici FormData 自带 multipart boundary。
    assert.equal(call.init.headers, undefined);
    // deadline 信号由 providerRequest 统一接线，请求必须有界。
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.ok(call.init.body instanceof FormData);
    const form = call.init.body as FormData;
    // 目标推导与 send/sendMessage 一致：chat_id = message.providerUserId。
    assert.equal(form.get("chat_id"), TELEGRAM_CHAT_ID);
    const document = form.get("document");
    assert.ok(document instanceof Blob);
    assert.equal((document as File).name, "result.txt");
    assert.ok(Buffer.from(await document.arrayBuffer()).equals(file.bytes));
    // 15s 默认超时对 5MB 上传太短；显式 60s 必须真实传给 providerRequest 的 deadline。
    assert.deepEqual(stub.setTimeoutDelays, [60_000]);
  } finally {
    stub.restore();
    await rm(dirname(file.localPath), { recursive: true, force: true });
  }
});

test("telegram sendAttachment：payload.ok=false → 抛错携带 description 且不重试", async () => {
  const file = await writeAttachmentFile();
  const stub = installProviderStub(
    () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const provider = createTelegramBotProvider({
      loadCredential: async () => TELEGRAM_TOKEN,
      // Alpha 6 F1：adapter 出站改走注入 requester；stub 安装后构造即捕获 stub 后的 global fetch。
      requester: createBotProviderRequester(),
    });
    const sendAttachment = provider.sendAttachment;
    assert.ok(sendAttachment, "telegram adapter must implement sendAttachment");
    await assert.rejects(
      sendAttachment(
        buildTelegramBot(),
        buildOutboundMessage(),
        buildOutboundAttachment(file.localPath, file.bytes.length),
      ),
      /chat not found/u,
    );
    // 失败语义：单次抛错上抛（服务层映射 send-failed），不做重试循环。
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    await rm(dirname(file.localPath), { recursive: true, force: true });
  }
});

test("telegram sendAttachment：缺少 token → 拒绝且不发起任何请求", async () => {
  const file = await writeAttachmentFile();
  const stub = installProviderStub(
    () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  try {
    const provider = createTelegramBotProvider({
      loadCredential: async () => null,
      requester: createBotProviderRequester(),
    });
    const sendAttachment = provider.sendAttachment;
    assert.ok(sendAttachment, "telegram adapter must implement sendAttachment");
    await assert.rejects(
      sendAttachment(
        buildTelegramBot(),
        buildOutboundMessage(),
        buildOutboundAttachment(file.localPath, file.bytes.length),
      ),
      /Telegram bot token is missing/u,
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await rm(dirname(file.localPath), { recursive: true, force: true });
  }
});

// specs/bot-file-delivery.md Phase C Alpha 5 验收场景 7：Telegram 原生命令菜单
// 通过 syncCommands → setMyCommands 注册 /file；allowedCommands.file 缺省 = 允许，
// 仅显式 false 时排除。

interface TelegramCommandPayload {
  commands: Array<{ command: string; description: string }>;
}

async function readSyncedCommands(
  botOverrides?: Partial<{ file: boolean | undefined }>,
): Promise<TelegramCommandPayload> {
  const stub = installProviderStub(
    () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  try {
    const provider = createTelegramBotProvider({
      loadCredential: async () => TELEGRAM_TOKEN,
      // Alpha 6 F1：adapter 出站改走注入 requester；stub 安装后构造即捕获 stub 后的 global fetch。
      requester: createBotProviderRequester(),
    });
    const bot = buildTelegramBot();
    if (botOverrides && "file" in botOverrides) {
      bot.allowedCommands = { ...bot.allowedCommands, file: botOverrides.file };
    }
    await provider.syncCommands(bot);
    const setCommandsCall = stub.calls.find((call) => call.url.endsWith("/setMyCommands"));
    assert.ok(setCommandsCall, "syncCommands must call setMyCommands");
    assert.ok(typeof setCommandsCall.init.body === "string");
    return JSON.parse(setCommandsCall.init.body as string) as TelegramCommandPayload;
  } finally {
    stub.restore();
  }
}

test("telegram syncCommands：默认注册 /file 原生命令", async () => {
  const payload = await readSyncedCommands();
  const fileCommand = payload.commands.find((command) => command.command === "file");
  assert.deepEqual(fileCommand, { command: "file", description: "Send a workspace file" });
});

test("telegram syncCommands：allowedCommands.file === false → 菜单不含 /file", async () => {
  const payload = await readSyncedCommands({ file: false });
  assert.ok(!payload.commands.some((command) => command.command === "file"));
  // 其余命令不受 file 开关影响。
  assert.ok(payload.commands.some((command) => command.command === "bind"));
});

test("telegram sendAttachment：>5MB 本地文件读侧复检 → 报 5MB 上限且零上传请求", async () => {
  // specs/bot-file-delivery.md「Inbound attachment gates (3.14.5 Alpha 6)」§5.4
  // （计划 §5.4）：TG/飞书 sendAttachment 对齐 weixin 的读侧 ≤5MB 复检——文件在
  // 服务层 stat 与 adapter readFile 之间可能变大，读取后、上传前必须再拦一次。
  // 红点：今天 readFile 后直接构造 FormData 上传（stub 成功即成功），不抛任何
  // 带上限的错误，超限文件会被硬传。
  const bytes = Buffer.alloc(6 * 1024 * 1024, 0x61);
  const dir = await mkdtemp(join(tmpdir(), "zcode-tg-attach-"));
  const localPath = join(dir, "big.bin");
  await writeFile(localPath, bytes);
  const stub = installProviderStub(
    () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const provider = createTelegramBotProvider({
      loadCredential: async () => TELEGRAM_TOKEN,
      requester: createBotProviderRequester(),
    });
    const sendAttachment = provider.sendAttachment;
    assert.ok(sendAttachment, "telegram adapter must implement sendAttachment");
    await assert.rejects(
      sendAttachment(buildTelegramBot(), buildOutboundMessage(), {
        kind: "file",
        filename: "big.bin",
        mimeType: "application/octet-stream",
        sizeBytes: bytes.length,
        localPath,
      }),
      /5MB/u,
    );
    assert.equal(stub.calls.length, 0, "超限必须在任何上传请求之前拒绝");
  } finally {
    stub.restore();
    await rm(dirname(localPath), { recursive: true, force: true });
  }
});
