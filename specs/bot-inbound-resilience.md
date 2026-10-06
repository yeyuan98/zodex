# Spec: Bot Inbound Resilience (3.14.5-alpha.3)

Status: **SHIPPED in `3.14.5-alpha.3` (PR #16, release `afd21da`) — rig T1–T4
PASSED 2026-10-03（T5–T8 subsumed by §2d investigation）；train 随 official
`3.14.5`（2026-10-06）收官**. 依据 §2b 事故
（WeChat 毒消息死锁：无模型草稿 throw → 游标永不提交 → 同批消息无限重投 + 队头阻塞，
52 次重处理 / 7 分钟，跨重启与禁用启用存活）。上一个 deferral（bot-provider-network.md
F4 "retry-forever, 有真实循环证据再 revisit"）由本次 rig 证据落地（见该 spec 的
alpha.3 amendment）。基线：main @ `527cce5`（3.14.5-alpha.2）。

Owners: bots 入站回调管线（`packages/services/src/bots/botsService.ts`
`processProviderCallback` + `handleInboundMessage` 草稿分支 + 交互处理）——本 spec 的
单一所有者；channel runtimes（weixin/telegram/feishu）——只保留各自的游标机械与
backoff；`specs/bot-provider-network.md` F4——游标重划定的历史记录（本 spec 落地）。
Related: `bot-message-delivery.md`（出站管线不在此 spec 范围）、`log-diagnostics-hygiene.md`。

## A. 无模型草稿：可执行指引（不 throw）

1. 草稿创建路径（无 `draftOptions.modelSelection` 且 Host 无可解析 preferred 选择，或
   selectionIssue）：**不得 throw**。回复本地化指引（zh/en 新 key）：让用户用 `/model`
   选择（或在桌面端设默认）后重发。不创建 task。
2. `/status` 与 `/new` ack 的模型行：无选择时显示明确的"未设置 / not set"文案
   （替代裸 `-`），让陷阱在首个 prompt 前可见。实现注记：`/new` ack 即
   `createStatusReply`，修 `formatStatusModelLabel` 一处即覆盖；该函数现无 locale
   参数，需将 actor locale 贯穿 4 个调用点（:5810/:5873/:6869/:6905）。

## B. 毒消息语义（共享契约，全部 provider；§7.12）

1. **consumed 判定**：一条入站消息业务失败后，满足任一即视为已消费——
   (a) 失败通知（callbackFailed/本地化指引）**送达**（sendOutbound 成功）；或
   (b) 会话失败信号（B2）**确认送达**（respondElicitation 成功 resolve，"尝试过"不算）。
   consumed ⇒ 消息计入已处理：队列继续、provider 游标照常推进
   （weixin buf / telegram offset / feishu 无游标，仅 ACK 语义）。
2. **洞规则**：通知未送达且无会话信号（如死通道 + 草稿级失败）⇒ NOT consumed——
   保持 abort-不提交（runtime 既有行为）。**后果精确化**：配合 C 的去重保留，同
   message id 的第一次重投会被去重吞并 ⇒ ok=true ⇒ 游标提交——即毒批在**一次重投
   周期内被静默丢弃**（有界自愈，优于无限循环；测试与 rig 预期按此钉住；用户修复后
   的真实重试是新 message id，不受影响）。
3. 基础设施失败（解析/prepare/transport，发生在任何业务处理之前）保持
   abort-不提交（transient 类，不改）。
4. **批内语义**：单条业务失败不中断同批后续消息的处理（processProviderCallback
   内既有 continue 保留；runtime 端 assert 仅在存在未消费失败时抛出——即游标不
   前移的唯一情形）。
5. feishu 卡片按钮：consumed 失败后旧按钮可能残留；requestId first-wins 应答语义
   使残留按钮无害（再次点击被 first-wins 吞并）。清理按钮为后续 polish，不阻塞。
6. **webhook provider**：`packages/server/src/http.ts` 以 `result.status` 映射 HTTP
   状态——consumed 的业务失败（通知已送达）返回 200；仅未消费失败保持 503/错误
   形态。webhook 的"游标"即该 HTTP 状态语义；同步更新 http.ts 中的过时注释。
   验收证据口径（review 2026-10-03）：服务级断言 `status === undefined`（consumed
   失败不携带错误状态）为接受的 proxy——http.ts 的映射逻辑（无 status ⇒ 200）
   本 alpha 未改动且无现成 server 路由测试 harness，不为其新建。

## B2. 会话失败信号（§7.13）

1. **问题/elicitation，双向**：
   - 出站方向（问题发送失败，死通道）：立即以 `action:"decline" +
content:{failureReason:"<原因>"}` resolve 该 pending（复用 respondElicitation
     seam，additive，无新 wire 类型），清除 pending，warn 日志。agent 看到
     "未获得用户回答：<原因>"并可改道（重问/默认/放弃）。
   - 入站方向（用户回答处理失败）：失败 catch 中，若该 actor 的 context 存在
     owned pendingElicitation（pending 存在时所有文本即回答路径），同样以
     decline+failureReason resolve；resolve 成功 ⇒ consumed（B1(b)）。resolve
     产生的用户侧回复**不进入失败通知机械**（本分支的用户可见回复就是失败通知
     本身；resolve 回复丢弃——review 2026-10-03 补记）。
   - **整组语义**：`submitPendingElicitation` 一次 respondElicitation 调用 resolve
     整个 pending 组（多题一组）——不存在逐题 resolve 的机械；中段失败（第 2/3 题）
     即整组一次 resolve。实现需为"确认送达"提供布尔判别（现返回
     `BotOutboundMessage[]` 无成功判别——小规模 result-object 重构或包装）。
2. **CLI broker 透传（前置条件）**：`v4AnswerToUserInputResponse`
   （zcode-cli interaction-broker.ts）对 decline/cancel 仅返回 `{action}`，
   **丢弃 content**——failureReason 永远到不了 agent，B2 语义空转。两个映射
   （普通 + plan-approval 变体）需透传 content（或映射 failureReason→reason）；
   wire schema 已接受 content（zcode-protocol-v4/command.ts），无 wire 改动。
3. **权限请求，双向**（在 bot force-yolo 下 CLI 不发权限事件，分支休眠；为
   3.15.0 Track B 预铺）：提示发送失败 ⇒ `stopGeneration`（task）+
   `respondPermission` deny-shaped 记录，清除 `pendingPermissionOptions`，warn。
4. **草稿级失败**（无 session）：仅聊天指引（A），无会话信号。

## C. 失败路径去重键保留

业务失败不再 `releaseInboundDelivery`（两处：business catch 与 send-fail rethrow，
:3701/:3848；函数随之删除——先用 `pnpm dep:refs` 验证无其他引用）；键随既有 2 分钟
TTL 过期。用户修复后重发 = 新 provider message id，永不误伤。Feishu WS 对失败消息的
重投同样被压制（配合 B.2 的一次重投静默丢弃语义）。

## D. 轮询错误 backoff 递增（weixin + telegram；owner 2026-10-03 保留）

连续错误：5s → 10s → 20s → 40s → 60s（封顶），任一成功周期复位到 5s。纯状态机
`createPollErrorBackoff()`（`nextDelayMs()`/`recordSuccess()`，无 timer，可同步单测）。
仅接线 error-catch 等待（weixin :177；telegram :192/:205/:264）；lock 竞争等待
（telegram :131、weixin :86）与 telegram 409 专属 10s（:187-192）语义不变、不进
backoff 状态。**每次失败 poll 输出一行 warn（次数 + 下次等待秒数）**——rig T6 直接
读日志验证节奏。实例声明在 try 块外（TS2304）。

## Invariants

- 出站管线（flush/drop/notice 语义）与游标机械（写哪个字段、何时写）不变；本 spec
  只改"业务失败是否阻塞游标"与失败信号的去向。
- 无新 timer；无新 wire 类型（B2 复用 decline+content；broker 透传走既有 schema）。
- 纯基础设施失败、成功路径行为逐字节不变（回归测试钉住）；webhook consumed 失败
  200 为文档化语义变化。
- consumed 判定只认"确认送达"（send 成功 / respondElicitation 成功），不认"尝试过"。
- 每个 consumed 判定留一行 info 日志（botsLogger）：notice-delivered /
  session-confirmed / hole(not-consumed) 三态（遵守 log-diagnostics-hygiene 契约）。

## Acceptance scenarios（红测先行）

1. weixin：确定性失败（无模型草稿 prompt）→ 恰一条指引回复；`ok=true`（consumed）；
   runtime 收到 ok ⇒ `writeWeixinGetUpdatesBuf(result.buf)` 被调用；同批后续消息
   仍被处理；第二次轮询携带新 buf。
2. telegram：同构断言（offset 前移；现状：callback 失败 throw 中止整批，修复后
   ok=true 走既有 per-update 前移，runtime 无改动）。
3. feishu：consumed 失败 ⇒ ok=true（旧按钮残留按 B.5 接受）。
4. 洞规则：通知发送也失败（sendOutbound 抛错）⇒ `ok=false`、无游标提交；同 id
   首次重投被去重吞并 ⇒ `ok=true` ⇒ 提交（一次重投周期内静默丢弃，一并钉住）。
5. 同 message id 在 TTL 内重投（失败后）⇒ 去重吞并（duplicated 日志，零重复处理）。
6. 无模型草稿：本地化指引回复、不 throw、不创建 task；`/status`/`/new` 模型行显示
   "未设置"。
7. B2 出站：pending elicitation 的提问发送失败 ⇒ respondElicitation 收到
   decline+failureReason；pending 清除。
8. B2 入站：回答处理失败 ⇒ 同上，且该消息 consumed（B1(b) 路径）。
9. B2 权限（休眠分支直测）：权限提示发送失败 ⇒ stopGeneration + respondPermission
   deny-shaped；pendingPermissionOptions 清除。
10. D：backoff 序列 5/10/20/40/60/60 + 成功复位（纯单元，无 timer）。
11. 回归：完全成功的批次行为不变；基础设施失败（prepare 401 形态）仍 ok=false；
    webhook consumed 失败 ⇒ HTTP 200（server 侧断言）。
12. feishu 同步卡片：`card.action.trigger` 回答处理失败 ⇒ 经既有 sync reply 返回
    失败卡片（handler 永不 reject）。
13. 中段 elicitation：第 2/3 题失败 ⇒ **整组一次** resolve（decline+failureReason），
    无逐题 resolve。
