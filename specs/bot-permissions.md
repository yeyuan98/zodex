# Spec: Bot Permission Parity (3.15.0 Track B)

Status: **alpha.1 SHIPPED（PR #30，release `7d11594`，tag `v3.15.0-alpha.1`，
2026-10-06；6 release jobs 绿、43 资产核验、单通道不变量成立；[ulw] 评审
READY-WITH-NITS 收口——4 NIT，3 折叠于 `21a269e`，transient 卡片自答 finalize
文案按评审携带为设计；验证全绿：services 351/351、shared 68/68、CLI bootstrap
32/32、server 10/10、root E2E 10/10、typecheck/lint/fmt/pre-push/architecture
0 违规；11 条红测 assertion 失败实证后全部转绿）——**rig C0-C6 全 PASS
（owner 陈述 2026-10-07，handoff §8.1 分级；含 C5 remote 门控写腿——
alpha.0 从未测项）→ alpha.1 里程碑关闭。**alpha.2 收尾批次 SHIPPED（PR #34，
release `08089d7`，tag `v3.15.0-alpha.2`，2026-10-07；R1 MCP 草稿失效平权 +
R2 bot-file-delivery §5.9 安全节修订 + R3 /help 三注记；新 spec
`draft-session-invalidation.md`；[ulw] 一轮收口）——rig D0-D3 收口（2026-10-07，
bundle zcode-logs-20261007-141821，分级记录见该 spec §7：D0/D2/D3 log-evidenced
PASS；D1 行为 PASS + host 侧佐证；附带登记：无模型草稿 /mode 回复 "Mode option
not found." 选模型后恢复，owner 裁定非阻塞）→ official 3.15.0 切版（owner
裁定 2026-10-07）。修订
= 本文 §8（F1 host 收口去重 / F2 deadline 冻结+持久化 / F3 自答 ack 单确认 /
F4 mode 选项源），验收场景 §7.16-§7.22。alpha.0 已发版
（PR #28，release `5c20edf`，2026-10-06）；rig 2026-10-06 晚（bundle
zcode-logs-20261006-221723，postmortem = handoff `../ZCode-handoff.md` §2k）
判定：本地权限问答核心链路可用，但四类缺陷证据锁定（D1 双通道重复提示、
D4 双确认消息、D3 deadline 源失步的虚假「已自动拒绝」文案、RC1 `/mode`
选项源为空——后者非 remote 专属；remote 门控写腿从未被测）。alpha.1 修订
= 本文 §8（F1 host 收口去重 / F2 deadline 冻结+持久化 / F3 自答 ack 单确认 /
F4 mode 选项源），验收场景 §7.16-§7.22 红测先行。此前记录——SPEC-FIRST
（2026-10-06）：owner rulings 已取得：D1 = Option A′
（扩展 CLI 既有交互登记表的自动结束机械，经 v4 createSession 增量字段携带 per-bot
deadline）；D2 = 在 Manage bot 表单（Mobile remote control → Manage bot，
BotsDialog）新增「权限超时（分钟）」数字字段（默认 10，最小 1）；D3 = 由证据
解决（解锁既有通用机械即得桌面平权——桌面模式选择本属下一次提交，运行中任务
保持其模式；bot 的 mode.list/set 在任务运行时同样拒绝）。本 spec 随
3.15.0-alpha.0 原子单元实现——解锁、迁移、无应答策略、提示退休、/status 模式行
五者永不拆开发版。**

