# Spec: Bot Outbound Message Delivery Reliability (3.14.5 Alpha 1)

Status: **SHIPPED — train closed at official `3.14.5` (2026-10-06)**; 本 spec 基线为
`3.14.5-alpha.1`. **Amended in 3.14.5-alpha.4（channel-death
retention 三分类 + revival 语义——证据锁定 §2d；见 F1.4/F2/Typing/Invariants 各条修订
与"Retention buffer"小节）**. **Appended in 3.14.5-alpha.9（rider：用户可见业务错误码
本地化包装——见文末「User-facing business-error localization」小节；随
specs/bot-file-delivery.md 的 alpha.9 四修复同批发版 `7f57abe`，2026-10-06 rig
验证通过；**3.14.5 train 收官 → official 3.14.5**）**. Owner-reported (2026-10-02, on 3.14.5-alpha.0 but
PREEXISTENT and code-confirmed): bot session messages get stuck on the desktop and arrive
late or only after the user sends another message; frequently MULTIPLE messages arrive as
ONE bubble concatenated with no separator; persistent "typing"; tight repro on
Feishu/Telegram — `/status` right as a job completes makes the completion message stick
until `/stop` plus another message dumps everything glued together. WeChat shows
stuck/concatenated behavior most on long tasks. Seven root causes (stale watcher orphan,
serial-queue + snapshot-first terminal handler, extract-before-send loss, WeChat text-send
token gap, Feishu card circuit never resets, interaction boundaries don't flush, silent
provider drops) are code-confirmed in the handoff (ZCode-handoff.md §2 Alpha 1).
Owners: bots service reply pipeline (`packages/services/src/bots/botsService.ts`) —
buffer/flush/drain/typing/terminal ordering (this spec); provider send contracts, token
behavior, cursor notes live in `specs/bot-provider-network.md` (single-owner split,
cross-referenced both ways).
Related: `specs/bot-file-delivery.md` (attachment delivery chain — untouched here),
`specs/bot-provider-network.md` (WeChat text token parity amendment, Alpha 1 section).

## Scope note

This spec owns REPLY-PIPELINE semantics ONLY: buffer boundaries and force-flush sites, the
single drain owner, the lossless-flush contract (incl. budget), terminal ordering, typing
lifecycle, and observability events. Provider-level send contracts (WeChat ret=-2
token-less retry, request timeouts, Telegram/Feishu honest failures) amend
`specs/bot-provider-network.md`.

## Behavior (F1 — single drain owner)

1. **One `disposeTaskWatcher` drain helper** replaces the three partial cleanups. For a
   workspace+task watcher it performs, in order:
   1. force-flush the pending assistant reply buffer as its own message (per the F2
      contract);
   2. clear the live-status progress entry for the task;
   3. stop typing for the task — OUTSIDE the serial `streamEventQueue` (the drain runs
      directly, never enqueued, so a parked queue cannot delay it);
   4. unsubscribe the stream subscription and remove the watcher registration.
2. **Call sites (exhaustive)**: the terminal handler (replaces its inline unsubscribe),
   `/stop` (ordered: `stopGeneration` → drain → the existing status reply), the
   stale-cleanup in `isContextActiveTaskRunning` (persisted status is terminal but the
   in-process running flag never cleared), and service dispose. Disposal reasons are
   logged (`terminal|stop|stale|dispose`). `taskDeliveryRegistry.forget` at those sites
   keeps its existing placement (Phase B semantics unchanged).
3. **Fresh watcher invariant**: after a drain, the next `watchTaskStream` for the same
   workspace+task MUST create a FRESH watcher closure (the existing-subscription guard
   finds no entry). A stale watcher must never be silently reused.
4. **Decided `/stop` semantics (owner §4.7)**: `/stop` delivers the AI's partial reply
   immediately as its own message (as-is — it is already visible in the desktop UI;
   discarding it is information loss, holding it hostage was the stuck-message bug),
   then `/stop`'s status reply; the late terminal notice is REPLACED by it. No timers.
   **Channel-dead 修订（3.14.5-alpha.4，§7.7 修订）**：死窗内 `/stop` 的部分回复不再
   "立即送达"（死通道必然失败）——部分回复进入 per-peer 保留缓冲，revival 时补发
   （顺序：补发序言 → 积压内容 → 新回合回复）。
