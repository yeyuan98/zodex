# Spec: Bot Provider Network Transport, Observability, Cursor Persistence (Alpha 6)

Status: **SHIPPED in `3.14.4-alpha.6` (PR #11, release `cbf6a68`); owner-rig validated
2026-10-02** (proxy set in app settings → Telegram `/bind` + `/file` + conversational
delivery all succeed on the previously-failing GFW rig; command menu self-heals; detailed
error visible with proxy unset; Feishu/WeChat regression clean). Postmortem decisions
FINAL, owner-approved 2026-10-02; folded into official `3.14.4`.
**Amended in `3.14.5-alpha.1`** (WeChat text token parity + provider honest-send
contracts — see the Alpha 1 section at the bottom).
Production incident 2026-10-01/02: the owner rig (mainland-China network) could not bind a
Telegram bot — the desktop UI showed the generic "Bot connection failed"
(`bots.runtime.connectionFailed`) and bind was blocked. Root cause PROVEN on a live rig (real
`createBotsService` + real long-polling, run off-repo with a real BotFather token): bot
provider networking uses Node's global `fetch`, which ignores proxies entirely; on GFW
networks `api.telegram.org` is DNS-poisoned/blackholed, so EVERY bot HTTP call to Telegram
times out (undici `ETIMEDOUT`) while curl/Telegram-clients (proxy-aware) succeed.
Feishu/WeChat are unaffected (domestically reachable). A live rig with the proxy honored via
`NODE_USE_ENV_PROXY=1` completed the FULL chain: long-poll started, queued updates processed,
`/bind` succeeded, `/file` delivered files incl. a subfolder path — the product logic was
already correct; only the network path was broken. Alpha 5 was exonerated. Secondary findings
fixed in the same alpha: poller errors are swallowed unlogged (`telegramChannelRuntime.ts`'s
catch-all discards the error object; statusSink writes an in-memory map only), the UI renders
one generic label for every telegram/weixin error and hides the detailed reason, add-bot
proceeds despite unreachable tokens (resolveName failure is warn-only), the Telegram command
menu never re-syncs after connectivity recovery, and two cursor writers can silently drop
their write.
Owners: bot provider request module (`packages/services/src/bots/providers/providerRequest.ts`)
— injectable requester factory; bots service (`botsService.ts`) — `providerFetch` seam +
cursor persistence; channel runtimes (`telegram/weixin/feishuChannelRuntime.ts`) — error
observability + self-heal; desktop host (`packages/desktop/src/host/index.ts`) +
attached-remote collection (`remoteWorkspaceServiceCollection.ts`) — transport composition;
UI (`packages/ui/src/BotsDialog`) — error detail surfacing.
Related: specs/bot-file-delivery.md (Alpha 0–5 delivery chain — untouched above the adapter
network path), `packages/services/src/providers/api/nodeApiNetwork.ts` (the host API network
transport being reused).

## Behavior (F1 — bot provider network transport: the core fix)

1. **All bot provider HTTP traffic goes through an injectable fetch.** `providerRequest.ts`
   exports a requester factory — `createBotProviderRequester(fetchImpl = globalThis.fetch)` —
   returning the existing three bounded helpers (`fetchBotProvider`, `fetchBotProviderJson`,
   `fetchBotProviderWithHeaders`); no module-level mutable globals; the module stays
   fetch-agnostic and Electron-agnostic.
2. **Injection seam.** `BotsServiceDeps.providerFetch?: typeof fetch` (same test-injection
   style as `providerOverrides`). Threaded to the four provider factories
   (telegram/weixin/feishu/webhook), the telegram channel runtime (deleteWebhook), and it
   replaces the 5 raw `fetch` escape hatches: telegramProvider getFile + file download
   (~548, ~562), weixinProvider CDN download (~1086), feishuProvider resource download
   (~2009), webhookProvider (~116).
3. **Composition — one proxy setting, zero new UX.** The desktop host passes the EXISTING host
   API network transport's fetch (settings-UI `httpProxy` → undici `ProxyAgent` dispatcher;
   `nodeApiNetwork.ts` `createHostApiNetworkTransport`), so ONE proxy setting covers AI +
   bots. Attached-remote collection passes its transport when present, else global fetch.
   Reuse the TRANSPORT, not the `ZCODE_HTTP_PROXY` env var (that is agent-subprocess env;
   review finding). Event order:

   ```text
   Zodex settings httpProxy (the ONE existing proxy setting — no new UI)
     └─ desktop host createHostApiNetworkTransport (nodeApiNetwork.ts)
          ├─ AI/API client egress (existing, unchanged)
          └─ createBotsService deps.providerFetch = transport fetch   ← Alpha 6 wiring
               └─ createBotProviderRequester(providerFetch)
                    └─ ALL bot egress: long-poll getUpdates, sends, uploads, downloads,
                       webhook calls, deleteWebhook, setMyCommands
   attached-remote collection (remoteWorkspaceServiceCollection.ts):
     its own transport when present, else global fetch (no desktop host in that assembly)
   ```

