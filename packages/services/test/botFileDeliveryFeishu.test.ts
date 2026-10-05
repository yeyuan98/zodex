import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotActor,
  BotConfig,
  BotInboundAttachment,
  BotOutboundAttachment,
  BotOutboundAttachmentKind,
  BotOutboundMessage,
} from "@zcode/shared";
import { createFeishuBotProvider } from "../src/bots/providers/feishuProvider.js";
import { createBotProviderRequester } from "../src/bots/providers/providerRequest.js";

// specs/bot-file-delivery.md Phase C Alpha 5 验收场景 4：Feishu adapter
// sendAttachment —— 全程 stub 全局 fetch，无真实网络；上传-再发送，按 kind 分流
// （image → im/v1/images，video/file → im/v1/files），0 字节先于上传诚实失败。

const FEISHU_TOKEN = "t-feishu-tenant-token-1";
const FEISHU_OPEN_ID = "ou_feishu_user_9";

interface CapturedFetchCall {
  url: string;
  init: RequestInit;
}

/**
 * stub 全局 fetch 与 setTimeout：前者捕获 tenant_access_token / im/v1/images /
 * im/v1/files / im/v1/messages 请求，后者捕获 providerRequest 施加的请求 deadline
 * （默认 15s；Alpha 5 要求上传与消息发送显式 60s）。
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

function jsonResponse(payload: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 飞书各端点的成功应答；未知 URL 直接失败，暴露意外请求。 */
function feishuOkResponder(call: CapturedFetchCall): Response {
  if (call.url.includes("/open-apis/auth/v3/tenant_access_token/internal")) {
    return jsonResponse({ code: 0, tenant_access_token: FEISHU_TOKEN, expire: 7200 });
  }
  if (call.url.includes("/open-apis/im/v1/images")) {
    return jsonResponse({ code: 0, data: { image_key: "img_v2_key_1" } });
  }
  if (call.url.includes("/open-apis/im/v1/files")) {
    return jsonResponse({ code: 0, data: { file_key: "file_v2_key_1" } });
  }
  if (call.url.includes("/open-apis/im/v1/messages")) {
    return jsonResponse({ code: 0, data: { message_id: "om_1001" } });
  }
  throw new Error(`unexpected feishu fetch: ${call.url}`);
}

function buildFeishuBot(appId: string): BotConfig {
  return {
    id: "bot-feishu-1",
    name: "Feishu Bot",
    provider: "feishu",
    enabled: true,
    feishuAppId: appId,
    credentialRef: `feishu-secret-${appId}`,
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
    replyMode: "streaming_card",
  };
}

function buildOutboundMessage(): BotOutboundMessage {
  return {
    botId: "bot-feishu-1",
    provider: "feishu",
    providerUserId: FEISHU_OPEN_ID,
    text: "",
  };
}

/**
 * 单次 sendAttachment 全流程：落盘临时文件 → stub 网络与定时器 → 调用 adapter。
 * 每次使用独立 appId，避开模块级 tenant_access_token 缓存对调用次数断言的干扰。
 */
async function runSendAttachment(options: {
  appId: string;
  filename: string;
  mimeType: string;
  kind: BotOutboundAttachmentKind;
  bytes: Buffer;
  respond?: (call: CapturedFetchCall) => Response;
}): Promise<{ calls: CapturedFetchCall[]; setTimeoutDelays: number[]; error?: Error }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fs-attach-"));
  const localPath = join(dir, options.filename);
  await writeFile(localPath, options.bytes);
  const stub = installProviderStub(options.respond ?? feishuOkResponder);
  try {
    const provider = createFeishuBotProvider({
      loadCredential: async () => "feishu-app-secret-value",
      // Alpha 6 F1：adapter 出站改走注入 requester；stub 安装后构造即捕获 stub 后的 global fetch。
      requester: createBotProviderRequester(),
    });
    const sendAttachment = provider.sendAttachment;
    assert.ok(sendAttachment, "feishu adapter must implement sendAttachment");
    const attachment: BotOutboundAttachment = {
      kind: options.kind,
      filename: options.filename,
      mimeType: options.mimeType,
      sizeBytes: options.bytes.length,
      localPath,
    };
    let error: Error | undefined;
    try {
      await sendAttachment(buildFeishuBot(options.appId), buildOutboundMessage(), attachment);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    return { calls: stub.calls, setTimeoutDelays: stub.setTimeoutDelays, error };
  } finally {
    stub.restore();
    await rm(dir, { recursive: true, force: true });
  }
}