5. **Cross-chat stale closure**: because the watcher key is workspace+task, a watcher
   whose task is persisted-terminal but whose terminal event was lost replies to the OLD
   chat forever; the stale-cleanup drain now removes it, so the next chat's
   `watchTaskStream` binds a fresh watcher to the NEW actor.

## Behavior (F2 — lossless bounded flush)

1. `flushAssistantReplyBuffer` sends chunk-wise and advances the buffer ONLY past
   successfully sent chunks (trim-on-success). It never re-prepends failed text into a
   retry-on-every-event loop.
2. **Per-invocation budget**: at most 2 send attempts per failing chunk with a single
   ~1s backoff sleep between attempts; the FIRST failing chunk stops the attempt loop
   and returns, so at most one chunk per invocation burns the budget. **3.14.5-alpha.4
   修订**：预算耗尽仅在 content-poison 类丢弃剩余；channel-dead 类预算耗尽即停止
   尝试并保留（缓冲 + 未发送分块全部进入 per-peer 保留缓冲）。The structural bound:
   cumulative added SLEEP ≤~1s per invocation; wall-clock is bounded by 2× the provider
   send timeout (15s explicit on WeChat text) plus one notice send. A poison message
   can never wedge the serial event queue.
3. **Final failure (content-poison 类)**: on budget exhaustion the remainder (unsent
   chunks + unsent buffer tail) is DROPPED and a localized notice (`replyDeliveryFailed`,
   zh/en) is sent via a catch-wrapped `sendOutbound` plus a warn log. The notice fires at
   most once per failed flush invocation. **3.14.5-alpha.4 修订（替换原
   "drop-with-notice, NOT retain" 决定语义句）**——发送失败按类别决定语义：
   `channel-dead`（weixinRet=-2 或网络类：HTTP 5xx/超时/AbortError）⇒ **保留**
   （进入 per-peer 保留缓冲，等待 revival 补发，不做任何死通道通知尝试——通知不可能
   送达，§8.7）；`content-poison`（其余，如 4xx）⇒ 维持 drop-with-notice。分类判别源
   （weixinRet 标签字段 / HTTP status / 错误名）必须在测试中可构造。
4. Non-forced flushes keep today's semantics: they only normalize the buffer; extraction
   (and thus any send) happens at force boundaries.

## Behavior (F3 — interaction-boundary flush)

On `permission_request` and `elicitation_request`, non-streaming-card providers
force-flush the buffer BEFORE the prompt message is built and sent — mirroring where
card providers call `sealStreamingCardReply` at the same sites. Pre-question text must
never glue onto post-answer text.

## Behavior (F5 — Feishu circuit reset + guaranteed final render)

1. A successful card sync resets `streamingCardCircuitOpen` and the failure counters
   (closes the circuit); transitions are logged (F10).
2. The FINAL terminal card sync — `task_complete` AND `task_error` — always attempts
   once even with the circuit open (half-open), so a terminal task cannot stay frozen
   on a "Running" card.
3. If that final render fails, degrade honestly: the completion content (change-summary
   messages; "task completed" fallback when nothing was ever delivered) — or the
   localized failure notice for `task_error` — is sent as normal text messages via the
   standard reply path, with a warn log. No retry storm: the degrade is one-shot per
   terminal event.

## Behavior (F7 — completion text first, paperwork second)

The terminal handler force-flushes the assistant reply buffer BEFORE `readTerminalTaskMeta`
and `getTaskSnapshot` (the paperwork that contends with `/status` RPCs on a
just-finishing session). Change-summary messages send unchanged and may arrive as a later
bubble. **Timing-only change vs 3.14.4**: message content and message boundaries are
unchanged; only the send order of body text vs change summary vs terminal paperwork moves.
Nothing else in the terminal handler is reordered.

## Typing lifecycle

- Typing starts at watcher creation and stops at watcher drain (inside `disposeTaskWatcher`)
  or at interaction boundaries as today. `/stop` clears typing immediately even when the
  serial event queue is parked — the drain call is never enqueued.
- **实测（§2d，3.14.5-alpha.4 记录）**：typing 在 sendmessage 死窗内存活（两窗
  25/12 分钟零 typing 失败行）——typing 是用户唯一的"仍在工作"信号，**不做暂停**；
  typing 成败日志维持现状（成功 debug、失败 warn 限频）。owner 决定 §7.19。
- **Same-process-only caveat (documented deferred decision)**: the Feishu typing-reaction
  handle lives in an in-memory map; an app restart can leave a stale typing reaction in
  the Feishu client until its own TTL. Out of scope for this alpha (owner: accepted).

