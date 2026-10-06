# Spec: Bot Permission Parity (3.15.0 Track B)

Status: **SPEC-FIRST（2026-10-06）——owner rulings 已取得：D1 = Option A′（扩展
CLI 既有交互登记表的自动结束机械，经 v4 createSession 增量字段携带 per-bot
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
   键 = 优雅降级为「无 deadline，提示照旧等待」，不产生错误）。bot 未配置或
   非 bot 任务不携带该字段（桌面会话行为逐字节不变）。
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
3. Timer 生命周期表（每个事件 → 清除/重设/触发）：

   | 事件                                                   | reminder/deny-note timer | 说明                                 |
   | ------------------------------------------------------ | ------------------------ | ------------------------------------ |
   | `permission_response`（任何客户端应答或 CLI 自动拒绝） | 清除                     | 权威已收口                           |
   | `task_complete` / `task_error` / `/stop` drain         | 清除 + pending 清空      | 终态                                 |
   | stale-watcher 清理（终态事件丢失）                     | 清除（**无** note）      | 不发迟到幽灵文案；CLI 倒计时自行收口 |
   | bot 禁用/删除                                          | 清除（note 抑制）        | 不向已禁用 bot 的频道发送            |
   | 服务 dispose                                           | best-effort 清除         | 静默丢失接受（与保留缓冲同规）       |
   | 服务启动扫描                                           | 清除过期项               | 见 3d                                |
   | deadline 配置中途变更                                  | 无效（不重设）           | 本次 pending 的 deadline 已定        |
   | 同 requestId 再提示                                    | 不重设                   | 时钟权威在登记表（3b.4）             |

### 3d. 重启对账

1. CLI 侧：reannounce 恢复（3b.4）。
2. Bot 侧：服务启动时扫描持久化 context——存在已过期的 pendingPermissionOptions
   条目时：清除该 pending；CLI 侧 deny 经 `permission_response` 到达（或已到）
   → 常规清理；若 CLI 为旧版本无倒计时（降级窗口），提示在旧 CLI 侧等待，
   用户仍可应答（first-wins）——deny-note 不补发（避免误导），披露为降级残留。
   未到期条目不重设 bot 侧 timer（reminder 丢失接受——纯装饰性）；CLI 侧
   倒计时继续（权威）。

### 3e. 边界

1. **AskUserQuestion / elicitation 不变**（本 alpha）：deadline 机制只作用于
   permission kind；问题类交互保持现状（含桌面 askUserQuestion 自动解决
   设置的既有语义）。guard 测试钉住。
2. 桌面（非 bot）会话不受影响：不带 deadline 字段 = 登记表行为逐字节不变。
3. 旧 CLI 降级 = 无倒计时（3a.2），提示照旧等待——不因解锁而恶化（解锁前
   权限事件本不存在）。

## 4. 提示退休与清理（retirement）

1. watcher 新增 `permission_response` 事件处理（镜像 `elicitation_response`）：
   清除 `pendingPermissionOptions`（仅该 requestId 相关；实现为整体清空或按
   requestId 过滤，以实现为准并在测试钉住）+ `broadcastTaskListChange`
   （`permission_resolved`）+ 退休聊天侧提示 UX：Telegram 键盘编辑、Feishu
   卡片更新（含 transient interaction card 的 finalize-on-resolution——补上
   现缺的第三处 finalize）、WeChat 文本注记。文本 `/approve`//`/deny` 路径的
   陈旧 pending 记录（`handledAt` 缺失的 orphan）随 `permission_response`
   一并清扫。
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