4. **Semantics.** No proxy configured → direct fetch, behavior byte-identical to alpha.5
   (zero drift). Transport disposed → requests fail closed with a structured error (NEVER
   silently fall back to direct — a fallback would exfiltrate traffic outside the configured
   proxy). Documented non-goal: env-var auto-pickup (`NODE_USE_ENV_PROXY`) is experimental
   and NOT adopted; users configure the app proxy setting once. Recorded decision — do not
   re-litigate.

## Behavior (F0 — failures name themselves)

1. **The telegram poller's catch-all binds and logs the real error** (cause survives: e.g.
   "fetch failed/ETIMEDOUT", HTTP status). All three runtimes log transitions INTO error
   status with the detailed message (`createServiceLogger("bots")` warn).
2. **UI surfaces the detailed runtime message for ALL providers on error.** Today only
   feishu/lark have an error detail panel (ProviderSettingsCard gates it on `isFeishuLike`;
   BotSummaryCard renders the generic label). Keep the generic label as the summary, the
   detail as a secondary line/tooltip.
3. **Add-time fail-fast.** When saveBot's resolveName (getMe etc.) fails on a
   credential-bearing save, the add flow surfaces the failure (the wizard must not sail
   through an unreachable token with only a warn).

## Behavior (F0b — self-heal)

When the telegram runtime transitions error→polling (connectivity recovered), re-run
`syncCommands` so the command menu stops staying empty until restart.

## Behavior (F4 — cursor writes never silently dropped)

`writeTelegramOffset` and `writeWeixinGetUpdatesBuf` (botsService) currently no-op when no
state entry exists AND `firstAllowedWorkspace` resolves no workspace — the cursor is lost and
one update batch reprocesses forever (duplicate replies every poll). Both always persist:
create/extend the state entry without requiring a resolvable workspace (workspace fields may
be empty until first use). Red-test-first.

## Invariants

- Single writer/data-owner rules unchanged; `deliverWorkspaceFile`, quota, registry
  untouched.
- WeChat + Feishu behavior byte-identical when no proxy is configured (zero drift, pinned by
  existing fixtures).
- Proxy routing covers ALL bot-provider egress (polling, sends, uploads, downloads, webhook
  calls, deleteWebhook, setMyCommands) — no raw-fetch escape hatch remains in
  `packages/services/src/bots`.
- Fail-closed on transport disposal; never direct-fallback under a configured proxy.
- Cursor persistence is unconditional (no silent drops).
- No secrets in logs (tokens never logged; proxy URLs may be logged without credentials).

## Acceptance scenarios

Unit/integration:

1. providerRequest factory: injected fetch used by all helpers; default = global fetch.
2. All five former raw-fetch sites route through the injected fetch (fetch-stub counting;
   incl. telegram getFile + file download + deleteWebhook).
3. No-proxy composition → direct fetch object identity/behavior unchanged.
4. Disposed transport → structured failure, zero direct fallback calls.
5. Poller error → log line carries the cause; status transition logged.
6. UI error detail present for telegram/weixin.
7. resolveName failure at add → surfaced to the add flow.
8. error→polling transition triggers syncCommands exactly once per recovery.
9. Red tests: cursor persists when no state entry + no workspace (both writers); no infinite
   reprocess.
10. Zero-drift: existing weixin/feishu suites unmodified and green.