## Serial event queue contract

- `enqueueStreamEvent` serializes per-task stream events and NEVER rejects: handler errors
  are caught and downgraded to warn logs. This contract is unchanged and now load-bearing:
  with F2's bounded flush, no provider failure can park the queue for more than the flush
  budget; a parked queue also cannot delay `/stop`'s drain or typing clear (F1).

## Observability (F10)

Info logs (service logger `bots`, no file paths/secrets): forced flush (taskId, chunk
count, bytes), watcher create/dispose (reason `terminal|stop|stale|dispose`), Feishu
circuit transitions (open/reset/half-open-final), WeChat token-less retry fired. Warn
logs: F2 drop path, F5 degrade path, notice-send failure. Debug stays reserved for raw
protocol data (unchanged).

**Amendment (3.14.5-alpha.2 — instrumentation-only; ships as its own alpha release;
the behavior contract above is unchanged and stays unchanged through alpha.2):** every `sendOutbound` call (the single seam shared by flush sends, terminal
paperwork sends, notices and command replies — i.e. BOTH delivery paths) logs one info
outcome line: `bot outbound send provider=… peer=… bytes=… ok|failed`; weixin lines add
`tokenAgeMs` (age of the persisted peer token actually used — successes AND failures,
so a dead window's TTL can be bounded from both sides; the token value itself is never
logged); failed lines add the tagged weixin fields (`weixinRet`/`weixinErrcode`/
`weixinHttpStatus`) and the error text. Failures still propagate unchanged. Rationale:
R1's diagnosis had to infer successful sends from silence and lacked ret codes on
drops (handoff §2 telemetry defects). Full logging contract:
`specs/log-diagnostics-hygiene.md`.

## Invariants

- One drain owner: only `disposeTaskWatcher` unsubscribes watchers (terminal/stop/stale/
  dispose); `watchTaskStream` only registers. Sole exception: the service-dispose sweep
  fires all drains best-effort and then clears both maps synchronously (shutdown must
  not be delayed by send chains).
- The drain is never enqueued onto `streamEventQueue`.
- The flush budget is bounded per invocation by construction (first failing chunk stops
  the loop: ≤2 attempts + one ~1s backoff sleep; wall-clock ≤ 2× send timeout + one
  notice send). **3.14.5-alpha.4**：首块失败即停止尝试（同预算）；channel-dead
  保留全部未送达内容至 per-peer 保留缓冲（~64KB 尾部截断，**utf8 字节口径**——
  `Buffer.byteLength`；缓冲内部是 UTF-16 字符，若按 `.length` 计数 cap 会翻倍，
  测试已钉住字节口径）；仅 content-poison 丢弃剩余。
- Provider parity: text providers flush at interaction boundaries; card providers seal
  (unchanged); `summary_changes` never streams (unchanged).
- No new timers; no new background processes; no polling.
- Reply-pipeline behavior for streaming_card and summary_changes modes is byte-identical
  except where F5 explicitly amends the final render.
- Known future work (recorded, not this alpha): memoize the per-send persisted-token
  state read for weixin outbound bursts. **原"成功 ret=-2 tokenless retry 后再失效
  持久化 token"的延期项已由 3.14.5-alpha.4 落地并超越**：ret=-2 即无条件失效——
  tokenless retry 实测死态永不成功（0/131），不再作为依据（见
  `bot-provider-network.md` alpha.2 amendment 第 3 条的实测块）。

## Retention buffer（channel-dead 保留缓冲，3.14.5-alpha.4）

- 权限提示**不进入**保留缓冲（alpha.3 的 stop-deny 语义不变）；
  `summary_changes`/`streaming_card` 模式无文本缓冲，不适用**缓冲保留**（终态
  文书直发缝隙的保留不受模式限制——共享的 change-summary 直发即 16:42 丢失类）。
- **命令回复不保留（owner 决定 §7.23，2026-10-04 rig 后）**：命令是"即时"动作，
  延迟到达的保留命令回复令人困惑——命令回复发送失败照旧（上抛/丢弃；/status 的
  待补发行只在存活通道上可见）。保留面 = 任务回复正文 + 终态文书，二者之外不扩。