Owners: bots 服务（`packages/services/src/bots/botsService.ts`）——解锁/迁移/
提醒与拒绝文案/`permission_response` 清理/`/status`；CLI v4 交互登记表
（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/interaction-registry.ts`

- `zcode-protocol/interaction-broker.ts`）——权限自动拒绝的倒计时与应答；
  `packages/shared`（`zcode-protocol-v4/command.ts` createSession payload）——
  deadline 增量字段；桌面 UI（`packages/ui/src/BotsDialog.tsx`）——超时字段。
  Related: `bot-inbound-resilience.md`（B2.3 休眠分支 = 同一 respondPermission
  seam 的发送失败触发器）、`bot-message-delivery.md`（保留面——本文新增的消息
  类别为非保留）、`off-peak-local-admission.md`（auto-deny 先例语义）。

## 0. 语义总览（plain）

Bot 会话与桌面会话共用**同一权限模型**。解锁后 bot 默认 `build`（变更前询问）；
用户经 `/mode` 切换（含 yolo——用户显式选择的全自动）。`/mode` 语义与桌面一致：
模式属于下一次提交——运行中任务保持其模式；任务运行时 `/mode` 回复
`taskRunning`（既有拒绝，与 thoughtLevel 相同）。Bot 权限提示在聊天内即时可见
（无隐藏宽限），若 deadline（per-bot，默认 10 分钟）内无人应答，系统代答
**deny**（拒绝可恢复且可见；永不自动放行——off-peak 判例）。deny 后 agent 带
拒绝继续（改道或以拒绝结果收尾），其后续回复走既有出站管线（含 channel-dead
保留/revival 机械，不在本 spec 范围）。

## 1. 解锁（unlock）

1. 删除 `BOT_FORCED_MODE` 常量与三处强制（draft 初始化 `buildInitializedDraftOptions`、
   任务继承 `buildActiveTaskDraftOptions`、建任务咽喉 `applyDraftConfigOptions`），
   以及 `mode.list`/`mode.set` 的两处 `modeLocked` 短路与 `messages.ts` 的
   `modeLocked` zh/en key（删除前 `pnpm dep:refs` 验证无其他引用）。
2. Draft 初始化改为读取 bot 配置模式：`currentOptions.mode`（读取时默认
   `"build"`，不落盘回写）；任务继承路径改用既有 `readCurrentActiveTaskMode`
   （读 active task 实际模式，替代强制值）。`applyDraftConfigOptions` 将
   draft 的 mode 经 `resolveSupportedDraftMode`（provider 不支持则跳过，既有
   分支）下发给 `setMode`——`setMode` 保持「mode 进入 agent session」的唯一
   建任务咽喉（与 `setConfigOption`→`switchCollaborationMode` 的既有任务路径
   并存：两扇前门、一个后端，均为用户驱动的 host→CLI 命令）。
3. `botsService.ts:2006-2008` 的 force-yolo 出站防泄露边界注释随解锁改写
   （泄露边界不再依赖「权限提示结构性缺席」）。
4. **安全不变量**：AI 不能自行切换自身模式——两个 mode 入口（`setMode`、
   `setConfigOption`/`switchCollaborationMode`）均只从用户授权的命令处理与
   建任务咽喉可达；agent 无调用任一入口的工具（`EnterPlanMode`/`ExitPlanMode`
   只写 `planEnabled`，后者用户门控——guard 测试明确此边界，不扩大解释为
   「agent 不可写任何执行状态」）。
5. **已知残留（披露，不修）**：weixin 桥无自身消息回环过滤且 `findBoundUser`
   接受任意 weixin actor——若桥将来把 bot 自己的出站回投为入站，agent 文本
   中的 `/mode yolo` 理论上可被当作授权命令执行。rig 从未观测到；记录为
   residual + rig 观察项（B8）；无证据不修（§8.5）。

## 2. 迁移（migration）

1. Actor-context 状态文件（`bot-state.v3.json`）**版本 3 → 4**：加载时一次性
   迁移——每个 context 的 `draftOptions.mode === "yolo"` → `"build"`；幂等；
   cursor/token 等字段按 `writeContext` 既有单写者规则原样保留（M5 先例）。
   v2→v3 legacy 导入（`importLegacyBotState`）路径同步应用同一 flip（迟来的
   旧版本导入不得重新引入 yolo）。无 `draftOptions` 的 context 跳过（解锁后
   `ensureDraftOptions` 首次写入读取时默认 build）。
2. Bot 配置存储（`bot-config.v3.json`）**不改版本**：`currentOptions.mode`
   读取时默认 `"build"`（缺省即 build；不落盘重写，避免写回抖动）。
3. 无聊天通知、无版本分支业务代码（§7.1）；升级时正在运行的任务保持其已应用
   的模式（迁移只改存储的 draft，不触碰运行中 session）。
4. 降级安全：旧版本无条件强制 yolo，与该字段值无关——回滚无需反向迁移。

## 3. 无应答策略（no-answer policy；D1 = A′）

### 3a. 配置与传递

1. Bot 配置新增 `currentOptions.permissionTimeoutMinutes: number`（默认 10，
   最小 1；D2：BotsDialog「权限超时（分钟）」数字字段，zh/en label + 校验）。
2. Bots 建任务时经 `createTask` 参数携带 `permissionAutoDenyMs`（分钟×60000），
   经 adapter v4 分支落入 `createSession` payload 顶层（与 `offPeakToolEnabled`
   同模式的 additive 字段；v4 payload 为非 strict z.object——旧 CLI 静默丢弃该
   键 = 优雅降级为「无 deadline，提示照旧等待」，不产生错误）。**ZCode-Agent
   provider 的 bot 任务一律携带**（未配置时按读取时默认 10 分钟——与 D2 的
   「默认 10」一致；实现注记 2026-10-06：澄清初版「bot 未配置不携带」的歧义
   措辞）；非 bot 任务与非 ZCode-Agent provider 不携带（桌面会话行为逐字节
   不变）。
3. CLI session record 保存该值；broker 注册权限交互时，若所属 session 携带
   deadline，登记表为该条目启用倒计时。

### 3b. 登记表扩展（`V4InteractionRegistry`）

1. 注册选项扩展 per-entry `autoResolutionMs`（本次权限 deadline）与
   kind `"permission"` 语义：**注册即武装倒计时**（不排队头——权限各自阻塞
   各自的工具调用，不是 UX 队列；askUserQuestion 的 head-only 语义不变）；
   **无 hiddenGrace**（提示即时可见——与 askUserQuestion 的 60s 隐藏宽限明确
   不同）；不可 snooze（`snoozeAutoResolution` 对非 askUserQuestion kind 已
   返回 false，维持）。
2. 到期 resolve 应答为**无 optionId 的 deny-shaped 应答**——落入
   `v4AnswerToPermissionResponse` 既有 deny 兜底（`buildPermissionDeniedContent`），
   与用户 deny 同构；`preserveReasonFormatting` 不触发（无 freeText）。
3. 任何真实应答（聊天按钮/文本命令、桌面 UI、手机远控、`resolveFullAccess`）
   先到先得，注销登记并清除 timer（既有 `resolve`/`remove` 机械；迟到应答
   `proto.alreadyResolved` 幂等）。
4. **倒计时持久化**：与 askUserQuestion 相同的 `onAutoResolutionUpdated` →
   session-entry 持久化接线扩展到 permission kind（重启后 reannounce 以
   `previous?.autoResolution` 恢复同一 deadlineAt，**不重置时钟**；已到期则
   恢复时立即 resolve deny——复用 `resumeAutoResolution` 的 overdue 分支）。
   `startedAt/deadlineAt` 时钟域为 CLI 本地时钟（与 askUserQuestion 现状一致）。
5. `setAskUserQuestionAutoResolutionEnabled` 的全局 gate **只作用于
   askUserQuestion kind**（现状维持）——bot 权限 deadline 独立于桌面
   askUserQuestion 自动解决设置（ruling 要求）。

### 3c. Bot 侧提醒与文案（非权威、非保留）

1. Bot 侧为每个 pending permission 武装**两个轻量策略 timer**（bots 服务内，
   `botId+peerKey+requestId` 寻址；本 spec 显式声明为「无新 timer」交付管线
   不变量的受控例外——策略 timer，非 flush/retention 机械）：
   - **reminder**：deadline − 2 分钟发送一次本地化提醒（deadline ≤ 5 分钟时
     不发）；仅提醒，无任何应答权威。
   - **deny-note**：deadline 时刻发送「权限超时未应答，已自动拒绝」本地化
     文案。**与 CLI 倒计时不构成双权威**：deny 的权威唯一在登记表；本 timer
     只负责聊天可见性。若 `permission_response`（CLI deny 已生效）或任何真实
     应答先到 → 两个 timer 一并清除（先答后不发、不发误导性文案）。
2. 三个新消息类别——reminder、deny-note、迟到点击反馈（「已自动拒绝/已被
   处理」）——均为 **best-effort、非保留**：经 `sendOutbound` 直发，失败即
   诚实丢弃，**不进入 channel-dead 保留缓冲**（amendment 落于
   bot-message-delivery.md 保留面小节；与 §7.23 命令回复不保留同一 rationale：
   即时性消息，延迟到达令人困惑；agent 的后续正文已承载拒绝后果）。
   事件驱动的超时文案选择规则（[ulw] 评审 R1-2）：`permission_response` 处理时
   若 decision=deny 且该 requestId 的 bot 侧武装 deadline 已过（登记表内存查询），
   注记文案用 `permissionAutoDenied`（超时/自动拒绝）而非通用 `permissionResolved`
   ——CLI 自动拒绝事件常先于 bot 侧 deny-note timer 触发，规则保证该竞态窗口内
   「拒绝可见」不降级为通用文案；standalone deny-note timer 保持为无事件到达时的
   兜底。
3. Timer 生命周期表（每个事件 → 清除/重设/触发）：

   | 事件                                                   | reminder/deny-note timer | 说明                                                                                                                                                                              |
   | ------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `permission_response`（任何客户端应答或 CLI 自动拒绝） | 清除                     | 权威已收口                                                                                                                                                                        |
   | `task_complete` / `task_error` / `/stop` drain         | 清除 + pending 清空      | 终态                                                                                                                                                                              |
   | stale-watcher 清理（终态事件丢失）                     | 清除（**无** note）      | 不发迟到幽灵文案；CLI 倒计时自行收口                                                                                                                                              |
   | bot 禁用/删除                                          | 清除（note 抑制）        | 不向已禁用 bot 的频道发送                                                                                                                                                         |
   | 服务 dispose                                           | best-effort 清除         | 静默丢失接受（与保留缓冲同规）                                                                                                                                                    |
   | 服务启动扫描                                           | 清除过期项               | 见 3d                                                                                                                                                                             |
   | deadline 配置中途变更                                  | 无效（不重设）           | 本次 pending 的 deadline 已定；alpha.1（§8 F2）把「已定」落为持久事实——deadline 冻结值随建任务持久化于 bot context，渲染/武装只读该值，配置变更对本次任务不可见（下一个任务生效） |
   | 同 requestId 再提示                                    | 不重设                   | 时钟权威在登记表（3b.4）                                                                                                                                                          |

### 3d. 重启对账

1. CLI 侧：reannounce 恢复（3b.4）。
2. Bot 侧（实现注记 2026-10-06——启动扫描降级为惰性清理，如实记录）：bot 侧
   timer 为纯内存态（重启无武装 timer，§3c 表「服务启动扫描」行平凡满足）；
   持久化 context 中的 pendingPermissionOptions 不做启动扫描，改**惰性清理**：
   下一个 `permission_response`/终态/`/new`/下一次提示覆盖时经
   `clearPendingPermissionOptions` 收口；迟到 `/approve`//`/deny` 走
   already-resolved 反馈。陈旧 pending 记录在无任何事件时静默留存（无渲染面，
   无行为影响——授权清理路径均已覆盖）。若 CLI 为旧版本无倒计时（降级窗口），
   提示在旧 CLI 侧等待，用户仍可应答（first-wins）——deny-note 不补发（避免
   误导），披露为降级残留。未到期条目不重设 bot 侧 timer（reminder 丢失
   接受——纯装饰性）；CLI 侧倒计时继续（权威）。

### 3e. 边界

1. **AskUserQuestion / elicitation 不变**（本 alpha）：deadline 机制只作用于
   permission kind；问题类交互保持现状（含桌面 askUserQuestion 自动解决
   设置的既有语义）。guard 测试钉住。
2. 桌面（非 bot）会话不受影响：不带 deadline 字段 = 登记表行为逐字节不变。
3. 旧 CLI 降级 = 无倒计时（3a.2），提示照旧等待——不因解锁而恶化（解锁前
   权限事件本不存在）。
4. **残留（[ulw] 评审 R1 披露，接受不修）——远端旧 CLI 混版窗口**：远端
   workspace 的旧 CLI 会剥离 v4 createSession 的 deadline 字段，该窗口内 CLI
   倒计时缺席而 bot 侧 deny-note timer 照发其文案（文案非权威，仅聊天可见性，
   实际无自动拒绝发生）；first-wins 仍允许用户照常应答；窗口随远端重连
   （bundle 自动升级）关闭。bot 侧武装不以「CLI 已确认收到 deadline」为前置
   （无 delivery acknowledgement 门控）——接受为降级残留。

## 4. 提示退休与清理（retirement）

1. watcher 新增 `permission_response` 事件处理（镜像 `elicitation_response`）：
   清除 `pendingPermissionOptions`（仅该 requestId 相关；实现为整体清空或按
   requestId 过滤，以实现为准并在测试钉住）+ `broadcastTaskListChange`
   （`permission_resolved`）+ 退休聊天侧提示 UX：Telegram 键盘编辑、Feishu
   卡片更新（含 transient interaction card 的 finalize-on-resolution——补上
   现缺的第三处 finalize，且仅在该卡片仍属于本 requestId 时执行，防止终结
   展示中较新交互的卡片）、WeChat 文本注记。文本 `/approve`//`/deny` 路径的
   陈旧 pending 记录（`handledAt` 缺失的 orphan）随 `permission_response`
   一并清扫。
   - **本 alpha 退休实现披露**：Telegram 侧退休以本地化文本注记交付（与
     WeChat 同形）；Telegram 键盘编辑（inline keyboard 移除按钮）推迟到
     polish 阶段，不阻塞 3.15.0-alpha.0。
   - **迟到用户 deny 的接受边界**：deadline 之后到达的用户 deny
     （`permission_response` decision=deny）同样显示超时文案（§3c.2 选择
     规则的推论——超时事实先于用户意图，文案以先发生的权威为准）。
2. 终态事件（`task_complete`/`task_error`）与 `/stop` drain 清空
   `pendingPermissionOptions`（补齐现缺；`writeDraftContext` 的 `/new` 清空
   为既有先例）。
3. 自动拒绝后迟到点击：first-wins 吞并（index 路径 `handledAt`；文本路径
   `respondPermission` 返回已收口语义）+ 本地化「已被处理/已自动拒绝」反馈。
4. 权限提示**不进入**保留缓冲；提示发送失败的 stop-deny 语义（B2.3）不变
   （触发器不同：发送失败 = stop + deny；到期 = deny-only，agent 继续）。

## 5. `/status` 模式行

`buildStatusText` 增加 mode 行（draft 显示 draftOptions.mode；active task 显示
其实际模式；缺失显示「未设置/not set」——`formatStatusModelLabel` 同款 fallback
形态）。zh/en keys（`statusMode` 等）。

## 6. 不变量（Invariants）

- **原子性**：解锁永不脱离无应答策略单独存在（红测联动：策略测试在仅解锁的
  树上必红）；单一 PR 发版（较 §6 的紧栈许可更严——拆分即部分发货向量）。
- mode 进入 agent session 仅经两扇用户驱动的 host→CLI 前门（`setMode` 建任务
  咽喉、`setConfigOption` 既有任务路径）；agent 无自调用路径。
- v4 createSession payload 增量字段保持非 strict 语义（不引入 strict-reject
  向量）；`zcode-protocol/index.ts` 的 v3 strict schema 不动（deadline 只走
  v4；bot 任务 `v4Create: true`）。
- 登记表 askUserQuestion 语义（hiddenGrace、head-only、snooze、全局 gate）
  逐字节不变；permission 扩展不回写任何 askUserQuestion 行为。
- 桌面（非 bot）会话行为不变（无 deadline 字段 = 无倒计时）。
- 新消息类别（reminder/deny-note/迟到反馈）非保留；出站管线其余语义不变。
- 服务端 bundle E2E 保持绿；`packages/services` 浏览器入口纯净性（esbuild
  检查）在触及 `index.ts`/`bots/contract.ts` 时必须通过。

## 7. 验收场景（红测先行；W1 提交全套，随各 worker 转绿）

1. 无配置模式的 bot：draft 初始化 mode=`build`（红：今 yolo）；建任务
   `setMode("build")`（红：今 `"yolo"`）。
2. `currentOptions.mode:"plan"` 的 bot：draft 继承 plan；`setMode("plan")`。
3. 迁移：v3 状态文件（yolo draft + cursor/token 字段）→ 加载后 v4 + mode
   `build` + cursor/token 原样；幂等；legacy 导入路径同 flip；无 draftOptions
   跳过。降级：v4 文件被旧版本读取时按未知版本处理不崩溃（旧版本行为由
   其自身强制逻辑覆盖，不测旧代码）。
4. 登记表：permission kind + deadline 注册 → 到期 resolve 无 optionId 应答
   （deny-shaped）→ `v4AnswerToPermissionResponse` 落 deny 兜底；真实应答
   先到 → timer 清除、无二次 resolve；无 hiddenGrace（注册即 visible
   countdown 状态）；不可 snooze。
5. 重启恢复：reannounce 携带 `previous.autoResolution` → 同一 deadlineAt
   恢复（不重置）；恢复时已过期 → 立即 resolve deny。
6. createSession payload：携带 `permissionAutoDenyMs` 可解析（红：今被
   strip）；不携带时行为不变；旧形状（无该键）照常解析。
7. `permission_response`：清除 pending + 退休提示（per-provider 矩阵）+ 清扫
   文本路径 orphan。
8. 终态/`/stop`/stale 清理：pending 清空、timer 清除、transient 卡片
   finalize；stale 清理**不发** note。
9. 提醒：deadline 10min → 恰一次 T-2min 提醒；deadline 1min → 无提醒。
10. 非保留：reminder/deny-note/迟到反馈发送失败 ⇒ 保留缓冲零新增条目。
11. 边界 guard：permission deadline 不触碰 pending user input（问题类行为
    不变）；askUserQuestion 全局 gate 关闭不影响 permission 倒计时。
12. `/status`：draft/active/未设置三形态 mode 行 + zh/en。
13. 迟到点击：自动拒绝后按钮/文本点击 ⇒ 吞并 + 反馈文案。
14. 回归：yolo 配置 bot 派发 yolo、零权限提示（guard，解锁后仍绿）。
15. bot 禁用后到期：note 抑制、登记表 deny 照常。
16. （alpha.1 F1）双通道收口：同一 requestId 经会话事件通道（A）与反向 RPC 通道
    （B）先后到达 ⇒ 全链路（host+adapter）恰广播一次 `permission_request` 流事件
    （红：今两条各广播一次 = Telegram 双卡/E9 僵尸卡根因）。
17. （alpha.1 F1）host 标记陷阱 guard：AskUserQuestion/ExitPlanMode 等待态标记
    （user-input-backed 工具名）不入 `pendingPermissions` 登记表（pending 仪表
    不受污染）；`"unknown"` requestId 永不去重（两条 distinct unknown-id 提示都
    必须广播）。
18. （alpha.1 F1）watcher 有界 seen-map 防御：同 requestId 重复事件只渲染一次；
    并发 A/B 时 A 的重复不得覆盖 B 的 pending；空 map 时首提示必须渲染（安全网
    不得掩盖 host 回归）。
19. （alpha.1 F2）deadline 冻结持久化：建任务后配置中途调低 ⇒ 已武装 timer 与
    后续提示的武装仍按建任务时的冻结值（E7 红）；重启后按持久值重武装（不读活
    配置）；无持久值（miss）⇒ deny-note 不武装（绝不活配置重武装）。
20. （alpha.1 F2）CLI resume 缺口：重建 session record 携带 `permissionAutoDenyMs`
    （持久化 session entry 同款机械；红：今 resume 后 deadline 丢失，新提示无
    权威倒计时）。
21. （alpha.1 F3）单确认：聊天自答（按钮+文本路径）恰一条消息 = 命令 ack，
    `permissionResolved` note 被抑制（红：今按钮路径双消息）；跨端/桌面应答 ⇒
    note 照发（guard）；CLI 自动拒绝 ⇒ `permissionAutoDenied` 超时文案（§3c.2
    既有规则不变）；迟到点击反馈不变（§7.13 guard）。
22. （alpha.1 F4）`/mode` 选项源：draft 路径合成 mode select（源自
    `getZCodeAgentAvailableModes`，当前值读取时默认 `build`；红：今
    `listDraftConfigOptions` 只合成 thought_level）；active-task 路径列表+设置
    往返均用 `active.configOptions`（红：今走 `listUserConfigOptions` 死 stub 恒
    空）；taskRunning 拒绝不变；无模型 draft 仍不列选项（modeMissing 边界
    pin，与 thoughtLevel 平权）。

## 8. alpha.1 修订（rig-221723）

> 证据与计划：`../ZCode-trackb-alpha1-plan.md`（[ulw] 评审 v2 收口）+
> handoff §2k postmortem（bundle zcode-logs-20261006-221723）。四项修订
> （F1–F4）不改变 §0-§7 既有语义，只收口缺陷；冲突处以本节为准。

### 8.1 F1 单一提示（双通道收口）

同一权限以**同一 requestId** 经两条通道到达 bot watcher——(A) CLI 会话事件流
（`permission-flow.ts` 在 broker 调用前发射 `permission.requested`，adapter
`mapSessionEvent` 映射）与 (B) 反向 RPC（`interaction/requestPermission` →
host `emitSessionEvent("permission.request")` → adapter `mapServiceEvent` 映射）。
alpha.0 的 watcher 无 requestId 去重 ⇒ 双发（Telegram 双卡，答其一后第二卡
`permissionExpired` 误导）。

1. **单一所有者 = host 既有 `pendingPermissions` 登记表**（§5.14 墓碑语义）：
   无论哪条通道先到，先到者把该 requestId 标记进登记表；既有 `wasPending`
   逻辑抑制第二条通道的广播——全链路（desktop 与 bot 消费方）每 requestId
   恰一次 `permission_request` 流事件。adapter 保持无状态。
2. **陷阱（评审钉死）**：
   - host 侧标记**必须过滤 user-input-backed 工具名**（AskUserQuestion /
     ExitPlanMode 的等待态标记携带不同 requestId）——不过滤会把问题类标记
     污染进权限登记表与 `agent.pendingPermissions` 仪表。
   - **永不以 `"unknown"` requestId 去重**（adapter 对缺失 requestId/toolCallId
     的合成兜底）——混版旧 CLI 窗口可能把两条 distinct 并发提示折叠成一条。
3. **watcher 有界 seen-map 防御（belt-and-braces）**：bots watcher 侧维护
   DEDICATED 有界 seen-map（requestId → options hash；有界 map 先例 =
   `createBotTaskDeliveryRegistry`）。明确**不得**键于 `pendingPermissionOptions`
   ——后者只保存最新请求，重复 A 的再渲染会覆盖 B 的 pending。空 map 时首提示
   必须渲染（安全网不得掩盖 host 回归）。
4. 已验证安全项：requestId 每次 ask 现铸（`permission-flow.ts`），墓碑不会吃掉
   合法再提示；restore/snapshot 路径不经 bots watcher
   （`deliveryKind: "bot-channel-continuous"`）。

### 8.2 F2 deadline 冻结 + 持久化

alpha.0 的 bot 侧 timer 在渲染点重读**活配置**（`armBotPermissionPolicyTimers`
读 `bot.currentOptions.permissionTimeoutMinutes`），而 CLI 自动拒绝用
createSession **冻结值**（`interaction-broker.ts` ← `createTask
permissionAutoDenyMs`）——中途改配置 ⇒ 聊天宣称「已自动拒绝」而 CLI 仍按旧
期限接受迟到 allow（E7 虚假文案类）。

1. **持久化冻结值**：createTask 携带的确切 `permissionAutoDenyMs` 随建任务
   **持久化于 bot context**（与 task/pending 状态同处）；渲染/武装点
   （reminder + deny-note timer）**只读该持久值**。
   （实现注记 2026-10-07 W3：keying = context 级字段 `permissionAutoDenyMs`
   （`BotState`，语义上归属当前 activeTaskId——经 `botsStateFileSchema` 透传，
   zod 非严格内层对象否则会剥离该键）；清理缝 = context 离开该任务处
   （`writeDraftContext` 的 /new//workspace/删除任务替换、`/task set` 切换到
   不同任务时显式清掉），终态/`permission_response`//stop **不清**（任务仍可
   续跑，deadline 是任务级冻结事实——场景19a 的 task_complete后续跑重建即
   靠此存活）；单字段无 map ⇒ 无增长问题。`watchAutomationRun` 的合成 context
   不携带该值 ⇒ automation 复用会话的提示不武装 bot 侧文案（miss 语义，
   CLI 登记表权威不受影响）。）
2. **miss 不武装**：任务早于该字段、或持久映射丢失 ⇒ deny-note 不武装
   （reminder-only 或全不武装——「不补发避免误导」哲学的推论；实现取**全不
   武装**：deadline 未知 ⇒ reminder/deny-note 两个时点都不可计算），**绝不**从
   活配置重武装（消灭 E7 虚假否认类）。
3. **中途变更语义**：配置变更对本次任务不可见（§3c 生命周期表「deadline
   配置中途变更：无效」由本节落为可执行），下一个任务生效（与 mode 同语义）。
4. **CLI resume 缺口（owner 决策 2026-10-06）**：CLI session record 在 resume
   时重建且不携带 `permissionAutoDenyMs`（重启后新提示缺权威倒计时）。优先
   小修：按 permission 自动拒绝 session entry 同款机械持久化 deadline（或
   reattach 时重投递）；若小修不成比例，在本文披露为残留。
   （实现注记 2026-10-07 W3：小修已落地——会话级 entry
   `{ id: "permission-deadline:<sessionId>", type: "permission-deadline",
data: { permissionAutoDenyMs } }`，v4 createSession 建档写 record 字段的
   同时经 host 钩子 `persistSessionPermissionDeadline` 直写 store（稳定 id
   overwrite，与 `permission-auto-resolution:<requestId>` 同模式；失败仅
   warn）；broker `resolvePermissionDeadline` 在 record 字段缺席时回落读该
   entry（按 `time.updated` 取最新）。record 字段保持建档主源；无 entry ⇒
   无倒计时（场景20b）；建档路径行为不变（场景20c）。）

### 8.3 F3 单确认（自答 ack / 外来解析 note）

alpha.0 每次应答同时产生命令 ack（`permissionSubmitted`/`permissionDenied`）
与 watcher 解析注记（`permissionResolved`），次序竞态不定（D4）。

1. **自答保留 ack 为单确认**（按钮 + 文本路径——WeChat 唯一反馈面）：命令
   ack 恰一条；watcher 的 `permissionResolved` note **仅对聊天未发起的解析**
   发射（跨客户端/桌面应答、CLI 自动拒绝、B2.3 stop-deny）。抑制经
   `permission_response` 处理器查阅的**有界 recently-self-answered requestId
   集合**实现。
2. 理由（[ulw] 评审 BLOCKER）：文本路径在 CLI 的 `permission.resolved` 竞速
   回程前已清 pending，note 对自答不是可靠单消息。
3. 不变项：`permissionLateHandled` 迟到反馈、失败 ack、deny-note/reminder
   文案、§3c.2 事件驱动超时文案选择规则（CLI 自动拒绝仍发
   `permissionAutoDenied` note——它是外来解析，不在抑制范围）。

### 8.4 F4 mode 选项源

解锁后 `/mode` 两条选项源皆空（RC1）：active-task 路径走
`listProviderConfigOptionsForActiveTask` → `listUserConfigOptions`（三方 CLI
遗留永久 stub `return []`），正确数据 `active.configOptions`（恒含 mode
select，thoughtLevel 分支已在用）在同一 handler 里闲置；draft 路径
`listDraftConfigOptions` 只合成 thought_level。

1. **active-task 路径**：列表与设置两处均改用 `active.configOptions`。
2. **死 stub 规范移除**：`listUserConfigOptions` 是 BotsService 契约面
   （`bots.ts` `getUserConfigOptions`）——按契约编辑 + `pnpm dep:refs` 验证
   无其他消费方后删除；若出现其他消费方则留 tombstone 注释。
3. **draft 路径**：`listDraftConfigOptions` 从 `getZCodeAgentAvailableModes`
   （桌面 composer 同源）合成 mode select；当前值 = 读取时默认 `build`。
   实现注记（[ulw] NIT）：draft 与 active 两路径的选项 label 统一用
   mode.name（"Ask before changes" 等，`getZCodeAgentModeSelectOptions` 同源
   数据）；`/mode` 标题显示原始 mode token（如 `build`，与 §5 `/status` 模式行
   同口径）——本地化 label 会掩盖可回传的 value。
4. **接受边界**：无模型 draft 仍不列选项——与 thoughtLevel 平权；rig C1 使用已配置
   模型的 bot。**3.16.0 PR1 rider（owner 裁定 §7.38③）修订**：无模型 case 的空选项
   回复从 `modeMissing` 换为新键 `modeMissingNoModel` 可行动文案（先 `/model` 选模型
   再设模式）；空选项行为不变，其余空选项路径（`/mode set` 无效值、active 任务、
   thoughtLevel）继续用 `modeMissing`/`thoughtLevelMissing`。
