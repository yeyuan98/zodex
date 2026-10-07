import type { Locale } from "@zcode/shared";

export type BotMessageLocale = Extract<Locale, "zh-CN" | "en-US">;

type MessageValues = Record<string, string | number | undefined>;

const DEFAULT_BOT_MESSAGE_LOCALE: BotMessageLocale = "zh-CN";

const messages = {
  "zh-CN": {
    botDisabled: "当前 bot 未启用。",
    privateChatOnly: "Bots 暂不支持群聊，请在私聊中使用。",
    bindPrivateOnly: "Bots 只允许在私聊中绑定。",
    userNotBound: "当前 bot 未绑定。请先在 zcode UI 生成绑定码，然后发送 **/bind <code>**。",
    commandNotAllowed: "当前 bot 未启用这个命令。",
    noWorkspaceAllowed: "没有可用 workspace，请先在 Bots 设置里允许 workspace。",
    workspaceOutOfScope: "当前聊天上下文的 workspace 已不在授权范围内，请重新选择 **/项目**。",
    bindCodeInvalid: "绑定码无效或已过期，请在 zcode UI 重新生成。",
    bindBotMissing: "绑定失败：bot 不存在。",
    bindSuccess: "绑定成功。发送 **/帮助** 查看可用命令。",
    weixinActivatedWelcome: "微信 Bot 已激活。发送 **/帮助** 查看命令，或直接描述你要做的事。",
    helpTitle: "Zodex 机器人命令：",
    helpHelp: "**/帮助** — 查看这份说明",
    helpBind: "**/bind <code>** — 绑定当前聊天",
    helpStatus: "**/状态** — 查看工作区、模型和任务状态",
    helpNew: "/新建 或 /clear — 开始新的任务草稿",
    helpWorkspace: "**/项目** — 切换工作区",
    helpModel: "**/模型** — 切换模型",
    helpMode: "**/模式** — 切换运行模式",
    helpThoughtLevel: "**/思考** — 切换思考级别",
    helpReply: "**/回复** — 切换回复详细程度",
    helpFile: "**/file <路径>** — 发送工作区内的文件（仅私聊，≤5MB）",
    webhookSecretInvalid: "Webhook secret 校验失败。",
    // Bugfix: 这条错误由通用 provider callback 处理路径触发，微信/飞书失败时不能误显示 Telegram。
    callbackFailed: "处理机器人回调失败：{message}",
    sessionExpiredNewTaskHint:
      "当前任务会话已失效，可能是任务已被清理或机器人消息已过期。请发送 **/new task** 创建新任务后再继续。",
    deletedTaskReplaced:
      "原任务已删除，已为你新建任务。本条消息将在新任务中处理，不会继承原任务的对话上下文。",
    received: "已收到。",
    attachmentOnlyPrompt: "请查看附件并根据内容协助我。",
    attachmentRejected: "附件处理失败：{message}",
    attachmentDownloadUnavailable:
      "无法下载附件。文件可能已过期、已撤回，或机器人没有读取权限。请重新发送附件后再试。",
    // 3.14.5 Alpha 6（specs/bot-file-delivery.md「Inbound attachment gates」§5.1/§5.2）：
    // >4 附件的即时通知 + 逐文件超限跳过通知（单次检查语义）。
    attachmentCountLimited: "一条消息最多处理前 {max} 个附件，已跳过其余 {count} 个附件。",
    attachmentTooLargeSkipped: "附件 {filename} 超过 5MB 上限，已跳过。",
    fileCommandUnsupported: "该渠道暂不支持发送文件，会在后续版本提供。",
    // Phase C Alpha 2：远程取回失败（远端不可达/超时/超预算）的如实文案。
    fileRemoteUnavailable: "远程工作区当前不可用，请稍后重试或先 /重连。",
    // 3.14.5 Alpha 0（A3a）：/file 立即 ack，投递后台执行，不再阻塞聊天队列。
    fileFetchStarted: "正在获取并发送文件…",
    fileMissingPath: "请指定要发送的文件路径，例如 **/file reports/result.png**。",
    fileOutsideWorkspace: "只能发送当前 workspace 内的文件：{path}",
    fileNotFound: "文件不存在或不可读：{path}",
    fileTooLargeOutbound: "文件超过 5MB 上限（{size}），请压缩或选择更小的文件。",
    fileSent: "已发送 {filename}（{size}）。",
    fileSendFailed: "文件发送失败：{message}",
    selectionCancelled: "已取消。",
    selectionCancelOption: "取消",
    selectionTextHint: "回复数字选择，0 取消。",
    selectionTextHintNoCancel: "回复数字选择。",
    newTaskDraft: "已进入 {workspacePath} 的新任务草稿。",
    workspaceSelectTitle: "当前 workspace {workspace}\n选择 workspace",
    workspaceMissing: "未找到可用 workspace。",
    modelSelectTitle: "选择 model",
    modelProviderSelectTitle: "当前模型 {model}\n选择模型供应商",
    modelModelSelectTitle: "当前模型 {model}\n选择模型",
    modelMissing: "未找到 model。",
    sessionModelUnavailable: "当前会话的模型选择不可用，请使用 /model 重新选择。原选择已保留。",
    // 3.14.5-alpha.3（specs/bot-inbound-resilience.md §A）：无模型草稿的可执行指引与可见陷阱。
    draftModelMissing:
      "当前项目还没有选择模型。请先发送 **/模型** 选择一个模型（或在桌面端设置默认模型），然后重新发送你的消息。",
    draftModelInvalid:
      "当前草稿保存的模型选择已不可用（模型或供应商可能已变化）。请发送 **/模型** 重新选择后重发；原选择已保留。",
    statusModelUnset: "未设置",
    statusModeUnset: "未设置",
    modeSelectTitle: "当前模式 {mode}\n选择模式",
    modeMissing: "未找到模式。",
    // 3.16.0 PR1 rider（specs/bot-permissions.md §8.4，owner 裁定 §7.38③）：无模型草稿
    // /mode 的空选项回复换可行动文案；其余空选项路径继续共用 modeMissing。
    modeMissingNoModel: "尚未选择模型：请先通过 /model 选择模型，再设置协作模式。",
    modeChanged: "当前任务模式已切换为 {mode}。",
    thoughtLevelSelectTitle: "当前思考级别 {level}\n选择思考级别",
    thoughtLevelMissing: "当前模型不支持思考级别。",
    thoughtLevelChanged: "当前任务思考级别已切换为 {level}。",
    modelProviderMissing: "未找到模型供应商。",
    modelChanged: "当前任务 model 已切换为 {model}。",
    taskMissing: "未找到任务。",
    taskChanged: "已切换到任务：{title}",
    noActiveTask: "当前没有 active task。",
    permissionExpired: "权限请求已过期，请在 zcode UI 中处理。",
    permissionHandled: "权限请求已处理。",
    permissionDenied: "已拒绝权限请求。",
    permissionSubmitted: "已提交权限响应。",
    // 3.15.0 Track B（specs/bot-permissions.md §4.1/§4.3）：permission_response 退休注记与
    // 迟到点击（CLI 自动拒绝/他端已应答）反馈——均为 best-effort、非保留。
    permissionResolved: "该权限请求已处理。",
    permissionLateHandled: "该权限请求已被处理（或已自动拒绝）。",
    // 3.15.0 Track B（specs/bot-permissions.md §3c.1）：bot 侧权限策略 timer 文案——
    // reminder（deadline − 2 分钟）与 deny-note（deadline 时刻）。均为 best-effort、
    // 非保留；deny 权威唯一在 CLI 登记表，deny-note 只负责聊天可见性。
    permissionDeadlineReminder: "权限请求将在 {minutes} 分钟后自动拒绝",
    permissionAutoDenied: "权限超时未应答，已自动拒绝",
    elicitationExpired: "问答请求已过期，请在 zcode UI 中处理。",
    elicitationHandled: "问答请求已处理。",
    elicitationSubmitted: "已提交问答响应。",
    elicitationCancelled: "已取消问答请求。",
    elicitationCustomOption: "自定义回答",
    elicitationCustomPlaceholder: "请输入自定义回答",
    elicitationQuestionTitle: "提问",
    planApprovalTitle: "请审阅此实施计划。",
    planApprovalHeader: "实施计划",
    planApprovalApprove: "批准",
    planApprovalApproveDescription: "退出计划模式并开始实施。",
    elicitationCancelledCard: "✅ 问答已取消",
    elicitationSubmitOption: "完成",
    elicitationSkipOption: "跳过",
    elicitationMultiSelectHint: "可多选；再次选择会取消，选择“完成”提交。",
    elicitationTextHint: "也可以直接回复文本作为自定义答案。",
    statusWorkspace: "工作区",
    statusModel: "模型",
    statusMode: "模式",
    statusTask: "任务",
    statusState: "状态",
    statusWorked: "已工作",
    statusProgress: "进展",
    statusDraft: "草稿",
    statusRemoteDisconnected: "远端未连接",
    statusCancelled: "已取消",
    statusStopped: "已停止",
    streamingStatusRunning: "⏳ 运行中",
    streamingStatusCompleted: "✅ 已完成",
    streamingStatusFailed: "失败",
    streamingWorking: "正在处理...",
    streamingToolSummaries: "工具摘要",
    stopSubmitted: "已停止当前任务生成。",
    unknownCommand: "未知命令：**/{command}**",
    taskFailed: "任务失败：{message}",
    // 3.14.5 Alpha 9 rider（specs/bot-message-delivery.md「User-facing business-error
    // localization」§7.35）：前置 `[数字]` 括号业务码的本地化外壳，原文逐字保留在尾部。
    modelBusinessError: "模型服务返回错误（代码 {code}）：{message}",
    taskRunning: "当前任务正在运行，稍后再试，或使用 **/停止** 停止当前任务。",
    taskSelectTitle: "当前任务 {task}\n选择任务",
    noHistoryTasks: "当前 workspace 没有历史任务。",
    remoteDisconnected:
      "当前远端项目 {workspacePath} 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。",
    remoteDisconnectedStatus: "当前远端项目 {workspacePath} 未连接。请发送 **/重连** 恢复连接。",
    remoteWorkspaceSelectedDisconnected:
      "已切换到远端项目 {workspacePath}，但当前未连接。请先发送 **/重连** 后再执行任务。",
    remoteReconnectStarting: "当前远端项目 {workspacePath} 未连接，正在为你重连...",
    remoteReconnectFailed: "当前远端项目 {workspacePath} 重连失败：{message}\n上一条请求没有执行。",
    remoteReconnectUnavailable:
      "当前远端项目 {workspacePath} 未连接，但机器人无法访问远端重连服务。请先在 Zodex 打开该远端项目后重试。",
    remoteReconnectLocal: "当前 workspace 是本地项目，不需要重连。发送 **/项目** 可切换远端项目。",
    remoteReconnectAlreadyConnected: "当前远端项目 {workspacePath} 已连接。",
    replySelectTitle: "当前第三方回复颗粒度 {mode}\n选择第三方回复颗粒度",
    replyMissing: "未找到回复颗粒度。",
    replyChanged: "第三方回复颗粒度已切换为 {mode}。",
    // F2（specs/bot-message-delivery.md）：flush 预算耗尽丢弃剩余正文时的一次性本地化通知。
    replyDeliveryFailed: "部分回复未能送达，已跳过。",
    // 3.14.5-alpha.4（specs/bot-message-delivery.md Retention buffer）：revival 补发序言
    //（owner 决定 §7.20 文案，先于积压内容走存活通道）与保留缓冲头部截断标记。
    retainedBacklogPreamble: "断线期间积压的 {count} 条消息已补发",
    retainedBacklogTruncatedHead: "…(更早的积压消息已截断)",
    // /status 在保留缓冲非空期间显示的待补发行（条数 + 约 KB 数）。
    statusPendingDelivery: "待补发：{count} 条断线积压消息（约 {kb} KB）",
    // 3.15.0-alpha.2（Track B 收尾 R3）：/help 尾部三条注记——配置变更生效时机 /
    // 技能按名调用 / 插件不热加载。本批仅落 key，buildHelpText 追加由 W2 接线。
    helpNoteConfigNextTask: "模式/超时等配置变更自下一个任务生效",
    helpNoteSkillsByName: "已安装技能可在会话中按名称调用",
    helpNotePluginsNoHotLoad: "插件不会热加载进运行中的会话",
  },
  "en-US": {
    botDisabled: "This bot is not enabled.",
    privateChatOnly: "Bots do not support group chats yet. Please use a private chat.",
    bindPrivateOnly: "Bots can only bind in a private chat.",
    userNotBound:
      "This bot is not bound. Generate a bind code in the zcode UI, then send **/bind <code>**.",
    commandNotAllowed: "This command is disabled for the current bot.",
    noWorkspaceAllowed: "No workspace is available. Allow a workspace in Bots settings first.",
    workspaceOutOfScope:
      "The workspace in this chat is no longer authorized. Please select **/workspace** again.",
    bindCodeInvalid: "The bind code is invalid or expired. Generate a new one in the zcode UI.",
    bindBotMissing: "Bind failed: bot does not exist.",
    bindSuccess: "Bound successfully. Send **/help** to see available commands.",
    weixinActivatedWelcome:
      "Weixin bot is active. Send **/help** to see commands, or describe what you want to do.",
    helpTitle: "Zodex bot commands:",
    helpHelp: "**/help** — Show this guide",
    helpBind: "**/bind <code>** — Bind this chat",
    helpStatus: "**/status** — Show workspace, model, and task status",
    helpNew: "/new or /clear — Start a new task draft",
    helpWorkspace: "**/project** — Switch workspace",
    helpModel: "**/model** — Switch model",
    helpMode: "**/mode** — Switch run mode",
    helpThoughtLevel: "**/think** — Switch thought level",
    helpReply: "**/reply** — Switch reply detail",
    helpFile: "**/file <path>** — Send a workspace file (private chat only, max 5MB)",
    webhookSecretInvalid: "Webhook secret verification failed.",
    callbackFailed: "Failed to process bot callback: {message}",
    sessionExpiredNewTaskHint:
      "The current task session has expired. It may have been cleaned up, or this bot message is stale. Send **/new task** to create a new task and continue.",
    deletedTaskReplaced:
      "The previous task was deleted, so I created a new task for you. This message will be processed in the new task without the previous conversation history.",
    received: "Received.",
    attachmentOnlyPrompt: "Please review the attachment and help based on its content.",
    attachmentRejected: "Failed to process attachment: {message}",
    attachmentDownloadUnavailable:
      "Could not download the attachment. The file may have expired, been removed, or the bot may not have permission to read it. Please send the attachment again and try once more.",
    // 3.14.5 Alpha 6 (specs/bot-file-delivery.md "Inbound attachment gates" §5.1/§5.2):
    // immediate >4-attachment notice + per-file oversize skip (single-check semantics).
    attachmentCountLimited:
      "At most the first {max} attachments in a message are processed; the remaining {count} were skipped.",
    attachmentTooLargeSkipped: "Attachment {filename} exceeds the 5MB limit and was skipped.",
    fileCommandUnsupported:
      "This channel does not support sending files yet; coming in a later release.",
    // Phase C Alpha 2: honest wording for remote fetch failures (unreachable/timeout/budget).
    fileRemoteUnavailable:
      "The remote workspace is currently unavailable. Please retry later or send /reconnect first.",
    // 3.14.5 Alpha 0 (A3a): /file acks immediately; delivery runs in the background.
    fileFetchStarted: "Fetching and sending the file…",
    fileMissingPath: "Specify the file to send, e.g. **/file reports/result.png**.",
    fileOutsideWorkspace: "Only files inside the current workspace can be sent: {path}",
    fileNotFound: "File not found or unreadable: {path}",
    fileTooLargeOutbound:
      "File exceeds the 5MB limit ({size}). Please compress or pick a smaller file.",
    fileSent: "Sent {filename} ({size}).",
    fileSendFailed: "Failed to send file: {message}",
    selectionCancelled: "Cancelled.",
    selectionCancelOption: "Cancel",
    selectionTextHint: "Reply with a number to choose, or 0 to cancel.",
    selectionTextHintNoCancel: "Reply with a number to choose.",
    newTaskDraft: "Entered a new task draft in {workspacePath}.",
    workspaceSelectTitle: "Current workspace {workspace}\nSelect workspace",
    workspaceMissing: "No available workspace found.",
    modelSelectTitle: "Select model",
    modelProviderSelectTitle: "Current model {model}\nSelect model provider",
    modelModelSelectTitle: "Current model {model}\nSelect model",
    modelMissing: "Model not found.",
    sessionModelUnavailable:
      "The session's model selection is unavailable. Use /model to choose again. Your saved selection has been preserved.",
    // 3.14.5-alpha.3 (specs/bot-inbound-resilience.md §A): actionable guidance + visible trap for model-less drafts.
    draftModelMissing:
      "This project has no model selected yet. Pick one with **/model** (or set a default in the desktop app), then resend your message.",
    draftModelInvalid:
      "The model selection saved in this draft is no longer available (the model or provider may have changed). Pick one again with **/model** and resend; your saved selection is preserved.",
    statusModelUnset: "not set",
    statusModeUnset: "not set",
    modeSelectTitle: "Current mode {mode}\nSelect mode",
    modeMissing: "Mode option not found.",
    // 3.16.0 PR1 rider (specs/bot-permissions.md §8.4, owner ruling §7.38③): actionable
    // copy for model-less draft /mode; other empty-option paths keep modeMissing.
    modeMissingNoModel:
      "No model selected yet. Pick a model with /model first, then set the collaboration mode.",
    modeChanged: "Current task mode changed to {mode}.",
    thoughtLevelSelectTitle: "Current thought level {level}\nSelect thought level",
    thoughtLevelMissing: "The current model does not support thought level.",
    thoughtLevelChanged: "Current task thought level changed to {level}.",
    modelProviderMissing: "Model provider not found.",
    modelChanged: "Current task model changed to {model}.",
    taskMissing: "Task not found.",
    taskChanged: "Switched to task: {title}",
    noActiveTask: "There is no active task.",
    permissionExpired: "This permission request has expired. Please handle it in the zcode UI.",
    permissionHandled: "Permission request has already been handled.",
    permissionDenied: "Permission request denied.",
    permissionSubmitted: "Permission response submitted.",
    // 3.15.0 Track B (specs/bot-permissions.md §4.1/§4.3): permission_response retirement note
    // and late-click feedback (CLI auto-deny / answered elsewhere) — both best-effort, non-retained.
    permissionResolved: "This permission request has been resolved.",
    permissionLateHandled: "This permission request was already handled (or auto-denied).",
    // 3.15.0 Track B (specs/bot-permissions.md §3c.1): bot-side permission policy timer
    // texts — reminder (deadline − 2 min) and deny-note (at deadline). Both best-effort,
    // non-retained; deny authority lives solely in the CLI registry.
    permissionDeadlineReminder: "This permission request will be auto-denied in {minutes} minutes.",
    permissionAutoDenied: "Permission timed out without a response and was auto-denied.",
    elicitationExpired: "This question request has expired. Please handle it in the zcode UI.",
    elicitationHandled: "Question request has already been handled.",
    elicitationSubmitted: "Question response submitted.",
    elicitationCancelled: "Question request cancelled.",
    elicitationCustomOption: "Custom answer",
    elicitationCustomPlaceholder: "Enter a custom answer",
    elicitationQuestionTitle: "Question",
    planApprovalTitle: "Review this implementation plan.",
    planApprovalHeader: "Implementation plan",
    planApprovalApprove: "Approve",
    planApprovalApproveDescription: "Exit plan mode and start implementation.",
    elicitationCancelledCard: "✅ Questions cancelled",
    elicitationSubmitOption: "Done",
    elicitationSkipOption: "Skip",
    elicitationMultiSelectHint:
      "You can select multiple options; select again to remove, then choose Done.",
    elicitationTextHint: "You can also reply with text as a custom answer.",
    statusWorkspace: "Workspace",
    statusModel: "Model",
    statusMode: "Mode",
    statusTask: "Task",
    statusState: "State",
    statusWorked: "Worked",
    statusProgress: "Progress",
    statusDraft: "draft",
    statusRemoteDisconnected: "remote disconnected",
    statusCancelled: "cancelled",
    statusStopped: "stopped",
    streamingStatusRunning: "Running",
    streamingStatusCompleted: "Completed",
    streamingStatusFailed: "Failed",
    streamingWorking: "Working...",
    streamingToolSummaries: "Tool summaries",
    stopSubmitted: "Current task generation stopped.",
    unknownCommand: "Unknown command: **/{command}**",
    taskFailed: "Task failed: {message}",
    // 3.14.5 Alpha 9 rider: localized shell for leading bracketed business codes;
    // the raw text is preserved verbatim in the tail.
    modelBusinessError: "The model service returned an error (code {code}): {message}",
    taskRunning:
      "The current task is still running. Try again later, or use **/stop** to stop the current task.",
    taskSelectTitle: "Current task {task}\nSelect task",
    noHistoryTasks: "There are no history tasks in the current workspace.",
    remoteDisconnected:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** first, then try again. The previous request was not executed.",
    remoteDisconnectedStatus:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** to restore the connection.",
    remoteWorkspaceSelectedDisconnected:
      "Switched to {workspacePath}, but the remote workspace is not connected. Send **/reconnect** before running tasks.",
    remoteReconnectStarting:
      "The remote workspace {workspacePath} is not connected. Reconnecting now...",
    remoteReconnectFailed:
      "Remote workspace {workspacePath} reconnect failed: {message}\nThe previous request was not executed.",
    remoteReconnectUnavailable:
      "The remote workspace {workspacePath} is not connected, but the bot cannot access the remote reconnect service. Open this remote project in Zodex and try again.",
    remoteReconnectLocal:
      "The current workspace is local and does not need reconnecting. Send **/workspace** to switch to a remote project.",
    remoteReconnectAlreadyConnected: "The remote workspace {workspacePath} is connected.",
    replySelectTitle: "Current third-party reply detail {mode}\nSelect third-party reply detail",
    replyMissing: "Reply detail option not found.",
    replyChanged: "Third-party reply detail changed to {mode}.",
    replyDeliveryFailed: "Part of the reply could not be delivered and was skipped.",
    retainedBacklogPreamble: "Delivered {count} messages queued during the outage",
    retainedBacklogTruncatedHead: "…(earlier queued messages were truncated)",
    statusPendingDelivery: "Pending delivery: {count} messages queued during the outage (~{kb} KB)",
    // 3.15.0-alpha.2 (Track B closing R3): three trailing /help notes — see zh-CN block.
    helpNoteConfigNextTask: "Config changes (mode, timeout) take effect on the next task",
    helpNoteSkillsByName: "Installed skills can be invoked by name mid-session",
    helpNotePluginsNoHotLoad: "Plugins never hot-load into a running session",
  },
} as const;

export type BotMessageId = keyof (typeof messages)[BotMessageLocale];

export function normalizeBotMessageLocale(locale: Locale | undefined): BotMessageLocale {
  return locale === "en-US" ? "en-US" : DEFAULT_BOT_MESSAGE_LOCALE;
}

export function formatBotMessage(
  locale: Locale | undefined,
  id: BotMessageId,
  values: MessageValues = {},
): string {
  let message: string = messages[normalizeBotMessageLocale(locale)][id];
  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return message;
}