- **权限提醒/拒绝文案不保留（3.15.0 Track B amendment，`specs/bot-permissions.md`
  §3c）**：permission reminder（deadline 前 ~2min）、deny-note（「权限超时
  未应答，已自动拒绝」）、迟到应答反馈（「已被处理/已自动拒绝」）三类为
  best-effort **非保留**消息——发送失败即诚实丢弃，不进入 per-peer 保留缓冲
  （与 §7.23 同 rationale：即时性消息，延迟到达令人困惑；deny 的后果由 agent
  的后续正文承载，正文本身照常保留）。权限提示本体不保留（既有边界不变）。
- 服务进程 dispose 时保留缓冲静默丢失（接受的残余，与桌面会话一致）。
- 保留缓冲 cap 为**字节**口径（~64KB 尾部 + 头部截断标记）；per-peer 串行化
  （promise chain，botId+peerKey）覆盖 streamEventQueue / 入站队列 / 出队 drain
  三个异步触点。
- revival 触发 = 该 bot+peer 的**任意** weixin 入站（非 token 值变化——实测存在
  不轮换的入站）；revival flush 在入站队列内、命令处理前执行，保证积压先于
  新回合回复；flush 自身重新分类，首块仍死即停止（同预算），一次 ping 不复活
  时代价有界。另：下一个 force 边界的 flush 对保留文本做一次有界重试。
- revival 补发前发送**一条**本地化序言（"断线期间积压的 N 条消息已补发" /
  "Delivered N messages queued during the outage"，zh/en）走存活通道，先于积压
  内容；`/status` 在保留缓冲非空期间显示待补发行（约 KB 数）。owner 决定 §7.20。
- **多波补发为预期形态（alpha.4 rig 实测记录，2026-10-04）**：revival 过程中通道
  再次死亡时，`deliverRetainedBacklog` 在首块 channel-dead 处停止并重新保留余量
  ——积压会按 revival 边界分成多波（每波各带一条序言），用户看到"两波/多波"消息
  属预期而非重复投递（实测 11/11 逐条恰好一次，无丢失无重复）。**空闲期零重试**：
  无入站、无 force 边界时保留缓冲静默等待（实测整夜 01:06–07:29 零发送尝试）；
  活跃流式阶段（终态前数分钟）每个 force 边界各做一次有界积压重试，可产生短时
  密集的失败行（实测 4 分钟 ~191 次失败尝试，边界密集所致，终态后自止）。

## Acceptance scenarios

Unit/integration (red-first; harness patterns from botFileDelivery/botInboundAttachments —
fake task service with captured stream enqueue, providerOverrides adapters):

1. **Stale-watcher drain via `/stop`**: buffer holds partial text → `/stop` → partial text
   arrives as its own message BEFORE any next inbound message; typing cleared;
   subscription removed (next `watchTaskStream` creates a fresh watcher with a NEW
   enqueue); `/stop`'s status reply follows. Red today: `/stop` leaves the buffer held;
   the next message dumps old+new glued.
2. **Poison chunk budget**: a send that always fails cannot delay subsequent queued events
   beyond the F2 budget (≤2 attempts + ~1s backoff); remainder dropped; one
   `replyDeliveryFailed` notice; queue continues. **3.14.5-alpha.4 变体**：always-fail
   若为 channel-dead 类（weixinRet=-2 标签 / 网络类错误名可构造）⇒ retained-待补发
   （不丢弃、无通知尝试、进入 per-peer 保留缓冲）；后续任意入站 ⇒ 序言先行 +
   积压补发（revive-补发）；一次不复活的 ping ⇒ 一次有界尝试后重新保留。
3. **Trim-on-success**: first chunk send succeeds, second fails twice → first chunk
   delivered, second dropped with notice, no re-send of the first on later events.
   **3.14.5-alpha.4 变体**：first chunk 成功、second 为 channel-dead 类 ⇒ first
   照常送达，second 及尾部进入保留缓冲（不丢弃、无通知）——健康路径逐字节不变。
4. **Boundary flush at permission (text providers)**: buffered pre-question text is
   delivered as its own message before the permission prompt message.
5. **WeChat text ret=-2 retry + persisted-token read** (fetch-mocked provider tests):
   text `/sendmessage` retry without `context_token` on ret=-2; text send carries an
   explicit 15s timeout; stream-path text sends read the freshest persisted token
   (fallback to captured actor token) for weixin actors.
6. **Feishu circuit reset + final half-open render + text degrade**: success closes an
   open circuit; final `task_complete` sync attempts with the circuit open; final-render
   failure degrades to normal text completion. `task_error` terminals get the SAME
   half-open attempt + degrade to the localized failure notice.