test("feishu sendAttachment：image → im/v1/images 上传 + msg_type=image 发送 + 显式 60s", async () => {
  const bytes = Buffer.from("png-bytes-for-feishu-upload", "utf8");
  const run = await runSendAttachment({
    appId: "cli_1000000000000001",
    filename: "plot.png",
    mimeType: "image/png",
    kind: "image",
    bytes,
  });
  assert.ok(!run.error, run.error?.message);
  // token → 上传 → 消息发送，恰好三次。
  assert.equal(run.calls.length, 3);
  const [tokenCall, uploadCall, sendCall] = run.calls;
  assert.ok(tokenCall.url.endsWith("/open-apis/auth/v3/tenant_access_token/internal"));
  assert.ok(uploadCall.url.endsWith("/open-apis/im/v1/images"));
  assert.equal(uploadCall.init.method, "POST");
  // 不手工设置 content-type：undici FormData 自带 multipart boundary。
  assert.deepEqual(uploadCall.init.headers, { authorization: `Bearer ${FEISHU_TOKEN}` });
  assert.ok(uploadCall.init.body instanceof FormData);
  const form = uploadCall.init.body as FormData;
  assert.equal(form.get("image_type"), "message_type");
  const image = form.get("image");
  assert.ok(image instanceof Blob);
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(bytes));
  // 目标推导与 send 完全一致：receive_id = message.providerUserId（ou_ → open_id）。
  assert.equal(
    sendCall.url,
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id`,
  );
  const body = JSON.parse(String(sendCall.init.body)) as {
    receive_id: string;
    msg_type: string;
    content: string;
  };
  assert.equal(body.receive_id, FEISHU_OPEN_ID);
  assert.equal(body.msg_type, "image");
  assert.deepEqual(JSON.parse(body.content), { image_key: "img_v2_key_1" });
  // token 请求保持 15s 默认；上传与消息发送都必须显式 60s（5MB 上传预算）。
  assert.deepEqual(run.setTimeoutDelays, [15_000, 60_000, 60_000]);
});

test("feishu sendAttachment：file → im/v1/files 上传（pdf）+ msg_type=file 发送", async () => {
  const bytes = Buffer.from("%PDF-1.7 feishu outbound file payload", "utf8");
  const run = await runSendAttachment({
    appId: "cli_1000000000000002",
    filename: "report.pdf",
    mimeType: "application/pdf",
    kind: "file",
    bytes,
  });
  assert.ok(!run.error, run.error?.message);
  assert.equal(run.calls.length, 3);
  const uploadCall = run.calls[1]!;
  assert.ok(uploadCall.url.endsWith("/open-apis/im/v1/files"));
  assert.equal(uploadCall.init.method, "POST");
  assert.ok(uploadCall.init.body instanceof FormData);
  const form = uploadCall.init.body as FormData;
  assert.equal(form.get("file_type"), "pdf");
  assert.equal(form.get("file_name"), "report.pdf");
  const file = form.get("file");
  assert.ok(file instanceof Blob);
  assert.equal((file as File).name, "report.pdf");
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes));
  const sendCall = run.calls[2]!;
  const body = JSON.parse(String(sendCall.init.body)) as {
    receive_id: string;
    msg_type: string;
    content: string;
  };
  assert.equal(body.receive_id, FEISHU_OPEN_ID);
  assert.equal(body.msg_type, "file");
  assert.deepEqual(JSON.parse(body.content), { file_key: "file_v2_key_1" });
});

test("feishu sendAttachment：file_type 映射 mp4/opus 命中，未知扩展 → stream", async () => {
  const rows: Array<{ filename: string; mimeType: string; expected: string }> = [
    { filename: "clip.mp4", mimeType: "video/mp4", expected: "mp4" },
    { filename: "voice.opus", mimeType: "audio/opus", expected: "opus" },
    { filename: "data.xyz", mimeType: "application/octet-stream", expected: "stream" },
  ];
  for (const [index, row] of rows.entries()) {
    const run = await runSendAttachment({
      appId: `cli_200000000000000${index + 1}`,
      filename: row.filename,
      mimeType: row.mimeType,
      kind: "file",
      bytes: Buffer.from(`payload-${row.filename}`, "utf8"),
    });
    assert.ok(!run.error, `${row.filename}: ${run.error?.message}`);
    const uploadCall = run.calls.find((call) => call.url.includes("/open-apis/im/v1/files"));
    assert.ok(uploadCall, row.filename);
    assert.equal((uploadCall.init.body as FormData).get("file_type"), row.expected, row.filename);
  }
});

test("feishu sendAttachment：0 字节文件在上传前如实失败（零上传请求）", async () => {
  const run = await runSendAttachment({
    appId: "cli_3000000000000001",
    filename: "empty.pdf",
    mimeType: "application/pdf",
    kind: "file",
    bytes: Buffer.alloc(0),
  });
  assert.ok(run.error, "0 字节文件必须抛错");
  assert.match(run.error.message, /empty/u);
  // 0 字节检查先于上传：im/v1/files 与 im/v1/images 均零请求（仅先行的 token 读取）。
  assert.equal(run.calls.filter((call) => call.url.includes("/open-apis/im/v1/files")).length, 0);
  assert.equal(run.calls.filter((call) => call.url.includes("/open-apis/im/v1/images")).length, 0);
  assert.equal(run.calls.length, 1);
});

test("feishu sendAttachment：上传业务错误（HTTP 200 code!=0）→ 抛错携带 code/msg/log_id", async () => {
  const run = await runSendAttachment({
    appId: "cli_4000000000000001",
    filename: "broken.pdf",
    mimeType: "application/pdf",
    kind: "file",
    bytes: Buffer.from("%PDF-1.7 broken", "utf8"),
    respond: (call) => {
      if (call.url.includes("/open-apis/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: FEISHU_TOKEN, expire: 7200 });
      }
      if (call.url.includes("/open-apis/im/v1/files")) {
        // HTTP 200 但业务拒绝：错误码在 body，log_id 在响应头 x-tt-logid。
        return jsonResponse(
          { code: 99991672, msg: "app has no im:resource scope" },
          { "x-tt-logid": "log-upload-42" },
        );
      }
      throw new Error(`unexpected feishu fetch: ${call.url}`);
    },
  });
  assert.ok(run.error, "业务错误必须抛错");
  assert.match(run.error.message, /code=99991672/u);
  assert.match(run.error.message, /msg=app has no im:resource scope/u);
  assert.match(run.error.message, /log_id=log-upload-42/u);
  // 失败语义：单次抛错上抛（服务层映射 send-failed），不做重试循环。
  assert.equal(run.calls.length, 2);
});

test("feishu sendAttachment：im/v1/files 上传成功但缺 file_key → 抛缺失键错误且零 im/v1/messages 调用", async () => {
  const run = await runSendAttachment({
    appId: "cli_6000000000000001",
    filename: "report.pdf",
    mimeType: "application/pdf",
    kind: "file",
    bytes: Buffer.from("%PDF-1.7 no file_key", "utf8"),
    respond: (call) => {
      if (call.url.includes("/open-apis/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: FEISHU_TOKEN, expire: 7200 });
      }
      if (call.url.includes("/open-apis/im/v1/files")) {
        // HTTP 200 且 code=0，但 data 缺 file_key：诚实失败，不得继续发送。
        return jsonResponse({ code: 0, data: {} });
      }
      throw new Error(`unexpected feishu fetch: ${call.url}`);
    },
  });
  assert.ok(run.error, "上传应答缺 file_key 必须抛错");
  assert.match(run.error.message, /Feishu upload file failed: response missing file_key/u);
  // 缺键即失败：不携带半成品去调 im/v1/messages（仅 token + 上传两次请求）。
  assert.equal(
    run.calls.filter((call) => call.url.includes("/open-apis/im/v1/messages")).length,
    0,
  );
  assert.equal(run.calls.length, 2);
});

test("feishu sendAttachment：im/v1/images 上传成功但缺 image_key → 抛缺失键错误且零 im/v1/messages 调用", async () => {
  const run = await runSendAttachment({
    appId: "cli_6000000000000002",
    filename: "plot.png",
    mimeType: "image/png",
    kind: "image",
    bytes: Buffer.from("png-bytes-without-image-key", "utf8"),
    respond: (call) => {
      if (call.url.includes("/open-apis/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: FEISHU_TOKEN, expire: 7200 });
      }
      if (call.url.includes("/open-apis/im/v1/images")) {
        // HTTP 200 且 code=0，但整个 data 缺失：同样命中缺键诚实失败分支。
        return jsonResponse({ code: 0 });
      }
      throw new Error(`unexpected feishu fetch: ${call.url}`);
    },
  });
  assert.ok(run.error, "上传应答缺 image_key 必须抛错");
  assert.match(run.error.message, /Feishu upload image failed: response missing image_key/u);
  assert.equal(
    run.calls.filter((call) => call.url.includes("/open-apis/im/v1/messages")).length,
    0,
  );
  assert.equal(run.calls.length, 2);
});

test("feishu sendAttachment：上传成功但 im/v1/messages 业务错误（HTTP 200 code!=0）→ 抛错携带 code/msg/log_id 且不重试", async () => {
  const run = await runSendAttachment({
    appId: "cli_6000000000000003",
    filename: "report.pdf",
    mimeType: "application/pdf",
    kind: "file",
    bytes: Buffer.from("%PDF-1.7 send will fail", "utf8"),
    respond: (call) => {
      if (call.url.includes("/open-apis/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: FEISHU_TOKEN, expire: 7200 });
      }
      if (call.url.includes("/open-apis/im/v1/files")) {
        return jsonResponse({ code: 0, data: { file_key: "file_v2_key_1" } });
      }
      if (call.url.includes("/open-apis/im/v1/messages")) {
        // 上传成功后的消息发送被业务拒绝：log_id 在 body error.log_id（优先于响应头）。
        return jsonResponse({
          code: 230002,
          msg: "receive message limited",
          error: { log_id: "log-send-77" },
        });
      }
      throw new Error(`unexpected feishu fetch: ${call.url}`);
    },
  });
  assert.ok(run.error, "消息发送业务错误必须抛错");
  assert.match(run.error.message, /Feishu send file message failed: HTTP 200/u);
  assert.match(run.error.message, /code=230002/u);
  assert.match(run.error.message, /msg=receive message limited/u);
  assert.match(run.error.message, /log_id=log-send-77/u);
  assert.match(run.error.message, /receive_id_type=open_id/u);
  // 失败语义：单次发送尝试上抛（token + 上传 + 发送恰好三次），无重试循环。
  assert.equal(
    run.calls.filter((call) => call.url.includes("/open-apis/im/v1/messages")).length,
    1,
  );
  assert.equal(run.calls.length, 3);
});

test("feishu sendAttachment：凭据缺失 → 显式拒绝且不发起任何请求", async () => {
  const bytes = Buffer.from("feishu outbound payload", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "zcode-fs-attach-"));
  const localPath = join(dir, "result.txt");
  await writeFile(localPath, bytes);
  const stub = installProviderStub(feishuOkResponder);
  try {
    const provider = createFeishuBotProvider({
      loadCredential: async () => null,
      requester: createBotProviderRequester(),
    });
    const sendAttachment = provider.sendAttachment;
    assert.ok(sendAttachment, "feishu adapter must implement sendAttachment");
    await assert.rejects(
      sendAttachment(buildFeishuBot("cli_5000000000000001"), buildOutboundMessage(), {
        kind: "file",
        filename: "result.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        localPath,
      }),
      /Feishu app credentials are missing/u,
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("feishu sendAttachment：>5MB 本地文件读侧复检 → 报 5MB 上限且零上传/发送请求", async () => {
  // specs/bot-file-delivery.md「Inbound attachment gates (3.14.5 Alpha 6)」§5.4
  // （计划 §5.4）：TG/飞书 sendAttachment 对齐 weixin 的读侧 ≤5MB 复检。红点：
  // 今天 readFile 后照常 upload-then-send（stub 全成功 → run.error 为空），
  // 超限文件会被硬传，报错里不会出现 5MB 字样。
  const run = await runSendAttachment({
    appId: "cli_7000000000000001",
    filename: "big.bin",
    mimeType: "application/octet-stream",
    kind: "file",
    bytes: Buffer.alloc(6 * 1024 * 1024, 0x61),
  });
  assert.ok(run.error, ">5MB 文件必须在读侧被拒绝（今天：stub 全成功、无任何抛错）");
  assert.match(run.error.message, /5MB/u);
  // 超限必须先于任何上传/发送请求（tenant_access_token 先行读取允许存在）。
  assert.equal(
    run.calls.filter((call) => call.url.includes("/open-apis/im/v1/")).length,
    0,
    "超限必须在任何 im/v1 上传或发送请求之前拒绝",
  );
});

// ---- Alpha 8（specs/bot-file-delivery.md Alpha 6 行为第 6 条）：飞书入站
// audio/video 资源按 messages-resources API 契约以 type=file 拉取（API 仅收
// image|file；file 覆盖 file/audio/video）。红测先行：今天 ternary 发
// type=audio / type=media（feishuProvider downloadAttachment URL 拼接），
// 契约非法、100% 下载失败。W2 改非 image → file 后转绿。----

/**
 * 单次 downloadAttachment：stub 网络后直接调 adapter 下载路径，捕获
 * tenant_access_token 与 messages/{message_id}/resources/{file_key} 请求
 * （记录 query string，返回小份二进制载荷 + ok 状态）。每次使用独立 appId，
 * 避开模块级 tenant_access_token 缓存。
 * 桩假设（披露）：直接构造 BotInboundAttachment（kind 显式给定）而非驱动
 * 完整 parseCallback——被测 ternary 只读 attachment.kind，与
 * readFeishuAttachment 经 inferFeishuAttachmentKind 从 msg_type 推得的
 * kind 取值一致；providerMessageId/providerFileId 缺一即返回 null。
 */
async function runDownloadAttachment(options: {
  appId: string;
  kind: BotInboundAttachment["kind"];
}): Promise<{ calls: CapturedFetchCall[]; error?: Error }> {
  const payload = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const stub = installProviderStub((call) => {
    if (call.url.includes("/open-apis/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: FEISHU_TOKEN, expire: 7200 });
    }
    if (call.url.includes("/open-apis/im/v1/messages/") && call.url.includes("/resources/")) {
      // 小份二进制载荷 + ok 状态：下载路径只关心字节与 HTTP 状态。
      return new Response(payload, { status: 200 });
    }
    throw new Error(`unexpected feishu fetch: ${call.url}`);
  });
  try {
    const provider = createFeishuBotProvider({
      loadCredential: async () => "feishu-app-secret-value",
      requester: createBotProviderRequester(),
    });
    const downloadAttachment = provider.downloadAttachment;
    assert.ok(downloadAttachment, "feishu adapter must implement downloadAttachment");
    const attachment: BotInboundAttachment = {
      id: "att-feishu-inbound-1",
      kind: options.kind,
      filename: `feishu-inbound-${options.kind}`,
      mimeType: "application/octet-stream",
      providerFileId: "file_v2_inbound_key_1",
    };
    const actor: BotActor = {
      provider: "feishu",
      botId: "bot-feishu-1",
      providerUserId: FEISHU_OPEN_ID,
      chatType: "private",
      chatId: "oc_feishu_chat_1",
      providerMessageId: "om_inbound_2001",
    };
    let error: Error | undefined;
    try {
      await downloadAttachment(buildFeishuBot(options.appId), attachment, actor);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    return { calls: stub.calls, error };
  } finally {
    stub.restore();
  }
}

test("feishu downloadAttachment：audio → 请求 type=file（API 仅收 image|file；今天 type=audio → 红）", async () => {
  const run = await runDownloadAttachment({ appId: "cli_8000000000000001", kind: "audio" });
  assert.ok(!run.error, run.error?.message);
  const resourceCall = run.calls.find(
    (call) => call.url.includes("/open-apis/im/v1/messages/") && call.url.includes("/resources/"),
  );
  assert.ok(resourceCall, "必须发起资源下载请求");
  assert.equal(
    new URL(resourceCall.url).searchParams.get("type"),
    "file",
    "audio 资源必须以 type=file 拉取（今天：type=audio，契约非法）",
  );
});

test("feishu downloadAttachment：video → 请求 type=file（今天 type=media → 红）", async () => {
  const run = await runDownloadAttachment({ appId: "cli_8000000000000002", kind: "video" });
  assert.ok(!run.error, run.error?.message);
  const resourceCall = run.calls.find(
    (call) => call.url.includes("/open-apis/im/v1/messages/") && call.url.includes("/resources/"),
  );
  assert.ok(resourceCall, "必须发起资源下载请求");
  assert.equal(
    new URL(resourceCall.url).searchParams.get("type"),
    "file",
    "video 资源必须以 type=file 拉取（今天：type=media，契约非法）",
  );
});

test("feishu downloadAttachment 守护：image → 仍请求 type=image", async () => {
  const run = await runDownloadAttachment({ appId: "cli_8000000000000003", kind: "image" });
  assert.ok(!run.error, run.error?.message);
  const resourceCall = run.calls.find(
    (call) => call.url.includes("/open-apis/im/v1/messages/") && call.url.includes("/resources/"),
  );
  assert.ok(resourceCall, "必须发起资源下载请求");
  assert.equal(new URL(resourceCall.url).searchParams.get("type"), "image");
});
