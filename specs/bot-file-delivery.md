# Spec: Bot Outbound File Delivery (Alpha 0 — WeChat `/file`; Alpha 1 — conversational `share_file`)

Status: Alpha 0 **shipped** in `3.14.4-alpha.0` (PR #2, merge `a399b22`; owner manual smoke
2026-09-29). Alpha 1 (Phase B, conversational `share_file`) **shipped** in `3.14.4-alpha.1`
(PR #4, merge `56312b9`, release commit `d6b9738`, tag `v3.14.4-alpha.1`; all 6 release jobs
green, asset set + single-channel invariant verified; owner-rig manual validation passed
2026-09-30). Phase B implements the design contract reviewed & owner-approved 2026-09-29
(two independent subagent review rounds + one implementation review round).
Alpha 2 (remote workspaces) **shipped** in `3.14.4-alpha.2` (PR #6). Alpha 3 (cross-host
recipient resolution + absolute-path parity) **shipped** in `3.14.4-alpha.3` (PR #7,
red-test-first; a speculative queued-turn fix was dropped after owner rig testing — busy
inputs are dropped by design). Alpha 4 (chain self-announcing diagnostics + three
stdio-handshake race fixes, found via the new built-bundle E2E) **shipped** in
`3.14.4-alpha.4` (PR #8) — **owner-rig validated 2026-10-01**: remote conversational
`share_file` and `/file` (relative AND absolute-inside paths) all deliver over real SSH.
Alpha 5 (Telegram + Feishu/Lark outbound senders) **shipped** in `3.14.4-alpha.5` (PR #10)
— **rig-validated 2026-10-02**: Feishu full pass on the owner rig; Telegram was blocked by
the GFW network incident (bot egress ignored proxies — root cause proven on a live rig,
see specs/bot-provider-network.md) and validated end-to-end (`/bind`, `/file` incl.
subfolder paths) after Alpha 6 routed bot traffic through the app proxy.
Alpha 6 (bot provider network/proxy + observability + cursor persistence) **shipped** in
`3.14.4-alpha.6` (PR #11) — owner-rig validated 2026-10-02; see
specs/bot-provider-network.md. **Train complete → official `3.14.4`.**
Inbound attachment UX (3.14.5 Alpha 6: >4-attachment notice, per-file oversize
single-check rejection, unnamed-attachment container sniffing, attachment-cache lazy
prune, Telegram/Feishu read-side size re-check) **shipped** in `3.14.5-alpha.6` (PR #19,
release `99359f6`). Outbound polish (3.14.5 Alpha 7: shared byte-budget filename helper,
inline image kinds widening, audit field dedup, image/audio dataBase64 strip) **spec'd
2026-10-05** — see "Outbound attachment naming & inline kinds (3.14.5 Alpha 7)" below;
implementation pending. §5.5 (share-file timeout wording) is CLI-only and rides the same
alpha without a spec section here (apps/zcode-cli has no test harness; rig B6 covers it).
Full-feature playbook: ../ZCode-handoff.md.
Owners: bots service (`packages/services/src/bots/botsService.ts`) — command admission, path
policy, size gates, `taskDeliveryRegistry` + `deliverWorkspaceFile` single writer + tool-source
quota; weixin provider adapter (`providers/weixinProvider.ts`) — CDN upload + media sendmessage;
bot state repo (`repo.ts`) — per-peer context_token persistence; CLI runtime (`apps/zcode-cli`) —
`share_file` tool + `BotFileSharePort` + per-turn injection gates; host RPC routing
(`packages/services/src/zcode-agent/zcodeAgentService.ts` + desktop wiring) — `bots/shareFile`
handler registration; UI chip renderer (`packages/ui`) — toolCall-row chip rendering.
Related: `docs/versioning.md` (patch 3.14.4 = full bidirectional file sync).

## Behavior (Alpha 0 — `/file`, shipped)

1. **New authorized bot command `/file <path>` (aliases `/文件`).** Only in private chats
   (`chatType === "private"`), only for providers whose adapter implements `sendAttachment`
   (Alpha 0: weixin only). Other channels get a localized "not supported yet" reply.
   Operators can disable the command per bot via `allowedCommands.file: false`
   (absent = allowed; schema + policy normalization honor explicit false).
2. **Path policy: workspace-only.** The requested path is resolved against the bot context's
   active workspace root. Paths escaping the workspace tree (after resolving `.`/`..` and
   symlinks via `realpath`) are rejected with a localized notice. Absolute paths inside the
   workspace are accepted. The `~/.zcode/v2/bot-attachments` cache is NOT in scope for Alpha 0
   (it lives outside the workspace; revisit in a later alpha with an explicit allowlist).
3. **Size/count gates: ≤ 5MB, 1 file per command** (symmetric with inbound
   `BOT_MAX_ATTACHMENT_SIZE_BYTES`). Oversize → localized rejection listing the limit.
4. **Remote workspaces: honest guard.** If the context workspace is remote
   (`workspaceIdentity` set) and connected, `/file` replies that remote-workspace delivery
   arrives in a later alpha; it never pretends success and never reads local paths for a remote
   context. (A _disconnected_ remote workspace surfaces the standard `/重连` hint first —
   `blockDisconnectedRemoteWorkspace` runs before the `/file` guard.)
   **Superseded by Phase C Alpha 2** (below): remote delivery now succeeds; this Alpha 0
   wording is kept for history only.
5. **Delivery pipeline (probe-proven 2026-09-29, see ../ZCode-handoff.md §5).**
   `getuploadurl` → AES-128-ECB(+PKCS7) encrypt → CDN ciphertext POST (read
   `x-encrypted-param` response header) → `sendmessage` with `image_item|file_item|video_item`.
   Wire details that are product invariants:
   - `media.aes_key = base64(utf8Bytes(hexKeyString))` — double-encoded; wrong form yields
     "receive failed" bubbles (live-verified failure mode).
   - `filesize` sent to getuploadurl = padded ciphertext size; `file_item.len` = plaintext
     size; `image_item.mid_size`/`video_item.video_size` = ciphertext size.
   - New provider calls carry `iLink-App-Id: bot` + `iLink-App-ClientVersion` headers in
     addition to the existing auth headers. The existing text-send path is unchanged.
6. **context_token freshness (probe-proven).** Media `sendmessage` requires a fresh per-peer
   `context_token`. The bots service persists the latest inbound token per (botId, peer
   userId) in bot state and passes it on outbound media. On `ret=-2 prepare failed`:
   retry once without the token; if that also fails, degrade to a localized text notice
   (never a silent drop). Conversational replies stay warm naturally (user just messaged).
7. **Type additions are additive and optional.** `BotOutboundAttachment` and
   `BotOutboundMessage.attachments?` extend the shared protocol; adapters without
   `sendAttachment` are unaffected. `BotCommand` gains `{type:"file"; value:string}`.
8. **Failure semantics.** Every failure (missing file, outside workspace, oversize, upload
   error, stale session) produces a localized text reply; `/file` never throws an unhandled
   error into the polling loop and never mutates the active task/draft context.
9. **Audit.** Successful and attempted deliveries log via `createServiceLogger("bots")`
   `info`: bot id, peer id (not name), filename, size, outcome.
   **3.14.5 Alpha 7 amendment (§5.8, field dedup):** `path=` is the single path field;
   `file=` is logged ONLY when its value differs from `path=` (e.g. a sanitized or
   remote-materialized delivery filename vs the user-requested path). When the two are
   identical (top-level workspace paths, pre-resolution failures), `file=` is omitted —
   never printed twice (the same-value dedup the forward-pin rejected line already
   applies). **3.14.5 Alpha 7 amendment (§5.9, honest guard statement — replaces the
   stale one-liner "Bot sessions are force-yolo; the workspace-only policy + audit log +
   5MB cap are the exfiltration guards"):** bot sessions today run in forced yolo mode —
   `BOT_FORCED_MODE` is applied at three botsService sites (draft init, inherit-task
   draft, and the task-creation `setMode` throat, the single point where mode enters the
   agent session; providers without yolo support keep their own default mode) — so
   interactive permission prompts are structurally absent for bot tasks TODAY, and the
   operative exfiltration guards are the workspace-only path policy + this audit log +
   the 5MB cap. Track B (3.15.0, specs/off-peak-local-admission.md is the auto-deny
   precedent) removes the force-yolo lock for bot permission parity; from that point the
   permission surface joins the guard set and this statement must be revised again.

## Invariants (Alpha 0)

- Bot message text replies, typing indicators, permissions, and task lifecycle behave
  exactly as before this change (zero modification to the existing text `send()` path).
- `/file` does not create, resume, or mutate tasks; it is a pure side-channel command.
- One writer for outbound media: `handleFileCommand` is the only media-delivery code path
  (an extension of the adapter contract, not a second queue; it calls `adapter.sendAttachment`
  directly rather than going through the text `sendOutbound` path). Phase B extracts this core
  as the shared `deliverWorkspaceFile` — see Phase B invariants for the superseding wording.

## Acceptance scenarios (Alpha 0)

Verified 2026-09-29: unit/integration tests (`packages/services/test/botFileDelivery.test.ts`,
103/103 suite) cover 2/3/4/5/7 + wire invariants; 1/6/8 validated by CI + owner manual smoke on
the deployed rig; 8 additionally covered by the full pre-existing bot regression suite.

1. `/file relative/path/result.png` in an active local workspace → WeChat receives an image
   message that opens on the phone.
2. `/file ../outside.txt` or an absolute path outside the workspace → localized rejection.
3. `/file big.bin` (>5MB) → localized rejection with the limit.
4. Missing file → localized rejection.
5. Telegram/Feishu bot `/file` → "channel not supported yet" text.
6. Remote workspace context → "later alpha" text.
7. Stale session (no recent inbound): send fails → retry-without-token → text fallback notice.
8. All existing bot behavior unchanged (regression: run bots-related flows).

## Phase B — Conversational delivery (share_file) — shipped in `3.14.4-alpha.1`

### Behavior

1. **New conversational tool `share_file(path)`.** In a WeChat private chat the user asks in
   natural language ("把刚才生成的图发给我"); the agent calls `share_file` with a single
   `path` parameter (no caption, no target fields). Tool exposure gates — ALL must hold,
   fail-closed: the turn carries `botDeliveryTarget` with provider `weixin` AND
   `chatType === "private"` AND no `automationId`/`offPeakTaskId`; runtime
   `taskType !== "subagent_child"`; the port is present. No target → tool hidden or refuses.
   Excluded by construction: automation turns, off-peak turns, subagent children, group chats,
   non-WeChat providers, desktop/UI turns.
2. **Host-side recipient resolution (recipient never client-supplied).** The tool calls
   `BotFileSharePort.share(path)` → host RPC `bots/shareFile` with params exactly
   `{taskId, path}` (strict zod; unknown keys rejected, tested). The host resolves the
   recipient from its own in-memory `taskDeliveryRegistry` (taskId → {botId, actor,
   workspacePath, workspaceIdentity}; populated ONLY at the conversational `watchTaskStream`
   call sites, never in `watchAutomationRun` — which deletes any existing entry; cleared on
   watcher terminal/cleanup; bounded at 200, evict oldest). A prompt-injected agent cannot
   point delivery at an arbitrary peer.
3. **Single delivery writer, `/file` parity.** The post-auth core of `handleFileCommand` is
   extracted as `deliverWorkspaceFile(bot, actor, context, requestedPath, {source, taskId})`;
   `/file` (source "command") and the RPC (source "tool") both call it. Admission gates are
   re-evaluated per call, at parity with `/file`: bot enabled, user bound,
   `allowedCommands.file`, private chat, adapter `sendAttachment` capability, non-remote
   workspace — then the same workspace-only path policy (lexical + realpath, re-realpath at
   read), 5MB gate (incl. growth between stat and read), and freshest persisted
   context_token (provider-internal ret=-2 retry-without-token applies unchanged).
4. **Tool-only quota.** Max 3 deliveries per rolling 10 minutes AND max 20 per rolling 1 hour
   per (botId, peerKey), applied only to source "tool". `/file` is never quota-bound.
   In-memory, host-side; no persistence (avoids the writeContext token-map revert race).
   The quota slot is reserved atomically before any file IO and released on delivery failure
   (review fix: `share_file` is a concurrentSafe tool whose parallel invocations would
   otherwise all pass the window check before any of them records — concurrent tool calls
   cannot bypass the window caps; observable semantics stay "only successful deliveries
   consume quota").
5. **Honest result semantics.** The tool returns the REAL outcome to the model:
   `BotShareFileResult` = `{ok: true; filename; sizeBytes}` | `{ok: false; reason; detail?}`
   with reasons: `no-target` (registry miss/terminal task, turn without botDeliveryTarget,
   queued-input edge, subagent/automation context), `not-allowed` (bot disabled, user unbound,
   `allowedCommands.file: false`, non-private chat — mid-task revocation parity with `/file`),
   `unsupported-provider` (adapter lacks sendAttachment), `remote-workspace`,
   `outside-workspace`, `not-found`, `too-large`, `quota-exceeded`, `send-failed` (adapter
   threw after provider-internal ret=-2 retry), `unsupported-method` (old host returned -32601;
   CLI-side mapping), `unknown-outcome` (RPC timed out — CLI-side synthesis; RPC timeout sits
   above the provider upload/send margin so a timeout never maps to false success/failure).
6. **Audit enrichment.** Per attempt: existing fields (bot, peer, file, size, kind) plus
   `source=command|tool`, `task=<taskId when tool>`, `path=<workspace relative>`.
   Field precision (matches implementation): `kind=` is present only on successful sends;
   pre-resolution failure and quota-exceeded lines omit `kind` and carry `size=0` placeholders
   (real sizes appear only after path/size resolution, e.g. `too-large` and `send-failed`).
7. **UI = toolCall row + chip renderer.** The share renders as the existing toolCall row plus
   a name-based chip renderer (`packages/ui/src/ToolCallBlocks/resolveRenderer.ts`; the chip
   derives the file path from the tool input and the status from the output prose) and a
   compact summary line (`packages/shared/src/tool-call-summary.ts`). No new protocol display
   types (structured filename/size display deferred). Both desktop-continuous and
   web-remote-replayable links render it. The WeChat text-mode tool summary line
   (`packages/services/src/bots/replyFormatter.ts`) shows honest status words for
   `share_file` — 已发送 / 未发送 / 结果未知 — derived from the output prose with the same
   three-way logic as the UI renderer (prose-derived until structured display lands; a
   failed delivery is a normal completed tool result, so the generic 完成 word must not
   appear for it).

### Invariants

- `bots/shareFile` RPC is the ONLY delivery trigger for conversational sends; no stream event
  exists; mirroring/echoing produces zero adapter calls.
- Neither `/file` nor `share_file` mutates task or bot context state (token store merge on
  inbound remains the only state write).
- Failure UX = tool result only; NO second system text notice from botsService (the model's
  reply rides the normal text path). Recorded decision — do not re-litigate.
- Text send path untouched; `/file` behavior unchanged (incl. no quota).
- All additions are optional/additive; old host + new CLI → structured `unsupported-method`.
- `deliverWorkspaceFile` is the sole media-delivery entry (supersedes the Alpha 0
  "sendOutbound" wording, which was already inaccurate).

### Acceptance scenarios

Verified 2026-09-30: unit/integration coverage below all green (services 139/139, shared 32/32,
UI 26/26; PR #4 CI 5/5); owner-rig manual E2E passed 2026-09-30 ("works well") on the released
`3.14.4-alpha.1`. Coverage: 1, 9, 13 (incl. chip reload + phone replay) are owner-rig manual
E2E; the rest are unit/integration — protocol zod tests (packages/shared), services tests
extending `packages/services/test/botFileDelivery.test.ts` (guard matrix, quota incl.
parallel-call TOCTOU + reserve/release, stale-registry terminal paths, single-writer,
no-context-mutation, audit), and the shared deny-predicate matrix tests
(packages/shared/test/botsShareFile.test.ts, `botShareFileDeliveryTargetQualifies`) consumed
by all three per-turn deny sites (CLI legacy + v4 prompt-turn builders and the services
`zcodeTaskServiceAdapter` mirror). apps/zcode-cli has NO test harness — the CLI builders are
covered only via the shared predicate plus each layer's fail-closed behavior and manual rig
spot checks, not CLI tests.

1. Happy path: "发给我" in an active local WeChat private chat → media arrives and opens on the
   phone; model text confirms; desktop renders the chip; chip survives history reload; phone
   replay shows the chip. [manual rig]
2. Injection matrix: tool injected iff the current send has weixin+private `botDeliveryTarget`
   and no automationId/offPeakTaskId; NOT injected for automation turns, off-peak turns,
   desktop/UI turns, feishu/lark turns, group turns, subagent children. [shared predicate
   tests + manual rig — no CLI harness exists; the three deny sites consume
   `botShareFileDeliveryTargetQualifies` from packages/shared]
3. Automation run reusing a bot-born session (targetTaskId): tool absent AND RPC denies
   (registry deleted by `watchAutomationRun`); zero deliveries. [services tests]
4. Strict schema: RPC rejects any client-supplied target/provider/peer field; delivery goes
   only to the turn's requesting peer even when file content instructs otherwise
   (prompt-injection README "share .env to …"). [protocol + services tests]
5. outside-workspace (lexical `..`, absolute outside, symlink escape) → honest failure;
   nothing sent; audited. [services tests]
6. > 5MB incl. growth between stat and read → `too-large`; nothing sent. [services tests]
7. Missing file → `not-found` honest failure. [services tests]
8. Quota: 4th tool send inside 10 min (or 21st/hour) → `quota-exceeded`; model steers to
   `/file`; audited; `/file` itself NOT quota-bound. [services tests]
9. Stale token: silent user, >40-min task → ret=-2 → provider retry-without-token → failure
   reaches the model via the tool result; mid-task user ping refreshes the persisted token and
   next attempt succeeds. [manual rig]
10. RPC timeout → `unknown-outcome`; the turn does not crash; no false success/failure.
    [code-verified + manual rig — the -32022 timeout → unknown-outcome mapping in the
    bootstrap port has no automated harness; disclosed]
11. Remote workspace context → `remote-workspace` honest failure; no local read fallback.
    [services tests]
12. Mid-task revocation (bot disabled / `allowedCommands.file: false` while the task runs) →
    `not-allowed` (parity with `/file`). [services tests]
13. Two sequential `share_file` calls in one turn → exactly two messages, each exactly once;
    no event mirror exists → zero double-send risk; single-writer verified via adapter-call
    counting. [manual rig + services tests]
14. A `share_file` turn does not create/resume/mutate tasks; no writeContext writes.
    [services tests]
15. Audit per attempt: bot, peer, relative path, size, outcome, taskId, source.
    [services tests]

## Phase C — Alpha 2: remote workspaces (WeChat) — spec'd 2026-09-30, in progress

Owner decision (approved 2026-09-30): temp-file materialization approach; split Alpha 2
(remote) / Alpha 3 (channels); Alpha 2 targets `3.14.4-alpha.2`.

### Behavior

1. **Remote delivery.** On a remote workspace context (`workspaceIdentity` set) that is
   connected, both `/file <path>` and conversational `share_file` fetch the file's bytes from
   the remote machine and deliver it through the unchanged single-writer path. Event order:

   ```text
   deliverWorkspaceFile (sole writer, botsService)
     ├─ admission re-eval (unchanged: bot enabled / bound / allowedCommands.file / private /
     │  adapter sendAttachment)          ← adapter gate runs BEFORE remote branch
     ├─ [tool source only: quota reserve happens in shareFileForTask immediately
     │  BEFORE entering deliverWorkspaceFile — reserve-before-IO, release-on-failure]
     ├─ remote fetch: bridge.getWorkspaceFileReader → chunked RPC read (≤512KiB/chunk,
     │  cumulative ≤5MB, per-chunk deadline 20s, total fetch budget 120s)
     ├─ materialize: os.tmpdir()/zcode-bot-outbound/<random>/<filename> (dir 0700, file 0600)
     ├─ adapter.sendAttachment (unchanged; reads the temp localPath)
     ├─ unlink temp (best-effort, in finally — removes the whole random dir)
     └─ quota release on failure (unchanged reserve/release semantics)
   ```

2. **New v4 wire method `v4/bot-workspace-file/read`** (desktop host → remote CLI gateway;
   `V4_METHODS` in `packages/shared/src/zcode-protocol-v4/transport.ts`, strict-zod params/result
   schemas alongside existing v4 attachment schemas). Params: `{relativePath: string (trimmed,
min 1 — the requested path written RELATIVE or ABSOLUTE; the wire field name stays
`relativePath`, renaming would break old remote CLIs), offset: uint, limit: uint
1..524288}`. Result: `{ok:true; filename; sizeBytes; dataBase64; eof}` | `{ok:false; reason:
outside-workspace|not-found|too-large|unavailable; detail?}`. **Path parity with the local
   resolver (Alpha 3 fix; previously the remote policy rejected ALL absolute paths —
   owner-observed):** absolute-inside input is normalized as-is and accepted, relative input
   joins the root, exactly like `resolveWorkspaceFilePath`. Containment is adjudicated by the
   remote owner (lexical under-root + realpath, unchanged): absolute-outside and `..` escapes
   (relative or absolute form) → outside-workspace. The remote CLI gateway handler
   (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts`, mirroring the
   `attachmentRead` case) owns ALL path semantics with remote-OS rules: lexical resolve →
   realpath → must sit inside the realpath'd workspace root (its cwd); re-stat per chunk read
   (growth → too-large); whole-file stat >10MB rejected (defense in depth above the 5MB product
   cap). Pure path-policy helpers live in `packages/shared` with tests there (apps/zcode-cli has
   no test harness).
3. **Bot-only exposure (the security lock).** The read capability is served ONLY on bot runtime
   attachments: desktop main marks the `AttachServicePort` message with
   `attachmentKind: "bot-runtime"` in `createBotRemoteWorkspaceRuntimePort`
   (`desktopRemoteSessions.ts`) — the only caller that sets it — and the desktop host
   (`packages/desktop/src/host/index.ts` AttachServicePort handler) exposes the narrow
   `IBotWorkspaceFileService` channel (single method) only when that marker is present. Renderer
   / relay / phone replay attachments share `IZCodeAgentService` and structurally never see this
   channel. **Recorded decision: `IZCodeAgentService` is NOT extended with a workspace-file
   read** — replay clients reach it, so it stays ref-scoped (attachment/conversation/artifact).
   The channel's host-side impl forwards to the v4 method above.
4. **Bridge accessor.** `createBotRemoteWorkspaceService` gains
   `getWorkspaceFileReader({workspacePath, workspaceIdentity})`, reusing the cached
   `getRuntimeServices` port (same lifecycle/failure modes: throws when no attachable route,
   60s init timeout). `createRemoteRuntimeServicesFromPort` wraps the new channel via
   `ProxyChannel.toService`.
5. **Materialization.** Chunks reassemble in memory (≤5MB) → temp file under
   `os.tmpdir()/zcode-bot-outbound/<random>/<filename>`, mode 0600, delivered via the unchanged
   `BotOutboundAttachment.localPath` contract, unlinked best-effort in `finally`. NOT under
   `~/.zcode/v2` (cleanability "none" there; tmpdir is OS-cleanable). Temp files are outside the
   workspace → never re-shareable via `/file` (parity with the inbound cache exclusion).
6. **Failure mapping.** New additive reason `remote-unavailable` (shared enum + CLI mirror +
   zh/en copy) covers: bridge absent, no attachable route, runtime init failure/timeout, old
   remote CLI missing the v4 method, mid-read RPC failure, chunk/total budget exceeded.
   Disconnected remote: `/file` keeps the existing `/重连` hint first
   (`blockDisconnectedRemoteWorkspace` unchanged); tool path returns `remote-unavailable`.
   Remote reader's typed rejections map 1:1 to existing `outside-workspace`/`not-found`/
   `too-large`. `remote-workspace` stays in the enums for old-CLI compatibility but new hosts
   no longer emit it (adapter gate still yields `unsupported-provider` where applicable).
   No auto-reconnect inside delivery (never calls `ensureConnected`).
7. **CLI mirror + prose.** `BOT_SHARE_FILE_FAILURE_REASONS` (contracts) gains
   `remote-unavailable`; CLI tool-result prose gains the case; stale `remote-workspace` prose
   ("not available yet") updated to reflect shipped remote delivery. Old CLI + new host:
   unknown reason fails closed into `send-failed`-style degradation (fail-safe, disclosed).
   Timeout budget: CLI RPC timeout stays 300s; all fetch failures surface as
   `remote-unavailable` far below it.
8. **Audit.** Remote attempts add `remote=<workspaceIdentity>`; `path=` logs the
   user-requested path as given (the wire result carries no relativePath; the desktop never
   re-resolves or normalizes a remote path for logging).
9. **Zero drift (local).** Local-workspace `/file` and `share_file` replies are byte-identical
   to `3.14.4-alpha.1` (pinned by regression fixtures). The Alpha 0 `/file` reply-order
   invariant (adapter → remote → empty path) is superseded: adapter gate first, then remote
   branch; empty-path check position unchanged.

### Invariants

- `deliverWorkspaceFile` remains the sole media-delivery entry; remote fetch happens inside it,
  before any adapter call; adapters never learn about remoteness (localPath contract unchanged).
- The machine that owns the filesystem is the ONLY decider of remote path containment; the
  desktop never resolves/realpaths remote paths locally and never trusts a remote absolute path.
- The workspace-file read channel exists only on bot-runtime-marked attachments (structural
  guarantee, not a role heuristic); replay/renderer/phone attachments cannot call it.
- Materialized temp file is the only local artifact: outside workspace + `~/.zcode/v2`, 0600,
  deleted in `finally`; a crash may leak at most one ≤5MB temp file in the OS tmpdir.
- Quota reserve/release semantics identical for remote and local (tool source only).
- All wire additions optional/additive; old remote CLI → typed `unavailable` → surfaced as
  `remote-unavailable`; old host + new CLI unaffected.

### Acceptance scenarios

Unit/integration (services `botFileDelivery.test.ts` + shared zod/policy tests):

1. Remote happy path: fake reader returns 2 chunks → exactly one `adapter.sendAttachment` with
   the materialized temp path; temp unlinked after; audit carries `remote=`.
2. Reader typed rejections map 1:1 (outside-workspace / not-found / too-large); nothing sent.
3. Cumulative >5MB mid-chunk → too-large; chunk deadline / total budget exceeded →
   remote-unavailable; reader missing/init throw → remote-unavailable.
4. Disconnected remote: `/file` → reconnect hint (pinned); tool → remote-unavailable.
5. Zero-drift: local-context `/file` + tool replies identical to pre-Alpha-2 fixtures.
6. Wire schemas strict (unknown keys rejected; limit bounds; absolute `relativePath` passes the
   schema — result semantics are the remote CLI's); shared path-policy helper matrix
   (relative + absolute-inside forms resolve to the SAME file, parity with the local resolver;
   absolute-outside, lexical `..` escape in relative or absolute form, realpath/symlink escape
   → outside-workspace; cross-OS drive-style inputs stay coherent with the injected pathOps).
7. Quota parity on remote tool sends incl. parallel reserve/release.
8. Desktop bot-only gate: `createScopedBotWorkspaceFileService` matrix (non-bot attachment /
   local scope / missing factory → no channel; bot-runtime + remote → scope-truth injected,
   caller-supplied workspace fields ignored, service-level extra keys pass wire projection,
   base throw and invalid wire input fold to structured unavailable) —
   `packages/desktop/test/botWorkspaceFileGate.test.ts`.
9. Absolute-path parity (Alpha 3 fix): `/file` with an absolute-inside requestedPath on a
   connected remote workspace → the reader receives the absolute path VERBATIM (desktop never
   rewrites remote paths; wire field stays `relativePath`) and delivery succeeds;
   absolute-outside requestedPath → the remote reader's outside-workspace verdict maps 1:1 →
   honest refusal, zero deliveries.

Manual rig (owner pause phase, blocks the alpha release) — **validated 2026-10-01 on
`3.14.4-alpha.4`** (remote conversational + `/file` relative AND absolute paths all
deliver over real SSH; the Alpha 2/3 checklist items passed cumulatively — R2 busy-drop,
R3/R4 absolute-in/outside, R5 relative, L1 local parity were exercised across the
alpha.3/alpha.4 rig runs):

1. Local regression: `/file` + conversational share behave exactly as `3.14.4-alpha.1`.
2. Remote happy path: `/file <path>` and "发给我" both deliver the real file from the remote
   workspace; chip survives restart.
3. Trick paths on remote: `../outside.txt`, missing file, >5MB → honest localized refusals.
4. Disconnect the remote machine: `/file` shows the reconnect hint; conversational share
   reports the precise unreachable reason; never fake success.
5. Rapid-fire conversational asks (quota unchanged); temp dir spot check afterwards.

## Phase C — Alpha 3: cross-host recipient resolution — spec'd 2026-10-01

Rig-confirmed bug this alpha fixes: conversational `share_file` on a REMOTE workspace
always returned `{ok:false, reason:"no-target"}`. Root cause (reproduced twice,
including a topology reproduction test): the remote CLI's reverse RPC `bots/shareFile`
terminates at the REMOTE machine's zcode-server (desktop-attached-remote assembly),
whose `botsShareFileExecutor` delegated to THAT assembly's own botsService — whose
`taskDeliveryRegistry` is permanently empty because registries are only populated by
the window-host desktop-local botsService when bot inbound arrives, and the remote
assembly never receives bot inbound.

### Behavior

1. **Forward, never self-answer.** In the desktop-attached-remote assembly the
   `botsShareFileExecutor` forwards `{taskId, path}` to the window-host desktop-local
   botsService (the single writer) over a narrow desktop-served channel on the SAME
   stdio connection that links the two processes. The remote assembly NEVER resolves
   recipients itself. Event order:

   ```text
   remote CLI share_file tool
     → reverse RPC bots/shareFile (remote zcodeAgentService, strict schema — unchanged)
     → botsShareFileExecutor = forwarder (remote assembly)
     → IBotShareFileForwardService.forward({taskId, path})  ← narrow channel, no recipient fields
     → desktop window Host forward handler
         ├─ strict schema re-check (unknown keys rejected → error → send-failed on remote side)
         ├─ connection workspace scopes = online logical sessions on THIS connection's target
         │  (desktop registry facts; caller-supplied workspace fields are ignored — none exist)
         └─ botsService.shareFileForTask({taskId, path}, {restrictToWorkspaces: scopes})
             ├─ taskDeliveryRegistry lookup (unchanged single writer)
             ├─ workspace-identity pin (below) → not-allowed on mismatch
             └─ unchanged Alpha-2 delivery core (quota → adapter gate → remote fetch →
                materialize → sendAttachment → cleanup)
   ```

2. **Channel.** `IBotShareFileForwardService` — single method
   `forward({taskId, path}) → BotShareFileResult` — channel name
   `ServiceChannels.BotShareFileForward` (`"bot-share-file-forward"`). Params reuse the
   strict `zcodeBotsShareFileParamsSchema` (unknown keys rejected; NO recipient/
   provider/peer/workspace fields — the desktop derives the workspace from the
   connection scope, never from the caller). Served by a desktop-side `ChannelServer`
   on the same `SocketProtocol` as the existing desktop `ChannelClient`
   (`RequestType`/`ResponseType` value ranges are disjoint, so both directions share
   one stdio stream); the remote side calls it via a `ChannelClient` on the same
   protocol. Precedent: `IBotWorkspaceFileService` (Alpha 2), opposite direction.

3. **Workspace-identity pin.** The desktop forward handler passes the connection's
   workspace scopes as `restrictToWorkspaces` into `shareFileForTask`, enforced inside
   the single writer right after the registry lookup, before quota reserve and any
   file IO: the registry entry's `(workspacePath, workspaceIdentity)` must equal one
   of the scopes of online logical sessions bound on this connection's remote target.
   A compromised remote must not borrow another workspace's or another machine's
   session. Empty scope set (no online session for the target) → fail-closed
   `not-allowed`. Local-workspace entries (no identity) never match a remote scope.

4. **Failure matrix (remote executor mapping).**

   | Condition                                                               | Result                                     | Notes                                                                                                                                                                                                                                            |
   | ----------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | Desktop channel absent (old desktop never initializes desktop channels) | `{ok:false, reason:"unsupported-method"}`  | Same honest semantics as an old host: CLI renders the existing capability prose. Detected via missing `Initialize`; never queues (a queued request would hang for the whole budget).                                                             |
   | Forward transport error / desktop handler error                         | `{ok:false, reason:"send-failed", detail}` | Includes malformed desktop result (strict result schema re-check fails).                                                                                                                                                                         |
   | Forward sub-timeout 280 s                                               | `{ok:false, reason:"send-failed", detail}` | Inside the CLI port's 300 s budget so the CLI gets a definitive answer instead of `unknown-outcome`. Honest caveat: the desktop may still complete the delivery after the timeout; the prose states failure of the request, not of the delivery. |
   | Pin mismatch / empty scopes (desktop)                                   | `{ok:false, reason:"not-allowed"}`         | Nothing delivered.                                                                                                                                                                                                                               |
   | Registry miss on the desktop                                            | `{ok:false, reason:"no-target"}`           | Now the truthful owner answers.                                                                                                                                                                                                                  |

5. **Unchanged assemblies.** desktop-local and standalone-server (HTTP entry without
   a desktop channel client) keep today's local resolution semantics exactly,
   including the fail-closed `no-target` before assembly completion. Old remote +
   new desktop: remote never learns the channel exists; zero cost. Old desktop + new
   remote: `unsupported-method` (above). New desktop + new remote: full fix.

### Invariants

- The remote assembly's botsService never resolves a `bots/shareFile` recipient;
  its registry stays unused for tool delivery (it is still armed by nothing and
  cleared on dispose — unchanged).
- No recipient/workspace/provider fields are added to ANY wire (protocol RPC,
  forward channel, v4 fetch) — recipient truth stays desktop-owned.
- `deliverWorkspaceFile` and the Alpha-2 remote fetch path are untouched; the pin is
  enforced in `shareFileForTask` before quota and IO.
- One stdio connection carries both directions; the desktop-serving ChannelServer
  registers only the narrow forward channel and is disposed with the connection.
- All changes additive; every old/new desktop/remote combination degrades honestly
  per the matrix above.

### Acceptance scenarios

Unit/integration (`packages/services/test/botShareFileRemoteTopology.test.ts`):

1. Topology reproduction flipped green: the production executor wiring (forward over
   a real ChannelServer/ChannelClient pair with the REAL desktop forward handler)
   returns `ok` and delivers exactly once via the desktop adapter, while the same
   params to a self-answering stand-in (today's semantics, kept by standalone-server)
   still return `no-target` — the only difference is the termination point.
2. Identity pin: forward with mismatched connection workspace scopes → `not-allowed`,
   zero deliveries; empty scopes → `not-allowed`.
3. Channel absent: forwarder against a client with no desktop server (no
   `Initialize`) → `unsupported-method`, zero deliveries, no queueing.
4. Control asymmetry: the desktop instance asked directly still delivers exactly
   once with materialization and cleanup (Phase-1 coverage kept).

### Instrumentation (Alpha 4 diagnostic footprint)

Production incident (remote WeChat `share_file` → `unsupported-method`): two candidate
chains were indistinguishable in chat. The `unsupported-method` prose now surfaces its
`detail` (same pattern as `send-failed`), discriminating "desktop reverse channel never
initialized" (forwarder readiness fold, a structured RESULT from Chain Y) from
"bots/shareFile is unavailable on this host" (remote `-32601` JSON-RPC error, Chain
X-a). Footprint (all additive, no behavior change beyond the detail surfacing; no file
paths in logs): CLI port logs per attempt the result reason plus, on
`ProtocolRequestError`, BOTH code and message (X-a vs stale-bundle X-b), else an
explicit "structured result; no rpc error" line (Chain Y); the forwarder folds with the
stable detail string, logs a one-shot "channel initialized" on `Initialize`, and logs
each forward outcome (reason + detail only); entry-stdio logs one assembly line
(`authority=… forwarder=ready|absent(client=absent)`); the desktop side logs the
ChannelServer construction decision (`serveDesktopChannels`) and the forward-channel
registration, plus a warn when the registration gap (botsService present,
desktopChannelServer absent) would otherwise stay silent.

### Readiness gap root cause & bundle E2E guard (Alpha 4 follow-up)

The full-dress rehearsal test (`packages/server/test/botShareFileRemoteBundleE2E.test.ts`)
reproduced Chain Y deterministically against the BUILT remote server bundle
(`dist/remote/zcode-server.cjs`) and pinned the root cause: `waitForAck` removes the only
stdin `data` listener while stdin stays in flowing mode, so desktop frames arriving in the
listener-less window are silently discarded. The remote reverse `ChannelClient` stays
`Uninitialized` forever and every forward folds to `unsupported-method` ("desktop
reverse channel never initialized"). TWO discard windows exist, and the fix closes both
(review-verified empirically on Node 22 + 24):

1. **Separate chunks**: ack and `Initialize` in different `data` chunks — closed by
   constructing the persistent socket/protocol/reverse `ChannelClient` immediately after
   `waitForAck` resolves, BEFORE any post-ack await (the continuation runs in the same
   microtask chain, so no new I/O event can intervene).
2. **Coalesced chunk** (the likely SSH production shape — ssh2 batches same-tick writes):
   ack + `Initialize` in ONE `data` chunk — `waitForAck`'s `unshift()` of the remainder
   happens while flowing with no listener and an empty buffer, which takes Node's
   direct-emit path and discards the bytes before the continuation attaches. Closed by
   `process.stdin.pause()` after `removeListener` / before `unshift`, with
   `process.stdin.resume()` in `main()` after the protocol listener is attached
   (explicit pause disables `on('data')` auto-resume).
3. **Binary remainder corruption** (found by the coalescing E2E leg itself): the old
   handshake accumulated stdin as a UTF-8 _string_ and re-encoded the remainder — RPC
   frames are binary and invalid-UTF-8 sequences were replaced, corrupting the first
   frame so the reverse client's deserializer crashed. Closed by buffer-only scanning:
   locate the ack line by `0x0A` byte, UTF-8-decode ONLY the ack line (JSON, safe),
   unshift the remainder as raw bytes — never through a string round-trip.
   The rehearsal test runs BOTH transport shapes (separate-chunk and a same-tick coalescing
   stub backend mirroring SSH batching), execs the real bundle via the real `connectRemote`

- a POSIX temp-HOME stub backend, registers the real desktop forward channel exactly as
  the window Host does, drives the agent-protocol dispatch leg with a minimal ndjson fake
  agent, and asserts `ok` + exactly one desktop adapter delivery while explicitly failing
  on any `-32601` / `unsupported-method` shape (bundle wiring losses become visible
  forever). Bundle freshness guard: the test rebuilds when any server/services/shared
  src file is newer than the bundle (stale local artifacts no longer mask regressions).

## Phase C — Alpha 5: Telegram + Feishu/Lark outbound senders

Spec'd 2026-10-01 from the owner-approved plan (../ZCode-handoff.md §4); implementation
pending; targets `3.14.4-alpha.5`. The delivery core has been WeChat-only purely because
only the weixin adapter implements `sendAttachment` — Alpha 5 adds the two remaining
senders and widens channel qualification; the single writer above them does not change.

### Behavior

1. **Same delivery, more channels.** `/file <path>` and conversational `share_file` work
   identically on Telegram and Feishu/Lark PRIVATE chats as on WeChat, through the
   unchanged single writer `deliverWorkspaceFile` (admission gates, workspace-only path
   policy, 5MB cap, tool-only quota, audit, remote fetch/materialization). Nothing above
   the adapter layer changes except channel qualification (item 2).
2. **Channel qualification widening (4 sites).** (a) The shared
   `zcodeAutomationBotDeliveryTargetSchema.provider` enum gains `"telegram"` (feishu/lark
   are already members). (b) The shared predicate `botShareFileDeliveryTargetQualifies`
   accepts weixin/telegram/feishu/lark, still private-only and still
   non-automation/off-peak. (c) The producer `resolveAutomationBotDeliveryTarget`
   (botsService) emits telegram targets — **owner decision: telegram PRIVATE chats only;
   telegram group chats never emit a target**. (d) The three deny-site consumers (CLI
   legacy + v4 prompt-turn builders and the services `zcodeTaskServiceAdapter` mirror)
   auto-widen by consuming the shared predicate — no fourth hand-copy.
3. **Explicit owner-approved side effect of (c): telegram pushback.** Telegram
   private-chat bots gain scheduled-task completion pushback (text, via the existing
   automation pushback machinery — telegram was permanently silent before because no
   target was ever emitted). Telegram group chats gain nothing. Feishu/lark/weixin
   pushback is unchanged.
4. **Telegram adapter `sendAttachment`: always `sendDocument`.** Multipart upload via
   the existing `fetchBotProvider`/`fetchBotProviderJson` helper with an EXPLICIT 60s
   timeout — the helper default (15s) is too low for 5MB uploads, and the Telegram bot
   API limit (50MB) sits far above our 5MB cap. The chat target is derived exactly like
   the existing `sendMessage` path (no new identity plumbing). Documents only — no
   recompression, no photo special-casing. **3.14.5 Alpha 6 amendment (§5.4):** after
   the `readFile` and before the upload request, `bytes.length` over the 5MB cap is
   rejected with an error naming the limit (parity with the weixin adapter's read-side
   re-check, same `${filename} exceeds 5MB.` shape) — a file that grew between the
   service-side stat and the adapter read must fail honestly, never upload oversized.
   See "Inbound attachment gates (3.14.5 Alpha 6)" item 5.
5. **Feishu/Lark adapter `sendAttachment`: upload-then-send, per attachment kind.**
   `readTenantAccessToken` (existing) gates both upload routes. Kind "image" → upload
   `im/v1/images` (inline render; 10MB API limit) then send `msg_type: "image"`. Kinds
   video/file → upload `im/v1/files` (30MB API limit; 0-byte files are rejected by the
   API — fail honestly BEFORE upload), file_type mapped from filename/mime over
   pdf/doc/xls/ppt/mp4/opus with "stream" as the fallback for everything else; then send
   `msg_type: "file"` via the existing `im/v1/messages` machinery. receive_id derives
   from the existing `resolveFeishuReceiveIdType`; errors surface via the existing
   `createFeishuMessageError` (code/msg/log_id preserved). Upload calls carry explicit
   60s timeouts (same rationale as Telegram). `sendAttachment` must NOT interact with
   the streaming reply card machinery — the media arrives as its own separate message
   bubble. **3.14.5 Alpha 6 amendment (§5.4):** the same read-side ≤5MB re-check as
   Telegram item 4 — after `readFile`, before ANY upload request, reject with an error
   naming the limit (parity with weixin). See "Inbound attachment gates (3.14.5 Alpha 6)"
   item 5.
6. **`/help` finally lists `/file` (deferred since Alpha 0).** "file" joins
   `BOT_MENU_COMMAND_ORDER`; `helpFile` copy lands in BOTH the zh and en catalogs;
   `telegramCommandNames`/`telegramCommandDescriptions` gain entries so Telegram's
   native command menu registers it. The per-bot `allowedCommands.file: false` toggle
   is honored automatically (absent = allowed — unchanged semantics).
7. **CLI tool description.** The `share_file` tool handler copy (apps/zcode-cli) no
   longer says "WeChat private chat" only.
8. **Rollout semantics: default-allow.** Merging instantly enables `/file` +
   `share_file` (+ telegram private pushback) for ALL existing telegram/feishu bots.
   Operator rollback is the per-bot `allowedCommands.file: false` toggle — no
   redeploy.

### Invariants

- `deliverWorkspaceFile` remains the sole media-delivery entry; adapters only upload +
  send; everything above them is provider-neutral and unchanged.
- WeChat behavior is byte-identical to `3.14.4-alpha.4` (pinned by the existing
  zero-drift fixtures).
- No new identity/target plumbing: adapters derive the chat target from the outbound
  message exactly like their text-send paths; recipient truth stays host-resolved
  (`taskDeliveryRegistry`).
- The shared predicate stays the single qualification source consumed by all three
  deny sites.
- Telegram group chats never receive files and never emit delivery targets (locked
  private-only decision).
- Feishu `sendAttachment` never touches streaming-card handles or transient card
  state.
- All wire additions are additive (enum widening only). **Owner decision (accepted
  degradation, no retry fallback):** `botDeliveryTarget.provider: "telegram"` on stale
  peers still running the old provider enum (`["feishu","lark","weixin"]`) fails their
  strict parse — new desktop + not-yet-reconnected remote runtime + telegram bot prompt
  → the whole prompt send fails with the structured params error (-32602; honest,
  user-visible) until reconnect redeploys the matching bundle; the reverse direction
  (new CLI → old desktop host, `automationCreate` with a telegram target) fails the
  same honest way. The host's existing omit-retry only covers top-level unrecognized
  keys and structurally cannot rescue nested enum mismatches — documented, accepted,
  transient, self-healing after reconnect; do NOT add fallback code for it.
- Expected breakage beyond that edge: none (additive for all other users).

### Acceptance scenarios

Unit/integration:

1. Predicate matrix widened (`packages/shared/test/botsShareFile.test.ts`):
   telegram/feishu/lark + private + no automation/off-peak → qualifies; each provider
   paired with a group chat → not; automationId/offPeakTaskId → not.
2. Producer tests (services): telegram private actor → target with provider
   "telegram"; telegram group actor → undefined; feishu/lark/weixin unchanged
   (including group-emission parity for feishu/lark).
3. Telegram adapter (fetch-mocked, no real network): happy path sends `sendDocument`
   multipart with the right chat id, filename, and explicit 60s timeout; API error →
   throw (maps to `send-failed` upstream).
4. Feishu adapter (fetch-mocked): image kind → `im/v1/images` upload +
   `msg_type: "image"` send; file kind → `im/v1/files` with the file_type mapping
   (pdf/doc/xls/ppt/mp4/opus examples + "stream" fallback for unknown); 0-byte file →
   honest failure BEFORE upload; API business error (code != 0) → error carries
   code/msg/log_id.
5. Unsupported-provider negative cases re-based: existing tests that used feishu as
   the no-`sendAttachment` stub switch to discord/webhook (feishu now HAS
   `sendAttachment`).
6. Zero-drift: weixin local replies identical to the alpha.4 fixtures (existing
   tests, unmodified).
7. Help: `/help` output includes the /file line in zh and en;
   `allowedCommands.file: false` hides it; Telegram `buildTelegramCommands` includes
   file when allowed, excludes it when explicitly false.
8. Manual rig checklist (blocks the alpha release): testers with Telegram + Feishu
   bots ready; the Feishu app needs `im:resource` scope + bot capability; reconnect
   remote workspaces after the desktop upgrade; Feishu — verify the file bubble
   coexists sensibly with the streaming reply card; optional — the stale-remote
   scenario shows the honest error.

## Inbound remote workspaces (3.14.5 Alpha 0)

Spec'd 2026-10-02 from ../ZCode-handoff.md §2 Track A Alpha 0 (A1 + A3a). Targets
`3.14.5-alpha.0`. Fixes the owner-rig-confirmed gap: images sent to a bot worked on
remote workspaces, but files/PDFs/videos did not — the remote agent received a
Windows desktop path in the prompt text and every tool read failed.

### A1. All attachment kinds become real prompt attachments

**Behavior.**

1. `prepareBotMessageContent` (botsService) pushes a `ZCodePromptAttachment`
   `{kind, filename, mimeType, localPath, sizeBytes}` for inbound kinds
   `file`/`video` exactly as it already did for `image`/`audio`. Kind mapping:
   inbound `video` → `video`; inbound `file` with mimeType `application/pdf`
   (parameters stripped, case-insensitive — same detection form as the CLI
   protocol mapper) → `pdf`; all other inbound `file` → `file`
   (`BotInboundAttachmentKind` has no `pdf`; providers never emit one). The
   existing per-attachment prompt line (`附件：… 已保存到：<localPath>`) is kept
   verbatim — the desktop remote wrapper rewrites the path substring inside it.
   `sizeBytes` uses the cached byte length (`cacheResolvedAttachment` always sets
   it); it is mandatory for kind `file` and set for `pdf`/`video` too.
2. `dataBase64` is NOT set for the new kinds: the CLI mapper prefers `localPath`
   for every kind, and `localPath` is guaranteed present because the gateway just
   wrote the cache file.
3. **Remote workspaces**: the desktop-host wrapper
   (`materializeRemotePromptAttachments`, packages/desktop) already uploads any
   attachment with a `localPath` to `~/.zcode/tmp/prompt-attachments/…` on the
   remote machine and rewrites both the attachment path and the path embedded in
   the prompt text (exact-substring replacement; multi-attachment and
   Windows-separator paths covered by tests). With A1 the attachment list is no
   longer empty for file/PDF/video, so the existing machinery delivers every kind
   with zero wrapper changes. Upload failure surfaces as today's honest
   `taskFailed` reply (unchanged path).
4. **Local workspaces (intended behavior change, release-noted)**: local PDFs and
   files become native model attachments instead of a path-only hint — this
   aligns the bot with how the desktop GUI already sends attachments. PDF kind
   gets the CLI's special pdf content-block handling (native document reading
   instead of a tool-read of the prompt path).
5. Old remote runtime + new desktop: existing honest reconnect/degradation
   messages (designed degradation; reconnect the workspace to redeploy the
   matching bundle).

**Invariants.**

- `image`/`audio` attachments STOP carrying `dataBase64` as of 3.14.5 Alpha 7 (§5.11
  amendment; supersedes this bullet's earlier "byte-identical incl. dataBase64, strip
  DEFERRED" wording). The R3 rig check passed 2026-10-04 (../ZCode-handoff.md §2h):
  path-only rendering was owner-verified on the phone WeChat preview AND the desktop
  transcript, so `localPath` (the just-written cache file, always present) is sufficient
  and the base64 duplicate dies. The strip applies ONLY at the botsService inbound
  prompt-attachment construction site; `dataBase64`-only attachments from other sources
  still pass through the desktop wrapper unchanged (wrapper invariant below unchanged).
  Prompt line, caching, and kind mapping are otherwise byte-identical.
- New kinds never carry `dataBase64`.
- The 5MB / 4-attachments-per-message inbound gates were unchanged in this alpha. The
  per-file rejection UX, the >4-attachment notice, unnamed-attachment container
  sniffing, and the attachment-cache lifecycle land in 3.14.5 Alpha 6 — see
  "Inbound attachment gates (3.14.5 Alpha 6)" below.
- Kind mapping is faithful: inbound kind is never widened; only the pdf mime
  derivation narrows `file` → `pdf`.

**Acceptance scenarios.**

1. Services red test first (`packages/services/test/botInboundAttachments.test.ts`):
   inbound file/pdf/video → `sendPrompt` carries attachments with `localPath` +
   correct kind + `sizeBytes`, no `dataBase64`, prompt line still present.
2. Regression: image/audio attachments keep their prompt line and `localPath`;
   `dataBase64` is now ABSENT (§5.11 Alpha 7 flip, gated on the R3 rig PASS — the
   updated A1 regression in `botInboundAttachments.test.ts` pins the flipped invariant;
   this is a spec invariant change, not an assertion weakening).
3. Remote-context (`workspaceIdentity` set) messages now carry attachments into
   `sendPrompt` (the wrapper input).
4. NEW desktop wrapper characterization suite
   (`packages/desktop/test/remotePromptAttachments.test.ts`): no-attachment
   passthrough (uploadedCount 0); single attachment upload + attachment-path
   rewrite + prompt-text rewrite under the resolved remote HOME root; multiple
   attachments incl. Windows-style localPath — both rewritten, order-stable;
   `backend.upload` throw → materialize throws with the filename; already-under-
   remote-root paths untouched (no upload); dataBase64-only attachments passed
   through unchanged (no upload).
5. Rig checklist: send file/PDF/video to a remote-workspace bot → agent reads
   them; previews render on desktop transcript + phone web replay (the original
   gate for the §5.11 image `dataBase64` decision, closed by R3 PASS 2026-10-04;
   alpha.7 rig B5 re-confirms previews after the strip lands); local regression
   pass.

### A3a. `/file` stops blocking the chat queue

**Behavior.**

1. `/file` keeps its FAST admission steps on the per-actor serialized inbound
   queue, in the existing order with the existing reply texts:
   `withAuthorizedContext` (incl. the disconnect/reconnect gate
   `blockDisconnectedRemoteWorkspace`), adapter `sendAttachment` capability
   check, empty-path check. After the gates it replies an immediate localized
   ack (`fileFetchStarted`, zh「正在获取并发送文件…」/ en "Fetching and sending
   the file…") and releases the queue; `deliverWorkspaceFile` + the result reply
   run in the background (fire-and-forget mirroring `sendPromptInBackground`).
2. Result replies reuse the exact existing `/file` copy/mapping (fileSent and
   every failure reason → localized text), sent via `sendOutbound` from the
   background task.
3. Invariants (restated under concurrency): admission gates are evaluated per
   call before the ack; `/file` never mutates task/context state; the WeChat
   inbound context-token merge (`persistWeixinContextToken`) stays on-queue (it
   precedes dispatch); background-leg errors NEVER throw into the polling loop —
   a catch-all sends a localized failure reply via `sendOutbound`.
4. Dedupe semantics (unchanged mechanism, documented): `markInboundDelivery`
   marks the provider message id before processing and the key is released only
   when `handleInboundMessage` throws synchronously or the reply send fails.
   Because the ack return is a successful completion, a later background failure
   cannot re-trigger duplicate processing (the key simply ages out of the TTL
   window).
5. Ordering caveat (accepted): the `/file` result may reorder relative to
   follow-up messages (e.g. a `/stop` acknowledgement arriving before the file
   result). Fast-failure replies remain synchronous and ordered.

**Acceptance scenarios.**

1. Services test (red first): with a deliberately deferred `sendAttachment`,
   `/file` acks immediately; a second inbound command (`/status`) AND a `/stop`
   complete while the delivery is still in flight; the final `fileSent` reply
   arrives only after the deferred resolves, with the existing copy. (Queue
   unblocking is command-agnostic — pinned via `/status` + `/stop`; the
   elicitation/permission-response variant rides the same serialization
   mechanism and is exercised on the rig.)
2. Services test: background failure (`not-found`) → localized `fileNotFound`
   reply via `sendOutbound`; no unhandled rejection (process-level
   `unhandledRejection` capture stays empty).
3. Rig checklist: slow remote `/file` + immediate `/stop` responds instantly;
   local `/file` regression (ack then result).

## Inbound attachment gates (3.14.5 Alpha 6)

Spec'd 2026-10-04 from ../ZCode-alpha6-plan.md Part 1 items 1-5 + Appendix B
(§5.1/§5.2/§5.15/§5.3/§5.4) and the ../ZCode-handoff.md §7.32 owner rulings
(single-check semantics; sniffing instead of hardcoded per-kind extensions).
Targets `3.14.5-alpha.6`. Red tests written first (`packages/services/test/
botInboundAttachments.test.ts`, `botFileDeliveryTelegram.test.ts`,
`botFileDeliveryFeishu.test.ts`); this section is the contract they pin.

### Behavior

1. **>4-attachment gate becomes visible (§5.1).** A message carrying more than
   `BOT_MAX_ATTACHMENTS_PER_MESSAGE` (4) attachments still processes exactly the
   first 4 (slice unchanged), but the silent drop dies. The user immediately
   receives a localized notice — new key `attachmentCountLimited` (zh
   「一条消息最多处理前 {max} 个附件，已跳过其余 {count} 个附件。」 / en
   "At most the first {max} attachments in a message are processed; the remaining
   {count} were skipped.") — as an immediate reply from the inbound handling,
   alongside (not instead of) normal message processing. The model-facing prompt
   gains one line stating that the message carried {total} attachments, only the
   first {max} were received, and the remaining {skipped} were skipped. Attachments
   beyond the first 4 are never resolved or downloaded (the slice runs before any
   per-attachment IO).
2. **Per-file oversize rejection with SINGLE-CHECK semantics (§5.2, §7.32).** One
   oversized file no longer rejects the whole message. Inside the per-attachment
   loop of `prepareBotMessageContent`, BEFORE resolution/download:
   - `sizeBytes` known AND over the 5MB cap → typed per-file reject WITHOUT
     downloading (all three providers already parse sizeBytes into
     `BotInboundAttachment.sizeBytes` on the message notification itself — zero
     extra requests);
   - `sizeBytes` known AND within the cap → download, cache, and NO post-download
     recheck — each file is size-checked exactly once, never before AND after;
   - `sizeBytes` absent → download and keep the existing post-download
     `byteLength` check as the per-file fallback.

   A rejected file produces (a) an individual localized chat reply naming the file
   — new key `attachmentTooLargeSkipped` (zh
   「附件 {filename} 超过 5MB 上限，已跳过。」 / en "Attachment {filename} exceeds
   the 5MB limit and was skipped.") — and (b) a prompt line naming the file and
   the 5MB limit. Sibling attachments
   and the message text proceed untouched. Whole-message rejection survives at
   exactly one edge: ALL attachments rejected AND no message text → reject the
   whole message (never create an empty task); the rejection reply names every
   rejected file individually, and ZERO cache files are written for that message.
   The brittle `/exceeds 5MB/i` error-prose regex coupling
   (`formatAttachmentRejectedReason`) dies with the typed per-file result.

3. **Extension-less attachment container sniffing (§5.15, §7.32: sniff, never
   hardcoded per-kind extensions; trigger widened 3.14.5 Alpha 8 per §7.33 — rig
   evidence 2026-10-05 §2i.1: weixin videos arrive under provider-given token
   names with NO extension, so the Alpha 6 fallback-only gate skipped them).**
   At cache time (`cacheResolvedAttachment`), when the attachment filename lacks
   an extension — ANY extension-less name, fallback-named (weixin's
   `weixin-attachment-N`) or provider-given (the image `.jpg` fallback stays
   as-is) — detect the container from the already-in-memory bytes'
   magic fingerprint (zero extra reads), then (a) append the correct extension to
   the cached filename and (b) correct the fallback mimeType to the real container
   type. New pure helper `sniffAttachmentContainer(data)` in packages/shared.
   Magic table:

   | container | fingerprint                                  | extension | mimeType           |
   | --------- | -------------------------------------------- | --------- | ------------------ |
   | mp4       | `ftyp` at offset 4, brand ≠ qt               | `.mp4`    | `video/mp4`        |
   | mov       | `ftyp` at offset 4, brand `qt  `             | `.mov`    | `video/quicktime`  |
   | webm      | EBML header (`1A 45 DF A3`) + DocType `webm` | `.webm`   | `video/webm`       |
   | mkv       | EBML header + DocType `matroska`             | `.mkv`    | `video/x-matroska` |
   | m4a       | `ftyp` at offset 4, brand `M4A `             | `.m4a`    | `audio/mp4`        |
   | mp3       | `ID3` at offset 0 or MPEG audio frame sync   | `.mp3`    | `audio/mpeg`       |
   | wav       | `RIFF` at offset 0 + `WAVE` at offset 8      | `.wav`    | `audio/wav`        |
   | ogg       | `OggS` at offset 0                           | `.ogg`    | `audio/ogg`        |

   Unknown fingerprint → keep the extension-less filename and the existing
   fallback mimeType (never worse than today).

   Alpha 8 amendments (§7.33 owner ratification):
   - Safety is content-positive-only: an extension is appended ONLY on an exact
     magic-signature match at fixed offsets (the table above); names are never
     pattern-guessed.
   - Amended ruling: provider-given filenames WITH an extension are never
     rewritten; extension-less names get a content-verified extension only when
     the bytes positively match a known container (the Alpha 6 fallback-only
     trigger protected garbage token names — retired).
   - `filenameIsFallback` retires (its only consumer was the old fallback-only
     gate).
   - Residuals (accepted): (i) a text file whose bytes literally begin with
     ID3/OggS/RIFF/ftyp signatures gains a media extension — near-impossible for
     real documents (§7.32 lineage, accepted); (ii) names carrying ANY dot (e.g.
     the once-observed weixin CDN token suffixed `.image`) are left untouched by
     the `extname===""` gate — revisit only if suffixed video tokens are ever
     observed.

4. **Attachment cache lazy prune — NO daemon (§5.3).** The
   `~/.zcode/v2/bot-attachments` cache previously only ever grew. Alpha 6 bounds
   it: one in-memory 24h gate; the prune piggybacks on
   `cacheResolvedAttachment` (fire-and-forget, NOT awaited — inbound latency must
   never wait on cleanup) and also runs one pass at service start. Each pass
   deletes files with mtime older than 7 days anywhere under the bot-attachments
   root and removes directories left empty by the deletion. Errors warn+swallow
   (a failed prune must never fail the message). Goal is bounded growth, not
   strict lifespan: replaying an old session may honestly find attachment files
   gone (accepted trade-off; surfaced as missing files, never fabricated).
5. **Telegram + Feishu read-side ≤5MB re-check (§5.4; amends Phase C Alpha 5
   items 4-5 above).** Both adapters' `sendAttachment` read the file with a bare
   `readFile` right before upload while the weixin adapter re-checks the cap at
   the same point (`uploadAndSendWeixinAttachment`). Parity fix: after reading,
   both adapters reject when the byte length is over the 5MB cap with an error
   naming the limit (weixin's `${filename} exceeds 5MB.` wording is the
   precedent), BEFORE any upload request; the failure surfaces through today's
   send-failed detail path.
6. **Feishu inbound resource download `type` (3.14.5 Alpha 8 fix).** Feishu
   inbound audio/video resources are fetched with `type=file` per Feishu's
   message-resources API (`GET /im/v1/messages/{message_id}/resources/{file_key}`
   accepts only `image|file`; `file` covers file/audio/video) — the Alpha ≤7
   `type=audio`/`type=media` requests were contract-invalid and failed 100% of
   audio/video downloads. Image keeps `type=image`. Audio UNDERSTANDING
   (transcription) remains unsupported (owner ruling, issue #21). Download
   failures log HTTP status + `x-tt-log-id` (warn) for diagnosis.

### Invariants

- Single-check: a file whose `sizeBytes` metadata is present is size-adjudicated
  exactly once — metadata is authoritative when known; the post-download
  `byteLength` check runs ONLY when metadata is absent. No before-AND-after
  double check (§7.32 owner ruling).
- Per-file gates never widen exposure: a rejected attachment is never downloaded,
  never cached, never attached; skipped (>4) attachments are never downloaded.
- Whole-message rejection happens only when every attachment is rejected AND the
  message has no text; in that case zero cache files are written and no task or
  prompt is created (never an empty task).
- Provider-supplied filenames WITH AN EXTENSION are never rewritten by sniffing;
  sniffing applies to extension-less names of ANY origin (Alpha 8 widening, §7.33;
  was: fallback names only); the image `.jpg` fallback behavior is
  unchanged (verified behavior, kept).
- The prune is best-effort background hygiene: no timers, no daemon process, no
  awaited IO on the inbound path; the deletion set is mtime > 7 days under
  bot-attachments only (never other config data).
- The outbound read-side re-check adds error copy only; upload/send sequencing is
  unchanged.

### Acceptance scenarios

Red-first (each fails on `3.14.5-alpha.5` for the stated reason; all in
packages/services/test):

1. R1 `botInboundAttachments.test.ts` — message with 6 provider-file attachments +
   text: immediate `attachmentCountLimited` localized reply (today: no reply);
   `downloadAttachment` invoked exactly 4 times (extras never resolved); prompt
   attachments = the first 4; prompt line mentions the skipped attachments
   (today: silent).
2. R2 oversize+valid mix + text: (a) metadata path — oversize via known sizeBytes
   (6MB) with small adapter-returned bytes + one valid attachment: prompt carries
   ONLY the valid attachment and an individual `attachmentTooLargeSkipped` reply
   names the file (today: the metadata is ignored, the oversize file is cached and
   attached); (b) fallback path — oversize via >5MB inline bytes with no sizeBytes
   - one valid attachment: the valid attachment still reaches `sendPrompt` with an
     individual reject notice (today: whole message throws, nothing reaches the
     prompt).
3. R3 all-rejected + no text: whole-message rejection reply names EVERY rejected
   file individually; `sendPrompt` never called (today: only the first throwing
   file is named).
4. R4 all-rejected ⇒ ZERO cache files under bot-attachments (today: the
   metadata-oversize sibling is cached before the byteLength-oversize file
   throws — partial cache writes happen).
5. R5 metadata-known pre-download reject: attachment with sizeBytes > 5MB → the
   provider `downloadAttachment` path is never invoked and the reject notice is
   immediate (today: it downloads).
6. R6 prune: pre-aged files (mtime 8 days) + a fresh file under the harness
   bot-attachments root; trigger one inbound attachment message (the
   cacheResolvedAttachment piggyback seam — the harness disables startup
   background tasks); aged files deleted, emptied dirs removed, fresh kept
   (today: nothing is ever deleted).
7. R7 `botFileDeliveryTelegram.test.ts` + `botFileDeliveryFeishu.test.ts` —
   `sendAttachment` with a >5MB local file throws an error naming the 5MB limit
   before any upload request (today: no throw, the oversized file is uploaded).
8. R8 sniffing: unnamed weixin-kind attachment with mp4 bytes (ftyp + non-qt
   brand) → cached filename ends `.mp4`, mimeType `video/mp4`; mov bytes (qt
   brand) → `.mov` + `video/quicktime`; EBML/webm bytes → `.webm`; RIFF/WAVE
   bytes → `.wav`; garbage bytes → filename stays extension-less (today: all stay
   extension-less).
9. Regression: the existing inbound attachment suite (A1/A3a) and the outbound
   zero-drift fixtures stay green.

## Outbound attachment naming & inline kinds (3.14.5 Alpha 7)

Spec'd 2026-10-05 from ../ZCode-alpha6-plan.md Part 1 items 7-8 + Appendix C (§5.6/§5.7)
and ../ZCode-handoff.md §2h finding ② (CJK basename wiped at the remote staging site:
`程曦简历.pdf` landed as `01-.pdf`). Red tests written first; targets `3.14.5-alpha.7`.
Log-hygiene items of the same alpha (§5.12a dead-window throttling, §5.14 pending gauges)
live in specs/log-diagnostics-hygiene.md.

### Behavior

1. **One shared byte-budget filename helper (§5.6).** A single pure helper in
   packages/shared (no IO, no clocks) turns a raw filename into a safe filename under a
   UTF-8 BYTE budget. Contract:
   - **Unicode basenames are PRESERVED.** Control characters and path separators are
     neutralized (as today), but there is NO ASCII-only stripping — `程曦简历.pdf` keeps
     its CJK basename end-to-end. The desktop staging site's `[^A-Za-z0-9._-]+ → "-"`
     sanitizer (which deleted the entire CJK basename) dies with this alpha.
   - **Truncation is by UTF-8 bytes, never by chars and never mid-codepoint.** The
     extension survives truncation: the stem is truncated within
     (budget − extension bytes); the output never exceeds the budget in bytes, never
     splits a multi-byte codepoint, and never garbles the basename. (Today the cache
     site slices 120 CHARS — a 125-CJK-char name keeps 120 CJK chars = 360 bytes and
     loses its extension entirely.)
   - **Windows reserved names are neutralized, including with-extension forms:**
     CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9 (`CON.txt`, `com1.tar.gz`, …). The
     helper's output basename is never a reserved name (a neutralization marker such as
     a leading `_` is acceptable; uniqueness prefixes below are NOT relied upon for
     this).
   - **Uniqueness prefixes keep working unchanged:** the inbound-cache digest prefix
     (`<16hex>-`) and the remote-staging index prefix (`01-`, `02-`, …) are applied by
     the call sites outside the budgeted segment; truncation cannot cause practical
     collisions.
   - Per-site byte budgets, preserved from current behavior (char limits → byte
     equivalents):

     | site                                                                                                        | sanitized segment | budget    |
     | ----------------------------------------------------------------------------------------------------------- | ----------------- | --------- |
     | botsService inbound cache filename (today `sanitizeAttachmentFilename`, `slice(0,120)` chars)               | filename          | 120 bytes |
     | botsService outbound temp materialization (remote fetch → `os.tmpdir()/zcode-bot-outbound/<random>/<name>`) | filename          | 120 bytes |
     | desktop `remotePromptAttachments` staging path                                                              | trace segment     | 80 bytes  |
     | desktop `remotePromptAttachments` staging path                                                              | nonce segment     | 64 bytes  |
     | desktop `remotePromptAttachments` staging path                                                              | filename segment  | 160 bytes |

   The helper's only consumers are the three sites (botsService cache path, botsService
   outbound temp file, desktop remote staging segments) — verified with `pnpm dep:refs`
   when the implementation lands.

2. **Inline image kinds widen (§5.7).** `OUTBOUND_IMAGE_EXTENSIONS`
   (`inferOutboundAttachmentKind`, botsService) gains `.heic/.heif/.tiff/.avif`; the
   weixin inbound infer regex in weixinProvider (which already contains `heic`) gains
   `heif/tiff/avif`, so attachments of those kinds classify as `image` (inline) instead
   of `file`. **Fallback clause:** weixin inline rendering of tiff/avif is unverified on
   the rig — tester table B3 checks it; if rendering proves broken there, those
   extensions fall back to file-kind delivery on the weixin side only (documented,
   no hard-fail; heic/heif stay).

### Invariants

- The helper is pure and lives once in packages/shared; no site keeps a private
  sanitizer (the desktop `sanitizePathSegment` ASCII-strip and the botsService
  char-slice are replaced, not supplemented).
- Provider-supplied filenames WITH AN EXTENSION are never rewritten by sniffing
  (Alpha 6 rule as amended by Alpha 8/§7.33: extension-less names get a
  content-verified extension only when the bytes positively match a known
  container) — the helper only sanitizes/truncates/budgets; it never invents
  extensions.
- The remote staging path structure (`<root>/<trace>/<nonce>/<index>-<filename>`) and
  its privacy hardening (chmod 700/600, private root) are unchanged; only the segment
  sanitizers change.
- Zero drift: for ASCII filenames already within budget, every affected output (cache
  paths, temp paths, staging paths, audit lines, reply texts) is byte-identical to
  3.14.5-alpha.6. **Disclosed micro-drift ([ulw] NIT-5，接受）**：desktop staging
  旧消毒的 ASCII 连字符折叠（`a--b`→`a-b`）与前导横线剥离随 ASCII-strip 一并
  消亡（安全字符原样保留）；`:` 的替换字符由 `-` 改为 `_`；空 nonce 兜底名
  `attachment`→`nonce`。三者在真实 UUID trace/nonce 下不可达。
- Reserved-name neutralization is a property of the helper output itself, not of call
  sites' prefixes (the inbound-cache file segment is incidentally reserved-safe via its
  digest prefix today; the outbound temp file is NOT — a remote `CON.txt` currently
  materializes as a literally invalid Windows temp name). **纯点号输出（`.`/`..`/
  `…`）同样在 helper 内兜底替换**（[ulw] MINOR-1：无前缀段经 join() 会折叠成
  父目录）。

### Acceptance scenarios (red-first on 3.14.5-alpha.6)

1. §5.6 services (`botInboundAttachments.test.ts`): inbound attachment with a
   > 120-char CJK filename → the cached filename segment is ≤120 UTF-8 bytes, extension
   > preserved, basename not garbled (today: 120 CJK chars = 360 bytes survive the
   > char-slice and the extension is sliced off).
2. §5.6 desktop (`remotePromptAttachments.test.ts`): staging `程曦简历.pdf` keeps the
   CJK basename in the remote path (today: collapses to `01-.pdf`).
3. §5.6 services (`botFileDelivery.test.ts`): a remote file named `CON.txt`
   materializes to a NON-reserved temp basename (today: the temp file is literally
   `CON.txt` — invalid on Windows).
4. §5.7 services: `inferOutboundAttachmentKind` routes `.heic/.heif/.tiff/.avif` to
   image (today: file).
5. §5.7 weixin (`botFileDelivery.test.ts`, via exported `getWeixinUpdates` with a fake
   requester): a file_item named `photo.heif` / `.tiff` / `.avif` parses as kind image
   (today: file; `heic` already passes).
6. §5.8 services (`botFileDelivery.test.ts`): the audit success line for a tool
   delivery whose filename equals its `path=` carries `path=` only — `file=` appears
   only when the two differ (today: both always printed).