Manual rig (blocks release): set proxy in Zodex settings (owner's local proxy address) →
restart → telegram bind succeeds → `/file` + conversational share deliver → command menu
appears (self-heal) → WeChat/Feishu regression pass → unset proxy → detailed error visible
in UI + logs (no generic-only).

## Amendment (3.14.5-alpha.1) — WeChat text token parity + provider honest sends

Reply-pipeline semantics (buffers, drain owner, flush budget) live in
`specs/bot-message-delivery.md` (single-owner split). This section owns the PROVIDER send
contracts:

1. **WeChat text token parity (F4)**: the text `/sendmessage` path gains the same token
   resilience the media path already has (`weixinProvider`):
   - `requestWeixinJson` tags `weixinRet` on thrown errors (mirror of
     `requestWeixinMediaJson`), so callers can branch on protocol ret codes.
   - Text `/sendmessage` retries ONCE WITHOUT `context_token` when the first attempt
     fails with `ret=-2` (mirror of the media retry; the original "~40 min token
     expiry" figure is SUPERSEDED — measured lifecycle in the alpha.2 amendment
     item 3, updated 3.14.5-alpha.4). Honest
     coverage note: the persisted-token read only helps when an inbound ping occurred
     mid-task; the token-less retry is the guarantee for zero-inbound >40-min tasks.
   - The text `/sendmessage` request carries an explicit 15s timeout (parity with other
     calls; no unbounded hang on a wedged network).
   - Stream-path TEXT sends in the bots service read the freshest persisted WeChat
     context token (`readPersistedWeixinContextToken`, refreshed by any inbound ping)
     for weixin actors at send time, with the captured actor token as fallback (mirror
     of the media-path usage). Coverage is honest, not magic: zero-inbound tasks rely on
     the ret=-2 retry above.
2. **Honest provider sends (F6)**: Telegram `send` checks the fallback plain-text resend
   response; `!ok` → throw naming BOTH statuses. Missing-token in Telegram and Feishu
   `send` throws a quiet credential error (no retry machinery, no
   notice-over-broken-channel — failures surface via the existing catch→warn paths;
   credential-not-configured stays quiet to avoid spam). No new retry loops.
   **Telegram cursor dead-end (SUPERSEDED in 3.14.5-alpha.3)**: a callback whose reply
   send throws used to skip that update's offset commit, redelivering the same update
   every ~5s. The alpha.1 text said "revisit only with rig evidence of a real loop" —
   that evidence arrived (§2b poison-message deadlock, 52 reprocessings in 7 min) and
   the rescope LANDED as the shared consumed semantics owned by
   `specs/bot-inbound-resilience.md` (B): business-failure-with-delivered-notice (or
   confirmed session signal) = consumed ⇒ offset/buf/ACK advance; infra failures and
   the notice-undeliverable hole keep abort-no-commit.
3. **Cursor rescope decision — LANDED in 3.14.5-alpha.3** (supersedes the former
   "deferred to alpha.2" note): the WeChat poll protocol has ONE marker per batch (no
   per-message markers like Telegram's update_ids), so per-message commit would ack
   unprocessed messages. The sound rescope — skip-failing-message-with-notice + commit
   — is now specified and owned by `specs/bot-inbound-resilience.md` §B (consumed
   semantics, all providers incl. webhook status-as-cursor). Do not re-implement here.

## Amendment (3.14.5-alpha.3) — inbound consumed semantics (pointer)

Cursor-rescope ownership moved to `specs/bot-inbound-resilience.md` (spec-first,
owner decisions §7.12–15): business failure with DELIVERED notice or CONFIRMED session
signal = consumed ⇒ weixin buf / telegram offset / feishu ACK / webhook HTTP 200
advance; notice-undeliverable hole and infra failures keep abort-no-commit; failure-path
dedupe retention; poll-error backoff 5→60s. This spec keeps the provider transport,
observability and cursor-write-mechanics sections above; nothing in them changes in
alpha.3 (the F4 "cursor writes never silently dropped" mechanics are untouched — only
the decision of WHEN a batch counts as processed changed, and that lives in the new
spec).

## Amendment (3.14.5-alpha.2) — provider send observability (instrumentation-only)

Ships as its own alpha release (owner ruling: every PR → one alpha). No send/retry/
cursor semantics change in alpha.2 (behavior fixes land in alpha.3, designed from the
probe run on the released alpha.2 build). This section owns the new provider-side
logging contract (pipeline-side lines live in `bot-message-delivery.md` F10; the
cross-module logging policy lives in `specs/log-diagnostics-hygiene.md`):

1. **Error field tagging**: both weixin request helpers (`requestWeixinJson`,
   `requestWeixinMediaJson`) attach `weixinRet` (existing), `weixinErrcode` (new) and,
   on non-OK HTTP, `weixinHttpStatus` (new) to the thrown Error. Message text is
   unchanged. Consumers may branch on the tagged fields; nothing branches on new fields
   in PR1.
2. **Typing outcomes** (`weixin` adapter): sendtyping success → debug; failure → warn,
   rate-limited to one line per 30s per adapter instance (lazy timestamp compare — no
   timer), carrying tagged ret/errcode. The getconfig call inside sendtyping logs
   whether its response contains a `context_token` as a boolean, only on change, at
   info — the alpha.2 probe uses this to test whether an out-of-band token refresh
   exists. Token values are never logged.
3. **Corrected token-lifetime facts** (replaces the ~40-min text figure in item F4
   above; 3.14.5-alpha.4 用实测块替换原 "pending the alpha.2 probe measurement"
   措辞与 R1 的 17.5–22.6 min 区间——探针判据已由 §2d 的 3 次独立观测满足):

   > **实测 token/会话生命周期（2026-10-03 §2d，3 次独立观测，探针判据满足）**：
   > WeChat 在对端 ~15–25 分钟无入站后杀死 bot 的发送会话；TTL 每次不同（窗口 A
   > 存活 ≥22.92 min / 死于 23.14 min；窗口 B 存活 ≥14.82 / 死于 16.80——区间不
   > 交叉）。token **年龄是代理指标而非原因**：9.6 小时的旧 token 在入站后立即
   > 成功（persistWeixinContextToken 仅在值变化时更新 updatedAt）；午间 3.9-min
   > token 失败、6.5-min 同一未轮换条目自愈。模型 = 服务端会话空闲超时；**唯一
   > 复活方式是该 peer 的任意入站**（两次实测均在 ~17 s 内恢复）。**无带外刷新
   > 机制**：getconfig 的 context_token present=false（3/3 进程生命周期）；
   > tokenless 重试死态永不成功（0/131）——ping-to-revive 是诚实上限，不建刷新
   > 机械。**typing 在 sendmessage 死窗内存活**（实测；§7.19：不暂停）。
   > **ret=-2 失效即失效凭据（alpha.4）**：无条件失效 + 实测权衡记录——瞬时 -2
   > 与会话死 -2 客户端不可区分（两者均双拒）；失效后任何入站无条件重新持久化
   > （early-return 仅在条目存在时生效）；失效不作为 revival 触发；失效后
   > tokenAgeMs 可观测性损失已接受。

   The media-probe-era ~40-min figure stays valid for the media path only.

## Amendment (3.14.5-alpha.4) — M3 协议 schema strip/widen（证据闭合）

CLI→host 会话事件 schema 漂移在 v3 线上整事件丢弃（host `.strict()`）。修复双侧：
(a) v3 mapper 源头 strip（legacy-desktop 安全，仓库规则：新 CLI 字段须在源头剥除）
——新漂移键 `sideEffectScope`（tool.updated，553 次/日 2026-10-03）入 strip 名单；
六键清单闭合：`readOnly`/`sideEffectScope`/`display`/`skillMetadata`
（tool.updated）、`executionStartedAt`（turn.started）、`fullAccessSupported`
（permission.requested）。三个 strip 站点：`mapPermissionRequestedPayload`、
ToolCall\* raw-spread、`default:` 透过的 key 定向剥除（非一刀切）。(b) host schema
additive widen（optional 字段）。**End-state 诚实**：strip-at-source 使 CLI 发射端
永不携带这些键过 v3 线——widen 仅为宽容性接收（对同仓库 emitter/测试/未来路径
有意义）；**Track B 不能经 v3 消费 `fullAccessSupported`**，记录在案。契约测试
矩阵钉 MAPPER OUTPUT vs host schema（当前 main 红）；schema 保持 strict——只
widen + strip，从不放松。反向（desktop→CLI）不受影响。

**值类漂移跟进（3.14.5-alpha.5，owner 决定 §7.24）**：CLI 远端链路实测发射**负数**
`duration`/`elapsedMs`（2026-10-02 远端会话 sess_a39948fb 20 次整事件
`too_small: expected number >=0` 丢弃，疑似远端主机时钟偏移）——key strip 不覆盖
值类；修复 = CLI 发射端 clamp 非负（`Math.max(0,…)`）+ M3 契约矩阵补值类断言
（mapper 输出数值字段 >=0）；schema 不放宽负值。

**瞬态 -2 类样本补充（alpha.4 rig 2026-10-04，handoff §2f.10）**：revival 中段
-2（tokenAge 3,547ms，10 连发后第 11 发失败；同 112B 消息 41s 后下一入站字节相同
送达——内容因素排除）加入瞬态类观测，与 10-03 10:27 先例（~233s 健康条目上 -2、
同未轮换条目 ≤2.6min 自愈）同型；服务端归因（burst 限速 vs 瞬态）n=1 未定，
观测增强提案（-2 行附 burst 序号 + token 指纹）见 handoff §2f.10。