7. **Telegram fallback checked**: Markdown send fails AND fallback plain-text send fails
   → throw naming both statuses; missing token in Telegram/Feishu `send` → throw (no
   silent return), no retry machinery, no notice-over-broken-channel.
8. **Completion-text-before-snapshot ordering**: slow `getTaskSnapshot`/meta reads cannot
   delay the completion body text (text bubble observed before snapshot resolves).
9. **Cross-chat stale-closure regression**: task persisted-terminal + stale watcher armed
   for chat A; chat B resumes the task → replies go to chat B's actor.

Manual rig (blocks the alpha): WeChat task >40 min with NO inbound → completion arrives;
`/status` sent right at completion → completion text arrives promptly and as its own
message (no glue, no stuck); `/stop` mid-reply → partial text arrives immediately, typing
stops; Feishu card survives 3 transient update failures and completes; no concatenated
multi-message bubbles anywhere; logs show flush/dispose reasons.

## Deferred decisions (recorded, NOT this alpha)

- **WeChat batch-cursor rescope（原 owner §4.8 延期项）——已由 3.14.5-alpha.3 落地**：
  共享 consumed 语义见 `specs/bot-inbound-resilience.md` §B（游标归属已迁移至该
  spec）；此处的过时 alpha.2 引用已删除。不要在此重新实现。
- **Feishu typing-reaction surviving app restarts**: out of scope (same-process only).

## User-facing business-error localization（3.14.5 Alpha 9 rider）

Spec'd 2026-10-06 from ../ZCode-alpha9-plan.md rider (owner ruling §7.35 — rider
INCLUDED; evidence: §2j F1, the raw `[1210][视频输入格式/解析错误]` BigModel/GLM
business error surfaced verbatim into chat and misled the owner into blaming the
feishu transport). Ships with the alpha.9 file-delivery fixes
(specs/bot-file-delivery.md, same alpha). **Placement disclosed in the spec
commit:** this rider lives here, not in bot-file-delivery.md, because it concerns
error-REPLY text formatting (message-delivery UX), not file handling.

### Behavior

1. **Bracketed business-code wrapper.** `formatUserFacingBotError` (botsService)
   detects an error text LED BY a bracketed numeric business code — the observed
   shape is `[1210][视频输入格式/解析错误]` (leading `[<digits>]` bracket) — and
   wraps it in a localized shell that PRESERVES the raw text verbatim:
   - zh: 「模型服务返回错误（代码 {code}）：<raw>」
   - en: "The model service returned an error (code {code}): <raw>"
     New zh/en keys via the bots messages mechanism (e.g. `modelBusinessError`
     with `{code}` and `{message}` placeholders). The code inside the wrapper is
     extracted from the leading bracket; `<raw>` is the FULL original text
     (brackets included), so no debugging information is lost.
2. **Plain errors pass through UNCHANGED.** An error text without a leading
   bracketed numeric code is returned byte-identically to today — no wrapping,
   no reformatting. The existing `sessionExpiredNewTaskHint` precedence is
   unchanged (it keeps winning before any wrapper logic runs).
3. **Both funnels.** The wrapper applies inside `formatUserFacingBotError`, so
   both call sites benefit unchanged: the provider-callback failure funnel
   (`callbackFailed: {message}`) and the `sendPromptInBackground` task-failure
   funnel (`taskFailed: {message}`). UX only.

### Invariants

- Text-only change: no error classification, retry, logging, or queueing
  behavior changes; failure semantics (consumed/abort, §7.12) untouched.
- The raw error text always survives verbatim inside the shell (the code is
  duplicated into the shell AND kept in the raw tail).
- Bracket-pattern over-match is the accepted, disclosed risk (§7.35 brief);
  after the alpha.9 inline video guard lands, garbage-bytes 1210s mostly
  disappear, shrinking exposure.

### Acceptance scenarios (red-first on 3.14.5-alpha.8)

1. A task whose `sendPrompt` rejects with `[1210][视频输入格式/解析错误]` →
   the user-facing failure reply contains the localized shell WITH the code
   (`模型服务返回错误（代码 1210）`) AND the raw tail
   (`[1210][视频输入格式/解析错误]`) verbatim (today: the raw text passes
   through unwrapped).
2. Guard: a task whose `sendPrompt` rejects with plain `boom` → the failure
   reply is byte-identical to today's passthrough (no shell).
