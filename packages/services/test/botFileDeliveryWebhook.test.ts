import assert from "node:assert/strict";
import test from "node:test";
import { createWebhookBotProvider } from "../src/bots/providers/webhookProvider.js";
import { createBotProviderRequester } from "../src/bots/providers/providerRequest.js";

// filenameSource 在 webhook parse 站点填充（payload filename → provided；
// `${id}.${kind}` 直铸名 → fallback）。[ulw] 评审收口新增：spec fix 3 要求
// 「ALL provider parse sites」钉测试，webhook 第 5 站由 W2a 补齐实现后在此补钉。
// 经 provider.parseCallback 驱动真实解析（无网络）。

test("A9 filenameSource（webhook）：payload filename → provided；缺名直铸 ${id}.${kind} → fallback", () => {
  const provider = createWebhookBotProvider({
    loadCredential: async () => null,
    requester: createBotProviderRequester(),
  });
  const messages = provider.parseCallback({
    botId: "bot-webhook-1",
    userId: "wh_user",
    text: "看下这两个文件",
    attachments: [
      { id: "wh-file-1", kind: "file", filename: "notes.txt" },
      { id: "wh-video-2", kind: "video" },
    ],
  });
  const attachments = messages[0]?.attachments ?? [];
  assert.equal(attachments.length, 2, "两个 webhook 附件都必须解析");

  const named = attachments.find((item) => item.kind === "file");
  assert.ok(named, "带名附件必须存在");
  assert.equal(named.filename, "notes.txt");
  assert.equal(named.filenameSource, "provided", "payload 提供文件名时必须标 provided");

  const minted = attachments.find((item) => item.kind === "video");
  assert.ok(minted, "缺名附件必须存在");
  assert.equal(minted.filename, "wh-video-2.video", "直铸名形状回归钉");
  assert.equal(minted.filenameSource, "fallback", "直铸名 ${id}.${kind} 形状必须标 fallback");
});
