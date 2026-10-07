# Changelog

## [3.15.0](https://github.com/yeyuan98/zodex/compare/v3.15.0-alpha.2...v3.15.0) (2026-10-07)

### Documentation

* **specs:** alpha.2 rig D0-D3 收口入账 + 观测判据生产可达性披露 → official 3.15.0 切版 ([4105dd1](https://github.com/yeyuan98/zodex/commit/4105dd123222aa9b16e7b7545363d04fd69a13aa))
  * draft-session-invalidation：Status 翻 rig 收口；§6 修订 = ui logger 生产全级 no-op 仅 lifecycle 落盘，D1 日志判据生产不可达（已知观测缺口入 post-3.15.0 候选池，一行修复）；§7 增分级 rig 记录（D1 = 行为 PASS owner 陈述 + saveMcpToUserDirectory host 侧佐证）
  * bot-permissions：Status 增 alpha.2 rig 收口 + 无模型草稿 /mode 短回复登记（owner 裁定非阻塞）
  * owner 裁定 2026-10-07：不出观测性 alpha.3，直接切 official

* **specs:** draft-session-invalidation Status——alpha.2 已发版 + awaiting rig D0-D3 ([b1c1c3e](https://github.com/yeyuan98/zodex/commit/b1c1c3e2eca7ed23b13a3f2f9764b2ff2f86ae29)), closes [#34]()

## [3.15.0-alpha.2](https://github.com/yeyuan98/zodex/compare/v3.15.0-alpha.1...v3.15.0-alpha.2) (2026-10-07)

### Features

* **bots:** /help 尾部追加三条使用注记（zh/en） ([4b925a1](https://github.com/yeyuan98/zodex/commit/4b925a1f8bdc897da3c2720bc8864d2b608b41dd))
  * buildHelpText 命令目录后追加空行 + helpNoteConfigNextTask/helpNoteSkillsByName/helpNotePluginsNoHotLoad 三条注记（3.15.0-alpha.2 Track B R3）
  * 注记是说明文本非命令，不参与 allowedCommands 过滤，命令收紧时仍渲染（guard 测试锁定）


### Bug Fixes

* **ci:** CLI workspace 格式门修复——5 文件 oxfmt 重排 + pre-push 补 CLI format:check ([868e4b9](https://github.com/yeyuan98/zodex/commit/868e4b98fac59399341aa9fee58bd4250f68cb5f))
  * apps/zcode-cli 为独立 workspace：根 fmt:check 不覆盖其文件，仅 CI 的 CLI job 检查——本 train（alpha.0×3 + alpha.1×2）触碰的 5 个文件未过 CLI 侧 oxfmt，main 上 CI 自 alpha.0 发版起连续红（Release Desktop 不受影响）
  * 5 文件纯格式重排（参数折行/对象缩进），bootstrap 32/32、CLI typecheck/lint/registry 均绿
  * verify:pre-push 追加 pnpm --dir apps/zcode-cli format:check——本地关上同类缺口，pre-push 与 CI 的 CLI job 对齐

* **ui:** MCP 导入与远端同步补失效 + 评审折叠（logScope/reason/spec 行号） ([402df55](https://github.com/yeyuan98/zodex/commit/402df552e2761ebbbf337fc652a324bf1824caeb))
  * MAJOR-1: McpSettingsSection onImported/onMcpSynced 回调补 invalidateDeferredDraftSessionForRuntimeChange（reason=settings-mcp-import / settings-remote-mcp-sync，skills 先例平权；导入/远端同步直写磁盘不经 store 四写 action）
  * NIT-3: useSettingsSync 门改用 RuntimeChange + logScope=settings-sync，legacy web 关闭日志不再误标 [skills]
  * NIT-4: settingsSyncDraftInvalidationReason 未知类别按原名入 reason，不再误标 plugin；谓词测试补未知类别断言
  * spec §3 新增 MCP 导入/远端同步两行并刷新过期行号（mcpStore 四写 :416/:432/:447/:479、mergePreloaded :692/deletePreloaded :724、persistScopedChange :233、useSettingsSync 门 :469、sidebar/header :1169/:733）；§7 验收改为诚实覆盖表述；Status 折叠 [ulw] 评审

* **ui:** MCP 设置写操作失效 pending draft session（与 skills/plugins 平权） ([fd9d20b](https://github.com/yeyuan98/zodex/commit/fd9d20b9ad1914bb41719b8ce9b68e947f94eecc))
  * mcpStore 四写 action（add/update/delete/toggle）接入 invalidateDeferredDraftSessionForRuntimeChange，reason=settings-mcp-add|save|delete|enabled，版本 bump 于 helper 首个 await 前同步完成
  * 新增 setMcpStoreSessionService DI（Pick<IZCodeSessionService,"closeSession">，Root 于 ServiceProvider 内注入 legacy v3 草稿 closeSession 腿），未注入时以 no-op 桩保证 bump；MCP 缝自带 [mcpStore] info 日志作 rig D1 判据（spec §6）
  * settings-sync 导入门扩为 skills|mcpServers|plugins（新纯谓词 lib/settingsSyncDraftInvalidation.ts），失效仍只做一次、reason 按首个命中类别取 settings-sync-skill|mcp|plugin-import，spec §3 表同步


### Documentation

* **specs:** bot-permissions Status——alpha.1 rig C0-C6 全 PASS + alpha.2 计划指针 ([49d4b0e](https://github.com/yeyuan98/zodex/commit/49d4b0ecd077f6e41149e58195460d384877b1a9))
  * rig 判定入档：C0-C6 全 PASS（owner 陈述 2026-10-07，§8.1 分级；含 C5 remote 门控写腿）
  * 下一步指针：alpha.2 收尾批次（R1 MCP 草稿失效平权 / R2 安全节修订 / R3 帮助注记）→ rig D0-D3 → official 3.15.0 评估

* **specs:** bot-permissions Status——alpha.1 已发版 + awaiting rig C0-C6 ([c797e93](https://github.com/yeyuan98/zodex/commit/c797e93f759c5e5f5708570a75294709160b7ae7)), closes [#30]()

* **spec:** 收编草稿失效不变量 + bot-file-delivery §5.9 post-Track-B 修订 ([870114c](https://github.com/yeyuan98/zodex/commit/870114c6c412cbfaf5685f3a2f4a77b08379e0e3))
  * 新建 specs/draft-session-invalidation.md：收编 draftRuntimeInvalidationVersion 唯一失效货币不变量与变更源清单表（skills/plugins/hooks/browser/settings-sync 既有 + MCP 本批新增 mcpStore 四写 action store 层缝），排除项守卫行（mergePreloaded/deletePreloaded 零调用方）、user-scope 平权与失败语义披露、rig D1 判据日志行（[mcpStore] scope + reason=settings-mcp-*）
  * bot-file-delivery.md §5.9：守卫表述翻为 post-Track-B 形态——workspace-only 路径策略 + 审计日志 + 5MB 上限 + 权限面（默认 build 变更前询问、用户经 /mode 可切含 yolo 非恒为 build、per-bot 超时自动拒绝、全会话单一权限模型、AI 不能自切模式），交叉引用 bot-permissions.md（weixin 自回环 residual 见其 §1.5），删除括号内 off-peak 先例引用

## [3.15.0-alpha.1](https://github.com/yeyuan98/zodex/compare/v3.15.0-alpha.0...v3.15.0-alpha.1) (2026-10-06)

### Features

* **bots:** alpha.1 F1+F4——权限提示双通道 host 收口 + /mode 选项源双侧修复 ([c92cca2](https://github.com/yeyuan98/zodex/commit/c92cca27004a21b2243ddb23cd461746cfe80d51))
  * F1 host pendingPermissions 登记表收口双通道（通道 A permission.requested 先到标记、wasPending 抑制后到广播；陷阱 a user-input-backed 工具名过滤不入表、陷阱 b "unknown" requestId 永不去重），adapter 保持无状态（场景16/17 红转绿+guard；单通道桌面 pin 保持绿）
  * F1 watcher 有界 seen-map 防御（requestId→options hash，独立于只存最新请求的 pendingPermissionOptions；空 map 首提示必渲染）（场景18a/18b 红转绿）
  * F1 user-input-backed 工具名判定抽到 permissionToolNames.ts，host 标记与 adapter 投影共用同一事实源
  * F4 active-task /mode 列表与设置改用 active.configOptions（thoughtLevel 同款先例）；draft 路径经 getZCodeAgentAvailableModes（桌面 composer 同源）合成 mode select，当前值读取时默认 build；/mode 标题改显原始 mode token（与 /status 模式行同口径）（场景22a/22b 红转绿，22a2/22c guard 保持绿）
  * F4 死代码 listUserConfigOptions 契约面规范移除（IBotsService.getUserConfigOptions + BotUserConfigOptionsParams；dep:refs 验证无消费方）

* **bots:** alpha.1 F2+F3——deadline 冻结持久化武装 + 自答单确认/外来解析注记 ([43fa0a4](https://github.com/yeyuan98/zodex/commit/43fa0a448e89617efb214056cd01fcd5f0d4b0d0))
  * F2 createTask 冻结 permissionAutoDenyMs 持久化于 bot context（BotState 单字段=当前 active task 冻结值，经 botsStateFileSchema 透传防 zod 剥离；/new//workspace/删除任务替换//task 切换清理，终态//stop/permission_response 不清——场景19a 的 task_complete 后续跑重建靠此存活），armBotPermissionPolicyTimers 只读持久值（E7 虚假超时文案根因——今读活配置）
  * F2 miss（任务早于字段/映射丢失）⇒ reminder/deny-note 均不武装，绝不活配置重武装；重启按持久值重武装（场景19a/19b/19c 红转绿）；alpha.0 timer 测试 fixture 补种持久化冻结值（9a/9b/10/11/15/R1-1/R1-2——F2 后武装不再读活配置，各测试钉住的 timer 语义不变）
  * F2 CLI resume 缺口最小修：会话级 permission-deadline entry（v4 createSession 建档写 record 字段同时经 host 钩子 persistSessionPermissionDeadline 直写 store，稳定 id overwrite 与 permission-auto-resolution 同模式）+ broker resolvePermissionDeadline 在 record 缺席时回落读 entry（场景20 红转绿；无 entry 不武装/建档主源不变两 guard 保持）
  * F3 permission_response 处理器查阅有界 recently-self-answered 集合（cap 200/TTL 60s，仅 respondPermission submitted=true 记录）：自答（按钮+文本）ack 为单确认、note 抑制但清理照常（pending 清除/broadcast/timer 清除/卡片退休 UX）；跨端应答/CLI 自动拒绝（permissionAutoDenied §3c.2 选择规则不变）/B2.3 stop-deny 照发 note（场景21a/21a2 红转绿，21b guard 保持）
  * spec §8.2 补 W3 实现注记（context 字段 keying/清理缝、watchAutomationRun miss 语义、CLI 小修落地形状）


### Bug Fixes

* **bots:** 折叠 [ulw] 评审 NIT——draft/active mode label 同口径 + spec 显示注记 + 场景16 稳态窗提速 ([61ea468](https://github.com/yeyuan98/zodex/commit/61ea468c35ae247600488ed89f0eb6f7a8a703ea))
  * draft mode 选项 label 改用 mode.name（与 active.configOptions 显示口径一致，消除 draft=build/active=Ask before changes 分裂）
  * spec §8.4 补实现注记：两路径 label 统一 mode.name；/mode 标题显示原始 mode token（与 /status 模式行同口径）
  * 场景16 改为首条广播 + 1.5s 稳态窗断言恰一次（> rig 实测 A→B 间隔 330-650ms），修复后不再恒烧 10s
  * NIT-4（transient 卡片 finalize 自答文案）按评审携带为设计，不改动


### Documentation

* **specs:** bot-permissions Status——alpha.0 已发版 + rig §2k 缺陷与 alpha.1 计划指针 ([0d75e21](https://github.com/yeyuan98/zodex/commit/0d75e21934659d453fb062f8cb3486cf78f0710c))

## [3.15.0-alpha.0](https://github.com/yeyuan98/zodex/compare/v3.14.5...v3.15.0-alpha.0) (2026-10-06)

### Features

* **bots:** 权限提示退休与清理——permission_response 处理 + 终态清空 + 孤儿清扫 + 迟到反馈 ([6e68a51](https://github.com/yeyuan98/zodex/commit/6e68a51660a99903cf3684c3fb9a4fead5073061))
  * watcher 新增 permission_response 事件处理（镜像 elicitation_response，spec §4.1）：按 requestId 清除 pendingPermissionOptions + broadcastTaskListChange(permission_resolved) + 退休聊天侧提示 UX——transient interaction card 存在时补上此前缺失的第三处 finalize，非瞬态渠道（微信文本）补发一条本地化退休注记（permissionResolved，best-effort、非保留，失败仅 warn）。
  * 终态清理（spec §4.2）：task_complete/task_error 处理器与 /stop drain 路径清空 pendingPermissionOptions（此前终态只清 pendingElicitation；/new writeDraftContext 为既有先例）。
  * 孤儿清扫（spec §4.1）：文本 /approve、/deny 应答提交成功（或已收口）后清除该 requestId 的 pending 记录，不再滞留到下一次 permission_request 覆盖。
  * 迟到点击反馈（spec §4.3）：respondPermission 返回 false（CLI 自动拒绝/他端已应答）时回本地化「已被处理/已自动拒绝」反馈（permissionLateHandled，zh/en）；序号按钮路径 handledAt 吞并语义不变。
  * 清除统一收口到 clearPendingPermissionOptions 助手（writeContext 单写者规则保留 cursor/token 字段），注释标注 W3b（§3c timer 生命周期表）的挂接点：permission_response / 终态 / stop。
  * 红测转绿：场景4（permission_response 清除 pending）、场景5（task_complete 清空）；新增场景13（迟到点击 ⇒ 反馈 + pending 清扫，fake respondPermission 增加旋钮）；场景4 追加微信文本退休注记断言（transient 卡片 finalize 为 Feishu 专属路径，缺口如实披露）。

* **bots:** 权限无应答 bot 侧落地——deadline 传递 + 提醒/自动拒绝文案 + 超时配置字段 ([4ec16f4](https://github.com/yeyuan98/zodex/commit/4ec16f4835e01dfa5b7efd6d93540e70cb8fab6b))
  * shared：BotCurrentOptions 新增 permissionTimeoutMinutes（schema 1..1440 整数，写入不注入默认）+ 纯函数 normalizePermissionTimeoutMinutes（读取时默认 10、数值字符串解析、小数截断、clamp；E.19 红测转绿）
  * shared：新增 BOT_PERMISSION_TIMER_SCALE_ENV（ZCODE_E2E_BOT_PERMISSION_TIMER_SCALE）测试时钟缩放 seam（先例 = ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV，仅 ZCODE_ENV=test、1..1000、时长除以系数）
  * bots：建任务 createTask（v4Create 咽喉）按 normalize×60000 携带 permissionAutoDenyMs（仅 ZCode-Agent provider 任务；缺省 10 分钟也携带，避免与 CLI 倒计时脱节）
  * bots：permission_request 渲染点武装 reminder（deadline−2min，恰一次，≤5min 整体跳过）与 deny-note（deadline 时刻「权限超时未应答，已自动拒绝」）两个策略 timer（spec §3c 声明的受控例外）；deny 权威唯一在 CLI 登记表，timer 只管聊天可见性
  * bots：两条 timer 文案 best-effort sendOutbound、非保留（不进 channel-dead 保留缓冲）、失败仅 warn；触发时重读 bot 配置，禁用/删除 ⇒ 抑制
  * bots：timer 清除收口——clearPendingPermissionOptions（permission_response/terminal/stop/text_response）+ stale-watcher 清理（无 note）+ /new writeDraftContext + 服务 dispose；同 requestId 再提示不重设、配置中途变更不重设（§3c 生命周期表）
  * bots：§B2.3 提示发送失败 stop-deny 分支提前 return，不再武装 timer（先答后不发，防与事实不符的「超时」文案）
  * ui：Manage bot 表单新增「权限超时（分钟）」数字字段（D2 ruling；空 = 默认 10，提交经 shared helper 归一，zh/en i18n）
  * test：场景 createTask 传递（7⇒420000 / 缺省⇒600000）+ 场景9a/9b（恰一次提醒/短 deadline 无提醒）+ 场景10（发送失败零保留条目，revival 无序言断言）+ 场景11（elicitation pending 原样存活）+ 场景15（禁用抑制）

* **bots:** 解锁 bot 权限模式（默认 build）+ yolo→build 迁移 + /status 模式行 ([6deb35f](https://github.com/yeyuan98/zodex/commit/6deb35f472648585789979bb555c3d40d382445a))
  * 解锁（specs/bot-permissions.md §1）：删除 BOT_FORCED_MODE 及三处强制——draft 初始化改读 bot 配置 currentOptions.mode（读取时默认 build、不落盘回写，经既有 repo.readConfig() 单一配置路径解析）；/new 任务继承改用 readCurrentActiveTaskMode 沿用 active task 实际模式；建任务咽喉 applyDraftConfigOptions 下发草稿自身 mode（setMode 仍为唯一前门，provider 不支持跳过分支保留）。
  * mode.list/mode.set 移除 modeLocked 短路，模式选择走 thoughtLevel 同款通用机械；taskRunning 拒绝保留（桌面平权，运行中任务保持其模式）；messages.ts 退休 modeLocked zh/en key（dep:refs 验证无其他引用）。
  * 迁移（§2）：状态文件版本 3→4（bot-state.v4.json，v3 降级只读快照）——加载时一次性把 v3 yolo 草稿翻转 build，幂等（版本守卫即迁移，v4 中用户显式选择的 yolo 不再翻转）；v2 legacy 导入路径应用同一 flip；cursor/token 等兄弟字段按 writeContext 单写者规则原样保留；无 draftOptions 的 context 跳过；无聊天通知、无版本分支业务代码。
  * /status 模式行（§5）：draft 显示 draftOptions.mode、active task 显示其实际模式（readCurrentActiveTaskMode）、缺失显示「未设置/not set」（statusModelUnset 同款 fallback）；新增 statusMode/statusModeUnset zh/en key；断连降级视图同样带模式行。
  * 修订 force-yolo 出站防泄露边界注释（泄露边界不再依赖权限提示结构性缺席）；botsService.ts:2006、telegramChannelRuntime 游标注释同步状态文件新名。
  * 测试：botPermissions 场景 1/2/3/6 转绿；新增 §7.14 guard（currentOptions.mode=yolo 的 bot 仍派发 setMode("yolo")）；场景 4/5（permission_response/终态清理，W4）保持红。

* **cli:** 权限无应答自动拒绝——v4 createSession deadline 字段 + 交互登记表 permission kind 扩展 ([863ee37](https://github.com/yeyuan98/zodex/commit/863ee377b4e1f4091657481f9c0aa3090d548e40))
  * shared：v4 createSession payload 新增 additive 字段 permissionAutoDenyMs（与 offPeakToolEnabled 同模式，非 strict 语义保持——旧 CLI 静默丢弃 = 无 deadline 降级），转绿 createSessionPermissionDeadline 场景一/二（spec §3a.2/§7.6）
  * services：createTask 参数与 adapter v4Create 分支透传 permissionAutoDenyMs（bot 配置分钟×60000；非 bot 任务不携带，桌面行为不变）
  * CLI session record seam：ZCodeProtocolSessionRecord/V4SessionRecordView 增加 permissionAutoDenyMs，由 v4 createSession handler 建档后直接写入（deadline 只走 v4，v3 strict schema 不动，spec §6 不变量）
  * 登记表：V4InteractionRegistrationOptions kind 扩展 "permission" + per-entry autoResolutionMs——注册即武装（不排队头）、无 hiddenGrace（首态 visibleCountdown）、不可 snooze；到期/过期恢复 resolve 无 optionId/action 的 deny-shaped 应答，askUserQuestion 的 accept 空答案与 head-only/全局 gate 语义逐字节不变（spec §3b.1/§3b.2/§3b.4/§3b.5），转红测 A/B/C 且 guard D 保持绿
  * broker：requestPermission 注册改走 kind "permission"，读 session record deadline + 持久化恢复（SESSION_ENTRY_PERMISSION_AUTO_RESOLUTION 新 entry，与 user_input 同一 store 覆写模式）；抽出纯函数 buildPermissionInteractionRegistrationOptions 并导出 v4AnswerToPermissionResponse（W1 测试去掉临时 cast 与命名空间探测）
  * 新增 permissionDeadlineWiring 测试：handler 落 record、装配缝 kind/deadline/恢复态透传、gate 边界 guard（问题类关闭不武装、permission 独立于 gate）


### Bug Fixes

* **bots:** 折叠 [ulw] 评审修复——timer 清除无条件收口 + 迟到 deny 超时文案 + 卡片 clobber 守卫 ([16b3a2e](https://github.com/yeyuan98/zodex/commit/16b3a2e83edc3a0e9a68d816dbce89e027b67314))
  * clearPendingPermissionOptions 无条件先清策略 timer（R1-1 MAJOR）：并发权限 A/B 下空 pending early-return 不再拦截清除，杜绝已应答请求补发幽灵 reminder/deny-note（场景R1-1 红转绿钉住）
  * permission_response 处理器新增事件驱动超时文案选择（R1-2）：decision=deny 且登记表武装 deadline 已过 ⇒ 发 permissionAutoDenied；deadline 前用户 deny 保持通用文案；新增 getArmedPermissionDeadline 查询缝（场景R1-2 红转绿钉住）
  * transient 卡片记录最后 upsert 的 requestId，permission_response finalize 守卫按 taskId+requestId 双比对，不再终结展示中较新交互的卡片（R1-4）
  * 序号按钮 permission.respond 迟到点击（respondPermission=false）随反馈清扫该 requestId 的 pending orphan，与文本路径对齐（R1-5）
  * permissionReply 未渲染时不再武装策略 timer（R1-6）：pending 已写但聊天内无可见提示时补发文案只会误导
  * botCurrentOptionsSchema permissionTimeoutMinutes 边界复用 BOT_PERMISSION_TIMEOUT_MIN/MAX_MINUTES 常量（R1-7）
  * /status activeTaskId+草稿过渡形态优先 draftOptions.mode（R1-8）
  * 登记表测试 pin：permission snooze 返回 false（§7.4）+ 未到期恢复保持原 deadlineAt 不提前不重置（§7.5 前半）
  * 迁移矩阵 pin（场景3b）：v4 版本守卫不翻转用户重选 yolo、翻转结果幂等、v2 legacy 导入 flip、v3 文件名双文件路径
  * 场景15 改为确定性窗口（默认 10min 缩放 600ms，禁用覆写先于 deadline）+ 场景6b /status 形态 pin（active-task 模式行/过渡形态/未设置 fallback/en）


### Documentation

* **specs:** [ulw] 评审收口——三份 spec Status 引导行翻转至 SHIPPED/train 收官 ([efbc19a](https://github.com/yeyuan98/zodex/commit/efbc19a5d16e93e0aa47c080f84d4a3551547dee))
  * bot-message-delivery.md：Status 引导行 IN FLIGHT → SHIPPED（train closed at
  * bot-inbound-resilience.md：IN FLIGHT → SHIPPED（PR #16，release afd21da，
  * log-diagnostics-hygiene.md：IN FLIGHT → SHIPPED（PR #15，release 527cce5，
  * 接受残余（记录不修）：CHANGELOG 3.14.5 官方节子条目折行截断为排版瑕疵

* **specs:** bot-permissions [ulw] 评审修正——超时文案选择规则 + 混版残留披露 + 状态行更新 ([ad60ce9](https://github.com/yeyuan98/zodex/commit/ad60ce965c8ae669333ef0f17c8e3f8976c87cbd))
  * §3c.2/§4.1 新增事件驱动的超时文案选择规则与迟到用户 deny 显示超时文案的接受边界
  * §3e 新增远端旧 CLI 混版窗口残留披露（deadline 字段被剥离、bot 侧武装无 delivery ack 门控、重连自动收敛）
  * §4.1 披露本 alpha Telegram 退休为本地化文本注记（键盘编辑推迟到 polish）+ transient 卡片 finalize 按 requestId 比对
  * 状态行更新为已实现于 agent/coder/bot-permission-parity（W1–W5），待 3.15.0-alpha.0 发版与 rig 验证

* **specs:** bot-permissions 实现注记——deadline 缺省携带语义澄清 + 启动扫描降级为惰性清理 ([d598d8d](https://github.com/yeyuan98/zodex/commit/d598d8d37c11e04f1c04f2c6ddef73d657c80169))

## [3.14.5](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.9...v3.14.5) (2026-10-06)

### Documentation

* **specs:** 标记 alpha.7/8/9 已发布并 rig 验证，3.14.5 train 收官 → official 3.14.5 ([52719f3](https://github.com/yeyuan98/zodex/commit/52719f3ed98edd72ae604a41801b3382184957ae))
  * bot-file-delivery.md Status：alpha.7「spec'd/implementation pending」改为
  * bot-message-delivery.md Status：rider 条目补发版哈希与 rig 验证结论，

## [3.14.5-alpha.9](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.8...v3.14.5-alpha.9) (2026-10-06)

### Bug Fixes

* **bots:** alpha.9 [ulw] 评审收口——webhook 站点钉测 + 大小写门钉测 + spec 枚举补齐 ([0272ad8](https://github.com/yeyuan98/zodex/commit/0272ad84d9aae2f96252e5e55bb6bf389b38bd05))
  * MINOR-3 收口：spec fix 3 的 parse 站点枚举补入 webhook（filename 提供名 →
  * NIT-1 收口：伪扩展名词汇表匹配大小写不敏感（toLowerCase）为有意语义，
  * NIT-5 披露：8323c92 中 String(error ?? "") 相对 String(error) 的微差
  * 接受残余（记录不修）：en 语种 rider 包装无独立测试（formatUserFacingBotError

* **bots:** alpha.9——伪扩展名 sniff 扩面 + 飞书 kind-aware 资源键 + 附件观测行 + 业务错误码本地化 ([8323c92](https://github.com/yeyuan98/zodex/commit/8323c9201d098ec6fa30389d492509524a159938))
  * 修复 1 伪扩展名 sniff 扩面（§7.34①）：cacheResolvedAttachment 的 sniff 门从
  * 修复 2 飞书 kind-aware 资源键（§2j F1a）：readFeishuAttachment 按 kind 选键取代
  * 修复 3 附件观测行：cacheResolvedAttachment 每附件一条生产可用 info——
  * 附带修复两处潜伏铸名 bug（红测钉住）：weixin/feishu parse 站 readString||链
  * rider 业务错误码本地化（§7.35，specs/bot-message-delivery.md）：前置 [数字]
  * 测试字面修正（main agent 裁定①）：botFileDeliveryFeishu.test.ts:719 的
  * fix 4b（CLI prompt 内联视频字节守卫）归 W2b：apps/zcode-cli 本提交零改动，

* **cli:** alpha.9——prompt 内联视频字节校验（非视频容器降级路径注记） ([c846f5e](https://github.com/yeyuan98/zodex/commit/c846f5e3d916087b68c99d860b5a45fa94cafe25))
  * 新增共享 helper isVideoContainerBytes（packages/shared/attachmentContainerSniff）：
  * attachment-media-resolver 两条 video 分支加字节守卫（PDF isPdfBytes 先例）：
  * 降级 warn 可 grep：命名附件 + expected vs sniffed mime（rig 取证）；
  * 披露成本（按 ruling 不修）：表外真容器（AVI 等）同样降级路径注记，agent

## [3.14.5-alpha.8](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.7...v3.14.5-alpha.8) (2026-10-05)

### Bug Fixes

* **bots:** [ulw] 评审收口——下载失败 warn 落地 prepare 漏斗 + logid 头名更正 ([da46222](https://github.com/yeyuan98/zodex/commit/da46222df02d7b0b1fa9b974d91b5d68ab79f3e6))
  * BLOCKER：rider 此前无效——富化后的错误文本在 handleMessage 的 prepare
  * MAJOR：trace 头名更正为 x-tt-logid（仓库先例 providerRequest.ts:118 与
  * NIT：A8 token 名用例 fixture mimeType 由 video/mp4 改 application/
  * 更正 c6e3bb8 披露：/download .+ failed: HTTP/i 正则从未匹配本消息形态
  * 验证：A8 scoped 3/3；services 全量 298/298；typecheck/lint/fmt:check 通过。

* **bots:** alpha.8——sniff 门放宽至任意无扩展名 + 飞书资源 type=file + 下载失败 logid ([c6e3bb8](https://github.com/yeyuan98/zodex/commit/c6e3bb896dc5d5a1fc2b87285dd31e08411ada2f))
  * sniff 门放宽（botsService cacheResolvedAttachment ~:2309）：门控由
  * filenameIsFallback 退役（唯一消费者是旧门控）：删除 shared/bots.ts 字段
  * fixture 对齐披露（botInboundAttachments.test.ts）：R8 兜底命名 helper
  * 飞书下载 type 修复（feishuProvider ~:2046）：资源 URL ternary 由
  * 下载失败 logid rider（owner 批准，feishuProvider ~:2054）：!response.ok
  * 验证：services 298/298（3 红→绿、守护全绿）、shared 61/61、


### Chores

* 第三方清单同步——补装 @larksuiteoapi/node-sdk 双版本落盘状态 ([0a456d2](https://github.com/yeyuan98/zodex/commit/0a456d262c59f80ea3f819e2775adcc0f4e18fc7))
  * 本工作区 node_modules 曾落后锁文件（licenses 脚本要求清单内 1.61.1 已安装，
  * 无代码变化；随 alpha.8 发布链路自然携带。

## [3.14.5-alpha.7](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.6...v3.14.5-alpha.7) (2026-10-05)

### Features

* **bots:** alpha.7 出站打磨——字节安全文件名、内联图片扩展、审计去重、死窗日志限频、心跳仪表归零、image/audio dataBase64 剥离 ([7fb0f05](https://github.com/yeyuan98/zodex/commit/7fb0f05406e9931da91fadbcfb479d88fe3db8d3))
  * §5.6 共享字节预算文件名 helper（packages/shared attachmentFilename.ts，经公开入口导出、被三站点消费）：Unicode 基名保留（修复 rig 实测 程曦简历.pdf 塌缩为 01-.pdf）、UTF-8 字节预算截断不劈码点且保留扩展名（修复 125 个 CJK 字符 = 360 字节缓存写盘 ENAMETOOLONG）、Windows 保留名中和（CON/PRN/AUX/NUL/COM1-9/LPT1-9 含带扩展形态；远端 CON.txt 出站临时物料化点是真正裸奔点，红测钉此）；botsService 入站缓存/出站临时 120B、desktop staging trace 80B / nonce 64B / filename 160B；digest/序号前缀仍在预算段之外
  * §5.7 内联图片扩容双侧同扩：OUTBOUND_IMAGE_EXTENSIONS += .heic/.heif/.tiff/.avif；weixin inferWeixinAttachmentKind regex += heif|tiff|avif（heic 已有）——tiff/avif 微信内联渲染按 rig B3 验证，坏则依 spec 回落条款回 file
  * §5.8 审计字段去重：path= 是唯一路径字段，file= 仅当与 path= 取值不同才输出（顶层路径/预解析失败/配额拒绝/投递前 Host 错误处同值不再双字段重复打印）；同段 §5.9 stale 一句话按 spec amendment 改写为如实版本
  * §5.12a 死窗失败行限频（仅日志密度，零行为变化）：sendOutbound 失败线与 stream-event catch warn 共享 per (botId, peerKey) 死窗状态，channel-dead 分类 30s 惰性时间戳合并（首条照常输出、后续计数不发射、下一条件携带 suppressed=），无 timer；content-poison 永不限频；revival 保留积压开始投递或下一发送结果不再判 channel-dead 时输出一条 dead-window summary（suppressed>=1 才输出、per 死窗恰一条）；alpha.5 观测用例逐线断言按 spec 迁移注记以 mock 时钟改写到新密度（burstOrdinal/sendCount10s/fp 计数语义不变，被合并尝试仍计位）
  * §5.14 pending 仪表归零：zcodeAgentService pendingPermissions/pendingUserInputs 条目在交互解决时打墓碑（resolved 标记退出 gauge 计数、保留键使 wasPending 去重继续生效、随既有断连/dispose 清理）——双挂点：(a) v4 resolveInteraction ACK 成功（respondPermission/respondElicitation 汇聚点，服务侧直接清理）、(b) permission.resolved / userInput.resolved 会话事件到达 host（覆盖 deny-on-stop/deadline）；墓碑 vs 删除由红测裁定为墓碑（解决后重发同 requestId 不得重新广播）
  * §5.11 image/audio 入站 prompt attachments 停发 dataBase64（R3 rig PASS 2026-10-04 门控的 spec invariant 翻转）：渲染依据 localPath（缓存文件刚写入），同一数据不再 base64 传两遍；desktop 包装器对 dataBase64-only 附件（其它来源）原样透传不变
  * §5.5 share_file send-failed 模型文案改写：不再断言「用户没有收到文件」——只陈述尝试失败与结局未知（桌面可能在工具超时 SHARE_FILE_TOOL_TIMEOUT_MS=330s 后完成投递）；apps/zcode-cli 无测试 harness，rig B6 人工覆盖（disclosed）
  * §5.6 共享 helper 纯函数矩阵测试落 packages/shared/test/attachmentFilename.test.ts（保留名/截断/零漂移/fallback/staging 预算）


### Chores

* **bots:** [ulw] 评审收口——纯点号文件名兜底、死窗汇总整窗计数、dispose 清理 ([f09305a](https://github.com/yeyuan98/zodex/commit/f09305a247972aacf8a4ce86c12278d0108d70c9))
  * MINOR-1 修复：sanitizeByteBudgetedFilename 对纯点号输出（./../…）回退
  * NIT-2 修复：死窗汇总行 suppressed= 改为整窗累计（发射线上的分段计数分工
  * NIT-4 修复：deadWindowFailureLogStates 随 disposeAllAndWait 清空（对齐相邻
  * NIT-3/5 记录：非 weixin/空积压 peer 的汇总时点残余与 staging 微漂移已按
  * 新增纯点号守卫单测（含 '..hidden' 正常形态不受影响钉）


### Documentation

* **specs:** alpha.7 出站打磨 + 观测卫生 spec 先行 ([a91abba](https://github.com/yeyuan98/zodex/commit/a91abba76484ed4016bfe9f169a3339fa871b674))
  * bot-file-delivery.md：新增「Outbound attachment naming & inline kinds (3.14.5
  * §5.7 出站图片扩展与微信入站推断扩至 heic/heif/tiff/avif（tiff/avif 渲染
  * bot-file-delivery.md §9 审计项：§5.8 字段去重（path= 单一路径字段，file=
  * bot-file-delivery.md「Inbound remote workspaces」§5.11 invariant 翻转：
  * log-diagnostics-hygiene.md：新增 §5.12a 死窗失败行限频 amendment（sendOutbound

## [3.14.5-alpha.6](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.5...v3.14.5-alpha.6) (2026-10-05)

### Features

* **bots:** alpha.6 入站附件 gate——>4 通知、per-file 单次大小检查、无名附件 sniff、缓存懒清理、TG/飞书读侧复检 ([f4276b9](https://github.com/yeyuan98/zodex/commit/f4276b9a5e683ba2ddacd70dbe527f02ed576ab1))
  * §5.1 >4 通知：slice 保持前 4 个不变，但静默丢弃死亡——立即回复
  * §5.2 per-file 超限（单次检查语义）：sizeBytes 已知超限 → 下载前 typed
  * §5.15 无名附件容器 sniff：packages/shared 新增纯函数
  * §5.3 缓存惰性修剪：无 daemon/timer；per-service 24h 内存门，
  * §5.4 TG/飞书读侧复检：sendAttachment readFile 后、任何上传请求前


### Chores

* **bots:** [ulw] 评审收口——通知随失败送达 + sniff 门控回兜底名 + mp3 保留位校验 ([6c69271](https://github.com/yeyuan98/zodex/commit/6c692717fb6a2c7c11783129e53236eef1767226))
  * MINOR-1 修复：prepare/下载/缓存中途 throw 与后续流程失败时，已累积的附件通知
  * MINOR-2 修复：BotInboundAttachment 新增 filenameIsFallback（三家 provider 兜底
  * NIT：删除失去唯一消费者的 attachmentTooLarge 文案 key；mp3 帧同步增加
  * R8 fixture 补 filenameIsFallback 标记（断言不变，仅对齐 provider 契约）


### Documentation

* **specs:** alpha.6 入站附件 gate 语义 + 缓存生命周期 + 无名附件格式识别 spec 先行 ([0273433](https://github.com/yeyuan98/zodex/commit/0273433a4119009ad50581ab92af5cb54cac2ee2))
  * specs/bot-file-delivery.md 新增「Inbound attachment gates (3.14.5 Alpha 6)」：
  * per-file 超限拒绝单次检查语义（§7.32）：sizeBytes 已知超限→下载前 typed reject；
  * 无名附件容器 sniff（sniffAttachmentContainer magic 表：mp4/mov/webm/mkv/m4a/
  * 缓存惰性修剪：24h 内存门 piggyback cacheResolvedAttachment（不 await）+ 启动
  * Phase C Alpha 5 第 4-5 项修订：TG/飞书 sendAttachment 读侧 ≤5MB 复检（对齐
  * Alpha 0 入站 invariant 改指向新章节；Status 头标注 Alpha 6 spec'd 2026-10-04

## [3.14.5-alpha.5](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.4...v3.14.5-alpha.5) (2026-10-04)

### Features

* **bots:** weixin -2 失败行观测增强——burstOrdinal/sendCount10s/token 指纹（log-only） ([2ef0da8](https://github.com/yeyuan98/zodex/commit/2ef0da8fcd347bd3047b83cada5a04699dd28742))
  * 失败行新增三字段：burstOrdinal（波内尝试位次）、sendCount10s（trailing 10s 惰性时间戳环计数，无 timer）、fp（token 值 SHA-256 前 8 hex）；成功行不变
  * 语义裁定（main-agent checkpoint）：每次出站发送尝试都计入波内——序言/保留积压逐条补发/正文分块/失败通知都打同一发送 API；§2f.10 实测 -2 正是补发波中段死亡（10 连发后第 11 发），排除补发会使限速-vs-瞬态判别在最需要的事件类上失明；spec 同步收紧波定义
  * token 指纹在 persist（值变化时独立 info 行）与发送读取（失败行 fp=）两站点记录；M2 失效实际生效时清除波上下文指纹；硬不变量=token 值永不入任何日志行（测试钉死）
  * 入站与 M2 失效归零 burst 位次；sendCount10s 时间戳环不随波重置（事实计数）
  * 测试：5 个 alpha.5 观测用例按行索引确定性断言（含补发重试计入位次、窗口滑出裁剪、指纹稳定性与缺席条件）


### Bug Fixes

* **cli:** 会话事件 duration/elapsedMs 发射端非负 clamp——修复远端链路负数整事件丢弃 ([54b1cb2](https://github.com/yeyuan98/zodex/commit/54b1cb295b4b7b1093aff4b5b6d3da5048f8883e))
  * 2026-10-02 远端会话 sess_a39948fb 20 次整事件值校验丢弃（turn.completed×7 duration + tool.updated×13 elapsedMs，too_small: expected number >=0）；根因=同机 wall-clock 回拨（NTP 校正/VM 暂停恢复），所有发射点均为同进程 Date.now() 差值
  * clamp 站点（评审穷尽核对）：turn.ts×4（含喂 turn-errors 的 durationMs×2）、rewind.ts×2、compact.ts×2、call-runner.ts:452（tool.updated result duration）、node-execution-adapter-run.ts×2（progress elapsedMs）；logger-only/常量 0/perf.totalMs 明确不动
  * 红→绿测试：三类发射端时钟回拨单测（node:test mock Date.now）；矩阵补 turn.completed 用例（此前为零）+ 负数 fixture 被 host schema 拒绝的 strictness pin（schema 保持 strict 不放宽，specs/bot-provider-network.md alpha.5）


### Chores

* [ulw] 评审收口——fmt 修复 + 失败线取样锚定 + spec 回退语义补记 ([4fc5d9b](https://github.com/yeyuan98/zodex/commit/4fc5d9be7eb7118801985fdc69663c8f0e61ab80))
  * oxfmt 两处超长断言行（services/core 测试）
  * 观测用例 1/4 的失败线取样由 .at(-1) 改为按 fp= 字段锚定（后续边界的无条目补发线不得被误采，评审 MINOR-3）
  * log-diagnostics-hygiene fp 字段补记 as-built 回退语义（同波 M2 删除后的最近读取指纹延续 + 20-peer 逐出角落，评审 NIT-4）


### Documentation

* **specs:** alpha.5 观测契约先行——负数 duration 根因更正 + clamp 设计；weixin -2 失败行观测增强字段 ([9226baa](https://github.com/yeyuan98/zodex/commit/9226baa009b7b93507dffda0acd96b0e77f414b6))
  * bot-provider-network 值类漂移跟进：根因由跨机时钟偏移更正为同机 wall-clock 回拨（所有 schema 约束发射点均为同进程 Date.now() 差值，审计核实）；记录 clamp 站点清单与 per-class 红/矩阵 guard 测试设计
  * 新增 bot-provider-network Alpha 5 amendment：token 指纹 fp=SHA-256 前 8 hex（persist + 发送读取两站点；token 值永不入日志硬不变量）
  * 新增 log-diagnostics-hygiene Alpha 5 amendment：失败行 burstOrdinal（入站/M2 失效归零）+ sendCount10s（惰性时间戳环，无 timer）；两文互链；零行为变化

* **specs:** rig 后裁定补记——命令回复不保留边界（§7.23）+ alpha.5 值类漂移跟进（§7.24）+ 瞬态 -2 类样本（§2f.10） ([35eb5a2](https://github.com/yeyuan98/zodex/commit/35eb5a26eeb74f223d05b731feb760bd22682c90))
  * bot-message-delivery.md Retention buffer：命令回复不做 channel-dead 保留（owner 决定——命令是即时动作，保留的命令回复令人困惑）；保留面维持任务回复分块 + 终态文书
  * bot-provider-network.md M3 amendment：负数 duration/elapsedMs 发射端 clamp 随 alpha.5（schema 保持 strict 不放宽负值）；07:30 revival 中段 -2（tokenAge 3.5s）加入瞬态类样本，服务端归因未定（n=1），观测增强提案记录于 handoff §2f.10

* **specs:** 补记 alpha.4 rig 实测——多波补发为预期形态 + 空闲零重试 + 终态段有界重试噪声 ([c27f818](https://github.com/yeyuan98/zodex/commit/c27f8185c6ddbf3a04a1dd62e515c7d4887096dc))
  * 2026-10-04 rig（handoff §2f）：revival 中途通道再死时积压按 revival 边界分波（11/11 逐条恰好一次，无丢失无重复）；空闲期保留缓冲零重试（整夜无发送尝试）；活跃流式段每 force 边界一次有界重试可产生短时密集失败行（4 分钟 191 次，终态后自止）——均为设计内行为，仅记录不改代码

## [3.14.5-alpha.4](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.3...v3.14.5-alpha.4) (2026-10-03)

### Bug Fixes

* **bots:** channel-dead 保留缓冲 + revival 补发 + /status 待补发行（M1）与 writeContext 陈旧回滚修复（M5） ([9b3ca94](https://github.com/yeyuan98/zodex/commit/9b3ca94119c8e5a3a625b23a2d9e8a27fc8bb028))
  * sendOutbound 缝隙两分类：新增 classifyBotSendFailure（weixinRet=-2 打标 / HTTP 5xx /
  * flush 预算修订：channel-dead 首败即停（不再二次尝试、不发死通道通知），当前分块由缝隙保留、
  * 保留缓冲：service 级 Map（botId::peerKey），watcher dispose 后存活；64KB utf8 字节尾部 cap +
  * revival：任意 weixin 入站触发（不 key 于 token 值变化），入站队列内、命令处理前补发——
  * /status 在保留缓冲非空期间追加待补发行（条数 + 约 KB）；zh/en 新增序言/截断标记/待补发文案
  * 场景 1/2/3/4/6/8/10/12 + 场景 5 分类钉住；scoped 运行

* **bots:** sendOutbound 保留动作包裹 catch，避免掩盖原始发送错误 ([0877950](https://github.com/yeyuan98/zodex/commit/08779502e2b369d28170300c8d4f439d91e14c70))
  * Worker B 评审发现：M1 缝隙保留的 await retainReplyTexts 若抛错会替换原始 provider 错误上抛，调用方分类失真；与 M2 失效同规则 try/catch 包裹并 warn

* **bots:** weixin ret=-2 即失效持久化 peer token（M2）与 writeContext 三字段唯一事实源收紧（M5 补完） ([8981882](https://github.com/yeyuan98/zodex/commit/8981882770c72cb2257126b93885ee4635625466))
  * M2：sendOutbound 失败边界对打标 weixinRet=-2 无条件删除持久化 peer token 条目，停止对死 API 的 double-hammer（tokenless 重试死态 0/131 永不成功）；瞬时 -2 短暂丢失有效 token 为已接受权衡（条目缺席时任何入站无条件重新持久化，早退仅在条目存在时生效），午间形态 fail→invalidate→inbound→re-persist→ok 已被测试钉住
  * M2 防复活竞态：仅当持久化条目 token 仍等于本次发送实际尝试值（与 tokenAgeMs 同点捕获）时才删除，发送在途被并发入站刷新的新 token 不误删；无持久化条目的发送无可失效
  * M2 失效不作为 revival 触发（不触碰保留缓冲），包裹 try/catch 不掩盖原始错误，日志只记 bot/peer 永不记 token 值
  * M5 收紧：weixinContextTokens/weixinGetUpdatesBuf/telegramOffset 三字段以持久化状态为唯一事实源——writeContext 一律写 existing 当前值（缺即保持缺），陈旧任务开始时代 context 不得复活已被 M2 失效或被游标写入方删除的 map/游标；weixinActivatedAt 维持有值保留、缺值用传入（激活写入方恰在持久化项缺失时经 writeContext 落值）
  * 测试（red-first）：场景 7 五用例（-2 失效/非 -2 不失效/午间形态/失效非 revival 触发/防复活竞态）+ M5 复活回归（三字段缺席不被陈旧 context writeContext 复活），沿用 botChannelRetention.test.ts 既有 harness

* **protocol:** M3 CLI→host 会话事件 schema 漂移——mapper 六键源头剥除 + host schema 宽容性 widen + 契约测试矩阵 ([1869dfe](https://github.com/yeyuan98/zodex/commit/1869dfed8536d8a3db9b2c64b2c75fd72c9f9eb8))
  * v3 session-mapper 源头剥除六键闭合集（specs/bot-provider-network.md alpha.4 修订；2026-10-02/03 两天日志实测）：ToolCall* raw-spread 统一 strip readOnly/sideEffectScope/display/skillMetadata（全部 kind 分支，含 started 的 startedAt 归一化路径），mapPermissionRequestedPayload 解构剔除 fullAccessSupported，default 透传对 turn.started 做 executionStartedAt 的 key 定向剥除（非一刀切，其余 default 事件原样透传）
  * host schema additive widen（保持 strict）：tool.updated 基座 +readOnly:boolean/sideEffectScope:七值枚举/display:jsonObject/skillMetadata:jsonObject（optional）；turn.started +executionStartedAt:protocolInstant（optional）；permission.requested +fullAccessSupported:boolean（optional）。End-state 诚实：strip-at-source 使 CLI v3 发射端永不带这些键过线，widen 仅为同仓库路径的宽容性接收；Track B 无法经 v3 消费 fullAccessSupported
  * 新增契约测试矩阵（red-first，修复前 9 断言红）：钉 MAPPER OUTPUT vs HOST SCHEMA——tool.updated 各 kind（含全四键样本）、turn.started（executionStartedAt）、permission.requested（fullAccessSupported）剥除后必须通过 strict schema；冻结 legacy key 白名单（= widen 前 schema 键集）让未来漏进 strip 名单的 emitter 新键在 CI 变红而非运行时静默丢事件；对照 default 透传不变 + 无漂移键 payload 逐字节回归


### Documentation

* **specs:** 3.14.5-alpha.4 通道可靠性 spec 修订（证据锁定） ([d9ec387](https://github.com/yeyuan98/zodex/commit/d9ec38785403f01cf2eb8ecd383e19a93af8bceb))
  * bot-message-delivery.md：F2.3 决定语义句替换为三分类（channel-dead 保留 / content-poison 维持 drop-with-notice）；F2.2 预算语义按类划分；Invariants 预算条目 + 64KB 字节 cap；F1.4 /stop 死窗 carve-out；typing 实测存活事实（§7.19 不暂停）；known-future-work ret=-2 失效项落地声明；deferred alpha.2 游标引用清理；验收场景 2/3 增 channel-dead 变体；新增 Retention buffer 小节（权限提示不保留/无文本缓冲模式/服务 dispose 静默丢失/字节 cap/per-peer 串行化/任意入站 revival + 序言 + /status 待补发行）
  * bot-provider-network.md：实测 token/会话生命周期块替换 ~40min 与 17.5-22.6min 旧口径及 pending-probe 措辞（15-25min 可变 TTL、年龄是代理、任意入站复活、无带外刷新、tokenless 0/131、typing 存活、ret=-2 无条件失效）；新增 alpha.4 M3 协议 schema strip/widen amendment（sideEffectScope 入名单、六键闭合、widen 宽容性、Track B 不能经 v3 消费 fullAccessSupported）

* **specs:** 评审收口——保留缓冲 cap 明确 utf8 字节口径；summary_changes 排除仅指缓冲保留 ([773a96a](https://github.com/yeyuan98/zodex/commit/773a96a9cb38eaaf7b08616075e2982479000d12))
  * 评审发现 1：Invariants 的"UTF-16 按 2 字节/字符换算"与实现（Buffer.byteLength utf8 口径，场景 10 测试钉住）表述不一，统一为 utf8 字节口径并说明 .length 翻倍陷阱
  * 评审发现 4：Retention buffer 小节澄清 summary_changes/streaming_card 排除仅指 flush 缓冲保留，终态文书直发缝隙（16:42 丢失类）不受模式限制

## [3.14.5-alpha.3](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.2...v3.14.5-alpha.3) (2026-10-03)

### Bug Fixes

* **bots:** [ulw] 评审收口——会话信号标记一次性读取 + 权限兜底注释 + spec 补记 ([587f16c](https://github.com/yeyuan98/zodex/commit/587f16cba4c42d1c425b62d64e5e596ab033f2ee))
  * isInboundSessionSignalConfirmed 改为 delete-on-read：业务处理慢于 2 分钟 TTL 时去重键先被 prune 而标记残留，孤儿标记不会再把同 id 后续重投误判为 consumed-session-confirmed
  * 权限休眠分支合成 optionId:"deny" 兜底加注释说明（Track B 继承时须知）
  * spec §B2.1 补记 resolve 回复丢弃口径；§B.6 记录 webhook 验收证据口径（服务级 status proxy）

* **bots:** B2 会话失败信号双向接线 + CLI broker content 透传（alpha.3 B2） ([539fd9d](https://github.com/yeyuan98/zodex/commit/539fd9dc0a55b4d950d1c32cf5149c17cb1ebd0b))
  * submitPendingElicitation 改返回 {confirmed, replies}：confirmed 仅在
  * B2 出站方向（handleElicitationRequest）：提问发送失败（死通道）⇒ 立即以
  * B2 入站方向（processProviderCallback 失败分支，先于 consumed 判定）：
  * B2 权限休眠分支（为 3.15.0 Track B 预铺，force-yolo 下生产不触发）：
  * CLI broker 透传（B2 前置条件）：v4AnswerToUserInputResponse 与 plan-approval
  * 测试（红测先行）：services 场景 7/8/9/12/13（提问发送失败/回答处理失败/
  * 删除 Worker A 预留的 void markInboundSessionSignalConfirmed 占位引用。

* **bots:** 入站毒消息 consumed 契约 + 失败路径去重键保留（alpha.3 B1/C） ([3fe593f](https://github.com/yeyuan98/zodex/commit/3fe593f7b62cf2a7e42049b7802be0d266282189))
  * processProviderCallback 业务失败按"确认送达"判定 consumed：失败通知 sendOutbound 成功，或会话失败信号确认（B2 hook，Worker C 接线）；每个判定恰一行 info（consumed-notice-delivered / consumed-session-confirmed / hole-not-consumed）
  * consumed ⇒ 最终 ok=true 且不携带错误状态：weixin buf / telegram offset / feishu ACK 照常提交，批内后续消息继续处理；仅未消费失败（洞：通知未送达且无会话信号）保持 ok=false + 503 abort-不提交
  * 删除两处失败路径 releaseInboundDelivery 及函数本身：去重键随既有 2 分钟 TTL 过期，同 id 重投被去重吞并 ⇒ 洞规则毒批在一次重投周期内静默丢弃（场景 4/5 钉住）
  * 新增 markInboundSessionSignalConfirmed/isInboundSessionSignalConfirmed（键与去重表同构，随同一次 TTL 清理）供 B2 wiring 标记会话信号确认
  * http.ts 503 映射注释更新为 §B.6 语义（consumed 失败 ⇒ 200）；feishu runtime 补 ACK 策略注释（§B.5 残留按钮接受），无行为改动
  * 新增 test/botInboundResilience.test.ts：spec 场景 1/2/3/4/5/11（服务级 + weixin/telegram 轮询级游标断言），红测先行

* **bots:** 无模型草稿可执行指引 + /status //new 未设置标签（alpha.3 A） ([aa1bd82](https://github.com/yeyuan98/zodex/commit/aa1bd82d767db1071ee3f4636c5aeef59f3a0c44))
  * 草稿首发路径（无 preferred 可解析或 selectionIssue）不再 throw
  * 新增 locale key（zh/en）：draftModelMissing（从未选择——引导 /model
  * formatStatusModelLabel 增加 locale 参数并贯穿 4 个调用点
  * Step-0 预检结论：桌面端同形态由 useDraftModelReadinessGate 在 UI
  * 测试（红测先行）：botInboundResilience 场景 6——无模型 prompt

* **bots:** 轮询错误 backoff 递增 5s→60s 封顶 + 成功复位（alpha.3 D） ([b476e20](https://github.com/yeyuan98/zodex/commit/b476e20ceecaf4f646eb9c0edaeb6512a3b73708))
  * channelRuntime 新增纯状态机 createPollErrorBackoff()（nextDelayMs/recordSuccess，
  * weixin：poll-error catch 的固定 5s 改为递增退避；成功周期（读取→处理→buf 提交
  * telegram：内层 getUpdates 循环三个 error-catch 等待（非 409 HTTP 错误 / 无效
  * 语义不变边界：409 专属 10s、weixin/telegram lock 竞争 10s 与锁 I/O 失败 5s
  * 场景 10 红测先行：纯单元序列 5/10/20/40/60/60 + 复位；telegram 双 bot 接线级


### Documentation

* **specs:** bot-provider-network F4 游标重划定落地为 alpha.3 指针 ([aa7fb58](https://github.com/yeyuan98/zodex/commit/aa7fb5847b6fa6991525e220eac26cb3edfe8b0a))
  * F4 deferral note（deferred to alpha.2）标记 SUPERSEDED——由 bot-inbound-resilience.md §B 拥有
  * telegram cursor dead-end note 标记 SUPERSEDED（§2b rig 证据落地）
  * 新增 alpha.3 amendment 指针节：本 spec 保留 transport/observability/游标写机械，consumed 判定归新 spec

* **specs:** 新增 bot 入站韧性 spec（3.14.5-alpha.3，spec-first） ([ea88c4a](https://github.com/yeyuan98/zodex/commit/ea88c4a033306289861a908b0e007033b83a3cbd))
  * specs/bot-inbound-resilience.md：§2b 毒消息死锁的契约化——consumed 语义（通知送达或会话信号确认 ⇒ 游标推进，全 provider 含 webhook 200）
  * 洞规则精确化：去重保留后毒批在一次重投周期内静默丢弃（有界自愈）
  * B2 会话失败信号：整组一次 resolve、布尔判别重构、CLI broker content 透传前置条件
  * 13 个红测先行验收场景（新增 feishu 同步卡片失败路径、中段 elicitation 整组 resolve）
  * Fix D backoff 5→60s 纯状态机 + 每次 fail 一行 warn（rig T6 可读）

## [3.14.5-alpha.2](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.1...v3.14.5-alpha.2) (2026-10-03)

### Features

* **bots:** 3.14.5 Alpha 2 PR1——通道观测埋点 + 日志治理（零行为变化） ([95480df](https://github.com/yeyuan98/zodex/commit/95480df751a00d1335ad7e179c5390fcbc3852fc))
  * 微信错误结构化打标：两个 request 助手补 weixinErrcode，HTTP !ok 补
  * sendOutbound 结果线：两条出站路径（缓冲流式回复 + 终态文书）的唯一汇合点
  * 微信 typing 观测：失败 warn 30s 限频（惰性时间戳，非 timer）附 ret/errcode；
  * 计数器注册表聚合（R1 bots.* 恒零根修）：同名多实例由"后者覆盖"改为全部
  * D1 rpc 轮询治理：四个高频轮询方法 OK 降 debug（实测占 2026-10-02 全天日志
  * D2 心跳降频：默认心跳 5→15 分钟；计数器提前写盘收紧为诊断相关键集合
  * D4 设置日志自包含：每本地自然日一条脱敏全量快照（进程首写/当日首写/60s
  * D3 入站消息全文保留（owner 决定）：provider callback 不截断


### Bug Fixes

* **bots:** Alpha 2 PR1 评审收口——file= 路径保留 / capped 标记 / D4 模块拆分 ([a87684f](https://github.com/yeyuan98/zodex/commit/a87684f4039eab1bf9f9d8aca51218cc3d055f7b))
  * MINOR：设置快照/增量行补回 file=<settingsFile>（旧 "writing settings to" 行
  * NIT：增量上限改 capped 标记——恰好 30 条自然变更不再误报 "(+more)"
  * NIT：删除无断言的空测试；快照行断言补 file= 存在性
  * NIT：readPersistedWeixinPeerToken 派生自 entry 读取器（读/写口径唯一）
  * max-lines 门禁：D4 助手拆分为 setting/settingLogHygiene.ts（纯日志模块，

## [3.14.5-alpha.1](https://github.com/yeyuan98/zodex/compare/v3.14.5-alpha.0...v3.14.5-alpha.1) (2026-10-02)

### Bug Fixes

* **bots:** 3.14.5 Alpha 1——bot 出站消息投递可靠性（卡死/粘连气泡根修） ([2aa645f](https://github.com/yeyuan98/zodex/commit/2aa645ffc441cb02d96d6fe338c793c852683a78))
  * F1 单一 drain owner（disposeTaskWatcher + taskWatcherDisposals 注册表）：
  * F2 无损有界 flush（trim-on-success）：缓冲只推进过已成功送出的分块；首个
  * F3 交互边界 flush：permission/elicitation 提示前文本 provider 先送出已缓冲
  * F4 微信文本 token 平权：requestWeixinJson 标记 weixinRet；文本 sendmessage
  * F5 飞书熔断复位 + 终态 half-open：成功同步关闸（旧实现永不复位，卡片冻结
  * F6 provider 诚实发送：Telegram 检查 plain-text 兜底响应（!ok 即抛，含双状
  * F7 终态正文先行：drain（含正文 flush）先于 readTerminalTaskMeta/
  * F10 观测：forced flush（taskId/分块/字节）、watcher create/dispose（含原

## [3.14.5-alpha.0](https://github.com/yeyuan98/zodex/compare/v3.14.4...v3.14.5-alpha.0) (2026-10-02)

### Features

* **bots:** 3.14.5 Alpha 0——入站附件远程可达 + /file 出队 ([012f8e5](https://github.com/yeyuan98/zodex/commit/012f8e58a289cfc34c83f880ca5d1e093ff1a67d))
  * prepareBotMessageContent 此前只给 image/audio 造 ZCodePromptAttachment，
  * 现在 file/pdf/video 同样产出 attachment（localPath 必带、sizeBytes 用缓存
  * image/audio 行为逐字节不变（dataBase64 剥离 deferred 到 preview E2E 后再定）
  * 本地行为变化（有意、已写入 spec 与发布注记）：bot 发来的 PDF/文件成为原生
  * /file 此前整体跑在 enqueueInboundProcessing 的 per-actor 串行队列内，远程
  * 现在快速准入（授权/断连门槛、adapter 能力、空路径——文案与顺序逐字不变）
  * 不变量：准入每次调用在 ack 前重评；/file 不改写 task/context 状态；微信
  * 新增 services botInboundAttachments.test.ts（file/pdf/video 矩阵、image/audio
  * 新增 desktop remotePromptAttachments.test.ts（包装器从零建测：无附件透传、
  * botFileDelivery.test.ts 6 处 /file 用例改为断言后台结果回复（文案不变）
  * 验证：services 203/203、desktop 38/38、server bundle E2E 10/10、根


### Bug Fixes

* **architecture:** bots 契约拆分浏览器安全子契约与 Node 装配入口（评审 B1/M1） ([5f02052](https://github.com/yeyuan98/zodex/commit/5f020525e13906717fa06217bdb8f04a32e499fc))
  * 评审复现的 BLOCKER：单一 contract.ts 让根 index（浏览器入口）静态连带
  * 浏览器 import 图守卫（esbuild --platform=browser 打包 src/index.ts）：构建
  * 修正 CONTRACT.md 依赖事实（M1）：跨包依赖补 @zcode/provider 与 Node 内置；
  * 修正 CONTRACT.md 对 node.ts 导出面的事实描述（MINOR-1）：


### Chores

* **architecture:** 声明 bots 模块——contract 前门 + 契约文档 + policy 登记 ([61db81d](https://github.com/yeyuan98/zodex/commit/61db81dd3eb489f3f7bbe2b690e7c9b4c2e1b1e4))
  * architecture-policy.yaml 新增 bots 模块登记（roots=packages/services/src/bots，
  * 新增 packages/services/src/bots/contract.ts 作为模块唯一公共前门：再导出
  * 新增 bots/CONTRACT.md：职责、公共面、状态所有者（bot state repo、
  * services 包入口收敛单一路径：index.ts/node.ts/accessor.ts 的 bots 再导出与
  * 纯模块图改动，零行为变化：services 198/198 测试通过，tsc/oxlint/oxfmt、

## [3.14.4](https://github.com/yeyuan98/zodex/compare/v3.14.4-alpha.6...v3.14.4) (2026-10-02)

### Documentation

* **specs:** 标记 Alpha 5/6 已发布并 rig 验证通过，3.14.4 train 收官 ([22516e5](https://github.com/yeyuan98/zodex/commit/22516e5da4648aaab11c08b0db3fb3e3c4f543a1))
  * bot-file-delivery.md 状态块：Alpha 5 shipped @ alpha.5（飞书 rig 全过；Telegram 因 GFW 网络事故受阻，根因经 live rig 证实，Alpha 6 代理修复后端到端验证）；Alpha 6 shipped @ alpha.6 rig 验证通过；train 完成 → 正式 3.14.4
  * bot-provider-network.md 状态块：SHIPPED @ alpha.6（PR #11）+ 2026-10-02 owner rig 验证明细（代理生效 bind//file/对话投递、菜单自愈、无代理时错误详情可见、飞书/微信回归干净）

## [3.14.4-alpha.6](https://github.com/yeyuan98/zodex/compare/v3.14.4-alpha.5...v3.14.4-alpha.6) (2026-10-02)

### Features

* **bots:** Alpha 6 F0+F0b——失败自宣（真实原因可见）+ 恢复自愈（菜单自动重同步） ([bf9d863](https://github.com/yeyuan98/zodex/commit/bf9d863d570b97ffb7e657ea0293565c17897e95))
  * telegram poller catch-all 绑定并透出真实错误：messageId 摘要不变、message 追加根因、logger.warn 落盘（事故根因曾被通用 catch 吞掉，owner 端只看到「机器人连接失败」）
  * setRuntimeStatus 对进入 error 的转换统一 warn 一次（单点覆盖三家 runtime；仅 provider 错误串，绝不记 token）
  * UI 全渠道展示错误详情：BotSummaryCard 次行 + tooltip 兜底；ProviderSettingsCard 将飞书专属错误面板镜像到 telegram/weixin（复用 DetailPanel/CircleAlert，新增 errorDetail/unknownError 双语 key）
  * saveBot 返回新增 resolveNameError（纯增量字段）：token 不可达时 add 流程以 warning toast 显式暴露，配置仍保存为本地事实
  * F0b 自愈：error→polling 恢复后首个成功 getUpdates 周期触发一次 syncCommands（持续故障期间不刷 setMyCommands），后续周期静默，再次故障-恢复可重触发
  * 测试：错误根因透传/进入 error 告警、resolveName 失败-成功-无凭据三态、恢复触发恰一次 + 再触发，UI 错误详情契约（无 React 渲染 harness，面板渲染为 typecheck 级，已披露）

* **bots:** Alpha 6 F1——bot provider 全部出站流量走可注入 fetch，桌面复用应用代理设置 ([aa59342](https://github.com/yeyuan98/zodex/commit/aa593422523ac405f51653b94b3bbe925029be07))
  * providerRequest 重构为 createBotProviderRequester(fetchImpl) 工厂，三个有界助手成为闭包；零模块级单例，既有调用方全部迁移
  * BotsServiceDeps 新增 providerFetch 注入：单实例 requester 贯穿 5 家 provider 工厂、3 个 channel runtime、attachment 兜底下载与 4 个注册方法
  * 收编全部裸 fetch 出站点（规格点名 5 处 + rg 追加 3 处：attachment downloadUrl 兜底、飞书/微信应用注册），src/bots 下裸 fetch 清零
  * 组装根：services/node.ts 传 hostApiNetworkTransport.fetch（settings 代理一处覆盖 AI+bot，零新增 UX）；attached 远端经 host/index.ts 活动传输 fail-closed 注入
  * 语义：未配置代理 = globalThis.fetch，与 alpha.5 字节级等价（零漂移）；传输销毁错误直传，绝不回退直连
  * 新增 botProviderNetwork.test.ts 9 例：工厂注入/默认、5 站点路由（含 AES 往返、真实后台轮询 deleteWebhook+getUpdates）、无代理零漂移、fail-closed 零全局兜底调用


### Bug Fixes

* **bots:** Alpha 6 F4——外部游标永不静默丢弃，红测先行钉死两类无限重投 ([1642e73](https://github.com/yeyuan98/zodex/commit/1642e73e5da9ee81eee0e5eafabe0ab7620a2e0d))
  * writeTelegramOffset/writeWeixinGetUpdatesBuf 在无 state entry 且无可解析 workspace 时原样丢弃写入：Telegram offset / 微信 getUpdates buf 丢失后同一批消息每个轮询周期重新拉取、重复回复
  * 修复：无条件持久化。已有 entry 行为不变；有可解析 workspace 照旧建全量 entry；无可解析 workspace 写「仅游标」entry（workspacePath 用 zcode://unresolved-bot-workspace 哨兵，满足 schema min(1) 且可识别），经 botsStateFileSchema.parse 往返校验
  * 连带防护：readContext 不得把仅游标 entry 当可用 context（否则哨兵路径会流入任务 cwd）——按「无 context」处理，与修复前 UX 一致；首次真实 context 写入时 pickPersistedBotCursors 携带游标，不丢批次
  * 红测证据：无 entry+零 workspace 场景在 HEAD bf9d863 上 3 例 fail（telegram/weixin 丢写 + 仅游标被误当 context），修复后 194/194 全绿


### Documentation

* **specs:** Alpha 6 规格先行——bot provider 网络走应用代理 + 失败可观测 + 游标永不静默丢弃 ([3e9b5b9](https://github.com/yeyuan98/zodex/commit/3e9b5b9d62eb0fd65218e01bc9ea0fb46fba933f))
  * 新增 specs/bot-provider-network.md：记录 2026-10-01/02 生产事故（Node fetch 无视代理，GFW 网络下 Telegram 全部超时）与 live-rig 双向验证结论
  * F1：providerRequest 工厂化 + BotsServiceDeps.providerFetch 注入 + 复用 host API 网络传输（settings 代理一处生效）；5 处裸 fetch 全部收编；无代理零漂移；传输销毁 fail-closed
  * F0：poller catch-all 绑定并记录真实错误；错误态转换落日志；UI 对全渠道展示详细原因；add 阶段 resolveName 失败显式暴露
  * F0b：error→polling 恢复时自动重同步 Telegram 命令菜单
  * F4：writeTelegramOffset/writeWeixinGetUpdatesBuf 无条件持久化（红测先行）
  * bot-file-delivery.md 状态块追加 Alpha 6 指向

## [3.14.4-alpha.5](https://github.com/yeyuan98/zodex/compare/v3.14.4-alpha.4...v3.14.4-alpha.5) (2026-10-01)

### Features

* **bots:** Alpha 5 /file 可发现性——/help 双语文案 + Telegram 原生命令菜单 + CLI 工具描述更正 ([0e173dc](https://github.com/yeyuan98/zodex/commit/0e173dc3ba6bcb7f800aa28dc002460dfc1dd5d3))
  * BOT_MENU_COMMAND_ORDER += file（置于策略命令后、bind 前；不进 BOT_POLICY_COMMAND_ORDER——那是 keyof BotCommandPolicy 的设置命令清单）
  * helpMessageByCommand + messages.ts 新增 helpFile：zh「/file <路径> — 发送工作区内的文件（仅私聊，≤5MB）」/ en 对应文案
  * telegramCommandNames/Descriptions 注册 file，buildTelegramCommands 自动收编且 allowedCommands.file 显式 false 时排除（缺省允许语义不变）
  * CLI share_file 工具描述由「仅微信私聊」更正为 WeChat/Telegram/Feishu/Lark 私聊四通道
  * 新增 botHelpCommand 测试（zh/en 文案、菜单位置、file:false 隐藏）+ telegram syncCommands 两行（默认包含/显式 false 排除）

* **bots:** Alpha 5 Telegram 出站投递——sendAttachment 走 sendDocument ([e35e469](https://github.com/yeyuan98/zodex/commit/e35e4693c6ba4d136b754ac929aecdfd36f4a33d))
  * telegramProvider 新增 sendAttachment：一律 sendDocument（不做重压缩），multipart 走全局 FormData/Blob（Node 24 原生），不手工设 content-type
  * chat_id 复用既有 sendMessage 路径的 providerUserId 推导，零新增身份管道；收件人真相仍在 host 侧 taskDeliveryRegistry
  * 显式 60s 超时（providerRequest 默认 15s 对 5MB 上传过短）；payload.ok!==true 抛错并携带 description，由服务层映射 send-failed
  * 凭据缺失直接抛错（send 的静默返回会向调用方谎报成功，出站投递必须诚实）
  * 新增 fetch-stub 测试：happy path（URL/chat_id/文件字节/60s deadline 直接观测）、API 错误透传 description 且零重试、无凭据拒绝

* **bots:** Alpha 5 通道扩宽——telegram 目标枚举/谓词/producer 三点解锁 ([b18974f](https://github.com/yeyuan98/zodex/commit/b18974fb08d54f8f512818d428b15b8cb9c5d3bc))
  * zcodeAutomationBotDeliveryTargetSchema.provider 枚举 += telegram（线上为增量字段，旧端按既有枚举严格解析，已按 owner 决策 A 接受 -32602 退化）
  * botShareFileDeliveryTargetQualifies 由 weixin 单通道扩到 weixin/telegram/feishu/lark（仍仅私聊、仍排除 automation/off-peak）；三处 deny 站点消费同一谓词自动扩宽
  * resolveAutomationBotDeliveryTarget 为 telegram 发目标，但仅私聊（owner 决策：telegram 群聊永不发目标；副作用：telegram 私聊 bot 获得定时任务完成回推）；feishu/lark/weixin 行为不变
  * 谓词矩阵扩宽：四通道私聊正例 + 群聊/automation/off-peak 负例
  * services 增 telegram 私聊 producer 正例、weixin/feishu 对齐行、telegram 群聊零目标回归（群聊在 withAuthorizedContext 已被拦，作为纵深防御锁定）

* **bots:** Alpha 5 飞书/Lark 出站投递——im/v1/images 内联图 + im/v1/files 文件气泡 ([7b3f643](https://github.com/yeyuan98/zodex/commit/7b3f643181f472f3f377c1b211b45f880d5f44e6))
  * feishuProvider 新增 sendAttachment：kind=image 走 im/v1/images 上传后 msg_type:image 内联渲染；video/file 走 im/v1/files 后 msg_type:file 文件气泡
  * file_type 按扩展名精确映射 pdf/doc/xls/ppt/mp4/opus，无歧义 mime 兜底，其余一律 stream；receive_id 复用既有 send 路径推导（ou_→open_id / oc_→chat_id），零新增身份管道
  * 0-byte 文件在上传前诚实失败（飞书 API 拒收空文件，先查后传省一次注定失败的网络往返）
  * 上传与发送均显式 60s 超时（默认 15s 对 5MB 上传过短）；业务错误经 createFeishuMessageError 透传 code/msg/log_id（入参放宽为结构化 payload，既有调用方行为不变）
  * 不触碰流式卡片/瞬时卡片机制：媒体作为独立消息气泡送达
  * 负例 stub 迁移：unsupported-provider 判定由 feishu 改为真实无 sendAttachment 的 webhook（feishu 现已具备该能力）
  * 新增 6 项 fetch-stub 测试：图片链路、pdf 链路、mp4/opus/未知扩展映射、0-byte 零上传、业务错误字段保全、凭据缺失诚实抛错


### Documentation

* **specs:** Alpha 5 规格先行——Telegram + Feishu/Lark 出站文件投递 ([310e17f](https://github.com/yeyuan98/zodex/commit/310e17f7c0b8cfa859b392bdddd7c701920e581e))
  * 新增 Phase C Alpha 5 章节：同一 single writer，新增两家上传 adapter，通道资格扩宽
  * 四处扩宽点定稿：provider 枚举 += telegram；共享谓词扩到四通道（仍仅私聊）；producer 仅 telegram 私聊发目标（owner 决策）；三处 deny 站点随谓词自动扩宽
  * 明确 owner 已批准的副作用：telegram 私聊 bot 获得定时任务完成回推（群聊不变）
  * Telegram sendDocument（显式 60s 超时）；Feishu 按 kind 走 im/v1/images / im/v1/files（file_type 映射、0-byte 上传前诚实失败、复用 receiveId/错误增强、不触碰流式卡片）
  * /help 终于列出 /file（zh+en，含 Telegram 原生命令菜单，尊重 allowedCommands.file）
  * 版本混用退化定稿（owner 决策 A）：旧远端对 telegram 目标的 -32602 整轮失败为已接受的自愈式降级，不加兜底重试
  * 默认开启发布语义：合入即对所有 telegram/feishu bot 生效，回滚 = 按 bot file:false
  * 验收场景：谓词矩阵/producer/两家 adapter fetch-mock/负例 stub 迁移/微信零漂移/help/手动 rig 清单

* **specs:** mark Phase C Alpha 2-4 shipped + rig-validated; next = Alpha 5 channels ([c5763ad](https://github.com/yeyuan98/zodex/commit/c5763ad55d4c6125a9e54a11a14f391ab6fd1462))
  * 状态头更新：Alpha 2/3/4 均已发布（3.14.4-alpha.2/3/4），Alpha 4 于 2026-10-01
  * Phase C 手册 rig 清单标记为已验证（含 alpha.3/4 两轮累计覆盖项）
  * 下一里程碑指向 Alpha 5（Telegram/Feishu 出站），计划见 ../ZCode-handoff.md §4

## [3.14.4-alpha.4](https://github.com/yeyuan98/zodex/compare/v3.14.4-alpha.3...v3.14.4-alpha.4) (2026-10-01)

### Features

* **bots:** alpha4 诊断足迹——生产 unsupported-method 链路自宣 ([f00a638](https://github.com/yeyuan98/zodex/commit/f00a638788988942bc391e5dfa1f2be3d5cf4d41))
  * [R2] share_file unsupported-method 散文补上 ${detail}（与 send-failed 同款），
  * [R5] 远端 forwarder 就绪门折叠携带稳定 detail 签名
  * [R1] CLI bot-file-share-port 每次尝试留日志：结构化结局（无 rpc 错误）显式一行；
  * [R8] entry-stdio 装配足迹一行：authority=<mode> forwarder=ready|absent(client=absent)
  * [A4] connect.ts 记录 desktop ChannelServer 构造决策（含 serveDesktopChannels 原值）；
  * spec：bot-file-delivery.md Phase C Alpha 3 增补 Instrumentation 足迹段
  * 测试：旧桌面折叠用例断言稳定 detail 字符串并经共享 schema 钉住 detail 保真


### Bug Fixes

* **server:** review-round fixes — coalesced-frame windows + bundle freshness (Alpha 4) ([70dbb02](https://github.com/yeyuan98/zodex/commit/70dbb0226b9accec41783c7d51df94b377bad5e7))
  * BLOCKER（评审在 Node 22/24 实证）：合包形态下 waitForAck 对 remainder 的
  * 新发现三段 Bug（合并块 E2E 腿首跑即崩）：握手把 stdin 累积为 UTF-8 字符串
  * E2E 新增合并块腿（同 tick 写入合并器复刻 ssh2 合包形态）+ 分离块腿并跑；
  * 诊断日志修正：entry 装配行去掉不可达分支；connect.ts 握手 unshift 补同款

## [3.14.4-alpha.3](https://github.com/yeyuan98/zodex/compare/v3.14.4-alpha.2...v3.14.4-alpha.3) (2026-10-01)

### Bug Fixes

* **bots:** forward remote share_file to desktop single writer (Phase C Alpha 3) ([7209b29](https://github.com/yeyuan98/zodex/commit/7209b296918809f940c51e4bb61245ad1ad52e42))
  * 窄化 channel: 新增 IBotShareFileForwardService（单方法 forward，channel
  * 传输: 同一条 stdio protocol 双向服务——桌面 connectRemote 在既有
  * 装配裁决: createBotsShareFileExecutor 收敛 node.ts 1812 语义——
  * 身份钉扎: shareFileForTask 新增可选 restrictToWorkspaces（仅桌面
  * 失败矩阵: 旧桌面不回 Initialize → 立即 unsupported-method（不排队，
  * 桌面装配: window Host 在远程连接上注册 forward channel，钉扎作用域
  * 测试: services botShareFileRemoteTopology 5/5（生产装配翻转 ok、

* **bots:** remote workspace file read accepts absolute-inside paths (Phase C Alpha 3) ([647bdf7](https://github.com/yeyuan98/zodex/commit/647bdf79fcd5f0dfff995c50a1eba92f2c0eb0dd))
  * 词法分支改为：绝对输入原样 normalize 后直接做 containment 前缀裁决，相对输入仍 join(root)；绝不 join(root, absolute)（会把 /etc/passwd 错拼成 <root>/etc/passwd，把越权逃逸变成同名文件误读）
  * containment 表达式与相对分支/本地 resolveWorkspaceFilePath 完全一致（分隔符边界前缀比较）；realpath 层不变，绝对-outside 与 `..` 逃逸（相对/绝对形式）仍拒
  * spec Phase C Behavior 2 与验收场景 6/9 更新为平价口径；wire 字段名保持 relativePath（additive，不破坏旧远端 CLI）
  * transport.ts 与 CLI gateway 的「只接受相对路径」陈旧注释同步修正；gateway 逻辑零改动（消费更新后的 shared 策略）
  * shared 策略矩阵补绝对-inside/绝对 `..` 逃逸/跨 OS 盘符输入 + 绝对与相对形式同文件断言；services 新增远程绝对路径平价测试（reader 原样收到绝对路径、绝对-outside → typed 拒绝零投递）

* **bots:** review-round fixes for alpha3 forward channel + path parity ([43b541f](https://github.com/yeyuan98/zodex/commit/43b541f611f6510da5a49f9f2da64cf6e2722efa))
  * BLOCKER（Initialize 竞态，评审者实测复现）：远端 forwarder 原在构造期订阅
  * 钉扎作用域过滤收敛为纯函数 resolveOnlineRemoteWorkspaceScopes（独立文件），
  * connectRemote 新增 serveDesktopChannels 开关：仅桌面窗口 Host 构造
  * forward-pin 审计日志去掉重复的 file= 字段；desktopChannelServer 类型移除

## [3.14.4-alpha.2](https://github.com/yeyuan98/zodex/compare/v3.14.4-alpha.1...v3.14.4-alpha.2) (2026-10-01)

### Features

* **bots:** deliver remote workspace files via /file + share_file (Phase C Alpha 2 items 1,5-9) ([900fbf5](https://github.com/yeyuan98/zodex/commit/900fbf5004744aa65df5ea46c878a592babfeb33))
  * 投递核心: deliverWorkspaceFile 用远程分支取代 remote-workspace 硬拒绝
  * 失败映射: 新增协议 reason remote-unavailable（bridge 缺席/无路由/
  * /file: 移除远程前置拒绝（Alpha 0 回复顺序注释按 spec §9 更新），
  * 协议镜像: shared botShareFileFailureReasonSchema 与 CLI contracts
  * 审计: 远程尝试追加 remote=<workspaceIdentity>；path= 用 workspace
  * 测试: services botFileDelivery 套件 57/57（远程 /file+tool happy

* **bots:** remote workspace file read wire + bot-only channel (Phase C Alpha 2 items 2-4) ([817027d](https://github.com/yeyuan98/zodex/commit/817027d74fd6fe757af9a6df7818b1dbf28e8759))
  * wire: 新增 v4 方法 v4/bot-workspace-file/read（V4_METHODS + strict zod
  * 策略: packages/shared 新增纯路径/配额 helper（botWorkspaceFilePolicy）——
  * CLI 网关: bot-workspace-file-read.ts 薄壳（realpath→containment→fd stat
  * bot-only 锁: AttachServicePort schema 增 additive attachmentKind:
  * 窄化 channel: IBotWorkspaceFileService 单方法 descriptor（services）；
  * bridge: createBotRemoteWorkspaceService 增 getWorkspaceFileReader
  * 兼容: 旧远端 CLI（-32601）/旧远端 server（channel 缺席）统一折叠为结构化
  * 测试: shared 43/43（wire strict + POSIX/Windows 路径矩阵 + realpath 逃逸 +


### Bug Fixes

* **bots:** review-round fixes for remote workspace file delivery ([a86a342](https://github.com/yeyuan98/zodex/commit/a86a3429d12042d92229476a297fbdb1e27bff6b))
  * BLOCKER：desktop host 包装曾用 strict v4 schema 直接 parse service 层参数，
  * 安全关键路径抽取为 createScopedBotWorkspaceFileService 纯函数并新增
  * 临时目录收紧为 0700（recursive mkdir 默认 0755 会暴露文件名列表）
  * 文件名截断 160 → 120，给 Windows MAX_PATH 深路径留余量
  * 测试补强：累积 5MB 上限用例改用 sizeBytesAtChunk 钉住 stat，真正命中
  * spec 对齐实现事实：quota reserve 位置（shareFileForTask 入口前）、


### Documentation

* **specs:** mark bot-file-delivery Phase B as shipped in 3.14.4-alpha.1 ([bf2b7af](https://github.com/yeyuan98/zodex/commit/bf2b7af8d86e49d7a94f3cf5c80085af26ce1327)), closes [#4]()

* **versioning:** release:alpha requires explicit --increment (train-jump incident) ([d2248b1](https://github.com/yeyuan98/zodex/commit/d2248b1e60bbe0943d4f55c22d6ea41892484946))
  * plain pnpm release:alpha empirically minor-jumps the train (2026-09-29
  * --increment=prerelease observed to minor-jump as well: do not use
  * correct usage: continue train with full version (--increment=3.14.4-alpha.1);
  * keep the dry-run package.json side-effect warning co-located

## [3.14.4-alpha.1](https://github.com/yeyuan98/zodex/compare/v3.14.4-alpha.0...v3.14.4-alpha.1) (2026-09-29)

### Features

* **protocol:** bots/shareFile RPC + share_file tool gating (CLI) ([340354a](https://github.com/yeyuan98/zodex/commit/340354a777b5f5c198f17d8fd3024893a74a0e90))
  * shared: SHARE_FILE_TOOL_NAME、BotShareFileResult 判别联合（11 种 failure reason）与 strict zod schema；bots/shareFile 请求严格 { taskId, path }，收件人字段一律拒绝
  * protocol: zcodeProtocolMethods 注册 bots/shareFile（schema 放叶子模块由 barrel 再导出，保持 node --test 可直跑校验）
  * contracts: share_file 工具输入 schema（仅 path）+ BotFileSharePort 端口契约
  * core: share_file ToolEntry（honest 结局文案、无审批流、providerVisible）+ ToolExecutionContext/executor/runtime deps 全链路端口透传；注册门 includeBotFileShare = 端口在场 && taskType !== subagent_child
  * bootstrap: bots/shareFile 端口实现——taskId 取自归属 session id；无 activeBotDeliveryTarget fail-closed no-target；-32601 → unsupported-method；超时(300s，高于 provider 上传+发送 ≈225s 最坏预算) → unknown-outcome；其余传输错误 → send-failed
  * per-turn 禁用名单：legacy buildPromptTurnToolDisallowlist + v4 buildTurnToolDisallowlist + zcodeTaskServiceAdapter resolvePromptToolDenylist 三处同值镜像——仅 weixin 私聊且非 automation/off-peak 轮放行 share_file（披露：非 bot 轮携带单项 deny，语义 no-op，additive）
  * tests: packages/shared/test/botsShareFile.test.ts（strict 拒绝未知键、空/空白 taskId/path、全部 reason 往返、barrel 注册源码扫描断言）

* **services:** conversational bot file delivery via bots/shareFile ([d2aff1a](https://github.com/yeyuan98/zodex/commit/d2aff1af4c51e284d2133327119677b4152bd0c1))
  * deliverWorkspaceFile：/file 鉴权后核心抽为单一媒体写出入口（/file 与 RPC 同源，adapter.sendAttachment 唯一调用点）；准入每次重评并复用 withAuthorizedContext 原语（findAuthorizedBot/findBoundUser/isUserCommandAllowed），失败映射回既有本地化文案（/file 零行为变化）；读取前 re-realpath + 大小重校验（symlink-swap TOCTOU 防护，含 stat 与读取间增长）
  * taskDeliveryRegistry：仅两处对话式 watchTaskStream 调用点登记（有界 200 淘汰最旧）；watchAutomationRun 复用 bot 会话时删除既有目标（automation 轮不得重新武装）；流终态与 disposeAll 清理
  * tool 专属滚动配额：每 (botId, peerKey) 10 分钟 3 次 AND 1 小时 20 次，纯内存（规避 writeContext token 回写竞争），文件 IO 之前裁决；/file 永不受限；tool 路径优先最新持久化 context_token，捕获 token 兜底，provider 内 ret=-2 重试不变
  * 审计增强：每次尝试记录 bot/peer/file/size/outcome + source=command|tool、task、workspace 相对路径
  * host 路由 + 装配：zcodeAgentService 新增 botsShareFileExecutor 选项与 bots/shareFile handler（W2 strict schema 拒绝任何收件人字段；未装配 host 返回 -32601 → CLI unsupported-method）；node.ts createLocalServices 按 OffPeak 前向引用模式接线到 botsService.shareFileForTask
  * tests：注册表（对话登记/automation 删除/终态清理/有界）、守卫矩阵（no-target、not-allowed×4、unsupported-provider、remote-workspace、outside-workspace×3、not-found、too-large、send-failed）、配额（10 分钟第 4 次拒、1 小时窗口、/file 25 次不受限）、单一写出（成功恰一次/失败零次 + pin 既有回复文案）、strict schema 拒注入字段、无上下文写入、token 偏好、审计字段、revalidate TOCTOU/增长

* **ui:** share_file tool chip + compact summary line ([e7b0f2d](https://github.com/yeyuan98/zodex/commit/e7b0f2d59aec716df54ee60a4b17c9b7936ee02d))
  * name-based renderer branch in resolveRenderer (path from tool input, delivery outcome from output prose; memoized leaf reusing FileDisplayInline chip; no protocol/display-union changes)
  * tool-call-summary compact entry: anchor primaryText on SHARE_FILE_TOOL_NAME when title is absent (path already covered by generic input summary)


### Bug Fixes

* **bots:** review-round fixes for share_file delivery ([405544f](https://github.com/yeyuan98/zodex/commit/405544fa9100f124bc80887790518ebe332c68f2))
  * atomic quota reserve/release: share_file is concurrentSafe and its parallel invocations all passed the pre-IO allows() check before any post-delivery record() landed (TOCTOU bypass of the 3/10min and 20/1h caps); quota tracker gains reserve() (synchronous check+hold before any file IO) and release() (exact-timestamp refund on delivery failure); observable semantics stay "only successful deliveries consume quota"; regression test fires 6 concurrent shareFileForTask calls against a slow adapter — exactly 3 reach sendAttachment, the rest get quota-exceeded
  * shared deny predicate: the weixin+private+clean-turn condition was triplicated across legacy buildPromptTurnToolDisallowlist, v4 buildTurnToolDisallowlist, and the zcodeTaskServiceAdapter mirror while apps/zcode-cli has no test harness; de-duplicated into botShareFileDeliveryTargetQualifies (packages/shared, next to the delivery-target schema) consumed by all three sites (each keeps its own input resolution; v4 keeps its stricter resolveTurnAutomationId fallback) + full matrix tests in packages/shared/test
  * /file gate-order parity restored: adapter capability and remote-workspace guards reply before the empty-path check as in Alpha 0 (drift introduced when the checks moved into deliverWorkspaceFile); deliverWorkspaceFile still re-evaluates every gate
  * registry forget on two missed terminal paths: sendPromptInBackground failure catch and isContextActiveTaskRunning missed-terminal detection now call taskDeliveryRegistry.forget so a terminal task always answers no-target
  * honest send-failed prose: CLI modelContent no longer asserts provider-side failure (host errors like pre-delivery config IO failures never reached the provider); shareFileForTask maps pre-delivery throws to send-failed with "host error before delivery:" detail
  * WeChat text-mode summary status word: share_file failures are normal completed tool results and previously rendered as 完成; formatBotToolCallSummaryLine now derives 已发送/未发送/结果未知 from the output prose with the same three-way logic as the UI renderer
  * docs truthfulness: Phase B coverage note now names the shared predicate matrix tests (apps/zcode-cli has no test harness; builders covered via shared predicate + fail-closed layers + manual rig), scenario 2 re-tagged [shared predicate tests + manual rig], scenario 10 re-tagged [code-verified + manual rig] with the -32022 timeout mapping disclosed as unharnessed; spec adds atomic reserve/release clause, audit field precision (kind= only on success), and the WeChat summary status-word clause; handoff §4/§6 updated to match


### Chores

* release v3.15.0-alpha.0 ([acb644a](https://github.com/yeyuan98/zodex/commit/acb644aace5ae9ae7ea25e57c4003ea797234913))


### Documentation

* **specs:** bot file delivery Phase B spec (conversational share_file) ([38ac229](https://github.com/yeyuan98/zodex/commit/38ac22949cdc1577b4306efa430c1ce833627f56))
  * add Phase B behavior: tool exposure gates, host-side recipient resolution
  * pin Phase B invariants: RPC sole trigger, no context mutation, tool-result-only
  * add all 15 acceptance scenarios with coverage split (unit vs owner-rig manual
  * update owners: CLI runtime, host RPC routing, taskDeliveryRegistry/quota,

* **specs:** correct Alpha 0 single-writer invariant + Phase B precision fixes ([a420b0f](https://github.com/yeyuan98/zodex/commit/a420b0fdeba0f82a753f30e2a6df38c3f3fec4a3))
  * rewrite Alpha 0 single-writer invariant truthfully: handleFileCommand is the
  * clarify token retry ownership: provider-internal ret=-2 retry applies
  * fix markdown glitch in Phase B behavior item 7 (stray nested-list marker

* **specs:** mark bot-file-delivery Alpha 0 as shipped in 3.14.4-alpha.0 ([01aca44](https://github.com/yeyuan98/zodex/commit/01aca44165a2eda761df0aad6464863c42a828f5)), closes [#2]()

* **specs:** oxfmt fix for bot-file-delivery spec ([9798dd9](https://github.com/yeyuan98/zodex/commit/9798dd956919bc1d0a5489d750fab4f34640f705))

## [3.14.4-alpha.0](https://github.com/yeyuan98/zodex/compare/v3.14.3...v3.14.4-alpha.0) (2026-09-29)

### Features

* **bots:** WeChat outbound file delivery via /file command (Alpha 0) ([aa63a31](https://github.com/yeyuan98/zodex/commit/aa63a3173c2eb167a0e16fe1ac2331c9eaa9d0f6))
  * add /file <path> (alias /文件) bot command: uploads a workspace file to the
  * weixinProvider: probe-proven upload pipeline — getuploadurl, AES-128-ECB
  * botsService: workspace-only path policy (lexical pre-check + realpath
  * persist latest per-peer weixin context_token in bot state (bounded 20
  * shared: additive BotOutboundAttachment type, BotOutboundMessage.attachments?,
  * providers: optional BotProviderAdapter.sendAttachment capability;
  * tests: 12 cases pinning wire invariants (padded-size math, aes_key
  * validated: pnpm typecheck, lint, fmt:check, verify:pre-push,

* P8 — Zodex versioning runbook, working alpha opt-out, upstream merge ledger ([2b14d9c](https://github.com/yeyuan98/zodex/commit/2b14d9c156b3c57c083485f43c7eec338c0cee58))
  * specs: P8 amendment revoking D-P5.1 allowPrerelease floor clause (stable v3.14.3 exists; floor made alpha opt-out a no-op); keep single latest.yml + never write autoUpdater.channel; record electron-updater 6.8.3 alpha.yml-probe fallback; rebrand spec: 'final release' framing superseded by ongoing alpha + upstream-merge policy
  * desktop main: resolveAutoUpdaterAllowPrerelease now strictly follows receivePreviewUpdates (single-param pure fn); opt-out semantics = no downgrade, stay until next official surpasses; new isDevPrereleaseAutoUpdateOverrideActive floor OR-ed into init + settings-refresh recompute (fixes override clobber exposed by floor removal)
  * tests: re-pin new allowPrerelease rule (false/undefined → false, true → true); source-scan guard pins dev prerelease floor
  * ui: settings toggle copy gains no-downgrade note; extra hint line when running a prerelease build (ZCODE_VERSION contains '-'), en-US + zh-CN
  * docs: new docs/versioning.md (version policy, on-demand alpha procedure, upstream merge runbook, glossary alpha vs Preview flavor) + docs/upstream-sync.md ledger (baseline row: 3.14.3 = ZCode 3.14.3); docs/updates.md channel semantics rewritten
  * release tooling: pnpm release:alpha (release-it --preRelease=alpha --ci, fresh train starts at X.Y.Z-alpha.0); changelog writer gains trailing 'Upstream' section rendering merge commits as single lines
  * AGENTS.md: release:alpha command row; release-entry bullet reconciled (release / release:alpha same toolchain); post-release check rejects stray alpha.yml/beta.yml channel files


### Bug Fixes

* [ulw] review round — spec history pointers, dev-floor guard hardening, doc nits ([a294c09](https://github.com/yeyuan98/zodex/commit/a294c09babc46bd2b6d4749e077322c877bce8e1))
  * specs/distribution-and-updates.md §A.4: inline strike/pointer to P8 (body text no longer states revoked floor as live rule)
  * specs/telemetry-and-update-policy.md: cross-reference notes floor clause revoked by P8
  * updateFeedPolicyP5.test.ts: dev-floor guard now pins the wired join shape (resolveAutoUpdaterAllowPrerelease(...) || isDevPrereleaseAutoUpdateOverrideActive(), exactly 2 sites) instead of bare identifier
  * autoUpdater.ts: dev override comment clarified (stable dev override is correctly reclaimed by strict-follow recompute; only prerelease overrides keep the floor)
  * docs: ledger title paren, updates.md toggle name aligned to actual label
  * VENDOR-PURGE-PLAN.md: historical floor-rule record annotated as revoked by P8

* **ci:** drop AppImage blockmap from linux release attach — builder does not emit one ([d3da47f](https://github.com/yeyuan98/zodex/commit/d3da47fb849e09b3d35efd253f19dab4c369b74b))
  * v3.14.3 tag run failed on unmatched glob (proof run couldn't catch it: attach steps are tag-gated)
  * AppImage updates fall back to full-file download; mac zip/dmg blockmaps verified produced
  * asset contract corrected to 43 across workflow comment, AGENTS.md, packaging.md, spec


### Documentation

* **plan:** P7 shipped — v3.14.3 released (43 assets), linux attach incident + fix recorded ([fa8c777](https://github.com/yeyuan98/zodex/commit/fa8c77769daae2f6d2f94833de34447fae48258f))

## 3.14.3 (2026-09-28)

### ⚠ BREAKING CHANGES

* rename packaged product identity ZCode -> Zodex
* replace remote builtin-provider catalog download with bundled-only source (P3 C5)
* **desktop:** delete context-prompt rollout + shared client/configs fetcher (P3 C5)
* remove vendor client/configs service + channel; plugin-store order falls back to bundled (P3 C5)
* remove vendor family/specs + de-plan settings provider page (P3 C4)
* **shared,ui:** unpin image-search from default-enabled official plugins (P3 C3, ruling 5)
* remove official MCP service + auth protocol + CLI adapter chain (P3 C3)
* **desktop,shared,web:** remove coding-plan webview/paypal/payment deep-link chain (P3 C2)
* **web:** remove web OAuth auth dir + share landing owner-login (P3 C1)

### Features

* brand-string sweep 2 — residual log/error/overlay strings to Zodex ([71c0b4a](https://github.com/yeyuan98/zodex/commit/71c0b4ae10070d16ceec52852582f50ac9ec63b3))
  * host task-service errors, data scanner, CUA IPC/overlay, in-app browser name
  * server-cli runtime (lock/launcher/update prep), remote-asset preflight copy
  * provider-node + server builtin-config errors; agent provider label + runtime warnings
  * plugin display-name map; native-search/build/distribution script logs
  * kept: protocol name constant, notice marker 'Modified by ZCode:', legacy deep-link

* **catalog:** restore GLM capability metadata rules (P1.1 F1, decision A5) ([e1cc514](https://github.com/yeyuan98/zodex/commit/e1cc5141cc54706a7e0651a6868fe2800453346e))
  * re-add the 24 pre-P1 GLM capability modelRules verbatim from 0ed9c86, original array order preserved (overlay order is load-bearing); the P1-sanitized composite ox-alpha|x-preview-f-free rule is superseded by the verbatim ox-alpha|glm-x-preview-f|x-preview-f-free form (same rule, glm alternative restored) — 84 rules total, matching pre-P1 sequence
  * probe evidence: bigmodel/zai listing endpoints return ids only on both api flavors, so curated capability rules are the only correct-config source for GLM models; 61 equivalent rules for other vendors survived P1 — without the restore, GLM is the only metadata-less major family (violates equal-vendor treatment: glm-5.3 resolved 200k/no-vision instead of 1M; glm-5.3-flash lost vision/video/pdf)
  * catalog invariant refined (A5): glm allowed only inside modelRules modelMatch + capability props; templateModelRules/builtinProviderModelRules stay glm-free (test: parse→null modelMatch→assert; + glm-free subtree asserts; count lock 84)
  * new builtinGlmCapabilityRules.test.ts: glm-5.3→ctx 1M; glm-5.3-flash→image+video+pdf overlay; uppercase GLM-5.3 matches; glm-4v-flash→16384+image
  * master plan: A5 recorded (user sanction quoted; rejected alternative noted), §1 goal 5/§3 row/§4 P1 summary/P6 allowlist annotated, P1.1 section added, alphas re-shifted (P3→alpha.6 … P6→alpha.9) incl. two pre-existing stale refs fixed

* **desktop,shared,web:** remove coding-plan webview/paypal/payment deep-link chain (P3 C2) ([04d0509](https://github.com/yeyuan98/zodex/commit/04d0509e33c534b5e2b89c25159a1b15a2d22701))
  * desktopWindowChrome: 删除 isPaypalHostname / isCodingPlanPaypalNavigationUrl /
  * desktopMainIpcRemote: 删除重复的 paypal/webview 判定块与 openExternal 的
  * preload/codingPlanWebview.ts + tsup 入口：删除（官网 zcodeBridge 购买完成信号链）
  * deep link: 删除 zcode://payment/callback 路由、pending 缓存与
  * 命令面: 删除 DesktopCommandIds.ClearCodingPlanWebviewStorage 与
  * env: 删除 desktopRuntimeEnv 的 ZAI_BUSINESS_BASE_URL 注入、tsup 的

* **desktop:** delete context-prompt rollout + shared client/configs fetcher (P3 C5) ([95ef0a7](https://github.com/yeyuan98/zodex/commit/95ef0a715389e4dccfd13165882c025111ee8ef5))
  * delete desktopContextPromptRollout.ts (vendor /api/v1/client/configs fetcher + rollout): context-prompt pins its local default OFF (A9), still injected as ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED=0 so host presentation-surface folding is unchanged
  * delete singleFeatureRollout.ts mechanism (both consumers gone)
  * rendererActionTraceRollout: local disabled constant (env overrides ZCODE_RENDERER_ACTION_TRACE_ENABLED / ZCODE_LOCAL_TTFT_ENABLED and OTLP exporter chain stay live)
  * remove first-host-spawn bounded rollout decision gate (createWindow option + main wiring)

* **desktop:** switch auto-update to GitHub Releases provider; delete vendor manifest feed + force-update gate ([96da325](https://github.com/yeyuan98/zodex/commit/96da325ed611e06da78c883e9b2721d9d9efe580))
  * electron-updater feed = github provider (yeyuan98/ZCode); single latest.yml
  * bundle.mjs passes --publish never (CI tag builds would otherwise trigger
  * release workflow uploads latest.yml + *.exe.blockmap beside the installer
  * deleted: manifestUpdateProvider, forceUpdateGuard, forceUpdatePrompt,
  * re-enabled all three P0-guarded update paths (production-flavor gate kept);
  * new updateFeedRuntime.ts: allowPrerelease floor rule (previews-on OR
  * refreshAutoUpdaterReleaseChannel flips allowPrerelease + re-checks; dev
  * desktopSecondInstanceDeepLink drops forceUpdate params (signature chain in
  * tests: updateFeedRuntime units (8) + source-scan guards (4: no channel

* **discovery:** parser hardening + optional capability hints (P1.1 F4) ([e583275](https://github.com/yeyuan98/zodex/commit/e583275f488e03eb73ba1e71b2b1c53c02ebcf90))
  * accept both snake_case has_more/first_id/last_id (Anthropic spec) and camelCase hasMore/firstId/lastId (bigmodel/zai legacy mirrors, live-probe-verified); snake_case takes precedence
  * repeated-first-id loop guard: a mirror that ignores after_id and restarts from page 1 stops paging immediately (treat as complete); 10-page cap retained as backstop
  * additive success-result field modelHints: anthropic max_input_tokens(>0)→contextWindow + capabilities.image_input/pdf_input.supported; openai-compat context_length(>0) + architecture.input_modalities ∩ {image,video} (audio/file ignored; 0/null absent); cross-page merge fills absent fields only, never overwrites; keys omitted when no metadata (deepEqual-stable)
  * +7 unit tests: camelCase mirror, snake-precedence, ignored-cursor guard (≤2 requests), anthropic metadata, max_input_tokens:0, openrouter shape, cross-page merge both directions

* **i18n,ui:** rebrand user-visible strings to Zodex ([64a1e8d](https://github.com/yeyuan98/zodex/commit/64a1e8dd7edee759875dc15bc925e77e6988d6b3))
  * locale values (zh/en, ~160 lines) with compound rules (Zodex Agent/CDN/Computer Use); keys + lowercase technical tokens untouched
  * About/tray/deep-link dialogs/export header/service errors/bot help/TUI strings
  * coupled error-match pairs renamed in lockstep (ui matchers <-> services producers)
  * CUA helper app + permission panels; git checkpoint author; CA CN; OpenRouter title
  * CLI TUI PRODUCT_NAME + distribution smoke regex; web titles; e2e welcome heading

* open source ([872ad96](https://github.com/yeyuan98/zodex/commit/872ad960de7ec172591f7e1952f7849229f94521))

* **p0:** remove vendor telemetry (ARMS RUM + 数仓) and disable vendor update paths ([bc4f533](https://github.com/yeyuan98/zodex/commit/bc4f53370f92d135026f2d7847075902e5d7ae78))
  * 删除 Alibaba ARMS RUM 遥测链路：appARMSBootstrap、arms* 桥接/脱敏/身份、
  * 删除 数仓事件上报：services telemetryCore、桌面/渲染层全部 funnel sender、
  * deviceMid 去持久化：desktop 不再读写 telemetry-state.json，改为进程内临时
  * 新增 packages/shared/updateFeedPolicy：厂商 manifest feed 期间禁用三条更新
  * crash capture 改为本地归档；host 内存诊断保留本地日志
  * third-party 清单再生成：移除 @arms/@rrweb/rrdom/keyv 依赖与 overrides，
  * 清理死代码：write-only 窗口集合、空 import、5 个孤儿模块、onAccepted 残参
  * 新增 specs/telemetry-and-update-policy.md、VENDOR-PURGE-PLAN.md 与

* **p2:** vendor-neutral onboarding, web token login, GitHub Issues feedback ([910307c](https://github.com/yeyuan98/zodex/commit/910307c945822fd739c0c87e3a2ccde7451cba90))
  * startup gate now opens the wizard iff no usable provider AND not dismissed;
  * new optional AppSettings field providerOnboardingDismissedAt (skip persistence;
  * guard waits for BOTH settings and model-selection hydration, with error escapes
  * welcome wizard replaces the vendor OAuth screen: full template catalog (all
  * useOAuth hook and vendor OAuth login UI deleted
  * packages/web gains a same-origin token login page (token entry, editable server
  * in-app feedback center fully deleted (20 UI files, IFeedbackService, vendor HTTP
  * every report entry (help menu, quickpick, error banners, task rows/menus,
  * config: feedback_url -> GitHub Issues, zh-CN community -> GitHub Discussions,

* **p4-b:** delete WebSearch tool + supportsNativeWebSearch + providerNative mechanism ([1722079](https://github.com/yeyuan98/zodex/commit/17220798ce53c143e4714501c922581eec8aa5bb))
  * delete websearch handler/contract files and all registry/barrel/subpath-export entries
  * remove anthropic-only provider-native encoding branch + helpers + option feeders in adapters
  * remove required per-model field supportsNativeWebSearch across shared/provider/prompt-trajectory (hard cut per spec Ruling 2; strict parse rejects old configs, no normalization)
  * remove tool from name-keyed lists: tool-identity known names, explore tools, microcompact, permission read-only, explore profile, provider-visible order, tool alias map (now identity), scheduler, subagents defaults, UI tool options, CLI argument alias rewrite
  * remove identity-mapped telemetry enum pair (agent-execution + model-api operation + querySource case)
  * excise providerNative tool mechanism (contracts tool contract fields, model contract passthrough, core registry/types)
  * remove UI metadata-editor field, i18n key + capabilities help bullet (both locales), NOTICE.md WebSearch sentence
  * keep: webSearchRequests usage accounting, 'search' tool family, embedded-search, catalog glm-free invariant test
  * tests: shared toolIdentity (no WebSearch + search family intact); services schema-rejection of removed field; fix providerModelDiscovery personal-path isolation (resolve after setDataBaseDir)

* **p4-c:** delete coding-plan gateway, start-plan error cluster, ModelRequestAuth chain, dead vendor residue ([0592298](https://github.com/yeyuan98/zodex/commit/0592298aec4514e394646628d3b63cae007a79ce))
  * delete official-coding-plan-gateway.ts + model-execution transport cache/wiring + barrel export; zai/bigmodel templates now connect directly to configured base URLs (NOTICE.md gateway row removed)
  * delete start-plan 3008/3009/3010 cluster: streaming-recovery sets/helpers, turn-model-step admission-retry branch + start_plan_admission_retry_discarded, target-completion-verification retry loop, failure-code entries (generic 429 path absorbs), UI providerBusinessError entries + i18n 3008/3009/3010 + dead 3102 + dead team-plan code/keys
  * delete dead OffpeakQueued retry reason + all consumers (telemetry recorder, governor, product-projection, dynamic-workflow, UI throttle map + keys); old replays may render raw codes (documented degradation)
  * delete inert ModelRequestAuth chain end-to-end: contracts types + ModelRequestAuthMissing code, core attach sites + port machinery, adapters runner-runtime chain (incl. runner-runtime-headers.ts), bootstrap port, desktop protocol schemas/methods, host fast-fail handler; session-title dead deferral gate removed (titles now generate on normal schedule)
  * delete phase-3 residue: /login redaction regex in tui app-submit, history.ts api-key pattern, login/logout slash-command union members + argv routing, shared-credentials vendor keys/types/methods (generic MCP OAuth store kept), unreachable account-plan model-selection branch + union + mapping
  * neutral-rename bracketed business-code parser symbols/comments (behavior kept)
  * tests: shared zcodeProtocolP4Purge guard (protocol no longer exports runtime-headers methods/schemas)

* **p4-d:** rename agent provider identity glm -> zcode end-to-end ([33ffd01](https://github.com/yeyuan98/zodex/commit/33ffd01616f26b200e9477504f13c822c1a19b39))
  * flip both provider literals in one commit (providers.ts ZCODE_PROVIDERS + zcode-task-types-core ZCodeProvider) + ZCODE_AGENT_PROVIDER const; rename task event glm_agent_model_state_update -> zcode_agent_model_state_update + ZCodeGlm* type names (desktop-internal literal)
  * outbound identity headers: X-ZCode-Agent: zcode; HTTP-Referer vendor platform origin -> repo URL (https://github.com/yeyuan98/ZCode)
  * env/dir rename in lockstep: GLM_BINARY_PATH -> ZCODE_AGENT_BINARY_PATH + bundled/remote dir glm/ -> zcode/ via shared descriptor; desktop env writer now derives from descriptor (single-source invariant); resolveBundledGlmBinaryPath -> resolveBundledAgentBinaryPath; deploy paths, remote package id, glm-content cache id, windows install locks, electron-builder from/to + signIgnore, prepare-prebuilds/stage-agent-bundle/prepare-agent-node-bundle/koffi scripts (old asset ids kept in nonReusableReleaseAssetIds history + new ids added)
  * skill prefix glm: -> zcode: producer + UI filter/permission map/display-help keys + 16 mode.* i18n keys both locales (atomic flip; enablement stays path-keyed)
  * icons: GlmMonochromeIcon -> ZcodeMonochromeIcon + icon assets renamed; orphan icon-glm.png deleted; third-party/inventory.json regenerated via licenses script
  * literal sites: task adapter alias, skills service, host WSL release, legacy remote allowlist query (hard cut, persisted rows orphaned per Ruling 1), task-model recovery (hard cut + 中文注释), bots mode-label key; comment rot updated where touched
  * tests: update 3 glm-asserting tests; add shared agentIdentityInvariants (provider/env/dir/event values) + ui skillReferencePrefixContract

* **p4-e:** rename zai themes to zcode, neutral WebFetch UA, neutralize vendor-citing comments ([97f8210](https://github.com/yeyuan98/zodex/commit/97f8210229c22ac0307bf4ef0fda8d4d1a4fc5ed))
  * rename theme ids zai-dark/zai-light -> zcode-dark/zcode-light across ui/web/desktop (93 replacements, 23 files: type/normalize/fallback, CSS classes, persisted default, settings config/sidebar, diff/mermaid/message/preview surfaces, palette, logo, i18n keys both locales, web seed + share route + index.html, desktop renderer/resource-manager); no old-value fallback (stored themes reset once, 中文注释 at fallback)
  * WebFetch User-Agent URL -> https://github.com/yeyuan98/ZCode (was vendor domain)
  * neutralize vendor-citing comments on kept behavior: compact empty-length finish guard, tool_result image-block ordering, workflow submit_result coercion, browser locator stable-pointer note

* **p6:** vendor-free gate script + unit tests; wire into verify:pre-push and knip ([fa24fb5](https://github.com/yeyuan98/zodex/commit/fa24fb561ec9e5df8a1a7196ab95552373355a40))
  * scripts/check-vendor-free.mjs: five fool-proof vendor patterns (no glm), binary-by-extension skip, CHANGELOG/plan/specs exclusions, 3-entry negative-assertion allowlist; --list triage mode; strict exit 1 on un-allowlisted hits
  * scripts/check-vendor-free.test.mjs: synthetic corpus (patterns, line numbers, classification, violations vs allowlisted, glm non-matching, allowlist paths exist)
  * verify:pre-push appends the gate; knip gains both script entries

* **provider:** P1 catalog rework — equal-vendor templates, ollama, zero GLM/websearch rules ([bacb08d](https://github.com/yeyuan98/zodex/commit/bacb08d376f41b7496f116ce7854664bee5eced2))
  * convert zai/bigmodel templates to plain api-key access, de-brand 'Coding Plan' names, drop their builtinModelIds (models now come from discovery/manual add)
  * delete 8 account:* providerRules, all builtinProviderModelRules, all glm-keyed model/template/site rules; strip glm ids from aggregator builtinModelIds (openrouter/opencode-go/opencode-zen)
  * delete zcode.z.ai-keyed site rules; remove supportsNativeWebSearch from all remaining rules (keep inputFormat/supportsMidConversationSystem capabilities for surviving endpoints)
  * add ollama template (openai-chat-completions, http://localhost:11434/v1, no access block)
  * catalog invariant: zero case-insensitive glm matches, zero account:/zhipu/websearch strings (locked by builtinProviderCatalog.test)
  * add services test runner (tsLoader shims + package.json test script; 3 pre-existing tests now gated)
  * default supportsNativeWebSearch=false in ModelPropertiesConfig assembly: catalog no longer carries the flag while the complete schema still requires it (field itself dies in P4)

* rebrand logo assets — flip to warm ivory Zodex mark (option B) ([eea5e91](https://github.com/yeyuan98/zodex/commit/eea5e918db9dc8d6215c8608f3b9c13733b4aae7)), closes [#F5F3EE]() [#17181A]()

* **remote-assets:** GitHub Releases flat asset naming; single-candidate default; mirror layout rules ([401881d](https://github.com/yeyuan98/zodex/commit/401881d9a035842fefb5fa521cf2158fdd8cc417))
  * desktop remoteCdn default base = github.com/yeyuan98/ZCode/releases/download/v<version>
  * server remoteAssetCdn: v<version>-tailed base = flat layout — exactly ONE url per
  * prepare-prebuilds flat staging mode (ZCODE_REMOTE_ASSET_FLAT_STAGING_DIR): emits
  * scripts/lib/flat-asset-names.mjs pure name build/parse module + unit tests
  * new packages/server test harness (registerTsLoader pattern) + remoteAssetCdn
  * .env.example CDN rows re-documented (GitHub default flat; mirror overrides nested)
  * knip.json registers the flat-name module entry (root-workspace precedent)

* remove official MCP service + auth protocol + CLI adapter chain (P3 C3) ([5de5c95](https://github.com/yeyuan98/zodex/commit/5de5c95eb995628e6ff5aee8fa2871b6adf3d0b3))
  * shared: delete official-mcp-auth.ts (auth-type/header/meta consts, failure-reason
  * shared protocol: drop interaction/requestOfficialMcpAuthHeaders method const +
  * shared v4/contracts: drop mcp_tool display 'unavailable' schema field and
  * services: delete official-mcp/ (credential resolver + issuance audit); remove
  * CLI: delete official-mcp-auth-port.ts + entrypoint/server wiring,
  * UI: delete orphaned mcpUnavailableBannerNotice; drop serverRequestId mapping

* remove vendor client/configs service + channel; plugin-store order falls back to bundled (P3 C5) ([2aab041](https://github.com/yeyuan98/zodex/commit/2aab041371acb96c7ea1cd66d1bdc1cfc04f12d4))
  * services: delete client-config service (IClientConfigService + createClientConfigService) and its registration in node.ts; drop accessor field and index export
  * shared: delete clientConfig snapshot parser + ServiceChannels.ClientConfig; pluginStoreOrder keeps local types only (parsePluginStoreOrder dies with the vendor envelope)
  * client/desktop host: remove ClientConfig proxy and remote-workspace passthrough registration
  * ui: usePluginStoreOrder resolves to null order (bundled default ordering from pluginStoreOrdering), refresh becomes no-op
  * spec: record C5 delivery notes (rendererActionTrace shares the dying fetcher; force-update gate read stays until P5)

* remove vendor family/specs + de-plan settings provider page (P3 C4) ([56e348a](https://github.com/yeyuan98/zodex/commit/56e348ab6e19bf4749a2f908476723dd1b91e5dc))
  * shared: delete model-provider-family.ts (zai/bigmodel family 目录、OAuthProviderId、
  * shared: 删除协议账号契约（zcodeAccountAccessSchema / zcodeProviderAccountAccessSchema）
  * shared: zcodeEndpoint 按 keep-list 收口——删除 ZAI OAuth/bigmodel builder、
  * shared: AppSettings 删除 startPlanRecommendationDismissed（zod strip 兼容旧配置）
  * cli: 删除零调用方的 cli-oauth.ts / bigmodel-oauth.ts / coding-plan-api-key.ts；
  * services: 删除 accountRequestAuthService（自 P2 起仅剩恒失败空实现）与孤儿
  * ui: 设置页 de-plan——删除套餐状态卡/Start Plan 卡/连接方式导航/entitlement 过渡
  * ui: 模型菜单/切换文案/list-models 分组改为中性按 provider 名称聚合；
  * provider-node: ModelSelectionFacade 分类器恒为 ordinary；provider rule-data-schema

* rename packaged product identity ZCode -> Zodex ([20bc26c](https://github.com/yeyuan98/zodex/commit/20bc26c19912c80a4fdc6a2ceca2fc5b99473d55))
  * identity module: Zodex / dev.zodex.app / zodex (+ Zodex Preview flavor); dev AUMID kept
  * runtimeApplicationName + dev bundle names -> Zodex (Dev/Preview); legacy dir readers unchanged
  * updater feed repo -> zodex (updateFeedRuntime + dev-app-update + tests)
  * eb config: homepage/author/maintainer/publish.repo, .app name fallbacks
  * updater cache isolation: afterPack rewrites app-update.yml updaterCacheDirName (fork-specific), pure helper + tests
  * ZCODE_LINUX_CI_TARGETS env override restricts linux targets (CI: AppImage,deb)
  * paths forbidden dirs add Zodex alongside kept ZCode entries
  * linux deep-link zodex.desktop + new marker, legacy cleanup retained
  * titles + process-name matchers lockstep; installer.nsh / doctor / smoke -> Zodex
  * context-menu label, CUA doc comments, protocol error display strings, CLI locale help -> Zodex (identifiers untouched)

* replace remote builtin-provider catalog download with bundled-only source (P3 C5) ([e9b41b9](https://github.com/yeyuan98/zodex/commit/e9b41b9a9989c8719cd3e6914bbebf1f7ddd6156))
  * provider-node: delete zcode-builtin-download (client/configs → builtin_provider_config_json → CDN), zcode-builtin-remote-synchronizer (TTL/lease refresh control), endpoint-scoped-zcode-builtin-source, zcode-builtin-cache-paths; NodeProviderConfigRuntime reads the bundled config only (offline-capable), refreshZCodeBuiltin becomes a local source re-read, applyRemoteRelease dies with the remote write path
  * services: drop zcodeBuiltinEnvironment/fetchZCodeBuiltinRemoteRelease wiring in node.ts + providerConfigRuntime options; delete zcodeBuiltinRemoteConfig.ts and runtime-tools/clientPlatform.ts (platform segment only served vendor catalog requests)
  * cli: process-provider-registry-runtime drops the remote download wiring + refresh reporter; prepareCliProviderRuntimeEnv points ZCODE_BUILTIN_PROVIDER_CONFIG_FILE straight at the bundled file (no endpoint-scoped active cache); ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV removed (last reader died)

* repoint repo URLs to yeyuan98/zodex (+ zodex-plugins) ([1ca4b77](https://github.com/yeyuan98/zodex/commit/1ca4b771d5879320c5ffd936035e1e8e083f96f0))
  * remote-asset base, architecture guard, changelog link, issues/discussions, product docs
  * libre marketplace source + catalog repo descriptions; webfetch UA Zodex-WebFetch
  * config/default.json feedback + community urls; CLI HTTP-Referer
  * URL-asserting tests updated in-commit; specs live-contract lines + P7 amendment note

* **settings:** per-provider Discover models action + bulk merge (P1.1 F3) ([180113f](https://github.com/yeyuan98/zodex/commit/180113f655a70c3710e12ea4e62730cf1031d15f))
  * facade discoverProviderModels(providerId): reads the provider's own config server-side (key never crosses the RPC surface nor appears in error text — asserted by test); keyless providers discover anonymously; delegates to the shared direct-endpoint core
  * ProviderConfigService.addPersonalModels: single-transaction bulk merge; dedupes silently against personal + builtin inherited ids and in-batch repeats; returns added count; hints gap-filling extracted as applyInitialModelHints and shared with createPersonalProvider (identical semantics)
  * UI: Discover models button in ProviderModelsSection next to add-model (existing feedback banner pattern; spinner while testing); useDiscoverProviderModels hook; i18n discoverModels/discoverModelsSuccess {count}/discoverModelsFail in both locales
  * 5 facade/provider unit tests: dedupe vs personal+builtin, 401 error excludes key while request carries it, keyless flow, unknown-provider/no-baseUrl errors, create-vs-bulk hints equivalence (glm-5.3 → no manual rule when catalog covers)

* **shared,desktop,services:** off-peak local admission window + settings + Run-now plumbing (P3 S1) ([45d86e7](https://github.com/yeyuan98/zodex/commit/45d86e71fe5b15e19c06ccbf25969aeeb97b5e57))
  * shared/off-peak-window.ts: withinWindow/msUntilWindowOpen 纯函数（跨午夜回绕、[start,end) 边界钉死）与 offPeakWindow zod schema
  * AppSettings 新增 offPeakWindow {enabled,start,end}（默认 00:00-07:00）：zod、protocol transport、patch schema
  * schedulerProtocol: 新增 correlated offpeak-admission-request/response 与 offpeak-run-now 消息
  * scheduler runtime 端口注入 seam 重构（index.ts 仅 Electron 装配；cron/offPeak controller 拆分），每 tick 认领前先询问 main 准入，超时 fail-closed
  * repo 新增 claimOneForRunNow（status='queued' AND claim_running=0 原子认领）；OffPeakTaskService.runNow（paused 先回 queued）
  * desktop main 是 settings 唯一属主：resolveOffPeakAdmission + window-open 定时器唤醒 scheduler；Run-now host→main→scheduler 转发链

* **shared,ui:** unpin image-search from default-enabled official plugins (P3 C3, ruling 5) ([22266cb](https://github.com/yeyuan98/zodex/commit/22266cb09570b53f8fecbcf63023ab0ff860bfbd))
  * image-search 的 MCP 后端是官方 Server MCP，已随 C3 主体删除，默认启用只会带来
  * 移除 UI 内置图标映射与打包资源 image-search.png；插件 definition 与市场条目

* **share:** delete vendor conversation-share chain; preserve export seed modules ([f643799](https://github.com/yeyuan98/zodex/commit/f64379968e0a1e528d31ee776927bfc1e9a06260))
  * deleted services/src/conversation-share/** (8 files, ~5.5k ln): publish/import
  * deleted shared/src/conversation-share.ts (incl. decodeConversationShareRows,
  * deleted web/src/share/** (landing page) + main.tsx share wiring + VITE share
  * deleted UI surface: share menu/picker/readonly-timeline (D-P5.2 hard-cut of
  * remoteWorkspaceServiceCollection: share client + ZCODE_JWT_TOKEN_KEY dead
  * preserved decode-only protocol schemas (old snapshots still parse)
  * NEW services/src/conversation-export/ seed modules (loadAllRows, structure
  * locale cleanup: 165 conversationShare.* keys x2 locales + 3 plugin-store
  * desktop renderer-only tsconfig build errors: 0 new vs HEAD

* **share:** local conversation markdown export (replaces vendor share) ([0458e8a](https://github.com/yeyuan98/zodex/commit/0458e8ac29547fdca49b4c8e8e78a054a29d0875))
  * new IConversationExportService (conversation-export channel): whole-session
  * formatter extends the seed: subagent rows render (summary + child-session
  * registration chain: ServiceChannels.ConversationExport + accessor + node.ts
  * UI: WorkspaceExportConversationButton in the old share header slot (icon-md
  * i18n: conversationExport.* 5 keys x2 locales
  * services tests 87 (+12: formatter matrix, guard, happy path w/ fake agent,

* **ui,i18n:** off-peak window settings UI + Run-now action + auto-decline copy (P3 S1) ([8fe315c](https://github.com/yeyuan98/zodex/commit/8fe315c174a63b6042326b67715cf9439e9384ef))
  * Automations idle tab 新增时间窗设置条（enabled + start/end 本地时钟输入，写共享 settings offPeakWindow；属主在 desktop main）
  * 闲时卡片菜单新增「立即运行」（queued/paused；scheduler 端 claim 原子 no-op）；TID_OFFPEAK_ACTION_RUN_NOW/TID_OFFPEAK_WINDOW_* test-ids
  * 创建资格本地化：无灰度/套餐/额度门，= Registry 存在可选模型（fail-closed）；远程 workspace 提示不可用
  * OffPeakCreate 轮尾卡删除位次快照
  * i18n（双语 89→81 键）：删除票据/额度/codingPlanOnly/newTask-banner/位次键；新增 window-setting + runNow 键；permissionWarning/空态/操作提示改为本地时间窗与自动拒绝语义

* update v3.14.3 ([29628c9](https://github.com/yeyuan98/zodex/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e))
  * The concurrency limit of a running workflow can now be adjusted directly, without stopping the task.
  * Optimized the reuse logic when modifying and restarting workflows.
  * Improved the real-time status display for large workflows.
  * Improved the efficiency of workflow script submission and modification, reducing token consumption.
  * Fixed an issue where workflows could cause the interface to crash in some cases.
  * Fixed an issue where buttons on workflow cards were sometimes pushed out of the interface.
  * Fixed an issue where the workflow tool took up too much context.

* **web:** remove web OAuth auth dir + share landing owner-login (P3 C1) ([c22bfa4](https://github.com/yeyuan98/zodex/commit/c22bfa46770409e9239ede240147b82372b5df76))
  * 删除 packages/web/src/auth/**（7 文件）：WebCallbackPage、webAuthService、
  * main.tsx：移除 /cn/share/callback OAuth 回调路由渲染与分享页 owner 登录
  * ConversationShareLandingPage：移除 WebOAuthProviderId 类型、双 provider
  * vite.config.ts：移除 VITE_ZAI_OAUTH_* define 注入与 /api/v1/oauth/token

* **wizard:** auto-discover on save + hints-aware initialModels persistence (P1.1 F2) ([88fcd2f](https://github.com/yeyuan98/zodex/commit/88fcd2f336cc85ba85561eebdb026988bca891cf))
  * save handler calls discoverTemplateModels directly (never stale hook state) when discovery state is idle and the template has an api config; silent; failure saves zero models (documented escapes); success/failure states never re-run
  * custom-provider path auto-discovers via new facade discoverCustomProviderModels → discoverModelsForEndpoint (direct-endpoint discovery wrapper)
  * CreatePersonalProviderInput.initialModelIds → initialModels: (string | {id, hints?})[]; InitialModelHints declared structurally in provider (no cross-package import); hints fill only fields the catalog leaves empty EXCLUDING the .* catch-all fallback (catch-all is the unknown-model default, not catalog knowledge — otherwise hints would be dead code); applied hints persist as complete manual rules (manual schema requires all leaves; creation-time effective values frozen for non-hint leaves — accepted shadow boundary, documented)
  * keyless (ollama) path included; hook state extended with modelHints
  * unit tests: hints fill-vs-override matrix through real createPersonalProvider→resolver (catalog-provided → no manual rule; explicit catalog false beats hint true; string entries; dedupe); discoverModelsForEndpoint URL normalization; e2e: save-without-button scenario locks auto-discover
  * e2e mock template no longer injects builtinModelIds: gate-closed-after-reload assertions now prove discovery persistence (both manual + auto paths) instead of passing via hardcoded ids

* **wizard:** P1 model auto-discovery client + wizard persistence ([b675567](https://github.com/yeyuan98/zodex/commit/b6755674ce6424a08a9891bbf9ae254860961b92))
  * new providerModelDiscovery.ts absorbs the P2 test-key probe: openai-compat GET {baseUrl}/models (Bearer only when key present), anthropic GET {baseUrl}/v1/models with x-api-key + anthropic-version + after_id cursor paging (10-page cap); proxy-aware fetch, versioned-path normalization, never spawns the agent runtime
  * facade probeTemplateApiKey → discoverTemplateModels (interface, impl, runtime fetch threading, node.ts wiring)
  * CreatePersonalProviderInput.initialModelIds: wizard persists discovered model ids into the created provider (gate requires models.length>0; template providers start empty since P1 dropped vendor builtinModelIds — without persistence the wizard would dead-loop the startup gate)
  * wizard key step: 'test key' → 'test & discover' with model-count feedback; key-less templates (ollama) skip the key input and discover unauthenticated; step-aware keyless header copy
  * i18n: login.wizard.testKey* → discoverKey* in both locales (+keylessStepDescription)
  * e2e: updated test&discover assertions + new wizard-complete⇒usable (gate-closed) lock


### Bug Fixes

* [ulw] review round fixes — residual brand strings + comment/spec/README corrections ([4956fb0](https://github.com/yeyuan98/zodex/commit/4956fb0595144a532751857b5ec70f6f9ace8e74))
  * space-variant 'Z Code' strings (quit dialog, X-Title header) -> Zodex
  * window frame title, skill catalog copy, MCP settings error, CUA admission gate
  * CLI agent-identity prompt cluster + /init template now self-identify as Zodex
  * outbound UA ZCode/<version> -> Zodex/<version>; plugin-installer UA; oauth client_name
  * server-cli service/unit descriptions, update/recovery/ownership messages
  * bots channel-runtime 'another window' copy aligned with renamed i18n
  * .zcodeignore template header (exact-line DEFAULTS marker kept for existing files)
  * finder-workflow comment corrected (bundle id DID change; Services residue noted)
  * spec W5 author fact synced; README plugin-hosting wording clarified

* **catalog:** GLM vision over-application on anthropic endpoints (P1.2) ([eab766f](https://github.com/yeyuan98/zodex/commit/eab766f31a281d7f86a3677805b445a0141f313a))
  * delete the two upstream vendor anthropic inputFormat site rules (api.z.ai + open.bigmodel.cn /api/anthropic, modelMatch .*): they expressed 'endpoint accepts image/video blocks' but overlay after modelRules (later-defined wins) and blanket-overrode every per-model image:false — all glm models showed vision on anthropic-flavor providers; latent upstream bug surfaced by the P1.1 rule restore; openai-compat flavor (no site rules) was already correct; midConversationSystem endpoint rules kept
  * extend the flash-family vision overlay in place to (?:x)?: glm-5.3-flashx (suffix letter, no separator) previously missed by the overlay and masked by the site blanket — now vision per user ruling, ctx 1M via family base rule; cross-flavor intended flip pinned in tests
  * resolver regression tests on both flavors: glm-5.3 image FALSE + ctx 1M; flash + flashx vision (video/pdf); glm-4.6v vision; unrated models default non-vision (no endpoint blanket)
  * catalog-level guard: no vendor anthropic site rule may carry inputFormat again
  * spec: P1.2 clauses + catalog-source note (upstream v3.14.3 vendor catalog rev 30, fork-maintained); master plan: P1.2 section, matrix row A6, alphas re-shifted (P3=alpha.7 … P6=alpha.10); revision stays 30

* **cli:** localize resource-sample interval after shared telemetry contract removal ([69e2a10](https://github.com/yeyuan98/zodex/commit/69e2a107de46cad9b596bda24a85b964722c7bd9))
  * P0 删除 shared processResourceTelemetry 契约后，CLI bootstrap 的
  * 采样周期常量本地化（60_000，与原值一致）；ZCodeProcessResourceSample 类型
  * app 侧接收端已随 P0 移除，sampler 协议通知暂无消费者；协议面清理留待 P4/P6
  * 验证：pnpm smoke:windows-bundle 通过（ZCode-3.14.3-win-x64.exe, 141.4 MiB）

* **p1.1:** apply ulw review fixes (shadow-scope spec, testing-race, e2e locks) ([b55d64a](https://github.com/yeyuan98/zodex/commit/b55d64ae106c67ff8b2ab9e55e1e7b813dfffd5f))
  * spec §2 corrected to the implemented shadow semantics: applying ANY hint persists a complete manual rule (manual schema requires all leaves) — the model then shadows future catalog changes for ALL manual leaves until user-edited/removed (was wrongly promising per-field shadowing); two-phase catalog regression test locks frozen-value-wins (500k frozen vs 999k later catalog rule)
  * spec §3: Continue disabled while a discovery run is in flight (was: mid-testing save fell through to zero-model); custom-form wording clarified (requires key; keyless goes via ollama template); ollama step wording aligned with implementation (key-less variant, not skip)
  * wizard: Continue button disabled during discovery testing state
  * e2e: custom-provider scenario gains the reload gate-closure assertion (auto-discover persistence locked on both paths)
  * unit: anthropic mirror has_more-without-last_id stops paging after one request
  * knip: unexport in-file-only ProviderModelDiscoveryState type

* **p1:** apply ulw review fixes (empty-list policy, CLI login residue, e2e locks) ([6a3bffc](https://github.com/yeyuan98/zodex/commit/6a3bffcba659592c77c9b21e4a7a79524d659582))
  * discovery: empty model list now degrades to failure ('no models returned') per spec — avoids misleading 'works · 0 models' saves that would reopen the wizard gate on next startup; unit tests added (empty list, anthropic /v1-prefixed baseUrl normalization, abort timeout)
  * e2e: failure test extended to save-after-401 and assert the wizard closes (spec acceptance 3); teardown ENOTEMPTY race fixed with bounded retries (SQLite handle release vs rm)
  * catalog: bigmodel-api key-management URL repointed to the real API-key console (was coding-plan overview)
  * CLI: remove P1-dead login residue — help lines (login/logout commands, --no-browser, /login //logout), command-center /login //logout branches + deps + login-flow.ts + loginSetup i18n block/types (both locales); loginRequired copy reworded to provider-API-key guidance (no /login mention)
  * spec: §4 kept-until-P3 list corrected (legacyAccountConnectionSettings + legacyTeamOrganizationResolver died fully dead in slice 1); expected-death list extended (CLI account-login surface, custom-path zero-model saves); e2e README wording

* **p3:** review round fixes — stale model-facing copy, comment rot, dead i18n keys, spec amendments ([41d5ca9](https://github.com/yeyuan98/zodex/commit/41d5ca96b42af91eeb6c2fd2c6ee1e14684322b9))
  * OffPeakCreate tool metadata rewritten for local semantics (own provider, idle window, build default, auto-decline noted); vendor ticket/quota language removed
  * /login & /logout slash-help entries deleted (documented commands deleted in P1; pulled forward from P4 as dead help text)
  * run-now channel comments reworded in node.ts/validation.ts/channels.ts; provider-runtime-headers stale account comment fixed; provider-selection-v2 gets P3 tombstone note
  * i18n: drop offPeak.sectionTitle + offPeak.form.keepAwakeHint (zero consumers; thought.*/tabs.* verified as live dynamic keys and kept); stale login.expired comments updated
  * specs/off-peak-local-admission.md: blocked-outcome wording matches implementation (standard outcomes, no separate status); ModelRequestAuth deferral recorded

* **p4-review:** apply [ulw] review fixes — durable theme reset, proxy/CA fetch memo, spec amendments ([fe5e5f6](https://github.com/yeyuan98/zodex/commit/fe5e5f6ca0395b491a81ac56e40f3375211eed65))
  * theme hard-cut made durable: pre-hydration readers (desktop renderer main, resource-manager window, web index.html bootstrap) validate stored theme and write back zcode-dark once; useTheme fallback persists — reset now happens exactly once instead of recurring first-paint flash
  * model-execution: instance-level proxy/CA fetch memo restores single CA read (lost with gateway transport cache deletion); business-error wrapper reuses memoized network fetch
  * neutralize two stale 'Zai dark' comments (desktop renderer main, web main)
  * spec amendments: A-P4.1 descope CLI-infra-dependent test units (compensating guards recorded), A-P4.2 accepted degradations (HTTP-200 SSE 3008 terminal-unknown; personal-config whole-file degradation under Ruling 2; offpeak_queued raw replay), A-P4.3 review fixes

* **p5:** [ulw] review round fixes (RA/RB/RC applied once) ([f87f264](https://github.com/yeyuan98/zodex/commit/f87f2648ec286eb043b78772b732f299011a31d6))
  * RA1: refreshAutoUpdaterReleaseChannel now honors the product-flavor disable
  * RA2: web saveFile defers revokeObjectURL by 10s (WebKit blob-fetch abort)
  * RB1: remove permanently-unavailable 'Create plugin' menu entry +
  * RB2: CLI README plugin section rewritten to P5 reality (bundled-only
  * RB3: delete knip-dead conversationRowSelection v2 seed (spec amendment 7
  * RB4: drop dead featured field from marketplace summary schema
  * RB5: sweep stale root-scoped services on daemon register (old-named
  * RC1: remove stray committed schedulerProtocol.d.ts.map build artifact
  * re-ran ALL gates post-fix: typecheck/lint/fmt/architecture 0/0, suites

* **p6:** [ulw] review round fixes (RA/RB/RC applied once) ([a847a68](https://github.com/yeyuan98/zodex/commit/a847a68de51c654a5854a51754a327e9040c3677))
  * spec: correct inverted container wording (map dropped, array kept) and record that marketplace strict-contract tests live in shared (A-P4.1: CLI has no runner; adapter is a thin delegate)
  * gate: summary counters now report real excluded/binary counts (classify before skip) instead of always printing 0
  * locales: delete second orphan key settings.modelProvider.namePlaceholder (both locales; no static or dynamic consumer — same class as the 2c orphan)

* **p6:** CI CLI job mirrors the sanctioned local flow — root install only ([4089b6e](https://github.com/yeyuan98/zodex/commit/4089b6ec9017c984d48ece2e2b13901a7dfb6920))
  * CLI packages live in the ROOT workspace (pnpm-workspace.yaml includes apps/zcode-cli/packages/*); root install + turbo from root node_modules/.bin is how local gates run — the nested apps/zcode-cli install I added was a flow nobody uses and exposed a pre-existing breakage: the CLI's standalone workspace/lockfile is vestigial and cannot fresh-install (workspace:* unresolvable inside it, lockfile pre-dates @withfig/autocomplete and post-dates vitest removal)
  * revert the link:-protocol experiment (root graph semantics must stay workspace:*); record the vestigial standalone-install breakage for a future structural decision instead of fixing it inside P6

* **p6:** drop redundant knip entries for vendor-free gate scripts ([ef6662e](https://github.com/yeyuan98/zodex/commit/ef6662ea2bd6ed9ef8d3245d8abd9dafb4125f29))

* **p6:** make apps/zcode-cli installable from scratch — root-package deps via link: protocol ([ca4f91a](https://github.com/yeyuan98/zodex/commit/ca4f91aaa6f2911b2f064d082cf052d35ba631fd))
  * first CI run exposed a pre-existing breakage: 8 CLI packages declared root-workspace packages (@zcode/shared/provider/provider-node/model-option-map/zcode-cua/formal-proof) as workspace:* but apps/zcode-cli is a separate pnpm workspace that cannot resolve them — fresh installs were impossible and only worked on machines with hand-made node_modules symlinks (frozen-lockfile also failed: lockfile pre-dated @withfig/autocomplete and post-dated vitest removal)
  * convert those 14 entries to link:../../../packages/<name>, replicating the historical symlink semantics as pnpm-managed links (root install remains the prerequisite, as in bootstrap); regenerate the CLI lockfile so --frozen-lockfile works
  * verified: frozen install + typecheck + lint + format:check + registry:check + turbo build all green

* **p6:** sweep 2a/2b — product docs URL repoints to repo; drop pre-rename glm decode ([febdabd](https://github.com/yeyuan98/zodex/commit/febdabd48ead184357297eb15324991b66b7c14f))
  * productDocs: ZCODE_PRODUCT_DOCS_URL now the repo README (Help menu + quick-pick show repo docs, not the deleted vendor site); ui test pins the target
  * provider-selection-v2: frozen 0002 decode keeps only the "zcode" execution-backend spelling (A-P6 amendment reverses the P4 keep-ruling); services test pins decode outcomes incl. the recorded dead-providerId breakage for hypothetical glm rows

* **wizard:** bounded scrollable layout, per-step headers, window controls ([bf15dda](https://github.com/yeyuan98/zodex/commit/bf15dda8d9f81eb72bc3492d6e38fb84198138b0))
  * rework wizard shell to the OccupationOnboarding fullscreen idiom: pt-12 drag-bar
  * render DesktopWindowControls on Win/Linux (frameless window had none)
  * headers now step-aware: key step shows chosen provider name + logo chip +
  * remove redundant inner form headings (incl. orphaned login.apiKey.title and
  * autoFocus key/name inputs on step entry; template-lookup miss falls back to
  * e2e: provider-name heading assertion + new wizard-scroll.spec.ts layout
  * format CHANGELOG/plan files regenerated by the alpha.2 release (fmt parity)


### Chores

* add local Windows bundle smoke tool and release runbook ([690749f](https://github.com/yeyuan98/zodex/commit/690749f230a276f46ed9dbd8f2816971398c8c40))
  * add scripts/smoke-windows-bundle.mjs + scripts/docker/Dockerfile.windows-cross: reproduce the release-desktop.yml Windows build locally in Docker (wine + wine32:i386 for NSIS makensis, rsync for --skip-install fast reruns)
  * run outputs live in ~/temp/zcode-smoke/<run-id>/ and are removed by default; pnpm/electron caches and the build workdir persist in a Docker named volume; base images are never pruned and the project image is kept unless --prune-image
  * new entry points: pnpm smoke:windows-bundle and mise task smoke-windows-bundle
  * seed CHANGELOG.md with a backfilled 3.14.3 section in the release-it writer format; detailed changes are tracked as commit body bullets going forward
  * document the release runbook in README/README.en/AGENTS.md: pnpm release is the only sanctioned release entry (bumps version, generates CHANGELOG, tags vX, triggers the installer workflow); manual git tag releases are forbidden

* dynamic-workflow + help-config comment refresh after C5 vendor config-fetch removal (P3 C5) ([93fe6b2](https://github.com/yeyuan98/zodex/commit/93fe6b20582d7be42183e3c0d185db2d9273e874))
  * CLI dynamic-workflow-policy: gate reads host-pushed local state only (no vendor fetch since C2); stale /client/configs comment corrected
  * shared dynamic-workflow-feature: header documents local-only resolution (env override > default disabled, A9 local constant OFF)
  * helpAppConfig: cross-reference now records all client/configs consumers dead except the P5 force-update gate
  * residue sweep clean: zero live client/configs / builtin_provider_config_json / clientConfigService / desktopContextPromptRollout / zcodeBuiltinRemoteConfig references outside P5 updater path and P3-deletion comments; dist/ artifacts regenerate on build

* **fmt:** apply oxfmt to plan + P5 spec (pre-existing fmt debt) ([20666ec](https://github.com/yeyuan98/zodex/commit/20666ecf367125880e14a8919c3dc170c968394d))

* **fmt:** exclude generator-owned CHANGELOG.md from oxfmt ([62e697b](https://github.com/yeyuan98/zodex/commit/62e697bf32fcc4c2db22dfb0703eb287b02a799e))

* **fmt:** format spec markdown ([3ccdb3d](https://github.com/yeyuan98/zodex/commit/3ccdb3dc989850c77fff82e2f145d1ced36aa8a8))

* **i18n:** drop dead vendor usage keys (P3 S2) ([7549c71](https://github.com/yeyuan98/zodex/commit/7549c71c0a09c67ff66a3f1225b7483535687953))
  * 删除 en-US/zh-CN 各 200 个无消费方的用量键（逐键 grep 消费方后删除，动态模板键保留）：
  * 模板字面量消费的 settings.usage.range.* 与 heatmap.range.* 保留；

* **identity:** neutral installer identity; rename background services; cut endpoint-origin web + clientScenes chain ([3cc57d7](https://github.com/yeyuan98/zodex/commit/3cc57d73adda49b74dd42964974506845ca0e50b))
  * electron-builder homepage/author/maintainer -> repo values
  * serviceManager names com.zhipu.zcode.server -> app.zcode.server (D7, no
  * Help-menu ZCode Endpoint selector, zcodeEndpointOrigin setting (both zod
  * zcodeEndpoint.ts DELETED (zero surviving importors; resolveRuntimeZCodeEnv
  * clientScenes chain deleted (nodeApiClient/apiEndpoints/apiJson/requestIdHeaders/
  * connect.ts drops ZCODE_BASE_URL/ENDPOINT_ORIGIN remote env passthrough;
  * tests: endpointWebPurge (4) — schema absence + legacy-file parse,

* knip sweep — drop 12 newly-orphaned exports (P3 review leftovers) ([78116c7](https://github.com/yeyuan98/zodex/commit/78116c76868ab17bc0d59f0ea7807c41c768b971))
  * 类型收窄为模块内（不再 export）：desktop scheduler 的 CronSchedulerControllerDeps / OffPeakSchedulerControllerDeps / SchedulerPortShape / SchedulerRuntimeHandle / SchedulerRuntimeDeps（测试经 ReturnType<typeof createSchedulerRuntime> 推导，无需导出 handle/deps 类型）、services OffPeakInteractionPolicy、desktopDeepLinkUrl isOAuthCallbackUrl（模块内消费）、ui resolveModelProviderNavLogo / SegmentPill / formatAppUsageDuration
  * 删除零消费者：ui setPendingSettingsUsageIntent（Usage 入口改为直接 setPendingSettingsSection("usage") 后遗留）
  * AlertDialogRequest 保持导出并在 useAlertDialog 显式引用（导出函数签名需要可命名的返回类型，同时构成真实跨模块消费）

* **knip:** remove P1-fanout orphaned files and exports ([7c4fbfa](https://github.com/yeyuan98/zodex/commit/7c4fbfa5047358a5ba1838bd0c9993925b923a46))
  * delete dead files (consumers died in slices 1-2): codingPlanProviderAvailability, bigmodelStartPlanZcodeJwt, providers/api barrel + apiKeyHeaders, ui oauthTeamPricing
  * unexport/delete orphaned symbols (zaiStartPlanBilling model list, coding-plan login headers, sidebar usage preference writer, footer badge helpers, ModelProviderSection test-support re-exports, CLI server/run type re-exports)
  * knip gate: zero genuinely-new entries vs branch-point baseline; 21 baseline entries eliminated

* **lint:** clear all format/lint baseline debt in both workspaces ([b957b56](https://github.com/yeyuan98/zodex/commit/b957b5613a8d1382bf312b9da42541c972b66142))
  * new apps/zcode-cli/.oxlintrc.json (max-lines off, P6+ split debt), dynamic-workflow

* **p0:** format/lint follow-up — zero new warnings vs baseline ([e072d55](https://github.com/yeyuan98/zodex/commit/e072d55dfba2b1805ac8e2550ec8963c77cb1901))
  * 修正 P0 引入的格式回归：VENDOR-PURGE-PLAN.md、specs/telemetry-and-update-policy.md、
  * 清理 P0 删除消费端后遗留的 unused 标识：index.ts(hostname/getDataBaseDir)、
  * release-it 增加 after:bump hook：版本写入 package.json 会改变 notices 门禁
  * 实测对比基线 53b17b3：fmt 失败文件 35→34（无新增）；lint warnings 70→58

* **p3:** S4 sweep — remove dead account:* logo registry entries, start-plan asset + orphaned test-ids ([a802f22](https://github.com/yeyuan98/zodex/commit/a802f22943a30e9dbf4da479f30b690b3a353e39))
  * logo-sources.json: drop Start Plan entry and account:* providerIds (dead since P1); map zai/bigmodel standard template ids to their family logos (equal-vendor icon coverage)
  * ProviderLogo: remove start-plan asset key (no config references it); delete the png
  * test-ids: remove start-plan and connection-mode TIDs (UI deleted in C4, zero consumers)

* **p5:** sweep P5-introduced unused exports + swr dep ([447a0a9](https://github.com/yeyuan98/zodex/commit/447a0a9d43407955a62ffa795c891486d0d0f447))
  * de-export AssistantTextRange / ConversationTurnNavigator types /
  * delete unused useOptionalBaseWorkspaceServices (clientScenes hooks were its
  * drop swr from packages/ui deps (last SWR consumer was useClientScenesResource)
  * knip set-diff vs branch point: zero P5-introduced unused entries

* **p6:** sweep 2c/2d/2e — dead code, vendor-literal comments, stale locale copy ([960aefb](https://github.com/yeyuan98/zodex/commit/960aefbe096dd8de33c6afb66732cc7197b3715f))
  * drop never-read _legacyProvider param (4 call sites + contract test) and orphan en-only key settings.memory.viewer.disabled
  * reword vendor-naming comments in remoteCdn/provider-data-schema/zcodeAgentService/zcode-protocol/featureSuggestedPrompts/desktopDeviceMid (device-id module kept per user directive; stale deletion promise removed) and trim the cli build.mjs endpoint tombstone
  * locales: neutral provider-name placeholder + section title (zh), delete orphan presetDescription pair, and neutralize presetEmpty stale OAuth wording

* **p6:** third-party notices full resync; drop orphaned ARMS evidence files ([4b372e4](https://github.com/yeyuan98/zodex/commit/4b372e4d1bed6c08bc4aef759f13c9ab4b272a78))
  * regenerate via licenses.mjs notices: only expected hash updates land (root package.json verify:pre-push change; builtinSkillI18n sweep) — ARMS/swr entries already absent since P5's regen
  * the three @arms/* upstream evidence txt files lost their override entries with P0's ARMS removal and are referenced by nothing (hash grep clean) — deleted

* release v3.14.3-alpha.1 ([d2dee71](https://github.com/yeyuan98/zodex/commit/d2dee71643c103042efb1cbedc0c5e70e4dcc8dd))

* release v3.14.3-alpha.10 ([4739c40](https://github.com/yeyuan98/zodex/commit/4739c40c9910a6f8a8276f58396c22d364e61f4a))

* release v3.14.3-alpha.2 ([a029161](https://github.com/yeyuan98/zodex/commit/a029161b7fe049955e876b18bc8ff12535cecc38))

* release v3.14.3-alpha.3 ([7cb4b9e](https://github.com/yeyuan98/zodex/commit/7cb4b9ecd6d27d97d5dac210883f83183d9454bd))

* release v3.14.3-alpha.4 ([d01c1f1](https://github.com/yeyuan98/zodex/commit/d01c1f15243567f91f917c0ca004cb9dbc46326d))

* release v3.14.3-alpha.5 ([f459f98](https://github.com/yeyuan98/zodex/commit/f459f986c600aa7c7ff568ab247f5c31574ddf04))

* release v3.14.3-alpha.6 ([6e66e2b](https://github.com/yeyuan98/zodex/commit/6e66e2bbe11f37936ca5bc59c29a736c8ba2d6fb))

* release v3.14.3-alpha.7 ([c1b187d](https://github.com/yeyuan98/zodex/commit/c1b187d658f480886448e948ccf04955f9d34874))

* release v3.14.3-alpha.8 ([81730bd](https://github.com/yeyuan98/zodex/commit/81730bda27a1de63b9681b1d5bbde62b85c2935d))

* release v3.14.3-alpha.9 ([2e34069](https://github.com/yeyuan98/zodex/commit/2e340695939569a644fc9d11f3162142cb0447e6))

* **shared:** fix stale forceUpdate comment after C2 purge (P3 C2) ([81e8fd5](https://github.com/yeyuan98/zodex/commit/81e8fd58640b90e8a0000c9b6ee0d20e1351fdb5))

* **ui:** drop newly-orphaned codingPlanPurchaseAuth (P3 C2) ([60f875c](https://github.com/yeyuan98/zodex/commit/60f875c8c413eaaa53d8667ce4d338867db09ba3))


### Documentation

* **p3:** S5 — flip spec status, record P3 delivered state + effort in master plan ([62f76a7](https://github.com/yeyuan98/zodex/commit/62f76a788fd774a14d47015f89aa765f091275fe))
  * specs: Status → implemented-by P3 (alpha.7)
  * VENDOR-PURGE-PLAN.md: §4 P3 delivered-state prose, §1 status → next P4, §7 effort refresh
  * handoff (ZCode-handoff.md, outside repo) rewritten separately

* **p3:** specs + amendments for services purge & off-peak local admission ([890c650](https://github.com/yeyuan98/zodex/commit/890c650ffc1e6f124ff81abca59217b665f1a142))
  * add specs/off-peak-local-admission.md: window-only admission (ruling 1) + Run-now, hands-off interaction policy with rationale (ruling 2), owners/event order, settings schema, ticket-column hard-cut, test scenarios, expected-death list
  * add specs/account-services-purge.md: C1-C5 domain commits, dormant user framework design (ruling 6), invariants/keep-traps, migration boundary
  * record amendments A6-A14 (P3) in VENDOR-PURGE-PLAN.md §4 P3

* **p5:** AGENTS.md release-verification covers both jobs + all asset kinds; record W2 layout-selection amendment in spec §B ([963feaf](https://github.com/yeyuan98/zodex/commit/963feafbd975e4c8e5f23be53cd38cf65d92b71c))

* **p5:** NOTICE rows track P5 behavior; README mirror guidance ([400efa2](https://github.com/yeyuan98/zodex/commit/400efa2c1fc427f3be9cd55af57c0b1cdec593ca))
  * NOTICE: share/import row replaced by local-export disclosure (no upload);
  * README: release section mentions updater metadata + remote-asset CI job;

* **p6:** succinct quickstart READMEs + docs/ module docs; trim .env.example ([095c26c](https://github.com/yeyuan98/zodex/commit/095c26cad61bc6698821b71122195e96af255f3e))
  * README(.en): 2-3 line intro, install/first-run quickstart, docs index; build/dev content relocated (not lost) to docs/development.md + docs/packaging.md; inherited vendor/origin community links removed
  * docs/providers.md (API-key/Ollama-template/vLLM-as-custom + reference), docs/updates.md (update channel, prereleases, three mirror vars), docs/plugins.md (bundled/libre/personal sources)
  * .env.example: tombstone comments dropped, live vars only, missing ZCODE_UPDATE_FEED_URL mirror var added
  * config/default.json en-US community URL repointed from inherited Discord to repo Discussions; NOTICE link follows the moved CLI section anchor

* **p6:** vendor-free gate + PR CI spec of record; amend keep-rulings per user directives ([c83428c](https://github.com/yeyuan98/zodex/commit/c83428c2a8deca7ed6f237e8773728bd362464d8))
  * new specs/vendor-free-gate-and-ci.md: five-pattern gate design (no glm), 3-entry allowlist, CI job matrix, four binding user directives
  * agent-identity spec: A-P6 amendment reverses the both-strings-decode Keep ruling (drop "glm" string, keep "zcode" semantics; new decode unit test; legacy importers kept)
  * distribution spec: P6 section records builtinSkillI18n marker shrink (superpowers kept) + strict known-marketplaces loading (inert guard layers retired, reserved-id guard kept)
  * VENDOR-PURGE-PLAN §4 P6 rewritten to the directive-shaped scope; final 3.14.3 moved to a separate session

* **plan:** A7 matrix row — delivered test counts + pending manual-pass note ([5171e64](https://github.com/yeyuan98/zodex/commit/5171e645e1d646fbbd1e17cfda8edf43df40c4fd))

* **plan:** mark P1.1 delivered (v3.14.3-alpha.5) ([459ce2f](https://github.com/yeyuan98/zodex/commit/459ce2fbe27e4baa94f693a21220067943c868f2))

* **plan:** mark P2 delivered as v3.14.3-alpha.2 ([9841e83](https://github.com/yeyuan98/zodex/commit/9841e832d57830f440f1112d182803006e06e3f3))
  * status header: P0+P2 done, next P1
  * P2 section: delivered summary (gate/wizard/probe/web login/feedback/e2e/lint-debt)
  * A2 matrix row: delivered test counts

* **plan:** record P1 delivery, amendments A1-A4, decision D8; re-shift alpha numbering ([d9fb09f](https://github.com/yeyuan98/zodex/commit/d9fb09f2e1dbdb2e53aa0de598d64475a157c507))
  * P1 section: delivered summary (catalog/discovery/excision/tests/amendments)
  * §3: D8 = compile-forced natural death / no pre-hiding / no over-deletion (was mis-cited as D5)
  * P3→alpha.5 … P6→alpha.8 (RC); matrix rows updated (A3 = P2 hotfix, A4 = P1)

* **plan:** record P1.2 merge/release hashes ([a359b17](https://github.com/yeyuan98/zodex/commit/a359b17f5cc0871d8ea3fdf00c990c8eacb9229e))

* **plan:** record P3 merge/release hashes (b508f3c / 020f430 / v3.14.3-alpha.7) ([f1e7755](https://github.com/yeyuan98/zodex/commit/f1e7755807a622aef0b929f1dfb84f3cb494aad4))

* **plan:** record P4 delivered state — alpha.8 merge/release, amendments A-P4.1-3, A8 matrix row ([503b280](https://github.com/yeyuan98/zodex/commit/503b2801661fd301b1998bbb7f1c4090cd2d0743))

* **plan:** record P5 delivered state — alpha.9 merge/release, amendments A-P5.1-8, A9 matrix row ([fa890c7](https://github.com/yeyuan98/zodex/commit/fa890c73781e9d896783d64c699169ffab14e784))

* **plan:** record P6 delivered state — alpha.10 merge/release, CI green, pending manual QA; program code phases complete ([834b1c4](https://github.com/yeyuan98/zodex/commit/834b1c47f1b97a277969b047749b1e1a3c1317da))

* **plan:** record P7 design + delivered state — rebrand, multi-platform, final release prep ([1c9e195](https://github.com/yeyuan98/zodex/commit/1c9e195200ab0530bc4087f587c9de6fec07177b))

* **plan:** record wizard UX hotfix alpha.3; P1 shifts to alpha.4 ([cf8b4ae](https://github.com/yeyuan98/zodex/commit/cf8b4ae16407efab117572a3380f912a0d1bd005))

* rebrand documentation set to Zodex ([e27f8b5](https://github.com/yeyuan98/zodex/commit/e27f8b5f9559ae373c3bc1c9fac478860d55dae6))
  * READMEs: fork-of-ZCode statement up front (zai-org/ZCode, Apache-2.0) + tracking-free/vendor-free distinctions + per-OS install lines
  * updates doc: per-platform channel files + mirror guidance; plugins/providers/development/packaging sync
  * NOTICE/CONTEXT/DESIGN + nested READMEs; AGENTS.md release contract: all desktop jobs + new asset list

* **spec:** P1 provider catalog & model discovery spec ([1f41d5e](https://github.com/yeyuan98/zodex/commit/1f41d5e8b1193199c0e9b52f2ae881189e44d38f))
  * new specs/provider-catalog-and-discovery.md: 21-template equal-vendor catalog invariants (zero glm matches, zero account providers, zero websearch props), runtime model discovery contract (openai-compat + anthropic /v1/models, no agent spawn), wizard test-and-discover with mandatory model persistence, schema excision scope incl. P3 retention boundary, expected-death list, migration boundary
  * amend specs/onboarding-and-gate.md §Behavior 3: P2 test-key probe superseded by P1 discovery client

* **spec:** P1.1 amendments — A5 capability-metadata invariant, auto-discover on save, hint merge rule ([7c84869](https://github.com/yeyuan98/zodex/commit/7c84869b544dd8df54de5216c8a8c5181a1c44db))
  * catalog invariant refined: glm allowed only inside modelConfigRules.modelRules (modelMatch + capability props); templateModelRules/builtinProviderModelRules stay glm-free (decision A5: equal-vendor capability metadata, 61-rule precedent)
  * discovery §2: legacy camelCase hasMore mirrors (bigmodel/zai) + repeated-first-id loop guard; optional capability hints (anthropic max_input_tokens/capabilities, openai-compat context_length/input_modalities) with catalog-wins precedence
  * wizard §3: save auto-discovers when idle (template/custom/keyless paths); failed discovery not re-run; custom-path expected-death bullet amended
  * acceptance scenarios extended (resolver glm metadata, hint precedence both directions, auto-discover e2e, per-provider discover unit)

* **spec:** P2 onboarding & gate spec + master-plan corrections ([d338782](https://github.com/yeyuan98/zodex/commit/d3387820339cb634e16664ace715a7dc8fafda2f))
  * add specs/onboarding-and-gate.md: gate rule, wizard flow, web token login, feedback policy, ownership invariants
  * master plan §5: record binding alpha policy (development-first, no alpha-to-alpha compat)
  * master plan P2: fix ZCODE_SERVER_TOKEN→ZCODE_SERVER_AUTH_TOKEN, mislabeled remoteWorkspaceServiceCollection token (share auth → P5), migration file moves P1→P2, feedback deletion scope + community decisions
  * master plan §2.7: correct server auth env name

* **spec:** P4 design of record — agent identity rename + WebSearch/gateway purge ([3198819](https://github.com/yeyuan98/zodex/commit/3198819c26a082fa67282afb474775ce39451245))
  * add specs/agent-identity-and-tooling-purge.md as P4 (alpha.8) spec
  * record rulings 1-8 incl. hard-cut for old glm data/configs (no migration, no config normalization)
  * define rename lockstep invariants (provider literal, env/dir descriptor, skill prefix, packaging scripts)
  * protect keep-lists: webSearchRequests accounting, search tool family, catalog GLM rules, BigModel ordinary error codes
  * test matrix incl. mandatory windows-bundle smoke (installer layout change)

* **spec:** record conversation-export W4b amendments (input shape, scope factory, e2e descope) ([4f2df71](https://github.com/yeyuan98/zodex/commit/4f2df7188d48c125f890e6e7d0b973e8ffede5bc))

* **spec:** wizard layout/header contract (alpha.3) + implemented status ([a890360](https://github.com/yeyuan98/zodex/commit/a890360eb1fff8395355165e6cf600ef834aca15))


### Refactorings

* **cli:** delete GLM selection backfill migrations 0020-0022 (P1 hard-cut) ([fe28d45](https://github.com/yeyuan98/zodex/commit/fe28d45271c16f3e94e8128099204ed7bc6cddb4))
  * remove the three tail SQLITE_MIGRATIONS entries + their SQL imports/files: 0020 provider-model-selection backfill, 0021 official-glm-selection id recasing, 0022 backfilled-session-reasoning repair (joins 0020's ledger row — one unit, all three go)
  * checksum-ledger runner iterates only present entries: safe for fresh and existing databases
  * ledger comment: ids 0020-0022 must never be reused with different SQL (old databases carry checksums for the original SQL); next migration starts at 0023

* **history:** delete GLM id/migration history (P1 slice 3, hard-cut) ([ba48c4f](https://github.com/yeyuan98/zodex/commit/ba48c4f26e6f49eda5ea693ebdec2eefeefa6119))
  * delete official-glm-model-id.ts + legacy-model-provider-identity.ts: migrateLegacyModelProviderId existed solely to map six zai/bigmodel legacy ids — deleted; subagent state/markdown migrations keep pure format conversion; bots migrateSelection drops dead builtin: selections (same semantics as the old unknown-builtin branch)
  * remove no-op user-markdown migration walker (existed only for the provider-id rewrite) across services + CLI
  * delete official-glm-selection-v3.ts + its 0003 registration in services tasksDatabase migrations (import, definitions entry, dispatch branch; ledger ignores stale 0003 rows; id never reused — noted in comment)
  * legacyZCodeConfigProviderReader: vendor parts only removed (preset GLM id set, BigModel anthropic normalization, runtime-URL kind inference, BigModel endpoint branches); generic config.json importer intact + regression test (former vendor preset id routes generically with declared kind + verbatim baseURL)
  * zaiStartPlanBilling inlines its canonical start-plan model list (shared file gone; billing file itself is P3 deletion scope)

* **p3:** S0 free deletions + ForceUpdateConfig inline ([e8837cd](https://github.com/yeyuan98/zodex/commit/e8837cd3fbe8725cb67144a5f6253999acd0dbbf))
  * delete shared plan-identity.ts / provider-family-connection-selection.ts / account-provider-state.ts (verified zero importers; barrel re-exports and package.json subpath removed with them)
  * delete dead provider/updateAccountConfig wire: params/result schemas + method id (zero handlers repo-wide)
  * delete resolveRuntimeProductEndpointConfig + RuntimeProductEndpointConfig (zero importers)
  * inline ForceUpdateConfig into forceUpdate.ts ahead of the coding-plan-subscription.ts deletion in C2 (gate itself is disposed of in P5)

* **p6:** sweep 2f — delete just-in-case legacy structures ([b969de7](https://github.com/yeyuan98/zodex/commit/b969de7404e4f69b3af567d56faa36b6dbd8ff38))
  * builtinSkillI18n: markers and descriptions for P5-deleted plugins removed (superpowers attribution + bundled browser-use kept; legacy "browser" alias had no live producer); cached stale installs fall back to plugin English copy
  * marketplace records: strict shape validation in shared (isValidPersistedMarketplaceSource/isAllowedPersistedMarketplaceSource) + reserved-id disk source contract (official=bundled, libre=default raw url); adapter loader array-only; old/malformed/vendor-CDN-source records dropped at load and defaults re-seed; official refresh branch is now pure bundled-no-network semantics
  * shared pluginMarketplacesP6 tests cover shapes + reserved contract + external repo URL pin; endpointWebPurge guard exempts the vendor-free gate script (must name what it bans); gate self-exclusion recorded in spec

* **plugins:** de-vendor marketplace — bundled-only official + libre default; kill paid-plan/featured/phantom listings ([4ff018c](https://github.com/yeyuan98/zodex/commit/4ff018c12ee0ef76474a06279435ac8137592956))
  * DEFAULT_PLUGIN_MARKETPLACES = 2: official (source-less, bundled-only:
  * DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS shrunk to in-tree pair; phantom
  * ZAI_AUTHOR + OFFICIAL_PLUGIN_ASSETS_BASE_URL deleted; browser-use author/icon
  * reserved-id set {official, libre} backs addMarketplace + bootstrap guards
  * requiresPaidPlan purged end-to-end (protocol schema, contracts type, parser,
  * Featured shelf deleted (no writer anywhere); auto-refresh retargeted to
  * featureSuggestedPrompts: vendor CDN icon base deleted; 13 dead-plugin entries
  * tests: parity (shared pinned set === bootstrap-derived, previously-fictional),
  * 3 store i18n keys x2 locales dropped in the following commit (shared locale file)

* **provider:** excise zhipu account access types + overlay; adapt CLI (P1 slice 2+2b) ([d41b31a](https://github.com/yeyuan98/zodex/commit/d41b31a17d04a6f61a2319be16ab7ee585cf0ca1))
  * delete zhipu-account/zhipu-coding-plan-api-key zod literals (access is api-key only), ZhipuAccountAccessConfig class, account overlay layer (account-provider-resolution/service/state, accountProviderConnectionResolver/Invalidation), account branches across config-service/resolver/registry-service/facades/sources/effective-model-selection
  * services wiring: node.ts/zcodeAgentService.ts account-config sync to agent removed; resolveCurrentAccountAccess/resolveAccountProvider become inert nulls (registry can no longer publish account providers); provisioning account-provider scope dropped (shared provider-provisioning.ts)
  * CLI (compiles against root packages via symlinks): delete standalone-account-provider-runtime + compile-forced chain (auth-login*, tui-auth, login-command, zcode-protocol/account-provider-config, login/logout dispatch) — these died with the account runtime; /login /logout surface gone transitively
  * runtime-string sweep: zero zhipu-account/zhipu-coding-plan literals outside protected shared protocol schemas (kept until P3 per master-plan amendment A1)
  * new providerVendorAccessExcision.test.ts: schema rejects both vendor access types; stale personal.json with vendor access fails whole-file parse (containment per spec)
  * protected P3 domains untouched: oauth/**, coding-plan-subscription/**, usage-stats/**, offPeakRuntimeModel, codingPlanProviderAvailability, accountProviderApiClient/CredentialService chain, protocol account schemas

* **services,shared:** purge vendor usage quota surface (P3 S2) ([13edfe6](https://github.com/yeyuan98/zodex/commit/13edfe66b20e0d8031345bfb41a3da311260a948))
  * 删除 shared/src/usage-stats.ts（vendor 半边：UsageStatsRequest/Snapshot、CodingPlanUsage*、UsageEntitlement*、PlanIdentity*、monitor 聚合类型）与 usage-quota.ts 全部额度类型；barrel 只保留 app-usage.ts
  * IUsageStatsService 仅保留 getAppUsageSnapshot；删除 getCodingPlanUsageSnapshot、getCodingPlanReset*、markCodingPlanResetHistoryRead、getSnapshot(monitor)、getEntitlementSnapshot
  * usageStatsService 甩掉全部三个跨 slice import（isCodingPlanModelProviderId / IAccountRequestAuthService / OfficialMcpCredentialSource），只依赖 zcodeAgentService
  * 删除 7 个 vendor provider：bigmodelUsageQuotaProvider/MonitorMapper/MonitorRange/QuotaMapper、bigmodelSubscriptionProvider、zcodeMcpQuotaProvider（providers/ 目录清空）
  * node.ts：usage 注册仅注入 zcodeAgentService；officialMcpCredentialSource 常量与 resolveOfficialMcpCredentials 导入随额度查询面删除（MCP 身份头 resolver 保留，属 C3）
  * desktop remoteWorkspaceServiceCollection：usage 注册同步精简；localAccountRequestAuthService/OAuthCredentialRepo/accountProviderCredentialService 等 vendor 查询链随之移除
  * UI 过渡：新增 lib/usageQuotaShapes.ts（C4 de-plan 时移除），model-provider-section 存活文件与 codingPlanProvider/codingPlanQuotaPresentation/codingPlanOwnedEntryPlans 的 entitlement/quota 类型改从过渡模块导入

* **settings:** delete providerFamilyDomain* field family + providerFamilyConnectionSelections (P1 slice 1) ([39f2169](https://github.com/yeyuan98/zodex/commit/39f2169b9ad9e461b94d46c33e5422ee731e435a))
  * remove providerFamilyDomain/providerFamilyDomainUpdatedAt/providerFamilyDomainMigrated/providerFamilyConnectionSelections from validationAppSettings (both schemas), protocol AppSettings, normalizeSettingsPatch, setting broadcast keys, settingService comparisons
  * compile-driven UI fan-out (~30 files): coding-plan Connect/Upgrade visibility, sidebar usage summary sections, composer start-plan quick-select, off-peak eligibility reads, account-connection-loss suggestion, plan-mode switch persistence all die with the field (per spec expected-death list; off-peak/account entitlement becomes inert until P3)
  * P3-scoped services: surgical read-removal only (codingPlanProviderAvailability team context constant-unknown; accountProviderConnectionResolver constant-null access; provisioning envelope drops accountSettings member; settingService legacy import/rollback machinery deleted — legacyAccountConnectionSettings + legacyTeamOrganizationResolver existed solely to feed the deleted field and are removed whole)
  * delete UI libs that existed only for the field (providerFamilyDomainSettings, modelProviderFamilyConnectionSelection, oauthProviderFamilySelectionRefresh, accountConnectionLossSuggestion)
  * i18n: 6 orphaned keys removed from both locales (usage/connection-suggestion strings)
  * old setting.json keys strip harmlessly on parse (verified runtime lenient parse; no migration per alpha policy)

* **shared,services,desktop,ui,cli:** rebuild off-peak as local window-admission feature (P3 S1) ([85c856f](https://github.com/yeyuan98/zodex/commit/85c856f81872135cf064e3240f0c5cb9f8c7fe70))
  * off_peak_tasks 删除 6 个供应商票据列（server_ticket_id/registered_at/schedulable/queue_position/next_poll_at/settled_at），索引 0 变更
  * repo 行映射/create/markRunning/markTerminal/invalidateModelSelection/claimDue 同步裁剪；claimDue = status='queued' AND claim_running=0（认领前由 scheduler→main 时间窗准入）
  * 删除 updateSchedulingSnapshot/markSettled/listUnsettledTerminal/requeueForContinuation（票据快照/核销 outbox/3102 续跑语义）
  * offPeakTaskService 重写：创建即落库（无取号/额度/灰度门），资格=存在可解析的模型选择；删除 offPeakTaskSync 轮询与 settle outbox；保留重启恢复语义
  * 删除 offPeakServerClient/offPeakMockGateway/offPeakModelSelectionView；offPeakRuntimeModel 只保留确定性错误类型
  * zcode-protocol off-peak create/snapshot 删票据字段与 3101/3103 分类；modelExecutionSchema 删除 requestAuth 字段
  * host dispatchOffPeakRun 删 requestAuth 注入与无票 guard；执行用任务持久化 Selection
  * 闲时免打扰（binding policy）：off-peak turn 为会话活跃 turn 期间（host 派发注册表，终态/订阅释放摘除），permission/AskUserQuestion/plan-approval 在 agent service 层自动拒绝；普通 turn 不受影响
  * OffPeakCreate 工具缺省权限档 yolo→build
  * 删除 offpeak-retry.ts（429 排队豁免/3102 标记）；runner-generate/runner-stream offPeak 分支与 ticket 头脱敏删除
  * bootstrap model-execution 删 requestAuth freeze；requestDependencies/ModelRequestAuthSource 注入链删除（ModelRequestAuth 保留给账号 runtime headers 刷新路径）
  * contracts off-peak 工具/端口删票据字段与额度/资格分类
  * providerBusinessError 3102 分支、ChatErrorBanner 标记兜底、offPeakTaskStore quota_3103/灰度/额度面删除
  * 'account-offpeak' Provider 身份类删除（effective-model-selection/model-selection-facade）

* **shared:** rehome AppUsage schemas to app-usage.ts (P3 S2) ([34b3d41](https://github.com/yeyuan98/zodex/commit/34b3d414c77e4ad6c3023666f6894c9f3260a85e))
  * 新增 packages/shared/src/app-usage.ts：ESTIMATED_TOKEN_CHAR_DIVISOR、APP_USAGE_RANGES、全部 appUsage*Schema 与 AppUsage* 类型、AppUsageRequest（P3 供应商套餐/配额面删除的通用半边迁移）
  * usage-stats.ts 顶部 re-export app-usage.js，删除文件内重复定义；协议 import 暂不切换行为
  * zcode-protocol/index.ts 与 zcode-protocol-v4/transport.ts 的 usage stats 方法 schema 改从 ../app-usage.js 导入（方法本身保留，AppUsage-only）
  * shared barrel 增加 app-usage 导出

* **ui:** delete vendor plan/quota usage UI cluster (P3 S2) ([4fd86c8](https://github.com/yeyuan98/zodex/commit/4fd86c85a74d9e85f1818a507bdfe19a97663ac3))
  * 删除 Coding Plan 用量面板族：CodingPlanUsagePanel/BarChart/LineChart、codingPlanUsageChartSeries、codingPlanUsageSources、来源偏好 sidebarUsageCodingPlanProviderPreference
  * 删除 entitlement UI 链：hooks/useUsageEntitlement、usageEntitlementCache、usageEntitlementRefreshPolicy、CodingPlanUsageRemainingPanel、WorkspaceSidebarFooterUsageSummary(+PlanBadgeHelpers)、footer 用量摘要/套餐徽标/升级入口接线
  * 删除额度重置簇：components/coding-plan-quota-reset/*（5 文件）、codingPlanQuotaResetUi/Coordinator/Confetti、useCodingPlanQuotaResetUi、store/codingPlanQuotaResetState（含 store 字段与跨窗口广播）、chat-input-toolbar 重置自动播放/机会提醒/徽标、contextQuotaMeterGrid、contextPanelAction（孤儿）
  * 删除 v4 会话额度横幅族：useV4SessionQuotaBanner、ConversationQuotaBanner、sessionQuotaBannerState/DismissalStore、startPlanQuotaBuckets/ReminderStore；SessionPane 移除 quotaBanner/handleOpenModelUpgrade/mcpUnavailableNotice 接线
  * 删除 Start Plan 推荐改选：useStartPlanRecommendation、startPlanRecommendation、startPlanEntitlementOptions、selectionSideInheritedModel（孤儿），SessionPane/AutomationEditView/SubagentsSection 调用点改为直接使用当前选择
  * contextUsage.tsx 收敛为 context-only（仅 Context windows 统计），V4ComposerToolbar 移除 entitlement/余额/升级组装
  * SettingsPage Usage 分区改单一 App Usage 面板；settingsNavigation 移除 usageTab 意图管道；ChatErrorBanner/ConversationComposer 移除升级入口
  * providerBusinessError 移除额度横幅专用业务码解析；useCodingPlanEntitlements 退化为空权益 stub（C4 de-plan 时移除）；StatusCards 剥离额度重置 UI；CodingPlanEntryButton gate 退化为恒 ready
  * useUsageStats 仅保留 useAppUsageStats（agent 数据库统计）


### Other Changes

* docs+test(p1.2): review fixes — full-lineup sweep test, plan re-shift corrections ([a5348f1](https://github.com/yeyuan98/zodex/commit/a5348f1bf88a1e0ccd2d2c178812cbfdd79e596e))
  * committed full 11-model bigmodel lineup sweep (vision only for flash/flashx; ctx tiers 131072/200000/1M) — hardens against future catalog drift (reviewer's throwaway sweep verified current values)
  * master plan: P1.1 version-note range re-worded (alpha.6 re-taken by P1.2); runbook A1..A10

* feat! remove coding-plan subscription service + shared purchase protocol + UI cluster (P3 C2) ([c68171d](https://github.com/yeyuan98/zodex/commit/c68171da7051abe4c6d94607ab60c550adfda061))
  * services: 删除 coding-plan-subscription/**（4 文件，购买/企业订单/静态目录/
  * node.ts: 账号请求鉴权改内联空 resolver（Registry 自 P2 不发布账号 Access，
  * accountRequestAuthService.ts: AccountRequestAuth* 类型与
  * wiring: accessor / services index / client remoteServiceAccess /
  * shared: 删除 coding-plan-subscription.ts（519L 购买/企业订单协议类型；
  * ui: 删除购买入口链（CodingPlanEmbeddedWebviewDialog + codingPlanEmbeddedWebview +

* feat! remove vendor OAuth services + adopt dormant user framework (P3 C1) ([9e75dae](https://github.com/yeyuan98/zodex/commit/9e75dae44dedfcf50dce2eca69ae20afb599e7a6))
  * 删除 packages/services/src/oauth/**（16 文件，含 providers/ 与 repo/oauthCredentialRepo.ts）；
  * node.ts：移除 apiClient 401 分类钩子、corrupt-session 登出广播、onboarding loadUserId
  * shared：新增 user.ts（UserInfo 迁入，ruling 6）与 credential.ts（通用凭据解密错误码迁入）；
  * channels/platform：删除 ServiceChannels.OAuth 与 OAuthRegisterState/OAuthCallback/
  * providerProvisioningSource/Target：OAuth 凭据键 allowlist 清空，同步机制保留。
  * desktopOAuthDeepLink.ts 拆分为通用 desktopDeepLink.ts（workspace/支付/分享导入路由、
  * appLaunchCoordinator 简化为 ready 即消费启动 gate（OAuth 回调等待删除）。
  * remoteWorkspaceServiceCollection 移除 OAuth 服务重实例化与登出 handler。
  * desktopRuntimeEnv/tsup/.env.example/server connect.ts 裁剪 ZAI_OAUTH_* 注入
  * 删除 useRootOAuthEffects、oauthCachedSessionRestore、oauthLoginAttemptGuard、
  * store 删除 OAuth 会话字段簇（isRestoringOAuthSession/oauthError/oauthPollingActive/
  * WorkspaceSidebarFooter 移除头像/用户块与登录/退出菜单，偏好菜单改中性触发器；
  * ModelProviderSection 仅摘除 OAuth 同步回调块；rootStartupGate 去掉启动 auth 恢复门禁。
  * i18n：删除 login.oauth.*/login.expired.*/logout.*/sidebar.profile.*/app.login/

* Initial commit ([77432b6](https://github.com/yeyuan98/zodex/commit/77432b6dbf9f70176ced3f4dcdc25f851c3acb2d))

## [3.14.3-alpha.10](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.9...v3.14.3-alpha.10) (2026-09-28)

### Features

* **p6:** vendor-free gate script + unit tests; wire into verify:pre-push and knip ([c668f02](https://github.com/yeyuan98/ZCode/commit/c668f02de4b7a53d0b1afca785cb89e1637ce82d))
  * scripts/check-vendor-free.mjs: five fool-proof vendor patterns (no glm), binary-by-extension skip, CHANGELOG/plan/specs exclusions, 3-entry negative-assertion allowlist; --list triage mode; strict exit 1 on un-allowlisted hits
  * scripts/check-vendor-free.test.mjs: synthetic corpus (patterns, line numbers, classification, violations vs allowlisted, glm non-matching, allowlist paths exist)
  * verify:pre-push appends the gate; knip gains both script entries


### Bug Fixes

* **p6:** [ulw] review round fixes (RA/RB/RC applied once) ([c9073b5](https://github.com/yeyuan98/ZCode/commit/c9073b518be1a621243064ad5097d2343815a81c))
  * spec: correct inverted container wording (map dropped, array kept) and record that marketplace strict-contract tests live in shared (A-P4.1: CLI has no runner; adapter is a thin delegate)
  * gate: summary counters now report real excluded/binary counts (classify before skip) instead of always printing 0
  * locales: delete second orphan key settings.modelProvider.namePlaceholder (both locales; no static or dynamic consumer — same class as the 2c orphan)

* **p6:** drop redundant knip entries for vendor-free gate scripts ([2b16064](https://github.com/yeyuan98/ZCode/commit/2b160646f2f7612ffa2f9b8671e413d8342b39c5))

* **p6:** sweep 2a/2b — product docs URL repoints to repo; drop pre-rename glm decode ([80e4ab7](https://github.com/yeyuan98/ZCode/commit/80e4ab76021549cfa86f87288c2cd1542868c1fa))
  * productDocs: ZCODE_PRODUCT_DOCS_URL now the repo README (Help menu + quick-pick show repo docs, not the deleted vendor site); ui test pins the target
  * provider-selection-v2: frozen 0002 decode keeps only the "zcode" execution-backend spelling (A-P6 amendment reverses the P4 keep-ruling); services test pins decode outcomes incl. the recorded dead-providerId breakage for hypothetical glm rows


### Chores

* **p6:** sweep 2c/2d/2e — dead code, vendor-literal comments, stale locale copy ([678394a](https://github.com/yeyuan98/ZCode/commit/678394ab837c2723b23f239c9be43f5afc2b9701))
  * drop never-read _legacyProvider param (4 call sites + contract test) and orphan en-only key settings.memory.viewer.disabled
  * reword vendor-naming comments in remoteCdn/provider-data-schema/zcodeAgentService/zcode-protocol/featureSuggestedPrompts/desktopDeviceMid (device-id module kept per user directive; stale deletion promise removed) and trim the cli build.mjs endpoint tombstone
  * locales: neutral provider-name placeholder + section title (zh), delete orphan presetDescription pair, and neutralize presetEmpty stale OAuth wording

* **p6:** third-party notices full resync; drop orphaned ARMS evidence files ([4fda2d8](https://github.com/yeyuan98/ZCode/commit/4fda2d86b7eccc9cbabbe0602d16baad4b5118fc))
  * regenerate via licenses.mjs notices: only expected hash updates land (root package.json verify:pre-push change; builtinSkillI18n sweep) — ARMS/swr entries already absent since P5's regen
  * the three @arms/* upstream evidence txt files lost their override entries with P0's ARMS removal and are referenced by nothing (hash grep clean) — deleted


### Documentation

* **p5:** AGENTS.md release-verification covers both jobs + all asset kinds; record W2 layout-selection amendment in spec §B ([c023f27](https://github.com/yeyuan98/ZCode/commit/c023f272c515c7dfc92fae29adeb02f2f8281c84))

* **p6:** succinct quickstart READMEs + docs/ module docs; trim .env.example ([3baa614](https://github.com/yeyuan98/ZCode/commit/3baa614a2e7043b61859926281fd898ff81d5899))
  * README(.en): 2-3 line intro, install/first-run quickstart, docs index; build/dev content relocated (not lost) to docs/development.md + docs/packaging.md; inherited vendor/origin community links removed
  * docs/providers.md (API-key/Ollama-template/vLLM-as-custom + reference), docs/updates.md (update channel, prereleases, three mirror vars), docs/plugins.md (bundled/libre/personal sources)
  * .env.example: tombstone comments dropped, live vars only, missing ZCODE_UPDATE_FEED_URL mirror var added
  * config/default.json en-US community URL repointed from inherited Discord to repo Discussions; NOTICE link follows the moved CLI section anchor

* **p6:** vendor-free gate + PR CI spec of record; amend keep-rulings per user directives ([9a43a6b](https://github.com/yeyuan98/ZCode/commit/9a43a6bb8ae49cc9af54bfb879e6cc221ea41d83))
  * new specs/vendor-free-gate-and-ci.md: five-pattern gate design (no glm), 3-entry allowlist, CI job matrix, four binding user directives
  * agent-identity spec: A-P6 amendment reverses the both-strings-decode Keep ruling (drop "glm" string, keep "zcode" semantics; new decode unit test; legacy importers kept)
  * distribution spec: P6 section records builtinSkillI18n marker shrink (superpowers kept) + strict known-marketplaces loading (inert guard layers retired, reserved-id guard kept)
  * VENDOR-PURGE-PLAN §4 P6 rewritten to the directive-shaped scope; final 3.14.3 moved to a separate session

* **plan:** record P5 delivered state — alpha.9 merge/release, amendments A-P5.1-8, A9 matrix row ([b6bebcd](https://github.com/yeyuan98/ZCode/commit/b6bebcd052d9bc061ce762e926a6fb83ee4328bd))


### Refactorings

* **p6:** sweep 2f — delete just-in-case legacy structures ([00c0022](https://github.com/yeyuan98/ZCode/commit/00c00225e988d4f5709672a7eecc828945b1a05a))
  * builtinSkillI18n: markers and descriptions for P5-deleted plugins removed (superpowers attribution + bundled browser-use kept; legacy "browser" alias had no live producer); cached stale installs fall back to plugin English copy
  * marketplace records: strict shape validation in shared (isValidPersistedMarketplaceSource/isAllowedPersistedMarketplaceSource) + reserved-id disk source contract (official=bundled, libre=default raw url); adapter loader array-only; old/malformed/vendor-CDN-source records dropped at load and defaults re-seed; official refresh branch is now pure bundled-no-network semantics
  * shared pluginMarketplacesP6 tests cover shapes + reserved contract + external repo URL pin; endpointWebPurge guard exempts the vendor-free gate script (must name what it bans); gate self-exclusion recorded in spec

## [3.14.3-alpha.9](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.8...v3.14.3-alpha.9) (2026-09-28)

### Features

* **desktop:** switch auto-update to GitHub Releases provider; delete vendor manifest feed + force-update gate ([6c040c4](https://github.com/yeyuan98/ZCode/commit/6c040c4d858d2075dd708f1392162061a16b9ae4))
  * electron-updater feed = github provider (yeyuan98/ZCode); single latest.yml
  * bundle.mjs passes --publish never (CI tag builds would otherwise trigger
  * release workflow uploads latest.yml + *.exe.blockmap beside the installer
  * deleted: manifestUpdateProvider, forceUpdateGuard, forceUpdatePrompt,
  * re-enabled all three P0-guarded update paths (production-flavor gate kept);
  * new updateFeedRuntime.ts: allowPrerelease floor rule (previews-on OR
  * refreshAutoUpdaterReleaseChannel flips allowPrerelease + re-checks; dev
  * desktopSecondInstanceDeepLink drops forceUpdate params (signature chain in
  * tests: updateFeedRuntime units (8) + source-scan guards (4: no channel

* **remote-assets:** GitHub Releases flat asset naming; single-candidate default; mirror layout rules ([151fa22](https://github.com/yeyuan98/ZCode/commit/151fa22d896863c62dda1aefbaf20ef6542bdc2a))
  * desktop remoteCdn default base = github.com/yeyuan98/ZCode/releases/download/v<version>
  * server remoteAssetCdn: v<version>-tailed base = flat layout — exactly ONE url per
  * prepare-prebuilds flat staging mode (ZCODE_REMOTE_ASSET_FLAT_STAGING_DIR): emits
  * scripts/lib/flat-asset-names.mjs pure name build/parse module + unit tests
  * new packages/server test harness (registerTsLoader pattern) + remoteAssetCdn
  * .env.example CDN rows re-documented (GitHub default flat; mirror overrides nested)
  * knip.json registers the flat-name module entry (root-workspace precedent)

* **share:** delete vendor conversation-share chain; preserve export seed modules ([c694aad](https://github.com/yeyuan98/ZCode/commit/c694aadabe5ac9d04a3f0bd395e5c537707efc75))
  * deleted services/src/conversation-share/** (8 files, ~5.5k ln): publish/import
  * deleted shared/src/conversation-share.ts (incl. decodeConversationShareRows,
  * deleted web/src/share/** (landing page) + main.tsx share wiring + VITE share
  * deleted UI surface: share menu/picker/readonly-timeline (D-P5.2 hard-cut of
  * remoteWorkspaceServiceCollection: share client + ZCODE_JWT_TOKEN_KEY dead
  * preserved decode-only protocol schemas (old snapshots still parse)
  * NEW services/src/conversation-export/ seed modules (loadAllRows, structure
  * locale cleanup: 165 conversationShare.* keys x2 locales + 3 plugin-store
  * desktop renderer-only tsconfig build errors: 0 new vs HEAD

* **share:** local conversation markdown export (replaces vendor share) ([1e83791](https://github.com/yeyuan98/ZCode/commit/1e837912a9213d22d2ed5916793cbecf0076a0bb))
  * new IConversationExportService (conversation-export channel): whole-session
  * formatter extends the seed: subagent rows render (summary + child-session
  * registration chain: ServiceChannels.ConversationExport + accessor + node.ts
  * UI: WorkspaceExportConversationButton in the old share header slot (icon-md
  * i18n: conversationExport.* 5 keys x2 locales
  * services tests 87 (+12: formatter matrix, guard, happy path w/ fake agent,


### Bug Fixes

* **p5:** [ulw] review round fixes (RA/RB/RC applied once) ([872499b](https://github.com/yeyuan98/ZCode/commit/872499b7d7308d0f583ffd6d390b5a2a28e24456))
  * RA1: refreshAutoUpdaterReleaseChannel now honors the product-flavor disable
  * RA2: web saveFile defers revokeObjectURL by 10s (WebKit blob-fetch abort)
  * RB1: remove permanently-unavailable 'Create plugin' menu entry +
  * RB2: CLI README plugin section rewritten to P5 reality (bundled-only
  * RB3: delete knip-dead conversationRowSelection v2 seed (spec amendment 7
  * RB4: drop dead featured field from marketplace summary schema
  * RB5: sweep stale root-scoped services on daemon register (old-named
  * RC1: remove stray committed schedulerProtocol.d.ts.map build artifact
  * re-ran ALL gates post-fix: typecheck/lint/fmt/architecture 0/0, suites


### Chores

* **fmt:** apply oxfmt to plan + P5 spec (pre-existing fmt debt) ([a5b1535](https://github.com/yeyuan98/ZCode/commit/a5b1535821f55b429c18fe1ac5f5d02dde7e19f3))

* **identity:** neutral installer identity; rename background services; cut endpoint-origin web + clientScenes chain ([cd68320](https://github.com/yeyuan98/ZCode/commit/cd68320a9e17eacd675c50a31ca0c39980398d49))
  * electron-builder homepage/author/maintainer -> repo values
  * serviceManager names com.zhipu.zcode.server -> app.zcode.server (D7, no
  * Help-menu ZCode Endpoint selector, zcodeEndpointOrigin setting (both zod
  * zcodeEndpoint.ts DELETED (zero surviving importors; resolveRuntimeZCodeEnv
  * clientScenes chain deleted (nodeApiClient/apiEndpoints/apiJson/requestIdHeaders/
  * connect.ts drops ZCODE_BASE_URL/ENDPOINT_ORIGIN remote env passthrough;
  * tests: endpointWebPurge (4) — schema absence + legacy-file parse,

* **p5:** sweep P5-introduced unused exports + swr dep ([c59d753](https://github.com/yeyuan98/ZCode/commit/c59d753af5872e99a379e28cc3dedcd01230ce3f))
  * de-export AssistantTextRange / ConversationTurnNavigator types /
  * delete unused useOptionalBaseWorkspaceServices (clientScenes hooks were its
  * drop swr from packages/ui deps (last SWR consumer was useClientScenesResource)
  * knip set-diff vs branch point: zero P5-introduced unused entries


### Documentation

* **p5:** NOTICE rows track P5 behavior; README mirror guidance ([2a1a67f](https://github.com/yeyuan98/ZCode/commit/2a1a67f24ea4d65e8c2e6d0d9c40da422a89e1c9))
  * NOTICE: share/import row replaced by local-export disclosure (no upload);
  * README: release section mentions updater metadata + remote-asset CI job;

* **plan:** record P4 delivered state — alpha.8 merge/release, amendments A-P4.1-3, A8 matrix row ([0faef49](https://github.com/yeyuan98/ZCode/commit/0faef4968fb775b07a824054e97d5e5a6644f251))

* **spec:** record conversation-export W4b amendments (input shape, scope factory, e2e descope) ([5e6d066](https://github.com/yeyuan98/ZCode/commit/5e6d06616de570e5100c11b68e50751cbc80186a))


### Refactorings

* **plugins:** de-vendor marketplace — bundled-only official + libre default; kill paid-plan/featured/phantom listings ([252026e](https://github.com/yeyuan98/ZCode/commit/252026e4e6278e40acfadfec6558eefa2d07c62a))
  * DEFAULT_PLUGIN_MARKETPLACES = 2: official (source-less, bundled-only:
  * DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS shrunk to in-tree pair; phantom
  * ZAI_AUTHOR + OFFICIAL_PLUGIN_ASSETS_BASE_URL deleted; browser-use author/icon
  * reserved-id set {official, libre} backs addMarketplace + bootstrap guards
  * requiresPaidPlan purged end-to-end (protocol schema, contracts type, parser,
  * Featured shelf deleted (no writer anywhere); auto-refresh retargeted to
  * featureSuggestedPrompts: vendor CDN icon base deleted; 13 dead-plugin entries
  * tests: parity (shared pinned set === bootstrap-derived, previously-fictional),
  * 3 store i18n keys x2 locales dropped in the following commit (shared locale file)

## [3.14.3-alpha.8](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.7...v3.14.3-alpha.8) (2026-09-28)

### Features

* **p4-b:** delete WebSearch tool + supportsNativeWebSearch + providerNative mechanism ([d63aae0](https://github.com/yeyuan98/ZCode/commit/d63aae0a16978c835d5e1f236c5c181cccc24826))
  * delete websearch handler/contract files and all registry/barrel/subpath-export entries
  * remove anthropic-only provider-native encoding branch + helpers + option feeders in adapters
  * remove required per-model field supportsNativeWebSearch across shared/provider/prompt-trajectory (hard cut per spec Ruling 2; strict parse rejects old configs, no normalization)
  * remove tool from name-keyed lists: tool-identity known names, explore tools, microcompact, permission read-only, explore profile, provider-visible order, tool alias map (now identity), scheduler, subagents defaults, UI tool options, CLI argument alias rewrite
  * remove identity-mapped telemetry enum pair (agent-execution + model-api operation + querySource case)
  * excise providerNative tool mechanism (contracts tool contract fields, model contract passthrough, core registry/types)
  * remove UI metadata-editor field, i18n key + capabilities help bullet (both locales), NOTICE.md WebSearch sentence
  * keep: webSearchRequests usage accounting, 'search' tool family, embedded-search, catalog glm-free invariant test
  * tests: shared toolIdentity (no WebSearch + search family intact); services schema-rejection of removed field; fix providerModelDiscovery personal-path isolation (resolve after setDataBaseDir)

* **p4-c:** delete coding-plan gateway, start-plan error cluster, ModelRequestAuth chain, dead vendor residue ([630a19e](https://github.com/yeyuan98/ZCode/commit/630a19ee2e801fcedb5968b97acf7c9cbb03ddcd))
  * delete official-coding-plan-gateway.ts + model-execution transport cache/wiring + barrel export; zai/bigmodel templates now connect directly to configured base URLs (NOTICE.md gateway row removed)
  * delete start-plan 3008/3009/3010 cluster: streaming-recovery sets/helpers, turn-model-step admission-retry branch + start_plan_admission_retry_discarded, target-completion-verification retry loop, failure-code entries (generic 429 path absorbs), UI providerBusinessError entries + i18n 3008/3009/3010 + dead 3102 + dead team-plan code/keys
  * delete dead OffpeakQueued retry reason + all consumers (telemetry recorder, governor, product-projection, dynamic-workflow, UI throttle map + keys); old replays may render raw codes (documented degradation)
  * delete inert ModelRequestAuth chain end-to-end: contracts types + ModelRequestAuthMissing code, core attach sites + port machinery, adapters runner-runtime chain (incl. runner-runtime-headers.ts), bootstrap port, desktop protocol schemas/methods, host fast-fail handler; session-title dead deferral gate removed (titles now generate on normal schedule)
  * delete phase-3 residue: /login redaction regex in tui app-submit, history.ts api-key pattern, login/logout slash-command union members + argv routing, shared-credentials vendor keys/types/methods (generic MCP OAuth store kept), unreachable account-plan model-selection branch + union + mapping
  * neutral-rename bracketed business-code parser symbols/comments (behavior kept)
  * tests: shared zcodeProtocolP4Purge guard (protocol no longer exports runtime-headers methods/schemas)

* **p4-d:** rename agent provider identity glm -> zcode end-to-end ([0263400](https://github.com/yeyuan98/ZCode/commit/0263400b88f5b03f51891f3f2cf175aaf1ac4ece))
  * flip both provider literals in one commit (providers.ts ZCODE_PROVIDERS + zcode-task-types-core ZCodeProvider) + ZCODE_AGENT_PROVIDER const; rename task event glm_agent_model_state_update -> zcode_agent_model_state_update + ZCodeGlm* type names (desktop-internal literal)
  * outbound identity headers: X-ZCode-Agent: zcode; HTTP-Referer vendor platform origin -> repo URL (https://github.com/yeyuan98/ZCode)
  * env/dir rename in lockstep: GLM_BINARY_PATH -> ZCODE_AGENT_BINARY_PATH + bundled/remote dir glm/ -> zcode/ via shared descriptor; desktop env writer now derives from descriptor (single-source invariant); resolveBundledGlmBinaryPath -> resolveBundledAgentBinaryPath; deploy paths, remote package id, glm-content cache id, windows install locks, electron-builder from/to + signIgnore, prepare-prebuilds/stage-agent-bundle/prepare-agent-node-bundle/koffi scripts (old asset ids kept in nonReusableReleaseAssetIds history + new ids added)
  * skill prefix glm: -> zcode: producer + UI filter/permission map/display-help keys + 16 mode.* i18n keys both locales (atomic flip; enablement stays path-keyed)
  * icons: GlmMonochromeIcon -> ZcodeMonochromeIcon + icon assets renamed; orphan icon-glm.png deleted; third-party/inventory.json regenerated via licenses script
  * literal sites: task adapter alias, skills service, host WSL release, legacy remote allowlist query (hard cut, persisted rows orphaned per Ruling 1), task-model recovery (hard cut + 中文注释), bots mode-label key; comment rot updated where touched
  * tests: update 3 glm-asserting tests; add shared agentIdentityInvariants (provider/env/dir/event values) + ui skillReferencePrefixContract

* **p4-e:** rename zai themes to zcode, neutral WebFetch UA, neutralize vendor-citing comments ([056ee0e](https://github.com/yeyuan98/ZCode/commit/056ee0ed33b3526e9c0778a0641da55f689538ab))
  * rename theme ids zai-dark/zai-light -> zcode-dark/zcode-light across ui/web/desktop (93 replacements, 23 files: type/normalize/fallback, CSS classes, persisted default, settings config/sidebar, diff/mermaid/message/preview surfaces, palette, logo, i18n keys both locales, web seed + share route + index.html, desktop renderer/resource-manager); no old-value fallback (stored themes reset once, 中文注释 at fallback)
  * WebFetch User-Agent URL -> https://github.com/yeyuan98/ZCode (was vendor domain)
  * neutralize vendor-citing comments on kept behavior: compact empty-length finish guard, tool_result image-block ordering, workflow submit_result coercion, browser locator stable-pointer note


### Bug Fixes

* **p4-review:** apply [ulw] review fixes — durable theme reset, proxy/CA fetch memo, spec amendments ([1489271](https://github.com/yeyuan98/ZCode/commit/14892714a039b19adbeeeda091f0b14eb6226021))
  * theme hard-cut made durable: pre-hydration readers (desktop renderer main, resource-manager window, web index.html bootstrap) validate stored theme and write back zcode-dark once; useTheme fallback persists — reset now happens exactly once instead of recurring first-paint flash
  * model-execution: instance-level proxy/CA fetch memo restores single CA read (lost with gateway transport cache deletion); business-error wrapper reuses memoized network fetch
  * neutralize two stale 'Zai dark' comments (desktop renderer main, web main)
  * spec amendments: A-P4.1 descope CLI-infra-dependent test units (compensating guards recorded), A-P4.2 accepted degradations (HTTP-200 SSE 3008 terminal-unknown; personal-config whole-file degradation under Ruling 2; offpeak_queued raw replay), A-P4.3 review fixes


### Documentation

* **plan:** A7 matrix row — delivered test counts + pending manual-pass note ([573bd66](https://github.com/yeyuan98/ZCode/commit/573bd668cf984e483856a5d126dca85fb059ee94))

* **plan:** record P3 merge/release hashes (b508f3c / 020f430 / v3.14.3-alpha.7) ([2e82768](https://github.com/yeyuan98/ZCode/commit/2e82768782f2551fe5f3b70bd8780cb720ce43d9))

* **spec:** P4 design of record — agent identity rename + WebSearch/gateway purge ([6df4204](https://github.com/yeyuan98/ZCode/commit/6df4204fc9216da1534122c041a5039666b8d854))
  * add specs/agent-identity-and-tooling-purge.md as P4 (alpha.8) spec
  * record rulings 1-8 incl. hard-cut for old glm data/configs (no migration, no config normalization)
  * define rename lockstep invariants (provider literal, env/dir descriptor, skill prefix, packaging scripts)
  * protect keep-lists: webSearchRequests accounting, search tool family, catalog GLM rules, BigModel ordinary error codes
  * test matrix incl. mandatory windows-bundle smoke (installer layout change)

## [3.14.3-alpha.7](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.6...v3.14.3-alpha.7) (2026-09-27)

### ⚠ BREAKING CHANGES

* replace remote builtin-provider catalog download with bundled-only source (P3 C5)
* **desktop:** delete context-prompt rollout + shared client/configs fetcher (P3 C5)
* remove vendor client/configs service + channel; plugin-store order falls back to bundled (P3 C5)
* remove vendor family/specs + de-plan settings provider page (P3 C4)
* **shared,ui:** unpin image-search from default-enabled official plugins (P3 C3, ruling 5)
* remove official MCP service + auth protocol + CLI adapter chain (P3 C3)
* **desktop,shared,web:** remove coding-plan webview/paypal/payment deep-link chain (P3 C2)
* **web:** remove web OAuth auth dir + share landing owner-login (P3 C1)

### Features

* **desktop,shared,web:** remove coding-plan webview/paypal/payment deep-link chain (P3 C2) ([6ea3bb5](https://github.com/yeyuan98/ZCode/commit/6ea3bb503f959e9ca58e472b04da3423fc36a677))
  * desktopWindowChrome: 删除 isPaypalHostname / isCodingPlanPaypalNavigationUrl /
  * desktopMainIpcRemote: 删除重复的 paypal/webview 判定块与 openExternal 的
  * preload/codingPlanWebview.ts + tsup 入口：删除（官网 zcodeBridge 购买完成信号链）
  * deep link: 删除 zcode://payment/callback 路由、pending 缓存与
  * 命令面: 删除 DesktopCommandIds.ClearCodingPlanWebviewStorage 与
  * env: 删除 desktopRuntimeEnv 的 ZAI_BUSINESS_BASE_URL 注入、tsup 的

* **desktop:** delete context-prompt rollout + shared client/configs fetcher (P3 C5) ([e21ceec](https://github.com/yeyuan98/ZCode/commit/e21ceec09c2349d19097663828358548d7d82f16))
  * delete desktopContextPromptRollout.ts (vendor /api/v1/client/configs fetcher + rollout): context-prompt pins its local default OFF (A9), still injected as ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED=0 so host presentation-surface folding is unchanged
  * delete singleFeatureRollout.ts mechanism (both consumers gone)
  * rendererActionTraceRollout: local disabled constant (env overrides ZCODE_RENDERER_ACTION_TRACE_ENABLED / ZCODE_LOCAL_TTFT_ENABLED and OTLP exporter chain stay live)
  * remove first-host-spawn bounded rollout decision gate (createWindow option + main wiring)

* remove official MCP service + auth protocol + CLI adapter chain (P3 C3) ([7b98a54](https://github.com/yeyuan98/ZCode/commit/7b98a54b961d1a5f678f3ff9363b1e33c9e49941))
  * shared: delete official-mcp-auth.ts (auth-type/header/meta consts, failure-reason
  * shared protocol: drop interaction/requestOfficialMcpAuthHeaders method const +
  * shared v4/contracts: drop mcp_tool display 'unavailable' schema field and
  * services: delete official-mcp/ (credential resolver + issuance audit); remove
  * CLI: delete official-mcp-auth-port.ts + entrypoint/server wiring,
  * UI: delete orphaned mcpUnavailableBannerNotice; drop serverRequestId mapping

* remove vendor client/configs service + channel; plugin-store order falls back to bundled (P3 C5) ([019a4e5](https://github.com/yeyuan98/ZCode/commit/019a4e518af5a38c03833221faf44e38eabc2e75))
  * services: delete client-config service (IClientConfigService + createClientConfigService) and its registration in node.ts; drop accessor field and index export
  * shared: delete clientConfig snapshot parser + ServiceChannels.ClientConfig; pluginStoreOrder keeps local types only (parsePluginStoreOrder dies with the vendor envelope)
  * client/desktop host: remove ClientConfig proxy and remote-workspace passthrough registration
  * ui: usePluginStoreOrder resolves to null order (bundled default ordering from pluginStoreOrdering), refresh becomes no-op
  * spec: record C5 delivery notes (rendererActionTrace shares the dying fetcher; force-update gate read stays until P5)

* remove vendor family/specs + de-plan settings provider page (P3 C4) ([8fc4edd](https://github.com/yeyuan98/ZCode/commit/8fc4eddaec58610dc7a96c665f264709e3558c21))
  * shared: delete model-provider-family.ts (zai/bigmodel family 目录、OAuthProviderId、
  * shared: 删除协议账号契约（zcodeAccountAccessSchema / zcodeProviderAccountAccessSchema）
  * shared: zcodeEndpoint 按 keep-list 收口——删除 ZAI OAuth/bigmodel builder、
  * shared: AppSettings 删除 startPlanRecommendationDismissed（zod strip 兼容旧配置）
  * cli: 删除零调用方的 cli-oauth.ts / bigmodel-oauth.ts / coding-plan-api-key.ts；
  * services: 删除 accountRequestAuthService（自 P2 起仅剩恒失败空实现）与孤儿
  * ui: 设置页 de-plan——删除套餐状态卡/Start Plan 卡/连接方式导航/entitlement 过渡
  * ui: 模型菜单/切换文案/list-models 分组改为中性按 provider 名称聚合；
  * provider-node: ModelSelectionFacade 分类器恒为 ordinary；provider rule-data-schema

* replace remote builtin-provider catalog download with bundled-only source (P3 C5) ([acd8488](https://github.com/yeyuan98/ZCode/commit/acd8488e006bd9889f3f3117d18099d3e726519d))
  * provider-node: delete zcode-builtin-download (client/configs → builtin_provider_config_json → CDN), zcode-builtin-remote-synchronizer (TTL/lease refresh control), endpoint-scoped-zcode-builtin-source, zcode-builtin-cache-paths; NodeProviderConfigRuntime reads the bundled config only (offline-capable), refreshZCodeBuiltin becomes a local source re-read, applyRemoteRelease dies with the remote write path
  * services: drop zcodeBuiltinEnvironment/fetchZCodeBuiltinRemoteRelease wiring in node.ts + providerConfigRuntime options; delete zcodeBuiltinRemoteConfig.ts and runtime-tools/clientPlatform.ts (platform segment only served vendor catalog requests)
  * cli: process-provider-registry-runtime drops the remote download wiring + refresh reporter; prepareCliProviderRuntimeEnv points ZCODE_BUILTIN_PROVIDER_CONFIG_FILE straight at the bundled file (no endpoint-scoped active cache); ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV removed (last reader died)

* **shared,desktop,services:** off-peak local admission window + settings + Run-now plumbing (P3 S1) ([2f4a8c9](https://github.com/yeyuan98/ZCode/commit/2f4a8c9adb40473b09b2a116a69c01a438f6c2e9))
  * shared/off-peak-window.ts: withinWindow/msUntilWindowOpen 纯函数（跨午夜回绕、[start,end) 边界钉死）与 offPeakWindow zod schema
  * AppSettings 新增 offPeakWindow {enabled,start,end}（默认 00:00-07:00）：zod、protocol transport、patch schema
  * schedulerProtocol: 新增 correlated offpeak-admission-request/response 与 offpeak-run-now 消息
  * scheduler runtime 端口注入 seam 重构（index.ts 仅 Electron 装配；cron/offPeak controller 拆分），每 tick 认领前先询问 main 准入，超时 fail-closed
  * repo 新增 claimOneForRunNow（status='queued' AND claim_running=0 原子认领）；OffPeakTaskService.runNow（paused 先回 queued）
  * desktop main 是 settings 唯一属主：resolveOffPeakAdmission + window-open 定时器唤醒 scheduler；Run-now host→main→scheduler 转发链

* **shared,ui:** unpin image-search from default-enabled official plugins (P3 C3, ruling 5) ([9e98de7](https://github.com/yeyuan98/ZCode/commit/9e98de7d19470928094825b2ff50b517ec557cd5))
  * image-search 的 MCP 后端是官方 Server MCP，已随 C3 主体删除，默认启用只会带来
  * 移除 UI 内置图标映射与打包资源 image-search.png；插件 definition 与市场条目

* **ui,i18n:** off-peak window settings UI + Run-now action + auto-decline copy (P3 S1) ([ce20396](https://github.com/yeyuan98/ZCode/commit/ce20396aadd2e962c2f970b25444a9415a48937b))
  * Automations idle tab 新增时间窗设置条（enabled + start/end 本地时钟输入，写共享 settings offPeakWindow；属主在 desktop main）
  * 闲时卡片菜单新增「立即运行」（queued/paused；scheduler 端 claim 原子 no-op）；TID_OFFPEAK_ACTION_RUN_NOW/TID_OFFPEAK_WINDOW_* test-ids
  * 创建资格本地化：无灰度/套餐/额度门，= Registry 存在可选模型（fail-closed）；远程 workspace 提示不可用
  * OffPeakCreate 轮尾卡删除位次快照
  * i18n（双语 89→81 键）：删除票据/额度/codingPlanOnly/newTask-banner/位次键；新增 window-setting + runNow 键；permissionWarning/空态/操作提示改为本地时间窗与自动拒绝语义

* **web:** remove web OAuth auth dir + share landing owner-login (P3 C1) ([7590490](https://github.com/yeyuan98/ZCode/commit/7590490874a3e93a6cede0345dfb39e541fe79d8))
  * 删除 packages/web/src/auth/**（7 文件）：WebCallbackPage、webAuthService、
  * main.tsx：移除 /cn/share/callback OAuth 回调路由渲染与分享页 owner 登录
  * ConversationShareLandingPage：移除 WebOAuthProviderId 类型、双 provider
  * vite.config.ts：移除 VITE_ZAI_OAUTH_* define 注入与 /api/v1/oauth/token


### Bug Fixes

* **p3:** review round fixes — stale model-facing copy, comment rot, dead i18n keys, spec amendments ([e92848b](https://github.com/yeyuan98/ZCode/commit/e92848bad81d80701b3293cae93c6c391747e4d4))
  * OffPeakCreate tool metadata rewritten for local semantics (own provider, idle window, build default, auto-decline noted); vendor ticket/quota language removed
  * /login & /logout slash-help entries deleted (documented commands deleted in P1; pulled forward from P4 as dead help text)
  * run-now channel comments reworded in node.ts/validation.ts/channels.ts; provider-runtime-headers stale account comment fixed; provider-selection-v2 gets P3 tombstone note
  * i18n: drop offPeak.sectionTitle + offPeak.form.keepAwakeHint (zero consumers; thought.*/tabs.* verified as live dynamic keys and kept); stale login.expired comments updated
  * specs/off-peak-local-admission.md: blocked-outcome wording matches implementation (standard outcomes, no separate status); ModelRequestAuth deferral recorded


### Chores

* dynamic-workflow + help-config comment refresh after C5 vendor config-fetch removal (P3 C5) ([ddb35c2](https://github.com/yeyuan98/ZCode/commit/ddb35c271d483cd14b2f8485c36cd25cc6504692))
  * CLI dynamic-workflow-policy: gate reads host-pushed local state only (no vendor fetch since C2); stale /client/configs comment corrected
  * shared dynamic-workflow-feature: header documents local-only resolution (env override > default disabled, A9 local constant OFF)
  * helpAppConfig: cross-reference now records all client/configs consumers dead except the P5 force-update gate
  * residue sweep clean: zero live client/configs / builtin_provider_config_json / clientConfigService / desktopContextPromptRollout / zcodeBuiltinRemoteConfig references outside P5 updater path and P3-deletion comments; dist/ artifacts regenerate on build

* **i18n:** drop dead vendor usage keys (P3 S2) ([5719fba](https://github.com/yeyuan98/ZCode/commit/5719fba27eec651f77c51b855a8ca1ff28f5ec9b))
  * 删除 en-US/zh-CN 各 200 个无消费方的用量键（逐键 grep 消费方后删除，动态模板键保留）：
  * 模板字面量消费的 settings.usage.range.* 与 heatmap.range.* 保留；

* knip sweep — drop 12 newly-orphaned exports (P3 review leftovers) ([63a0fff](https://github.com/yeyuan98/ZCode/commit/63a0fffb05aa13e30a3d3eef10635dec67cfa937))
  * 类型收窄为模块内（不再 export）：desktop scheduler 的 CronSchedulerControllerDeps / OffPeakSchedulerControllerDeps / SchedulerPortShape / SchedulerRuntimeHandle / SchedulerRuntimeDeps（测试经 ReturnType<typeof createSchedulerRuntime> 推导，无需导出 handle/deps 类型）、services OffPeakInteractionPolicy、desktopDeepLinkUrl isOAuthCallbackUrl（模块内消费）、ui resolveModelProviderNavLogo / SegmentPill / formatAppUsageDuration
  * 删除零消费者：ui setPendingSettingsUsageIntent（Usage 入口改为直接 setPendingSettingsSection("usage") 后遗留）
  * AlertDialogRequest 保持导出并在 useAlertDialog 显式引用（导出函数签名需要可命名的返回类型，同时构成真实跨模块消费）

* **p3:** S4 sweep — remove dead account:* logo registry entries, start-plan asset + orphaned test-ids ([90970f0](https://github.com/yeyuan98/ZCode/commit/90970f043b1b4bc8bde9981bc47eca07cb2cde1c))
  * logo-sources.json: drop Start Plan entry and account:* providerIds (dead since P1); map zai/bigmodel standard template ids to their family logos (equal-vendor icon coverage)
  * ProviderLogo: remove start-plan asset key (no config references it); delete the png
  * test-ids: remove start-plan and connection-mode TIDs (UI deleted in C4, zero consumers)

* **shared:** fix stale forceUpdate comment after C2 purge (P3 C2) ([6032aed](https://github.com/yeyuan98/ZCode/commit/6032aed5c0a612f00f38e0c0cd291e939accef74))

* **ui:** drop newly-orphaned codingPlanPurchaseAuth (P3 C2) ([f94c946](https://github.com/yeyuan98/ZCode/commit/f94c946fd77ac319f5b67d8801f4890807134a63))


### Documentation

* **p3:** S5 — flip spec status, record P3 delivered state + effort in master plan ([2e42944](https://github.com/yeyuan98/ZCode/commit/2e4294442aa12838561441b16e495999922958e3))
  * specs: Status → implemented-by P3 (alpha.7)
  * VENDOR-PURGE-PLAN.md: §4 P3 delivered-state prose, §1 status → next P4, §7 effort refresh
  * handoff (ZCode-handoff.md, outside repo) rewritten separately

* **p3:** specs + amendments for services purge & off-peak local admission ([02e8f0e](https://github.com/yeyuan98/ZCode/commit/02e8f0e04aa44d0dd1ca9b585cdfb8d356aa47fa))
  * add specs/off-peak-local-admission.md: window-only admission (ruling 1) + Run-now, hands-off interaction policy with rationale (ruling 2), owners/event order, settings schema, ticket-column hard-cut, test scenarios, expected-death list
  * add specs/account-services-purge.md: C1-C5 domain commits, dormant user framework design (ruling 6), invariants/keep-traps, migration boundary
  * record amendments A6-A14 (P3) in VENDOR-PURGE-PLAN.md §4 P3

* **plan:** record P1.2 merge/release hashes ([d89e4ca](https://github.com/yeyuan98/ZCode/commit/d89e4ca6629ff3702cf7128dd381b832c498c520))


### Refactorings

* **p3:** S0 free deletions + ForceUpdateConfig inline ([b670e6c](https://github.com/yeyuan98/ZCode/commit/b670e6c46e0383a824cfe43b2c7d5c8879168eda))
  * delete shared plan-identity.ts / provider-family-connection-selection.ts / account-provider-state.ts (verified zero importers; barrel re-exports and package.json subpath removed with them)
  * delete dead provider/updateAccountConfig wire: params/result schemas + method id (zero handlers repo-wide)
  * delete resolveRuntimeProductEndpointConfig + RuntimeProductEndpointConfig (zero importers)
  * inline ForceUpdateConfig into forceUpdate.ts ahead of the coding-plan-subscription.ts deletion in C2 (gate itself is disposed of in P5)

* **services,shared:** purge vendor usage quota surface (P3 S2) ([6c72801](https://github.com/yeyuan98/ZCode/commit/6c728012c19d638817f5f5fb0d90cdfb74802015))
  * 删除 shared/src/usage-stats.ts（vendor 半边：UsageStatsRequest/Snapshot、CodingPlanUsage*、UsageEntitlement*、PlanIdentity*、monitor 聚合类型）与 usage-quota.ts 全部额度类型；barrel 只保留 app-usage.ts
  * IUsageStatsService 仅保留 getAppUsageSnapshot；删除 getCodingPlanUsageSnapshot、getCodingPlanReset*、markCodingPlanResetHistoryRead、getSnapshot(monitor)、getEntitlementSnapshot
  * usageStatsService 甩掉全部三个跨 slice import（isCodingPlanModelProviderId / IAccountRequestAuthService / OfficialMcpCredentialSource），只依赖 zcodeAgentService
  * 删除 7 个 vendor provider：bigmodelUsageQuotaProvider/MonitorMapper/MonitorRange/QuotaMapper、bigmodelSubscriptionProvider、zcodeMcpQuotaProvider（providers/ 目录清空）
  * node.ts：usage 注册仅注入 zcodeAgentService；officialMcpCredentialSource 常量与 resolveOfficialMcpCredentials 导入随额度查询面删除（MCP 身份头 resolver 保留，属 C3）
  * desktop remoteWorkspaceServiceCollection：usage 注册同步精简；localAccountRequestAuthService/OAuthCredentialRepo/accountProviderCredentialService 等 vendor 查询链随之移除
  * UI 过渡：新增 lib/usageQuotaShapes.ts（C4 de-plan 时移除），model-provider-section 存活文件与 codingPlanProvider/codingPlanQuotaPresentation/codingPlanOwnedEntryPlans 的 entitlement/quota 类型改从过渡模块导入

* **shared,services,desktop,ui,cli:** rebuild off-peak as local window-admission feature (P3 S1) ([8c5b8a6](https://github.com/yeyuan98/ZCode/commit/8c5b8a6fb5c055bee9feebe2cc210357cfdb4e6e))
  * off_peak_tasks 删除 6 个供应商票据列（server_ticket_id/registered_at/schedulable/queue_position/next_poll_at/settled_at），索引 0 变更
  * repo 行映射/create/markRunning/markTerminal/invalidateModelSelection/claimDue 同步裁剪；claimDue = status='queued' AND claim_running=0（认领前由 scheduler→main 时间窗准入）
  * 删除 updateSchedulingSnapshot/markSettled/listUnsettledTerminal/requeueForContinuation（票据快照/核销 outbox/3102 续跑语义）
  * offPeakTaskService 重写：创建即落库（无取号/额度/灰度门），资格=存在可解析的模型选择；删除 offPeakTaskSync 轮询与 settle outbox；保留重启恢复语义
  * 删除 offPeakServerClient/offPeakMockGateway/offPeakModelSelectionView；offPeakRuntimeModel 只保留确定性错误类型
  * zcode-protocol off-peak create/snapshot 删票据字段与 3101/3103 分类；modelExecutionSchema 删除 requestAuth 字段
  * host dispatchOffPeakRun 删 requestAuth 注入与无票 guard；执行用任务持久化 Selection
  * 闲时免打扰（binding policy）：off-peak turn 为会话活跃 turn 期间（host 派发注册表，终态/订阅释放摘除），permission/AskUserQuestion/plan-approval 在 agent service 层自动拒绝；普通 turn 不受影响
  * OffPeakCreate 工具缺省权限档 yolo→build
  * 删除 offpeak-retry.ts（429 排队豁免/3102 标记）；runner-generate/runner-stream offPeak 分支与 ticket 头脱敏删除
  * bootstrap model-execution 删 requestAuth freeze；requestDependencies/ModelRequestAuthSource 注入链删除（ModelRequestAuth 保留给账号 runtime headers 刷新路径）
  * contracts off-peak 工具/端口删票据字段与额度/资格分类
  * providerBusinessError 3102 分支、ChatErrorBanner 标记兜底、offPeakTaskStore quota_3103/灰度/额度面删除
  * 'account-offpeak' Provider 身份类删除（effective-model-selection/model-selection-facade）

* **shared:** rehome AppUsage schemas to app-usage.ts (P3 S2) ([6a69485](https://github.com/yeyuan98/ZCode/commit/6a694859ecfa3964b7c52517f7309a68d1abb7c5))
  * 新增 packages/shared/src/app-usage.ts：ESTIMATED_TOKEN_CHAR_DIVISOR、APP_USAGE_RANGES、全部 appUsage*Schema 与 AppUsage* 类型、AppUsageRequest（P3 供应商套餐/配额面删除的通用半边迁移）
  * usage-stats.ts 顶部 re-export app-usage.js，删除文件内重复定义；协议 import 暂不切换行为
  * zcode-protocol/index.ts 与 zcode-protocol-v4/transport.ts 的 usage stats 方法 schema 改从 ../app-usage.js 导入（方法本身保留，AppUsage-only）
  * shared barrel 增加 app-usage 导出

* **ui:** delete vendor plan/quota usage UI cluster (P3 S2) ([dd430a2](https://github.com/yeyuan98/ZCode/commit/dd430a2c86219d5ea84cf81c9622ecd0d63256ea))
  * 删除 Coding Plan 用量面板族：CodingPlanUsagePanel/BarChart/LineChart、codingPlanUsageChartSeries、codingPlanUsageSources、来源偏好 sidebarUsageCodingPlanProviderPreference
  * 删除 entitlement UI 链：hooks/useUsageEntitlement、usageEntitlementCache、usageEntitlementRefreshPolicy、CodingPlanUsageRemainingPanel、WorkspaceSidebarFooterUsageSummary(+PlanBadgeHelpers)、footer 用量摘要/套餐徽标/升级入口接线
  * 删除额度重置簇：components/coding-plan-quota-reset/*（5 文件）、codingPlanQuotaResetUi/Coordinator/Confetti、useCodingPlanQuotaResetUi、store/codingPlanQuotaResetState（含 store 字段与跨窗口广播）、chat-input-toolbar 重置自动播放/机会提醒/徽标、contextQuotaMeterGrid、contextPanelAction（孤儿）
  * 删除 v4 会话额度横幅族：useV4SessionQuotaBanner、ConversationQuotaBanner、sessionQuotaBannerState/DismissalStore、startPlanQuotaBuckets/ReminderStore；SessionPane 移除 quotaBanner/handleOpenModelUpgrade/mcpUnavailableNotice 接线
  * 删除 Start Plan 推荐改选：useStartPlanRecommendation、startPlanRecommendation、startPlanEntitlementOptions、selectionSideInheritedModel（孤儿），SessionPane/AutomationEditView/SubagentsSection 调用点改为直接使用当前选择
  * contextUsage.tsx 收敛为 context-only（仅 Context windows 统计），V4ComposerToolbar 移除 entitlement/余额/升级组装
  * SettingsPage Usage 分区改单一 App Usage 面板；settingsNavigation 移除 usageTab 意图管道；ChatErrorBanner/ConversationComposer 移除升级入口
  * providerBusinessError 移除额度横幅专用业务码解析；useCodingPlanEntitlements 退化为空权益 stub（C4 de-plan 时移除）；StatusCards 剥离额度重置 UI；CodingPlanEntryButton gate 退化为恒 ready
  * useUsageStats 仅保留 useAppUsageStats（agent 数据库统计）


### Other Changes

* feat! remove coding-plan subscription service + shared purchase protocol + UI cluster (P3 C2) ([e41f6a3](https://github.com/yeyuan98/ZCode/commit/e41f6a3bd8a49559f3edc3c70bc0a5b2d288e4b6))
  * services: 删除 coding-plan-subscription/**（4 文件，购买/企业订单/静态目录/
  * node.ts: 账号请求鉴权改内联空 resolver（Registry 自 P2 不发布账号 Access，
  * accountRequestAuthService.ts: AccountRequestAuth* 类型与
  * wiring: accessor / services index / client remoteServiceAccess /
  * shared: 删除 coding-plan-subscription.ts（519L 购买/企业订单协议类型；
  * ui: 删除购买入口链（CodingPlanEmbeddedWebviewDialog + codingPlanEmbeddedWebview +

* feat! remove vendor OAuth services + adopt dormant user framework (P3 C1) ([37e9545](https://github.com/yeyuan98/ZCode/commit/37e9545cb1caaa700a1f41c3556196bedd94d6b2))
  * 删除 packages/services/src/oauth/**（16 文件，含 providers/ 与 repo/oauthCredentialRepo.ts）；
  * node.ts：移除 apiClient 401 分类钩子、corrupt-session 登出广播、onboarding loadUserId
  * shared：新增 user.ts（UserInfo 迁入，ruling 6）与 credential.ts（通用凭据解密错误码迁入）；
  * channels/platform：删除 ServiceChannels.OAuth 与 OAuthRegisterState/OAuthCallback/
  * providerProvisioningSource/Target：OAuth 凭据键 allowlist 清空，同步机制保留。
  * desktopOAuthDeepLink.ts 拆分为通用 desktopDeepLink.ts（workspace/支付/分享导入路由、
  * appLaunchCoordinator 简化为 ready 即消费启动 gate（OAuth 回调等待删除）。
  * remoteWorkspaceServiceCollection 移除 OAuth 服务重实例化与登出 handler。
  * desktopRuntimeEnv/tsup/.env.example/server connect.ts 裁剪 ZAI_OAUTH_* 注入
  * 删除 useRootOAuthEffects、oauthCachedSessionRestore、oauthLoginAttemptGuard、
  * store 删除 OAuth 会话字段簇（isRestoringOAuthSession/oauthError/oauthPollingActive/
  * WorkspaceSidebarFooter 移除头像/用户块与登录/退出菜单，偏好菜单改中性触发器；
  * ModelProviderSection 仅摘除 OAuth 同步回调块；rootStartupGate 去掉启动 auth 恢复门禁。
  * i18n：删除 login.oauth.*/login.expired.*/logout.*/sidebar.profile.*/app.login/

## [3.14.3-alpha.6](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.5...v3.14.3-alpha.6) (2026-09-27)

### Bug Fixes

* **catalog:** GLM vision over-application on anthropic endpoints (P1.2) ([50ee7e4](https://github.com/yeyuan98/ZCode/commit/50ee7e4dc8cb1cbad4cbaa82c4dc1a4dd76d236e))
  * delete the two upstream vendor anthropic inputFormat site rules (api.z.ai + open.bigmodel.cn /api/anthropic, modelMatch .*): they expressed 'endpoint accepts image/video blocks' but overlay after modelRules (later-defined wins) and blanket-overrode every per-model image:false — all glm models showed vision on anthropic-flavor providers; latent upstream bug surfaced by the P1.1 rule restore; openai-compat flavor (no site rules) was already correct; midConversationSystem endpoint rules kept
  * extend the flash-family vision overlay in place to (?:x)?: glm-5.3-flashx (suffix letter, no separator) previously missed by the overlay and masked by the site blanket — now vision per user ruling, ctx 1M via family base rule; cross-flavor intended flip pinned in tests
  * resolver regression tests on both flavors: glm-5.3 image FALSE + ctx 1M; flash + flashx vision (video/pdf); glm-4.6v vision; unrated models default non-vision (no endpoint blanket)
  * catalog-level guard: no vendor anthropic site rule may carry inputFormat again
  * spec: P1.2 clauses + catalog-source note (upstream v3.14.3 vendor catalog rev 30, fork-maintained); master plan: P1.2 section, matrix row A6, alphas re-shifted (P3=alpha.7 … P6=alpha.10); revision stays 30


### Documentation

* **plan:** mark P1.1 delivered (v3.14.3-alpha.5) ([39a7878](https://github.com/yeyuan98/ZCode/commit/39a7878505f65280036932f5d4f49f7bbe8a60ed))


### Other Changes

* docs+test(p1.2): review fixes — full-lineup sweep test, plan re-shift corrections ([4cf9032](https://github.com/yeyuan98/ZCode/commit/4cf9032ca884dbf32b659350ba10f4d53522e4e3))
  * committed full 11-model bigmodel lineup sweep (vision only for flash/flashx; ctx tiers 131072/200000/1M) — hardens against future catalog drift (reviewer's throwaway sweep verified current values)
  * master plan: P1.1 version-note range re-worded (alpha.6 re-taken by P1.2); runbook A1..A10

## [3.14.3-alpha.5](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.4...v3.14.3-alpha.5) (2026-09-27)

### Features

* **catalog:** restore GLM capability metadata rules (P1.1 F1, decision A5) ([3696988](https://github.com/yeyuan98/ZCode/commit/369698897495dc78211252441425022e23b36cb3))
  * re-add the 24 pre-P1 GLM capability modelRules verbatim from 0ed9c86, original array order preserved (overlay order is load-bearing); the P1-sanitized composite ox-alpha|x-preview-f-free rule is superseded by the verbatim ox-alpha|glm-x-preview-f|x-preview-f-free form (same rule, glm alternative restored) — 84 rules total, matching pre-P1 sequence
  * probe evidence: bigmodel/zai listing endpoints return ids only on both api flavors, so curated capability rules are the only correct-config source for GLM models; 61 equivalent rules for other vendors survived P1 — without the restore, GLM is the only metadata-less major family (violates equal-vendor treatment: glm-5.3 resolved 200k/no-vision instead of 1M; glm-5.3-flash lost vision/video/pdf)
  * catalog invariant refined (A5): glm allowed only inside modelRules modelMatch + capability props; templateModelRules/builtinProviderModelRules stay glm-free (test: parse→null modelMatch→assert; + glm-free subtree asserts; count lock 84)
  * new builtinGlmCapabilityRules.test.ts: glm-5.3→ctx 1M; glm-5.3-flash→image+video+pdf overlay; uppercase GLM-5.3 matches; glm-4v-flash→16384+image
  * master plan: A5 recorded (user sanction quoted; rejected alternative noted), §1 goal 5/§3 row/§4 P1 summary/P6 allowlist annotated, P1.1 section added, alphas re-shifted (P3→alpha.6 … P6→alpha.9) incl. two pre-existing stale refs fixed

* **discovery:** parser hardening + optional capability hints (P1.1 F4) ([33c70fb](https://github.com/yeyuan98/ZCode/commit/33c70fb850665a7ff4feb7cba3ee8936bb71f75a))
  * accept both snake_case has_more/first_id/last_id (Anthropic spec) and camelCase hasMore/firstId/lastId (bigmodel/zai legacy mirrors, live-probe-verified); snake_case takes precedence
  * repeated-first-id loop guard: a mirror that ignores after_id and restarts from page 1 stops paging immediately (treat as complete); 10-page cap retained as backstop
  * additive success-result field modelHints: anthropic max_input_tokens(>0)→contextWindow + capabilities.image_input/pdf_input.supported; openai-compat context_length(>0) + architecture.input_modalities ∩ {image,video} (audio/file ignored; 0/null absent); cross-page merge fills absent fields only, never overwrites; keys omitted when no metadata (deepEqual-stable)
  * +7 unit tests: camelCase mirror, snake-precedence, ignored-cursor guard (≤2 requests), anthropic metadata, max_input_tokens:0, openrouter shape, cross-page merge both directions

* **settings:** per-provider Discover models action + bulk merge (P1.1 F3) ([27a6d8d](https://github.com/yeyuan98/ZCode/commit/27a6d8df2307546ee142a33d34d0adaf4442c31f))
  * facade discoverProviderModels(providerId): reads the provider's own config server-side (key never crosses the RPC surface nor appears in error text — asserted by test); keyless providers discover anonymously; delegates to the shared direct-endpoint core
  * ProviderConfigService.addPersonalModels: single-transaction bulk merge; dedupes silently against personal + builtin inherited ids and in-batch repeats; returns added count; hints gap-filling extracted as applyInitialModelHints and shared with createPersonalProvider (identical semantics)
  * UI: Discover models button in ProviderModelsSection next to add-model (existing feedback banner pattern; spinner while testing); useDiscoverProviderModels hook; i18n discoverModels/discoverModelsSuccess {count}/discoverModelsFail in both locales
  * 5 facade/provider unit tests: dedupe vs personal+builtin, 401 error excludes key while request carries it, keyless flow, unknown-provider/no-baseUrl errors, create-vs-bulk hints equivalence (glm-5.3 → no manual rule when catalog covers)

* **wizard:** auto-discover on save + hints-aware initialModels persistence (P1.1 F2) ([814feb8](https://github.com/yeyuan98/ZCode/commit/814feb88f7c22157f3317edca850b6a35e7db023))
  * save handler calls discoverTemplateModels directly (never stale hook state) when discovery state is idle and the template has an api config; silent; failure saves zero models (documented escapes); success/failure states never re-run
  * custom-provider path auto-discovers via new facade discoverCustomProviderModels → discoverModelsForEndpoint (direct-endpoint discovery wrapper)
  * CreatePersonalProviderInput.initialModelIds → initialModels: (string | {id, hints?})[]; InitialModelHints declared structurally in provider (no cross-package import); hints fill only fields the catalog leaves empty EXCLUDING the .* catch-all fallback (catch-all is the unknown-model default, not catalog knowledge — otherwise hints would be dead code); applied hints persist as complete manual rules (manual schema requires all leaves; creation-time effective values frozen for non-hint leaves — accepted shadow boundary, documented)
  * keyless (ollama) path included; hook state extended with modelHints
  * unit tests: hints fill-vs-override matrix through real createPersonalProvider→resolver (catalog-provided → no manual rule; explicit catalog false beats hint true; string entries; dedupe); discoverModelsForEndpoint URL normalization; e2e: save-without-button scenario locks auto-discover
  * e2e mock template no longer injects builtinModelIds: gate-closed-after-reload assertions now prove discovery persistence (both manual + auto paths) instead of passing via hardcoded ids


### Bug Fixes

* **p1.1:** apply ulw review fixes (shadow-scope spec, testing-race, e2e locks) ([6f6e488](https://github.com/yeyuan98/ZCode/commit/6f6e4884f103bbf9b25c05fca2ff085b91e9e9be))
  * spec §2 corrected to the implemented shadow semantics: applying ANY hint persists a complete manual rule (manual schema requires all leaves) — the model then shadows future catalog changes for ALL manual leaves until user-edited/removed (was wrongly promising per-field shadowing); two-phase catalog regression test locks frozen-value-wins (500k frozen vs 999k later catalog rule)
  * spec §3: Continue disabled while a discovery run is in flight (was: mid-testing save fell through to zero-model); custom-form wording clarified (requires key; keyless goes via ollama template); ollama step wording aligned with implementation (key-less variant, not skip)
  * wizard: Continue button disabled during discovery testing state
  * e2e: custom-provider scenario gains the reload gate-closure assertion (auto-discover persistence locked on both paths)
  * unit: anthropic mirror has_more-without-last_id stops paging after one request
  * knip: unexport in-file-only ProviderModelDiscoveryState type


### Documentation

* **spec:** P1.1 amendments — A5 capability-metadata invariant, auto-discover on save, hint merge rule ([2a8cd75](https://github.com/yeyuan98/ZCode/commit/2a8cd7539676ec794b48435095b224fae9291f84))
  * catalog invariant refined: glm allowed only inside modelConfigRules.modelRules (modelMatch + capability props); templateModelRules/builtinProviderModelRules stay glm-free (decision A5: equal-vendor capability metadata, 61-rule precedent)
  * discovery §2: legacy camelCase hasMore mirrors (bigmodel/zai) + repeated-first-id loop guard; optional capability hints (anthropic max_input_tokens/capabilities, openai-compat context_length/input_modalities) with catalog-wins precedence
  * wizard §3: save auto-discovers when idle (template/custom/keyless paths); failed discovery not re-run; custom-path expected-death bullet amended
  * acceptance scenarios extended (resolver glm metadata, hint precedence both directions, auto-discover e2e, per-provider discover unit)

## [3.14.3-alpha.4](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.3...v3.14.3-alpha.4) (2026-09-26)

### Features

* **provider:** P1 catalog rework — equal-vendor templates, ollama, zero GLM/websearch rules ([10057e1](https://github.com/yeyuan98/ZCode/commit/10057e11a2608e962e57fdd665a04b8e52636bed))
  * convert zai/bigmodel templates to plain api-key access, de-brand 'Coding Plan' names, drop their builtinModelIds (models now come from discovery/manual add)
  * delete 8 account:* providerRules, all builtinProviderModelRules, all glm-keyed model/template/site rules; strip glm ids from aggregator builtinModelIds (openrouter/opencode-go/opencode-zen)
  * delete zcode.z.ai-keyed site rules; remove supportsNativeWebSearch from all remaining rules (keep inputFormat/supportsMidConversationSystem capabilities for surviving endpoints)
  * add ollama template (openai-chat-completions, http://localhost:11434/v1, no access block)
  * catalog invariant: zero case-insensitive glm matches, zero account:/zhipu/websearch strings (locked by builtinProviderCatalog.test)
  * add services test runner (tsLoader shims + package.json test script; 3 pre-existing tests now gated)
  * default supportsNativeWebSearch=false in ModelPropertiesConfig assembly: catalog no longer carries the flag while the complete schema still requires it (field itself dies in P4)

* **wizard:** P1 model auto-discovery client + wizard persistence ([abf28b6](https://github.com/yeyuan98/ZCode/commit/abf28b6e45e105a63befe26f496354180a0c752a))
  * new providerModelDiscovery.ts absorbs the P2 test-key probe: openai-compat GET {baseUrl}/models (Bearer only when key present), anthropic GET {baseUrl}/v1/models with x-api-key + anthropic-version + after_id cursor paging (10-page cap); proxy-aware fetch, versioned-path normalization, never spawns the agent runtime
  * facade probeTemplateApiKey → discoverTemplateModels (interface, impl, runtime fetch threading, node.ts wiring)
  * CreatePersonalProviderInput.initialModelIds: wizard persists discovered model ids into the created provider (gate requires models.length>0; template providers start empty since P1 dropped vendor builtinModelIds — without persistence the wizard would dead-loop the startup gate)
  * wizard key step: 'test key' → 'test & discover' with model-count feedback; key-less templates (ollama) skip the key input and discover unauthenticated; step-aware keyless header copy
  * i18n: login.wizard.testKey* → discoverKey* in both locales (+keylessStepDescription)
  * e2e: updated test&discover assertions + new wizard-complete⇒usable (gate-closed) lock


### Bug Fixes

* **p1:** apply ulw review fixes (empty-list policy, CLI login residue, e2e locks) ([dd6db8f](https://github.com/yeyuan98/ZCode/commit/dd6db8f8693c84b91832361d92e7635d091f65aa))
  * discovery: empty model list now degrades to failure ('no models returned') per spec — avoids misleading 'works · 0 models' saves that would reopen the wizard gate on next startup; unit tests added (empty list, anthropic /v1-prefixed baseUrl normalization, abort timeout)
  * e2e: failure test extended to save-after-401 and assert the wizard closes (spec acceptance 3); teardown ENOTEMPTY race fixed with bounded retries (SQLite handle release vs rm)
  * catalog: bigmodel-api key-management URL repointed to the real API-key console (was coding-plan overview)
  * CLI: remove P1-dead login residue — help lines (login/logout commands, --no-browser, /login //logout), command-center /login //logout branches + deps + login-flow.ts + loginSetup i18n block/types (both locales); loginRequired copy reworded to provider-API-key guidance (no /login mention)
  * spec: §4 kept-until-P3 list corrected (legacyAccountConnectionSettings + legacyTeamOrganizationResolver died fully dead in slice 1); expected-death list extended (CLI account-login surface, custom-path zero-model saves); e2e README wording


### Chores

* **fmt:** exclude generator-owned CHANGELOG.md from oxfmt ([0ed9c86](https://github.com/yeyuan98/ZCode/commit/0ed9c862237b81ad61c1ef39867d7c79125b4cac))

* **fmt:** format spec markdown ([841a318](https://github.com/yeyuan98/ZCode/commit/841a318d70c7f4927814482e37db2209107f9873))

* **knip:** remove P1-fanout orphaned files and exports ([f81e2b7](https://github.com/yeyuan98/ZCode/commit/f81e2b77882de689acddbbe2bb74d1fed44c107b))
  * delete dead files (consumers died in slices 1-2): codingPlanProviderAvailability, bigmodelStartPlanZcodeJwt, providers/api barrel + apiKeyHeaders, ui oauthTeamPricing
  * unexport/delete orphaned symbols (zaiStartPlanBilling model list, coding-plan login headers, sidebar usage preference writer, footer badge helpers, ModelProviderSection test-support re-exports, CLI server/run type re-exports)
  * knip gate: zero genuinely-new entries vs branch-point baseline; 21 baseline entries eliminated


### Documentation

* **plan:** record P1 delivery, amendments A1-A4, decision D8; re-shift alpha numbering ([5443413](https://github.com/yeyuan98/ZCode/commit/544341346552e8bbf5704da311bfd74c47aa0b63))
  * P1 section: delivered summary (catalog/discovery/excision/tests/amendments)
  * §3: D8 = compile-forced natural death / no pre-hiding / no over-deletion (was mis-cited as D5)
  * P3→alpha.5 … P6→alpha.8 (RC); matrix rows updated (A3 = P2 hotfix, A4 = P1)

* **plan:** record wizard UX hotfix alpha.3; P1 shifts to alpha.4 ([634cc60](https://github.com/yeyuan98/ZCode/commit/634cc60df79ad54636d64575f371d6564bd7ba1f))

* **spec:** P1 provider catalog & model discovery spec ([4b1a9aa](https://github.com/yeyuan98/ZCode/commit/4b1a9aa6c4279aa88073c22f80c7055dc961dbbc))
  * new specs/provider-catalog-and-discovery.md: 21-template equal-vendor catalog invariants (zero glm matches, zero account providers, zero websearch props), runtime model discovery contract (openai-compat + anthropic /v1/models, no agent spawn), wizard test-and-discover with mandatory model persistence, schema excision scope incl. P3 retention boundary, expected-death list, migration boundary
  * amend specs/onboarding-and-gate.md §Behavior 3: P2 test-key probe superseded by P1 discovery client

* **spec:** wizard layout/header contract (alpha.3) + implemented status ([ae78e69](https://github.com/yeyuan98/ZCode/commit/ae78e69b79b992e80478de06c8b1cc631dd71488))


### Refactorings

* **cli:** delete GLM selection backfill migrations 0020-0022 (P1 hard-cut) ([5627a4c](https://github.com/yeyuan98/ZCode/commit/5627a4cfe125a76eed4a2b181974b26c0ae30203))
  * remove the three tail SQLITE_MIGRATIONS entries + their SQL imports/files: 0020 provider-model-selection backfill, 0021 official-glm-selection id recasing, 0022 backfilled-session-reasoning repair (joins 0020's ledger row — one unit, all three go)
  * checksum-ledger runner iterates only present entries: safe for fresh and existing databases
  * ledger comment: ids 0020-0022 must never be reused with different SQL (old databases carry checksums for the original SQL); next migration starts at 0023

* **history:** delete GLM id/migration history (P1 slice 3, hard-cut) ([478a2dd](https://github.com/yeyuan98/ZCode/commit/478a2ddc89685af26d744c06f1bd20922c40a2bb))
  * delete official-glm-model-id.ts + legacy-model-provider-identity.ts: migrateLegacyModelProviderId existed solely to map six zai/bigmodel legacy ids — deleted; subagent state/markdown migrations keep pure format conversion; bots migrateSelection drops dead builtin: selections (same semantics as the old unknown-builtin branch)
  * remove no-op user-markdown migration walker (existed only for the provider-id rewrite) across services + CLI
  * delete official-glm-selection-v3.ts + its 0003 registration in services tasksDatabase migrations (import, definitions entry, dispatch branch; ledger ignores stale 0003 rows; id never reused — noted in comment)
  * legacyZCodeConfigProviderReader: vendor parts only removed (preset GLM id set, BigModel anthropic normalization, runtime-URL kind inference, BigModel endpoint branches); generic config.json importer intact + regression test (former vendor preset id routes generically with declared kind + verbatim baseURL)
  * zaiStartPlanBilling inlines its canonical start-plan model list (shared file gone; billing file itself is P3 deletion scope)

* **provider:** excise zhipu account access types + overlay; adapt CLI (P1 slice 2+2b) ([53f9a20](https://github.com/yeyuan98/ZCode/commit/53f9a20c2be77aa3b2abd04a00188d2ca6a6ab20))
  * delete zhipu-account/zhipu-coding-plan-api-key zod literals (access is api-key only), ZhipuAccountAccessConfig class, account overlay layer (account-provider-resolution/service/state, accountProviderConnectionResolver/Invalidation), account branches across config-service/resolver/registry-service/facades/sources/effective-model-selection
  * services wiring: node.ts/zcodeAgentService.ts account-config sync to agent removed; resolveCurrentAccountAccess/resolveAccountProvider become inert nulls (registry can no longer publish account providers); provisioning account-provider scope dropped (shared provider-provisioning.ts)
  * CLI (compiles against root packages via symlinks): delete standalone-account-provider-runtime + compile-forced chain (auth-login*, tui-auth, login-command, zcode-protocol/account-provider-config, login/logout dispatch) — these died with the account runtime; /login /logout surface gone transitively
  * runtime-string sweep: zero zhipu-account/zhipu-coding-plan literals outside protected shared protocol schemas (kept until P3 per master-plan amendment A1)
  * new providerVendorAccessExcision.test.ts: schema rejects both vendor access types; stale personal.json with vendor access fails whole-file parse (containment per spec)
  * protected P3 domains untouched: oauth/**, coding-plan-subscription/**, usage-stats/**, offPeakRuntimeModel, codingPlanProviderAvailability, accountProviderApiClient/CredentialService chain, protocol account schemas

* **settings:** delete providerFamilyDomain* field family + providerFamilyConnectionSelections (P1 slice 1) ([fa9dce2](https://github.com/yeyuan98/ZCode/commit/fa9dce2c2cac9799832c113e4aee7e222193378f))
  * remove providerFamilyDomain/providerFamilyDomainUpdatedAt/providerFamilyDomainMigrated/providerFamilyConnectionSelections from validationAppSettings (both schemas), protocol AppSettings, normalizeSettingsPatch, setting broadcast keys, settingService comparisons
  * compile-driven UI fan-out (~30 files): coding-plan Connect/Upgrade visibility, sidebar usage summary sections, composer start-plan quick-select, off-peak eligibility reads, account-connection-loss suggestion, plan-mode switch persistence all die with the field (per spec expected-death list; off-peak/account entitlement becomes inert until P3)
  * P3-scoped services: surgical read-removal only (codingPlanProviderAvailability team context constant-unknown; accountProviderConnectionResolver constant-null access; provisioning envelope drops accountSettings member; settingService legacy import/rollback machinery deleted — legacyAccountConnectionSettings + legacyTeamOrganizationResolver existed solely to feed the deleted field and are removed whole)
  * delete UI libs that existed only for the field (providerFamilyDomainSettings, modelProviderFamilyConnectionSelection, oauthProviderFamilySelectionRefresh, accountConnectionLossSuggestion)
  * i18n: 6 orphaned keys removed from both locales (usage/connection-suggestion strings)
  * old setting.json keys strip harmlessly on parse (verified runtime lenient parse; no migration per alpha policy)

## [3.14.3-alpha.3](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.2...v3.14.3-alpha.3) (2026-09-26)

### Bug Fixes

* **wizard:** bounded scrollable layout, per-step headers, window controls ([ab586f7](https://github.com/yeyuan98/ZCode/commit/ab586f7c262859e5b3b53459a4103891c9a19449))
  * rework wizard shell to the OccupationOnboarding fullscreen idiom: pt-12 drag-bar
  * render DesktopWindowControls on Win/Linux (frameless window had none)
  * headers now step-aware: key step shows chosen provider name + logo chip +
  * remove redundant inner form headings (incl. orphaned login.apiKey.title and
  * autoFocus key/name inputs on step entry; template-lookup miss falls back to
  * e2e: provider-name heading assertion + new wizard-scroll.spec.ts layout
  * format CHANGELOG/plan files regenerated by the alpha.2 release (fmt parity)


### Documentation

* **plan:** mark P2 delivered as v3.14.3-alpha.2 ([43bb3e0](https://github.com/yeyuan98/ZCode/commit/43bb3e07569058dc280e791835cf8a074da43932))
  * status header: P0+P2 done, next P1
  * P2 section: delivered summary (gate/wizard/probe/web login/feedback/e2e/lint-debt)
  * A2 matrix row: delivered test counts

## [3.14.3-alpha.2](https://github.com/yeyuan98/ZCode/compare/v3.14.3-alpha.1...v3.14.3-alpha.2) (2026-09-26)

### Features

- **p2:** vendor-neutral onboarding, web token login, GitHub Issues feedback ([d644ed1](https://github.com/yeyuan98/ZCode/commit/d644ed17efcfe0541ff00bbab1e7dd5d42afa8d6))
  - startup gate now opens the wizard iff no usable provider AND not dismissed;
  - new optional AppSettings field providerOnboardingDismissedAt (skip persistence;
  - guard waits for BOTH settings and model-selection hydration, with error escapes
  - welcome wizard replaces the vendor OAuth screen: full template catalog (all
  - useOAuth hook and vendor OAuth login UI deleted
  - packages/web gains a same-origin token login page (token entry, editable server
  - in-app feedback center fully deleted (20 UI files, IFeedbackService, vendor HTTP
  - every report entry (help menu, quickpick, error banners, task rows/menus,
  - config: feedback_url -> GitHub Issues, zh-CN community -> GitHub Discussions,

### Chores

- **lint:** clear all format/lint baseline debt in both workspaces ([1074e7d](https://github.com/yeyuan98/ZCode/commit/1074e7dd977a17a78dc074fc80a5fda85bdc24f8))
  - new apps/zcode-cli/.oxlintrc.json (max-lines off, P6+ split debt), dynamic-workflow

- **p0:** format/lint follow-up — zero new warnings vs baseline ([9b052bc](https://github.com/yeyuan98/ZCode/commit/9b052bca5e9f7b408298767f830f6e8d2af59627))
  - 修正 P0 引入的格式回归：VENDOR-PURGE-PLAN.md、specs/telemetry-and-update-policy.md、
  - 清理 P0 删除消费端后遗留的 unused 标识：index.ts(hostname/getDataBaseDir)、
  - release-it 增加 after:bump hook：版本写入 package.json 会改变 notices 门禁
  - 实测对比基线 53b17b3：fmt 失败文件 35→34（无新增）；lint warnings 70→58

### Documentation

- **spec:** P2 onboarding & gate spec + master-plan corrections ([e11c377](https://github.com/yeyuan98/ZCode/commit/e11c3776eae09c6c8702c0fed6ddb2b3a41763b0))
  - add specs/onboarding-and-gate.md: gate rule, wizard flow, web token login, feedback policy, ownership invariants
  - master plan §5: record binding alpha policy (development-first, no alpha-to-alpha compat)
  - master plan P2: fix ZCODE_SERVER_TOKEN→ZCODE_SERVER_AUTH_TOKEN, mislabeled remoteWorkspaceServiceCollection token (share auth → P5), migration file moves P1→P2, feedback deletion scope + community decisions
  - master plan §2.7: correct server auth env name

## 3.14.3-alpha.1 (2026-09-26)

### Features

- open source ([872ad96](https://github.com/yeyuan98/ZCode/commit/872ad960de7ec172591f7e1952f7849229f94521))

- **p0:** remove vendor telemetry (ARMS RUM + 数仓) and disable vendor update paths ([3e29bdc](https://github.com/yeyuan98/ZCode/commit/3e29bdc5a11d8abfeb3ceeeebb6c2cd8b0de1688))
  - 删除 Alibaba ARMS RUM 遥测链路：appARMSBootstrap、arms\* 桥接/脱敏/身份、
  - 删除 数仓事件上报：services telemetryCore、桌面/渲染层全部 funnel sender、
  - deviceMid 去持久化：desktop 不再读写 telemetry-state.json，改为进程内临时
  - 新增 packages/shared/updateFeedPolicy：厂商 manifest feed 期间禁用三条更新
  - crash capture 改为本地归档；host 内存诊断保留本地日志
  - third-party 清单再生成：移除 @arms/@rrweb/rrdom/keyv 依赖与 overrides，
  - 清理死代码：write-only 窗口集合、空 import、5 个孤儿模块、onAccepted 残参
  - 新增 specs/telemetry-and-update-policy.md、VENDOR-PURGE-PLAN.md 与

- update v3.14.3 ([29628c9](https://github.com/yeyuan98/ZCode/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e))
  - The concurrency limit of a running workflow can now be adjusted directly, without stopping the task.
  - Optimized the reuse logic when modifying and restarting workflows.
  - Improved the real-time status display for large workflows.
  - Improved the efficiency of workflow script submission and modification, reducing token consumption.
  - Fixed an issue where workflows could cause the interface to crash in some cases.
  - Fixed an issue where buttons on workflow cards were sometimes pushed out of the interface.
  - Fixed an issue where the workflow tool took up too much context.

### Bug Fixes

- **cli:** localize resource-sample interval after shared telemetry contract removal ([d3f3161](https://github.com/yeyuan98/ZCode/commit/d3f316197b7bc70b964eab8836f41ae914787ead))
  - P0 删除 shared processResourceTelemetry 契约后，CLI bootstrap 的
  - 采样周期常量本地化（60_000，与原值一致）；ZCodeProcessResourceSample 类型
  - app 侧接收端已随 P0 移除，sampler 协议通知暂无消费者；协议面清理留待 P4/P6
  - 验证：pnpm smoke:windows-bundle 通过（ZCode-3.14.3-win-x64.exe, 141.4 MiB）

### Chores

- add local Windows bundle smoke tool and release runbook ([53b17b3](https://github.com/yeyuan98/ZCode/commit/53b17b3e18cb9c7fbbed7f97fa0f099ac0cfd687))
  - add scripts/smoke-windows-bundle.mjs + scripts/docker/Dockerfile.windows-cross: reproduce the release-desktop.yml Windows build locally in Docker (wine + wine32:i386 for NSIS makensis, rsync for --skip-install fast reruns)
  - run outputs live in ~/temp/zcode-smoke/<run-id>/ and are removed by default; pnpm/electron caches and the build workdir persist in a Docker named volume; base images are never pruned and the project image is kept unless --prune-image
  - new entry points: pnpm smoke:windows-bundle and mise task smoke-windows-bundle
  - seed CHANGELOG.md with a backfilled 3.14.3 section in the release-it writer format; detailed changes are tracked as commit body bullets going forward
  - document the release runbook in README/README.en/AGENTS.md: pnpm release is the only sanctioned release entry (bumps version, generates CHANGELOG, tags vX, triggers the installer workflow); manual git tag releases are forbidden

### Other Changes

- Initial commit ([77432b6](https://github.com/yeyuan98/ZCode/commit/77432b6dbf9f70176ced3f4dcdc25f851c3acb2d))

本文件由 `pnpm release`（release-it + conventional-changelog）自动生成并维护。
详细变更通过 conventional commit 消息体中的 bullet 列表描述；禁止手工 `git tag` 发版，
否则会跳过本文件的生成（v3.14.3 曾因此缺失自动生成的条目，下节为事后补录）。

## 3.14.3 (2026-09-25)

首个开源版本快照；此前的内部版本历史不在本仓库追踪范围内。以下条目为事后补录。

### Features

- **repo:** open-source snapshot of ZCode 3.14.3 (29628c9)
  - desktop (Electron main/host/renderer), web, server, shared UI/services/rpc/client packages
  - Agent CLI and runtime source in apps/zcode-cli (regular directory, no submodule)

### Chores

- **ci:** add Windows x64 installer release workflow (be58138)
  - GitHub Actions workflow `Release Desktop` triggers on `v*` tag push
  - builds the unsigned NSIS installer (`ZCode-<version>-win-x64.exe`) on windows-latest and attaches it to the GitHub release
  - production identity via `ZCODE_ENV=production`; remote runtime assets skipped (`ZCODE_SKIP_REMOTE_ASSETS=1`)
