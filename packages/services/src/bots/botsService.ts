/* eslint-disable max-lines -- Bots 服务仍复用原 RPC 文件名，先把鉴权、命令路由、ZCode Agent 桥接收口集中在同一服务内。 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { IDisposable } from "@zcode/rpc";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ALL_BOT_WORKSPACES,
  generateTraceId,
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  BOT_TASK_BROADCAST_CHANNEL,
  BOT_TASK_STREAM_BROADCAST_CHANNEL,
  appendAssistantMessagePart,
  buildZCodeAssistantPresentation,
  decodeCustomModelValue,
  encodeCustomModelValue,
  getPermissionRequestPreview,
  getSupportedBotReplyGranularities,
  normalizeBotReplyGranularity,
  type ZCodeConfigOption,
  type ZCodeElicitationRequest,
  type ZCodeElicitationQuestion,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodePromptAttachment,
  type ZCodeTaskMode,
  type ZCodeAssistantMessagePart,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeProvider,
  type ZCodeStreamEvent,
  type TaskStreamMirrorableEvent,
  type ZCodeTaskMeta,
  type BotActor,
  type BotTaskBroadcastPayload,
  type BotTaskStreamBroadcastPayload,
  type BotConfig,
  type BotContextState,
  type BotDraftOptions,
  type BotState,
  type BotCommand,
  type BotInboundAttachment,
  type BotInboundMessage,
  type BotOutboundAttachment,
  type BotOutboundMessage,
  type BotPendingElicitation,
  type BotStructuredElicitationResponse,
  isFeishuBotProvider,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotReplyGranularity,
  type BotRuntimeInfo,
  type BotWorkspaceRef,
  type ModelSelection,
  type BotsConfigFile,
  type Locale,
  type SelectionPrompt,
  type BotShareFileFailureReason,
  type BotShareFileResult,
  sniffAttachmentContainer,
  sanitizeByteBudgetedFilename,
} from "@zcode/shared";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { IBotWorkspaceFileService } from "./botWorkspaceFileService.js";
import {
  PROTOCOL_V4_LIMITS,
  type V4BotWorkspaceFileReadResult,
} from "@zcode/shared/zcode-protocol-v4";
import { resolveProviderModeIdFromConfigOptions } from "#src/session/sessionModeOptions.js";
import { deriveSessionTitle as deriveTaskTitle } from "#src/session/sessionTitle.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { ICredentialService } from "../credential/credential.js";
import { getAppConfigDir } from "../paths.js";
import type { ISettingService } from "../setting/setting.js";
import type {
  IModelSelectionService,
  ModelSelectionView,
} from "../model-provider/providerFacadeServices.js";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  BotBindCodeResult,
  BotAutomationRunWatchParams,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotSaveBotResult,
  BotShareFileTaskDeliveryOptions,
  BotTestResult,
  BotUserConfigOptionsParams,
  IBotsService,
} from "./bots.js";
import {
  beginFeishuAppRegistration,
  pollFeishuAppRegistration,
} from "./providers/feishuAppRegistration.js";
import {
  BOT_BIND_CODE_TTL_MS,
  buildBotCredentialKey,
  buildBotWebhookSecretKey,
  getDefaultBotReplyGranularity,
  normalizeBotCommandPolicy,
  normalizeBotCurrentOptions,
} from "./config.js";
import { BOT_MENU_COMMAND_ORDER } from "./commandOrder.js";
import { parseBotCommand } from "./commandParser.js";
import { BotsRepo } from "./repo.js";
import type {
  BotProviderAdapter,
  BotStreamingReplyCardBlock,
  BotStreamingReplyCardHandle,
  BotTransientInteractionCardHandle,
  BotTypingTarget,
} from "./providers/types.js";
import { createTelegramBotProvider } from "./providers/telegramProvider.js";
import {
  createBotProviderRequester,
  type BotProviderRequester,
} from "./providers/providerRequest.js";
import { createWebhookBotProvider } from "./providers/webhookProvider.js";
import { createWeixinBotProvider } from "./providers/weixinProvider.js";
import {
  beginWeixinRegistration as beginWeixinQrRegistration,
  pollWeixinRegistration as pollWeixinQrRegistration,
} from "./providers/weixinRegistration.js";
import { createFeishuBotProvider } from "./providers/feishuProvider.js";
import { formatBotMessage, type BotMessageId } from "./messages.js";
import {
  extractBotAssistantResponseMessages,
  formatBotAssistantReplyBlocks,
  formatBotToolCallSummaryLine,
  formatBotPermissionRequestSummary,
  formatBotToolCallReply,
  isBotToolCallReplyTerminal,
  updateBotReplyToolCalls,
  type BotAssistantReplyBlock,
  type BotReplyToolCallState,
} from "./replyFormatter.js";
import {
  findBoundUser,
  findAuthorizedBot,
  findCallbackBot,
  findBot,
  getContextKey,
  isUserCommandAllowed,
  normalizeBotConfig,
  normalizeConfigBots,
} from "./botConfigHelpers.js";
import {
  firstAllowedWorkspace,
  createWorkspaceRef,
  filterAllowedWorkspaces,
  getWorkspaceLabel,
  getWorkspaceKey,
  isWorkspaceAllowed,
  normalizeAllowedWorkspaces,
  normalizeConfiguredAllowedWorkspaces,
  resolveWorkspaceByValue,
} from "./workspaceHelpers.js";
import { getNativeModelProviderId } from "./modelSelectionHelpers.js";
import {
  formatStatusStreamToolProgress,
  formatStatusTaskLine,
  formatTaskRunningDuration,
  normalizeStatusProgressText,
  readLatestAssistantTurnChangeSummary,
  readLatestTaskProgress,
  readTaskWorkedDurationMs,
  taskStatus,
  truncateLiveStatusProgressText,
} from "./statusFormatting.js";
import { createTelegramChannelRuntime } from "./telegramChannelRuntime.js";
import { createWeixinChannelRuntime } from "./weixinChannelRuntime.js";
import { createFeishuChannelRuntime } from "./feishuChannelRuntime.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const botsLogger = createServiceLogger("bots");

function formatBotModelSelectionValue(selection: ModelSelection | undefined): string | undefined {
  if (!selection) return undefined;
  return selection.providerId === ZCODE_AGENT_PROVIDER
    ? selection.modelId
    : encodeCustomModelValue(selection.providerId, selection.modelId);
}

function parseBotModelOptionValue(value: string): ModelSelection | undefined {
  const decoded = decodeCustomModelValue(value);
  if (decoded?.providerId && decoded.modelName) {
    return { providerId: decoded.providerId, modelId: decoded.modelName };
  }
  const separatorIndex = value.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < value.length - 1) {
    return {
      providerId: value.slice(0, separatorIndex),
      modelId: value.slice(separatorIndex + 1),
    };
  }
  return value.trim() ? { providerId: ZCODE_AGENT_PROVIDER, modelId: value.trim() } : undefined;
}

const BOT_REPLY_GRANULARITY_OPTIONS = [
  {
    id: "assistant_changes",
    label: { "zh-CN": "标准回复", "en-US": "Standard reply" },
    aliases: ["assistant", "assistant_changes", "normal", "default", "standard", "标准回复"],
  },
  {
    id: "assistant_toolcalls_changes",
    label: { "zh-CN": "完整回复", "en-US": "Full reply" },
    aliases: ["full", "tool", "toolcalls", "assistant_toolcalls_changes", "完整回复"],
  },
  {
    id: "summary_changes",
    label: { "zh-CN": "摘要回复", "en-US": "Summary reply" },
    aliases: ["summary", "summary_changes", "latest", "摘要回复"],
  },
  {
    id: "streaming_card",
    label: { "zh-CN": "流式卡片", "en-US": "Streaming card" },
    aliases: ["stream", "streaming", "streaming_card", "流式", "流式卡片"],
  },
] as const satisfies ReadonlyArray<{
  id: BotReplyGranularity;
  label: Record<"zh-CN" | "en-US", string>;
  aliases: readonly string[];
}>;

const BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS = new Set<BotProvider>(["telegram", "feishu", "lark"]);
const FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS = 1_000;
const FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS = 1_000;
const FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD = 3;
const BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS = 1_000;
const BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS = 3_000;

// F4（specs/bot-provider-network.md）：bot 开启且轮询正常、但此刻没有任何可解析 workspace 时，
// 游标写入曾被静默丢弃——外部队列（Telegram update offset / 微信 getUpdates buf）失去确认点，
// 同一批更新每个轮询周期都被重新拉取并重复处理（用户每轮收到重复回复）。
// 修复：游标无条件落盘，先创建“仅游标”的 state entry，workspace 字段留待首次解析出 workspace 时补齐。
// schema 要求 workspacePath 非空（min(1)），因此用哨兵路径标记“尚未解析出 workspace”；
// readContext 识别该哨兵并把此类 entry 视为“尚无 context”，绝不把哨兵路径当成真实任务 cwd。
const UNRESOLVED_BOT_WORKSPACE_PATH = "zcode://unresolved-bot-workspace";

function isCursorOnlyBotState(entry: BotState | undefined): boolean {
  return (
    entry !== undefined &&
    entry.workspacePath === UNRESOLVED_BOT_WORKSPACE_PATH &&
    !entry.workspaceIdentity &&
    !entry.workspaceId
  );
}

function createCursorOnlyBotState(
  botId: string,
  cursor: Pick<Partial<BotState>, "telegramOffset" | "weixinGetUpdatesBuf">,
): BotState {
  return {
    botId,
    workspacePath: UNRESOLVED_BOT_WORKSPACE_PATH,
    mode: "draft",
    activeTaskId: null,
    ...cursor,
    updatedAt: Date.now(),
  };
}

/** 仅游标 entry 升级为真实 context 时，必须原样带走的外部队列确认点字段。 */
function pickPersistedBotCursors(
  entry: BotState | undefined,
): Pick<
  Partial<BotState>,
  "telegramOffset" | "weixinGetUpdatesBuf" | "weixinActivatedAt" | "weixinContextTokens"
> {
  if (!entry) {
    return {};
  }
  return {
    ...(entry.telegramOffset !== undefined ? { telegramOffset: entry.telegramOffset } : {}),
    ...(entry.weixinGetUpdatesBuf !== undefined
      ? { weixinGetUpdatesBuf: entry.weixinGetUpdatesBuf }
      : {}),
    ...(entry.weixinActivatedAt !== undefined
      ? { weixinActivatedAt: entry.weixinActivatedAt }
      : {}),
    ...(entry.weixinContextTokens ? { weixinContextTokens: entry.weixinContextTokens } : {}),
  };
}

type StreamingCardTimelineBlock =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "tools";
      toolIds: string[];
    };

const helpMessageByCommand = {
  help: "helpHelp",
  bind: "helpBind",
  status: "helpStatus",
  new: "helpNew",
  workspace: "helpWorkspace",
  model: "helpModel",
  mode: "helpMode",
  thoughtLevel: "helpThoughtLevel",
  reply: "helpReply",
  file: "helpFile",
} as const satisfies Record<(typeof BOT_MENU_COMMAND_ORDER)[number], BotMessageId>;

function validateBotConfig(config: BotsConfigFile, candidate: BotConfig): void {
  if (!candidate.id.trim()) {
    throw new Error("Bot id is required.");
  }
  if (candidate.enabled && candidate.providerUserId?.trim()) {
    const duplicateBinding = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.providerUserId === candidate.providerUserId,
    );
    if (duplicateBinding) {
      throw new Error("An enabled bot with this provider user already exists.");
    }
  }
  if (
    candidate.enabled &&
    candidate.credentialRef?.trim() &&
    BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS.has(candidate.provider)
  ) {
    const duplicateCredential = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.credentialRef === candidate.credentialRef,
    );
    if (duplicateCredential) {
      throw new Error("Enabled polling bots cannot share the same credential.");
    }
  }
}

interface BotsServiceDeps {
  credentialService: ICredentialService;
  zcodeTaskService: IZCodeTaskService;
  broadcastService?: IBroadcastService;
  settingService?: ISettingService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  remoteWorkspaceService?: BotRemoteWorkspaceService;
  // 修复原因：desktop-attached 远端启动阶段不应抢跑 bot 轮询、runtime lock 和模型候选缓存；
  // 这些后台任务属于本地桌面 host，不属于 SSH/Docker 远端首屏连接路径。
  runStartupBackgroundTasks?: boolean;
  /** 测试注入：替换内置 provider adapter（如监听 sendAttachment 调用），不影响生产装配。 */
  providerOverrides?: Partial<Record<BotProvider, BotProviderAdapter | null>>;
  /** 测试注入：预置/观察 taskDeliveryRegistry；缺省在服务内创建唯一实例（specs Phase B）。 */
  taskDeliveryRegistry?: BotTaskDeliveryRegistry;
  /** 测试注入：缩短远端文件分块读取的 deadline/总预算，避免测试真实等待 20s/120s。 */
  remoteFileDeliveryTimeouts?: { chunkDeadlineMs?: number; totalBudgetMs?: number };
  /**
   * specs/bot-provider-network.md F1：bot provider 全部出站 HTTP 的注入出口。
   * 缺省 undefined → globalThis.fetch（与既有直连行为零漂移）；桌面组合根注入
   * host API 网络 transport 的 fetch（设置页 httpProxy 一处配置同时覆盖 AI 与 bots）。
   * transport 已销毁时错误原样上抛，绝不回退直连（fail-closed，防代理外泄流）。
   */
  providerFetch?: typeof globalThis.fetch;
}

interface BotRemoteWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity: string;
}

interface BotRemoteWorkspaceReconnectResult {
  ok: boolean;
  message?: string;
}

interface BotRemoteWorkspaceService {
  isConnected(target: BotRemoteWorkspaceTarget): Promise<boolean>;
  ensureConnected(target: BotRemoteWorkspaceTarget): Promise<BotRemoteWorkspaceReconnectResult>;
  getZCodeTaskService?(target: BotRemoteWorkspaceTarget): Promise<IZCodeTaskService | null>;
  getModelSelectionService?(
    target: BotRemoteWorkspaceTarget,
  ): Promise<Pick<IModelSelectionService, "getView"> | null>;
  /** Phase C Alpha 2：远端 workspace 文件读取（与 getZCodeTaskService 同一 lifecycle 约定）。 */
  getWorkspaceFileReader?(
    target: BotRemoteWorkspaceTarget,
  ): Promise<IBotWorkspaceFileService | null>;
  syncAppRuntimePreferences?(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
}

interface PreparedBotMessageContent {
  content: string;
  zcodeAttachments: ZCodePromptAttachment[];
  /**
   * Alpha 6（§5.1/§5.2）：随正常处理一起返回给用户的即时本地化通知
   * （>4 附件通知 + 逐文件超限跳过通知）。
   */
  noticeReplies: BotOutboundMessage[];
  /**
   * Alpha 6（§5.2）边界：全部附件被拒且消息无文字 → 调用方必须整条拒绝
   * （绝不创建空任务），直接返回 noticeReplies。
   */
  wholeRejection: boolean;
}

type BotAuthorizedCommand =
  | "help"
  | "status"
  | "new"
  | "reconnect"
  | "workspace"
  | "model"
  | "mode"
  | "thoughtLevel"
  | "task"
  | "reply"
  | "stop"
  | "message"
  | "approve"
  | "file";

interface BindCodeRecord {
  botId: string;
  code: string;
  allowedWorkspaces: string[];
  expiresAt: number;
}

interface BotModelOption {
  id: string;
  label: string;
  description?: string;
}

interface BotModelProviderOption {
  id: string;
  label: string;
  description?: string;
  models: BotModelOption[];
}

interface BotTaskSelectionEntry {
  task: ZCodeTaskMeta;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface BotWorkspaceSelectionEntry {
  workspace: BotWorkspaceRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNestedRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return isRecord(nested) ? nested : null;
}

function readNestedString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" && nested.trim().length > 0 ? nested : undefined;
}

function summarizeCallbackPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return `type=${typeof payload}`;
  }
  const header = readNestedRecord(payload, "header");
  const event = readNestedRecord(payload, "event") ?? payload;
  const message = readNestedRecord(event, "message");
  const context = readNestedRecord(payload, "context");
  const action = readNestedRecord(payload, "action");
  const keys = Object.keys(payload).slice(0, 16).join(",");
  return [
    `keys=${keys || "none"}`,
    `botId=${readNestedString(payload, "botId") ?? "none"}`,
    `eventType=${readNestedString(header, "event_type") ?? readNestedString(header, "type") ?? readNestedString(payload, "event_type") ?? "none"}`,
    `messageType=${readNestedString(message, "message_type") ?? "none"}`,
    `chatType=${readNestedString(message, "chat_type") ?? readNestedString(context, "chat_type") ?? readNestedString(payload, "chat_type") ?? "none"}`,
    `hasAction=${action ? "true" : "false"}`,
  ].join(" ");
}

function createCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function getReplyGranularityOptions(locale: Locale | undefined, provider?: BotProvider) {
  const messageLocale = locale === "en-US" ? "en-US" : "zh-CN";
  const supportedIds = provider ? new Set(getSupportedBotReplyGranularities(provider)) : null;
  return BOT_REPLY_GRANULARITY_OPTIONS.filter(
    (option) => !supportedIds || supportedIds.has(option.id),
  ).map((option) => ({
    id: option.id,
    label: option.label[messageLocale],
  }));
}

function resolveReplyGranularityByValue(
  value: string,
  locale: Locale | undefined,
  provider?: BotProvider,
) {
  const trimmed = value.trim();
  const index = Number.parseInt(trimmed, 10);
  const options = getReplyGranularityOptions(locale, provider);
  if (Number.isFinite(index) && index > 0) {
    return options[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  const option = BOT_REPLY_GRANULARITY_OPTIONS.find(
    (item) =>
      (item.aliases as readonly string[]).includes(normalized) ||
      normalizeText(item.label["zh-CN"]) === normalized ||
      normalizeText(item.label["en-US"]) === normalized,
  );
  return option ? (options.find((item) => item.id === option.id) ?? null) : null;
}

function resolveOptionByValue<T extends { id: string; label: string }>(
  items: T[],
  value: string,
): T | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    return items[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  return (
    items.find(
      (item) => normalizeText(item.id) === normalized || normalizeText(item.label) === normalized,
    ) ?? null
  );
}

function isSelectionIndexValue(value: string): boolean {
  return /^[1-9]\d*$/u.test(value.trim());
}

function createOutbound(
  actor: BotActor,
  text: string,
  selection?: SelectionPrompt,
  extras: Pick<BotOutboundMessage, "elicitation" | "locale"> = {},
): BotOutboundMessage {
  return {
    botId: actor.botId,
    provider: actor.provider,
    providerUserId: actor.chatId ?? actor.providerUserId,
    text,
    ...(selection ? { selection } : {}),
    ...extras,
    ...(actor.providerContextToken ? { providerContextToken: actor.providerContextToken } : {}),
  };
}

function resolveAutomationBotDeliveryTarget(
  actor: BotActor,
): ZCodeAutomationBotDeliveryTarget | undefined {
  // Phase C Alpha 5（specs/bot-file-delivery.md §2c，owner decision）：telegram 仅私聊
  // 产出投递目标，群聊永远不产出；feishu/lark/weixin 维持任意 chatType 均产出的既有行为。
  // 群聊入站虽已在授权层被 privateChatOnly 拦截，产出侧的私聊限定是纵深防御，
  // 保证未来新增入站路径也不会让 telegram 群聊拿到回推目标。
  if (
    actor.provider !== "feishu" &&
    actor.provider !== "lark" &&
    actor.provider !== "weixin" &&
    (actor.provider !== "telegram" || actor.chatType !== "private")
  ) {
    return undefined;
  }
  const providerUserId = actor.chatId?.trim() || actor.providerUserId.trim();
  if (!providerUserId) return undefined;
  return {
    provider: actor.provider,
    botId: actor.botId,
    providerUserId,
    chatType: actor.chatType,
  };
}

function formatSelectionFallback(selection: SelectionPrompt, locale?: Locale): string {
  const lines = selection.options.map((option, index) => {
    const description = option.description ? ` ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}`;
  });
  // Bugfix: 微信这类纯文本通道没有原生选项卡，之前把完整 slash command 和长路径展开，
  // workspace/remote identity 会把消息刷得很长。这里只展示编号，数字解析仍走 pending selection。
  if (selection.showCancel === false) {
    return `${selection.title}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHintNoCancel")}`;
  }
  const cancelLabel = selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption");
  return `${selection.title}\n0. ${cancelLabel}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHint")}`;
}

type BotPermissionOptionDisplayKind =
  | "allowOnce"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways"
  | "custom";

const BOT_PERMISSION_OPTION_PRIORITY = {
  allowOnce: 0,
  allowAlways: 1,
  rejectOnce: 2,
  rejectAlways: 3,
  custom: 4,
} as const satisfies Record<BotPermissionOptionDisplayKind, number>;

function getBotPermissionOptionDisplayKind(
  option: ZCodePermissionOption,
): BotPermissionOptionDisplayKind {
  const text = `${option.optionId} ${option.kind} ${option.name}`.toLowerCase();
  const isAlways =
    /\b(always|persistent|permanent|remember)\b/u.test(text) ||
    /始终|永久|记住|不再询问/u.test(text);
  const isAllow = /\b(allow|approve|accept|yes)\b/u.test(text) || /允许|同意|批准/u.test(text);
  const isReject = /\b(deny|reject|decline|no)\b/u.test(text) || /拒绝|不允许|否/u.test(text);
  if (isAllow) {
    return isAlways ? "allowAlways" : "allowOnce";
  }
  if (isReject) {
    return isAlways ? "rejectAlways" : "rejectOnce";
  }
  return "custom";
}

function sortBotPermissionOptions(
  options: readonly ZCodePermissionOption[],
): ZCodePermissionOption[] {
  return [...options].sort((left, right) => {
    const leftPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(left)];
    const rightPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(right)];
    return leftPriority - rightPriority;
  });
}

function formatBotPermissionOptionLabel(option: ZCodePermissionOption, locale?: Locale): string {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (locale === "en-US") {
    switch (displayKind) {
      case "allowOnce":
        return "Allow";
      case "allowAlways":
        return "Always Allow";
      case "rejectOnce":
        return "Deny";
      case "rejectAlways":
        return "Always Deny";
      case "custom":
        return option.name;
    }
  }
  switch (displayKind) {
    case "allowOnce":
      return "允许";
    case "allowAlways":
      return "始终允许";
    case "rejectOnce":
      return "拒绝";
    case "rejectAlways":
      return "始终拒绝";
    case "custom":
      return option.name;
  }
}

function formatBotPermissionOptionDescription(
  option: ZCodePermissionOption,
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  locale?: Locale,
): string | undefined {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (displayKind === "custom") {
    return option.kind;
  }
  const scope = getPermissionRequestPreview(request).scope;
  if (locale === "en-US") {
    if (displayKind === "allowOnce") {
      return "Allow this time only";
    }
    if (displayKind === "rejectOnce") {
      return "Reject this time";
    }
    if (displayKind === "allowAlways") {
      return scope === "command"
        ? "Do not ask again for the same command"
        : scope === "file"
          ? "Do not ask again for the same file operation"
          : "Do not ask again for the same permission request";
    }
    return scope === "command"
      ? "Always reject the same command"
      : scope === "file"
        ? "Always reject the same file operation"
        : "Always reject the same permission request";
  }
  if (displayKind === "allowOnce") {
    return "仅允许这一次";
  }
  if (displayKind === "rejectOnce") {
    return "这次先拒绝";
  }
  if (displayKind === "allowAlways") {
    return scope === "command"
      ? "后续相同命令不再询问"
      : scope === "file"
        ? "后续相同文件操作不再询问"
        : "后续相同权限请求不再询问";
  }
  return scope === "command"
    ? "后续相同命令也会直接拒绝"
    : scope === "file"
      ? "后续相同文件操作也会直接拒绝"
      : "后续相同权限请求也会直接拒绝";
}

function isBotPermissionRejectOption(option: ZCodePermissionOption): boolean {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  return displayKind === "rejectOnce" || displayKind === "rejectAlways";
}

function stripModelProviderDescriptionsForTextSelection(
  selection: SelectionPrompt,
): SelectionPrompt {
  if (selection.action !== "model.provider.set") {
    return selection;
  }
  return {
    ...selection,
    options: selection.options.map((option) => ({
      ...option,
      description: undefined,
    })),
  };
}

function formatWorkspaceOptionLabel(workspace: BotWorkspaceRef, locale?: Locale): string {
  if (!workspace.workspaceIdentity) {
    return workspace.label;
  }
  const remoteLabel = locale === "en-US" ? "[Remote]" : "[远端]";
  return `${workspace.label} ${remoteLabel}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_BOT_ZCODE_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
// Bot 模式硬锁 yolo：所有 bot task 一律免交互权限，且禁止通过 /mode 切换运行模式。
const BOT_FORCED_MODE = "yolo";
const BOT_TYPING_INTERVAL_MS = 4_000;
const BOT_TASK_META_RETRY_DELAYS_MS = [80, 160, 320] as const;
const BOT_WORKSPACE_REFS_CACHE_TTL_MS = 5_000;
const BOT_MAX_ATTACHMENTS_PER_MESSAGE = 4;
const BOT_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
// Alpha 6（§5.3）：附件缓存惰性修剪——无 daemon、无 timer；24h 内存门内最多一趟，
// 每趟删 mtime > 7 天的缓存文件并移除清空的目录。
const BOT_ATTACHMENT_CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOT_ATTACHMENT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
// Phase C Alpha 2（specs/bot-file-delivery.md Phase C §1）：远端文件分块读取的时限与预算。
const BOT_REMOTE_FILE_CHUNK_DEADLINE_MS = 20_000;
const BOT_REMOTE_FILE_FETCH_BUDGET_MS = 120_000;
const REMOTE_RECONNECT_DEDUPE_TTL_MS = 3_000;
const REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
const BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
const BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS = 5 * 60_000;
const BOT_ELICITATION_CUSTOM_OPTION_ID = "__custom__";
const BOT_ELICITATION_SUBMIT_OPTION_ID = "__submit__";
const BOT_ELICITATION_SKIP_OPTION_ID = "__skip__";
const BOT_ELICITATION_FORM_VALUE_PREFIX = "__form__:";
// F2（specs/bot-message-delivery.md）：单次 flush 的重试预算——每个失败分块至多 2 次尝试，
// 期间只做一次 ~1s 退避；预算按构造有界，毒丸消息不可能拖住串行事件队列。
const BOT_REPLY_FLUSH_MAX_ATTEMPTS = 2;
const BOT_REPLY_FLUSH_RETRY_BACKOFF_MS = 1_000;
// M1（specs/bot-message-delivery.md 3.14.5-alpha.4 Retention buffer）：per-peer 保留缓冲的
// 字节 cap（utf8 字节口径——回复缓冲是 UTF-16 字符，必须换算），尾部保留 + 头部截断标记。
const BOT_RETAINED_BUFFER_MAX_BYTES = 64 * 1024;

/** M1 发送失败两分类（specs/bot-message-delivery.md F2.3 修订）。 */
type BotSendFailureClass = "channel-dead" | "content-poison";

/**
 * Bugfix（M1，specs/bot-message-delivery.md 3.14.5-alpha.4 Retention buffer）：发送失败
 * 按类别决定语义——channel-dead 保留待 revival 补发，content-poison 维持 alpha.1
 * drop-with-notice。判别源（测试可构造）：
 * - channel-dead：打标 weixinRet=-2（会话死与瞬态 -2 客户端不可分，一律按死通道）；或网络类——
 *   打标 weixinHttpStatus>=500、AbortError/TimeoutError/ETIMEDOUT 错误名、HTTP 5xx 状态形状
 *   或 timed out / fetch failed 网络形状的错误文本（telegram/feishu 适配器现状即文本形态）。
 * - content-poison：其余（4xx、非 -2 协议码、业务拒绝等）。
 */
function classifyBotSendFailure(error: unknown): BotSendFailureClass {
  if (error !== null && typeof error === "object") {
    const tagged = error as { weixinRet?: unknown; weixinHttpStatus?: unknown; name?: unknown };
    if (tagged.weixinRet === -2) {
      return "channel-dead";
    }
    if (typeof tagged.weixinHttpStatus === "number" && tagged.weixinHttpStatus >= 500) {
      return "channel-dead";
    }
    const name = typeof tagged.name === "string" ? tagged.name : "";
    if (name === "AbortError" || name === "TimeoutError" || name === "ETIMEDOUT") {
      return "channel-dead";
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/HTTP\s+5\d\d/u.test(message)) {
    return "channel-dead";
  }
  if (/\bETIMEDOUT\b/u.test(message) || /timed out|fetch failed/iu.test(message)) {
    return "channel-dead";
  }
  return "content-poison";
}

/** F1（specs/bot-message-delivery.md）：watcher drain 的四个法定来源，写入观测日志。 */
type BotTaskWatcherDisposeReason = "terminal" | "stop" | "stale" | "dispose";

const OUTBOUND_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  // §5.7（specs/bot-file-delivery.md Alpha 7）：heic/heif/tiff/avif 按图片（内联）发送，
  // 不再落成"文件"气泡；与 weixinProvider 入站推断 regex 双侧扩容。tiff/avif 的微信
  // 内联渲染未在 rig 验证——渲染坏则按 spec 回落条款回 file（rig B3）。
  ".heic",
  ".heif",
  ".tiff",
  ".avif",
]);
const OUTBOUND_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const OUTBOUND_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export function inferOutboundAttachmentKind(filename: string): BotOutboundAttachment["kind"] {
  const extension = extname(filename).toLowerCase();
  if (OUTBOUND_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (OUTBOUND_VIDEO_EXTENSIONS.has(extension)) return "video";
  return "file";
}

export function inferOutboundAttachmentMime(
  filename: string,
  kind: BotOutboundAttachment["kind"],
): string {
  return (
    OUTBOUND_MIME_BY_EXTENSION[extname(filename).toLowerCase()] ??
    (kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : "application/octet-stream")
  );
}

/**
 * /file 路径策略（specs/bot-file-delivery.md §2）：只允许当前 workspace 目录树内的普通文件。
 * 通过 realpath 归一化两侧路径后再做前缀判断，相对路径按 workspace 根解析。
 * 供测试与命令处理共用；调用方负责大小上限与渠道能力检查。
 */
export async function resolveWorkspaceFilePath(
  workspacePath: string,
  requestedPath: string,
): Promise<
  | { ok: true; absolutePath: string; sizeBytes: number }
  | { ok: false; reason: "outside" | "missing" }
> {
  const candidate = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(workspacePath, requestedPath);
  // 词法预检：先把明显的 “..”/绝对路径逃逸挡掉（即使目标不存在也按 outside 拒绝，语义确定）。
  const normalizedRoot = resolve(workspacePath);
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + sep)) {
    return { ok: false, reason: "outside" };
  }
  try {
    // realpath 二次校验：拦截词法上在树内、实际指向树外的符号链接。
    const [root, target] = await Promise.all([realpath(workspacePath), realpath(candidate)]);
    if (target !== root && !target.startsWith(root + sep)) {
      return { ok: false, reason: "outside" };
    }
    const stats = await stat(target);
    if (!stats.isFile()) {
      return { ok: false, reason: "missing" };
    }
    return { ok: true, absolutePath: target, sizeBytes: stats.size };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

const WEIXIN_CONTEXT_TOKEN_MAX_PEERS = 20;

/**
 * 合并并裁剪每个 bot 的 peer → context_token 表（specs/bot-file-delivery.md §6）。
 * 只保留最近活跃的 N 个 peer，防止长期运行下状态文件无界膨胀。
 */
export function mergeWeixinContextTokens(
  existing: BotContextState["weixinContextTokens"],
  peerKey: string,
  token: string,
  updatedAt: number,
  maxPeers = WEIXIN_CONTEXT_TOKEN_MAX_PEERS,
): NonNullable<BotContextState["weixinContextTokens"]> {
  const merged: NonNullable<BotContextState["weixinContextTokens"]> = {
    ...existing,
    [peerKey]: { token, updatedAt },
  };
  return Object.fromEntries(
    Object.entries(merged)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, maxPeers),
  );
}

// ---- Phase B：对话式 share_file 投递（specs/bot-file-delivery.md）----

/** taskDeliveryRegistry 条目：收件人只从对话式入站消息捕获，绝不来自协议参数。 */
export interface BotTaskDeliveryEntry {
  botId: string;
  actor: BotActor;
  workspacePath: string;
  workspaceIdentity?: string;
}

const BOT_TASK_DELIVERY_REGISTRY_MAX = 200;

export interface BotTaskDeliveryRegistry {
  get(taskId: string): BotTaskDeliveryEntry | undefined;
  /** 记录/刷新条目；重写时更新插入顺序，保证按最旧淘汰。 */
  remember(taskId: string, entry: BotTaskDeliveryEntry): void;
  forget(taskId: string): void;
  clear(): void;
  readonly size: number;
}

/**
 * taskId → 投递目标的内存注册表（specs/bot-file-delivery.md Phase B §2）。
 * 只在对话式 watchTaskStream 调用点写入；有界（200，淘汰最旧）防止长运行内存增长。
 * 独立导出为纯数据结构，便于单测淘汰与清理语义；服务内部持有唯一实例。
 */
export function createBotTaskDeliveryRegistry(): BotTaskDeliveryRegistry {
  const entries = new Map<string, BotTaskDeliveryEntry>();
  return {
    get: (taskId) => entries.get(taskId),
    remember(taskId, entry) {
      entries.delete(taskId);
      entries.set(taskId, entry);
      while (entries.size > BOT_TASK_DELIVERY_REGISTRY_MAX) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
    },
    forget: (taskId) => {
      entries.delete(taskId);
    },
    clear: () => {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

export interface BotShareFileQuotaTracker {
  allows(botId: string, peerKey: string, now: number): boolean;
  record(botId: string, peerKey: string, now: number): void;
  /**
   * 原子预留：同步完成「窗口判定 + 占位」。share_file 工具是 concurrentSafe，调度器会
   * 并行执行多个调用；若沿用 allows() 判定 + 事后 record()，并行调用会在彼此落账前
   * 全部通过判定（TOCTOU），绕过窗口上限。预留必须在任何 IO 之前发生。
   */
  reserve(botId: string, peerKey: string, now: number): boolean;
  /** 释放一个具体预留时间戳：投递失败时归还占位，保持「只有成功投递消耗配额」的可观测语义。 */
  release(botId: string, peerKey: string, at: number): void;
}

/** tool 来源配额：滚动窗口 10 分钟 3 次 AND 1 小时 20 次（specs Phase B §4）。 */
const BOT_SHARE_FILE_QUOTA_WINDOWS = [
  { limit: 3, windowMs: 10 * 60_000 },
  { limit: 20, windowMs: 60 * 60_000 },
] as const;

/**
 * share_file（source "tool"）滚动配额。纯内存、不落盘：持久化会与入站 token 合并的
 * writeContext 产生回写竞争（specs Phase B 不变量）。时间由调用方注入便于测试。
 * 说明：10 分钟窗口先命中时 1 小时窗口数学上不可达（≤18 次/小时），保留双窗口是
 * 防御纵深——未来任一窗口调整时另一窗口仍是硬上限。
 */
export function createBotShareFileQuotaTracker(): BotShareFileQuotaTracker {
  const deliveriesByKey = new Map<string, number[]>();
  const buildKey = (botId: string, peerKey: string): string => `${botId}::${peerKey}`;
  const longestWindowMs =
    BOT_SHARE_FILE_QUOTA_WINDOWS[BOT_SHARE_FILE_QUOTA_WINDOWS.length - 1]!.windowMs;
  const allows = (botId: string, peerKey: string, now: number): boolean => {
    const timestamps = deliveriesByKey.get(buildKey(botId, peerKey));
    if (!timestamps) return true;
    for (const { limit, windowMs } of BOT_SHARE_FILE_QUOTA_WINDOWS) {
      if (timestamps.filter((at) => now - at < windowMs).length >= limit) {
        return false;
      }
    }
    return true;
  };
  const record = (botId: string, peerKey: string, now: number): void => {
    const key = buildKey(botId, peerKey);
    const timestamps = [...(deliveriesByKey.get(key) ?? []), now].filter(
      (at) => now - at < longestWindowMs,
    );
    deliveriesByKey.set(key, timestamps);
  };
  return {
    allows,
    record,
    // Review 修复（并行 share_file TOCTOU）：share_file 是 concurrentSafe 工具，调度器
    // 并行执行多个调用；原实现 allows() 判定在 IO 之前、record() 落账在投递完成之后，
    // 并发调用在彼此落账前全部通过判定，可无限绕过窗口上限。reserve() 同步完成
    // 判定 + 占位（JS 单线程内不可分割），每个在途调用各占一个槽位。
    reserve(botId, peerKey, now) {
      if (!allows(botId, peerKey, now)) return false;
      record(botId, peerKey, now);
      return true;
    },
    release(botId, peerKey, at) {
      const key = buildKey(botId, peerKey);
      const timestamps = deliveriesByKey.get(key);
      if (!timestamps) return;
      const index = timestamps.indexOf(at);
      if (index >= 0) {
        timestamps.splice(index, 1);
      }
      if (timestamps.length === 0) {
        deliveriesByKey.delete(key);
      }
    },
  };
}

/**
 * deliverWorkspaceFile 的判别结果：成功携带 filename/sizeBytes；失败携带协议 failure
 * reason（detail 供 /file 侧还原既有本地化文案，如体积或错误信息）。
 */
export type DeliverWorkspaceFileResult =
  | { ok: true; filename: string; sizeBytes: number }
  | { ok: false; reason: BotShareFileFailureReason; detail?: string };

/**
 * 读取侧二次校验（symlink-swap TOCTOU 防护）：resolveWorkspaceFilePath 完成词法 + realpath
 * 校验后、真正读取前，路径上的符号链接可能被替换为指向 workspace 外（或文件增长超限）。
 * 因此发送前必须重新 realpath 并确认真实路径仍在 workspace 内、大小仍在 5MB 内；
 * 不能只复用首次 stat 的大小结果。
 */
export async function revalidateWorkspaceFileForDelivery(
  workspacePath: string,
  absolutePath: string,
): Promise<
  | { ok: true; absolutePath: string; sizeBytes: number }
  | { ok: false; reason: "outside-workspace" | "not-found"; sizeBytes?: undefined }
  | { ok: false; reason: "too-large"; sizeBytes: number }
> {
  try {
    const [root, target] = await Promise.all([realpath(workspacePath), realpath(absolutePath)]);
    if (target !== root && !target.startsWith(root + sep)) {
      return { ok: false, reason: "outside-workspace" };
    }
    const stats = await stat(target);
    if (!stats.isFile()) {
      return { ok: false, reason: "not-found" };
    }
    if (stats.size > BOT_MAX_ATTACHMENT_SIZE_BYTES) {
      return { ok: false, reason: "too-large", sizeBytes: stats.size };
    }
    return { ok: true, absolutePath: target, sizeBytes: stats.size };
  } catch {
    return { ok: false, reason: "not-found" };
  }
}

/** §5.6（specs/bot-file-delivery.md「Outbound attachment naming & inline kinds (3.14.5
 *  Alpha 7)」）：文件名消毒统一走 packages/shared 的共享字节预算 helper——Unicode 基名
 *  保留（不再按字符 slice(0,120)——125 个 CJK 字符 = 360 字节曾击穿文件系统单段上限并
 *  丢失扩展名）、扩展名在预算内保留、Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9
 *  含带扩展形态）中和。本站点预算 120 字节 = 旧字符口径的字节等价（Windows MAX_PATH
 *  深路径余量）；入站缓存的 `<digest>-` 前缀由调用方拼在预算段之外（spec：前缀不承担
 *  保留名中和）。ASCII 预算内名字输出逐字节不变（零漂移）。 */
function sanitizeAttachmentFilename(filename: string): string {
  return sanitizeByteBudgetedFilename(filename, { byteBudget: 120 });
}

/** 纯格式化工具：字节数 → 人类可读大小（未知/非正值 → unknown size）。 */
function formatAttachmentSize(sizeBytes: number | undefined): string {
  if (!sizeBytes || sizeBytes <= 0) {
    return "unknown size";
  }
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.ceil(sizeBytes / 1024)}KB`;
  }
  return `${sizeBytes}B`;
}

/**
 * 远端分块读取的 deadline 包装（Phase C Alpha 2）：超时 reject。底层 promise 判负后
 * 迟到的 reject 由调用方预先挂 no-op catch 吸收，不会变成 unhandledRejection。
 */
function withDeadlineMs<T>(
  promise: Promise<T>,
  deadlineMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), deadlineMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Phase C Alpha 2（specs/bot-file-delivery.md Phase C §1/§5）：远程文件取回 + 临时物料化。
 * 只被 deliverWorkspaceFile 调用（adapter 门槛已过；tool 来源的 quota 已由
 * shareFileForTask 在进入前原子预留）。失败 reason 与 wire 协议 1:1：
 * - reader typed 拒绝透传 outside-workspace / not-found / too-large；
 * - bridge 缺席、getWorkspaceFileReader 返回 null 或 throw、读取 throw、
 *   单块 deadline / 总预算超限 → remote-unavailable（unavailable 同映射）。
 * 不做任何自动重连（specs §6：delivery 内绝不调用 ensureConnected）。
 */
function fetchRemoteWorkspaceFileForDelivery(
  deps: Pick<BotsServiceDeps, "remoteWorkspaceService" | "remoteFileDeliveryTimeouts">,
  context: { workspacePath: string; workspaceIdentity: string },
  requestedPath: string,
): Promise<
  | { ok: true; filename: string; sizeBytes: number; tempFilePath: string; tempDir: string }
  | { ok: false; reason: BotShareFileFailureReason; sizeBytes?: number; detail?: string }
> {
  const chunkDeadlineMs =
    deps.remoteFileDeliveryTimeouts?.chunkDeadlineMs ?? BOT_REMOTE_FILE_CHUNK_DEADLINE_MS;
  const totalBudgetMs =
    deps.remoteFileDeliveryTimeouts?.totalBudgetMs ?? BOT_REMOTE_FILE_FETCH_BUDGET_MS;
  const unavailable = (
    detail: string,
  ): { ok: false; reason: "remote-unavailable"; detail: string } => ({
    ok: false,
    reason: "remote-unavailable",
    detail,
  });
  return (async () => {
    let reader: IBotWorkspaceFileService | null = null;
    if (deps.remoteWorkspaceService?.getWorkspaceFileReader) {
      try {
        reader = await deps.remoteWorkspaceService.getWorkspaceFileReader({
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        });
      } catch (error) {
        return unavailable(
          `remote reader init failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!reader) {
      return unavailable("remote workspace file reader unavailable");
    }
    const chunks: Buffer[] = [];
    let filename = "";
    let sizeBytes = 0;
    let offset = 0;
    let totalBytes = 0;
    const fetchStartedAt = Date.now();
    // 分块读取：单块 deadline + 总预算双限时；远端每块回传的整文件大小（读取时刻 stat）
    // 与本地累积字节数都受 5MB 硬上限约束——分块间文件增长同样在读取侧被拒（specs §1）。
    for (;;) {
      const remainingBudgetMs = totalBudgetMs - (Date.now() - fetchStartedAt);
      if (remainingBudgetMs <= 0) {
        return unavailable(`remote file fetch exceeded total budget ${totalBudgetMs}ms`);
      }
      const deadlineMs = Math.min(chunkDeadlineMs, remainingBudgetMs);
      const readPromise = reader.readWorkspaceFile({
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        relativePath: requestedPath,
        offset,
        limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
      });
      readPromise.catch(() => undefined);
      let result: V4BotWorkspaceFileReadResult;
      try {
        result = await withDeadlineMs(
          readPromise,
          deadlineMs,
          `remote file chunk read timed out after ${deadlineMs}ms`,
        );
      } catch (error) {
        return unavailable(error instanceof Error ? error.message : String(error));
      }
      if (!result.ok) {
        if (result.reason === "unavailable") {
          return unavailable(result.detail ?? "remote workspace file read unavailable");
        }
        // 远端文件系统所有者给出的 typed 拒绝按协议 1:1 透传，本机不重判远程路径。
        // too-large 无 detail 时补上 5MB 上限（/file 本地化文案需要 {size} 占位）。
        return {
          ok: false,
          reason: result.reason,
          detail:
            result.reason === "too-large"
              ? (result.detail ?? formatAttachmentSize(BOT_MAX_ATTACHMENT_SIZE_BYTES))
              : result.detail,
        };
      }
      if (result.sizeBytes > BOT_MAX_ATTACHMENT_SIZE_BYTES) {
        return {
          ok: false,
          reason: "too-large",
          sizeBytes: result.sizeBytes,
          detail: formatAttachmentSize(result.sizeBytes),
        };
      }
      const data = Buffer.from(result.dataBase64, "base64");
      if (chunks.length === 0) {
        filename = result.filename;
      }
      sizeBytes = result.sizeBytes;
      offset += data.byteLength;
      totalBytes += data.byteLength;
      chunks.push(data);
      if (totalBytes > BOT_MAX_ATTACHMENT_SIZE_BYTES) {
        return {
          ok: false,
          reason: "too-large",
          sizeBytes: totalBytes,
          detail: formatAttachmentSize(totalBytes),
        };
      }
      if (result.eof) {
        break;
      }
      if (data.byteLength === 0) {
        // 非 eof 空分块会让 offset 原地踏步读同一位置：这是远端协议违约，按不可用失败，不能死循环。
        return unavailable("remote reader returned an empty non-eof chunk");
      }
    }
    // 物料化（specs §5）：OS tmpdir 下的随机目录（系统可清理），绝不落在 workspace 或
    // ~/.zcode 内；0600 仅 POSIX 强制（Windows 忽略 mode），临时文件在 workspace 之外、
    // 对 /file 不可再见（与入站缓存排除规则同款 parity）。
    const safeFilename = sanitizeAttachmentFilename(filename);
    const tempDir = join(tmpdir(), "zcode-bot-outbound", randomBytes(16).toString("hex"));
    const tempFilePath = join(tempDir, safeFilename);
    try {
      // Review 修复：目录本身也收紧为 0700（recursive mkdir 的默认 0755 会暴露文件名列表；
      // 文件内容仍由 0600 保护）。0700/0600 仅 POSIX 强制，Windows 忽略 mode。
      await mkdir(tempDir, { recursive: true, mode: 0o700 });
      await writeFile(tempFilePath, Buffer.concat(chunks, totalBytes), { mode: 0o600 });
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      return unavailable(
        `temp materialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ok: true, filename: safeFilename, sizeBytes, tempFilePath, tempDir };
  })();
}

export function createBotsService(
  deps: BotsServiceDeps,
): IBotsService & { disposeAll(): void; disposeAllAndWait(): Promise<void> } {
  const runStartupBackgroundTasks = deps.runStartupBackgroundTasks !== false;
  // Alpha 6（§5.3）：附件缓存修剪的 24h 内存门——per-service（每个服务实例生命期内
  // 首次触发即开门），无 timer/daemon。
  let lastAttachmentCachePruneAtMs = 0;
  const repo = new BotsRepo();
  const bindCodes = new Map<string, BindCodeRecord>();
  const automationDeliveryWarningAtByKey = new Map<string, number>();
  const streamSubscriptions = new Map<string, IDisposable>();
  // F1（specs/bot-message-delivery.md）：watcher 的唯一 drain 注册表——键与 streamSubscriptions
  // 相同（workspace::task）。disposeTaskWatcher 由此取 drain 闭包：force-flush 未送出正文 →
  // 队列外停 typing → 清 live 进度 → 拆订阅。写入只发生在 watchTaskStream，删除只发生在
  // disposeTaskWatcher（terminal/stop/stale/dispose 四个法定调用点）。
  const taskWatcherDisposals = new Map<
    string,
    { dispose(reason: BotTaskWatcherDisposeReason): Promise<void> }
  >();
  const streamingCardRequestControllers = new Set<AbortController>();
  const transientInteractionCards = new Map<
    string,
    {
      bot: BotConfig;
      taskId: string;
      handle: BotTransientInteractionCardHandle;
    }
  >();
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingTargets = new Map<string, { bot: BotConfig; target: BotTypingTarget }>();
  const runningTasks = new Set<string>();
  const liveStatusProgressByTaskId = new Map<
    string,
    { kind: "message" | "thought" | "tool"; text: string }
  >();
  const runtimeByBotId = new Map<string, BotRuntimeInfo>();
  const pendingSelectionsByContext = new Map<string, SelectionPrompt>();
  // 只读取任务订阅和运行状态的数量，不暴露消息内容。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("bots", () => ({
    streamSubs: streamSubscriptions.size,
    runningTasks: runningTasks.size,
    typingIntervals: typingIntervals.size,
    liveStatusProgress: liveStatusProgressByTaskId.size,
  }));
  const pendingTaskSelectionsByContext = new Map<string, Map<string, BotTaskSelectionEntry>>();
  const pendingWorkspaceSelectionsByContext = new Map<
    string,
    Map<string, BotWorkspaceSelectionEntry>
  >();
  const pendingRemoteReconnectsByKey = new Map<string, Promise<BotOutboundMessage[]>>();
  const recentRemoteReconnectAtByKey = new Map<string, number>();
  const recentRemoteReconnectDeliveryAtByKey = new Map<string, number>();
  const recentInboundDeliveryAtByKey = new Map<string, number>();
  const inboundProcessingQueuesByContext = new Map<string, Promise<void>>();
  // M1（specs/bot-message-delivery.md 3.14.5-alpha.4 Retention buffer）：per-peer 保留缓冲
  // （键 `${botId}::${peerKey}`，peerKey 派生与 persistWeixinContextToken 一致：chatId 优先）。
  // service 级持有——watcher dispose 后仍存活，直到补发送达或按 content-poison 丢弃。
  // 所有变更/投递经 retainedReplyBufferQueues 的 per-peer promise chain 串行化
  // （三个异步触点：streamEventQueue flush、入站队列 revival、队列外 drain）。
  const retainedReplyBuffers = new Map<string, string[]>();
  const retainedReplyBufferQueues = new Map<string, Promise<void>>();
  // alpha.5 观测（specs/log-diagnostics-hygiene.md Amendment 3.14.5-alpha.5）：weixin per-peer
  // 出站观测状态（burstOrdinal 波次序号 + sendCount10s 时间戳环 + lastReadTokenFp 波上下文
  // token 指纹）。service 级惰性内存状态，与 retainedReplyBuffers 同生命周期模式；仅日志
  // 用途（零行为变化），求值时惰性裁剪、无 timer。
  const weixinSendObservationByPeer = new Map<
    string,
    { burstOrdinal: number; sendTimestamps: number[]; lastReadTokenFp: string | undefined }
  >();
  // alpha.7 §5.12a（specs/log-diagnostics-hygiene.md Amendment 3.14.5-alpha.7）：死窗
  //（channel-dead）失败行限频状态——per (botId, peerKey) 惰性时间戳 + 自上一条发射线
  // 以来合并的条数。owner rig 实测断线窗内任务仍输出时 `bot outbound send … failed`
  // 每分钟约 82 行、持续数小时，淹没有用信号。仅日志密度变化（零行为变化）：窗口内
  // 第一条失败线照常输出，30s 内后续合并计数不发射；下一条件（到期新线/汇总行）携带
  // suppressed=。无 timer（先例：weixin typing warn 30s、zcodeTaskIndexSyncer 60s）。
  // content-poison 失败线永不限频，逐条保全。
  const deadWindowFailureLogStates = new Map<
    string,
    { lastEmitAtMs: number; suppressedSinceLastEmit: number }
  >();
  let botStorageMigrationPromise: Promise<void> | null = null;
  const cachedWorkspaceRefsByKey = new Map<
    string,
    { expiresAt: number; value: BotWorkspaceRef[] }
  >();
  let cachedLocale: Locale | undefined;
  // F1：本服务实例内唯一 requester；所有 provider/通道出站都从这里走，
  // 保证注入的 providerFetch（如代理 transport）覆盖轮询、发送、上传、下载与 webhook。
  const providerRequester: BotProviderRequester = createBotProviderRequester(deps.providerFetch);
  const providers: Record<BotProvider, BotProviderAdapter | null> = {
    telegram: createTelegramBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
      requester: providerRequester,
    }),
    webhook: createWebhookBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
      requester: providerRequester,
    }),
    feishu: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
      requester: providerRequester,
    }),
    lark: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
      requester: providerRequester,
    }),
    weixin: createWeixinBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
      requester: providerRequester,
    }),
    discord: null,
    wecom: null,
    // 测试注入的 adapter 覆盖（如监听 sendAttachment）；生产装配不传该参数。
    ...deps.providerOverrides,
  };
  // Phase B：taskId → 对话式投递目标注册表 + tool 来源滚动配额（均为纯内存，Host 侧唯一属主）。
  const taskDeliveryRegistry = deps.taskDeliveryRegistry ?? createBotTaskDeliveryRegistry();
  const shareFileQuota = createBotShareFileQuotaTracker();
  let service: IBotsService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  };
  let shutdownPromise: Promise<void> | null = null;

  function onDeliveryResult(bot: BotConfig, deliveryError: string | undefined): void {
    // 收消息正常不代表回复已投递，不能把投递错误混成连接错误。
    const current = runtimeByBotId.get(bot.id);
    setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: current?.status ?? (bot.enabled ? "idle" : "disabled"),
      deliveryError,
    });
  }

  function setRuntimeStatus(status: BotRuntimeInfo): void {
    const previous = runtimeByBotId.get(status.botId);
    if (status.status === "error" && previous?.status !== "error") {
      // Bugfix（事故 2026-10-01）：轮询错误此前只写进内存状态映射，服务日志完全看不到
      // runtime 进入错误态。telegram/weixin/feishu 三条链路都在这里单点记录“进入 error”
      // 的转换（已在 error 中不重复刷屏）；message 是 provider 错误串，不含凭据。
      botsLogger.warn(
        undefined,
        `bot runtime entered error state bot=${status.botId} provider=${status.provider}: ${status.message ?? status.messageId ?? "unknown error"}`,
      );
    }
    runtimeByBotId.set(status.botId, {
      ...previous,
      ...status,
      lastUpdateAt: Date.now(),
    });
  }

  const statusSink = {
    getRuntimeStatus(botId: string) {
      return runtimeByBotId.get(botId);
    },
    setRuntimeStatus,
  };
  const telegramRuntime = createTelegramChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    telegramProvider: providers.telegram,
    requester: providerRequester,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readTelegramOffset,
    writeTelegramOffset,
    processProviderCallback,
  });
  const weixinRuntime = createWeixinChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    requester: providerRequester,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readWeixinGetUpdatesBuf,
    writeWeixinGetUpdatesBuf,
    processProviderCallback,
  });
  const feishuRuntime = createFeishuChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    requester: providerRequester,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    summarizeCallbackPayload,
    processProviderCallback,
  });

  async function readTelegramOffset(botId: string): Promise<number | undefined> {
    return (await repo.readState()).bots[botId]?.telegramOffset;
  }

  async function writeTelegramOffset(botId: string, offset: number): Promise<void> {
    const state = await repo.readState();
    const existing = state.bots[botId];
    if (existing) {
      state.bots[botId] = {
        ...existing,
        telegramOffset: offset,
        updatedAt: Date.now(),
      };
    } else {
      const bot = findBot(await repo.readConfig(), botId);
      const workspace = bot ? firstAllowedWorkspace(await listWorkspaceRefs(), bot) : null;
      // F4：游标必须无条件落盘。此前 bot 存在但没有任何可解析 workspace 时这里直接跳过写入，
      // 外部队列确认点丢失导致同一批 update 无限重投；现在降级为“仅游标”entry（见哨兵注释）。
      state.bots[botId] = workspace
        ? {
            botId,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            workspaceId: workspace.id,
            mode: "draft",
            activeTaskId: null,
            telegramOffset: offset,
            updatedAt: Date.now(),
          }
        : createCursorOnlyBotState(botId, { telegramOffset: offset });
    }
    await repo.writeState(state);
  }

  async function readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined> {
    return (await repo.readState()).bots[botId]?.weixinGetUpdatesBuf;
  }

  async function writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void> {
    const state = await repo.readState();
    const existing = state.bots[botId];
    if (existing) {
      state.bots[botId] = {
        ...existing,
        weixinGetUpdatesBuf: buf,
        updatedAt: Date.now(),
      };
    } else {
      const bot = findBot(await repo.readConfig(), botId);
      const workspace = bot ? firstAllowedWorkspace(await listWorkspaceRefs(), bot) : null;
      // F4：同 writeTelegramOffset——微信服务端游标（get_updates_buf）必须无条件落盘，
      // 否则游标回退会让同一批消息重新进入业务处理（重复回复/重复 AskUserQuestion）。
      state.bots[botId] = workspace
        ? {
            botId,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            workspaceId: workspace.id,
            mode: "draft",
            activeTaskId: null,
            weixinGetUpdatesBuf: buf,
            updatedAt: Date.now(),
          }
        : createCursorOnlyBotState(botId, { weixinGetUpdatesBuf: buf });
    }
    await repo.writeState(state);
  }

  async function readContext(_actor: BotActor, bot: BotConfig): Promise<BotContextState | null> {
    await ensureBotStorageMigrated();
    const state = await repo.readState();
    const existing = state.bots[getContextKey(bot)];
    // F4：仅游标 entry 不构成可用 context——哨兵路径绝不能被当成任务 cwd（否则消息会被
    // 投递到不存在的目录）。视为“尚无 context”走下方新建分支；workspace 仍解析不出来时
    // 与修复前一致返回 null（消息回复 noWorkspaceAllowed），解析出来则升级为真实 context。
    const existingContext: BotState | undefined = isCursorOnlyBotState(existing)
      ? undefined
      : existing;
    if (existingContext) {
      const latestWorkspaces = await listWorkspaceRefs();
      const canonicalWorkspace = resolveCanonicalContextWorkspace(
        existingContext,
        latestWorkspaces,
      );
      if (!canonicalWorkspace) {
        return existingContext;
      }
      const currentWorkspaceKey = getWorkspaceKey(
        existingContext.workspacePath,
        existingContext.workspaceIdentity,
      );
      const nextWorkspaceId =
        existingContext.workspaceId && existingContext.workspaceId !== currentWorkspaceKey
          ? existingContext.workspaceId
          : canonicalWorkspace.id;
      const nextContext: BotContextState = {
        ...existingContext,
        workspacePath: canonicalWorkspace.workspacePath,
        workspaceIdentity: canonicalWorkspace.workspaceIdentity,
        workspaceId: nextWorkspaceId,
      };
      if (
        nextContext.workspacePath === existingContext.workspacePath &&
        nextContext.workspaceIdentity === existingContext.workspaceIdentity &&
        nextContext.workspaceId === existingContext.workspaceId
      ) {
        return existingContext;
      }
      // Bugfix: 历史 Bot context 可能只有 workspacePath，没有持久化 remote workspaceIdentity。
      // 这样 createTask 虽然还能成功，但后续 bots:task 广播会因为 identity 不匹配被 UI 丢弃，
      // 最终表现成“第三方会话正常回复，侧栏任务列表却不刷新”。这里优先在服务层自愈旧 context。
      await writeContext(nextContext);
      return nextContext;
    }
    const workspace = firstAllowedWorkspace(await listWorkspaceRefs(), bot);
    if (!workspace) {
      return null;
    }
    return {
      botId: bot.id,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      workspaceId: workspace.id,
      mode: "draft",
      activeTaskId: null,
      draftOptions: await buildInitializedDraftOptions(workspace),
      // F4：从仅游标 entry 升级时带回外部队列确认点，避免首次 context 落盘又丢一批游标。
      ...pickPersistedBotCursors(existing),
      updatedAt: Date.now(),
    };
  }

  async function writeContext(context: BotContextState): Promise<void> {
    // Bugfix（M5，2026-10-03 §2d 事故）：watcher 闭包捕获的 context 可能是任务开始时代的
    // 旧快照——旧实现整条覆盖会把 weixinContextTokens / weixinGetUpdatesBuf /
    // telegramOffset / weixinActivatedAt 回滚到旧值（实测两次终态 dispose 后 token 表
    // updatedAt 倒退 2-3 分钟，游标回退还会引发重复投递）。
    // 3.14.5-alpha.4 收紧（M5 复活回归）：weixinContextTokens / weixinGetUpdatesBuf /
    // telegramOffset 三字段以持久化状态为唯一事实源——writeContext 一律写 existing 的当前值
    // （缺即保持缺），陈旧 context 不得复活已被 M2 ret=-2 失效或被游标写入方删除的 map/游标
    // （旧“仅有值才覆盖”的带回会在持久化项缺席时让 context 旧值复活）。weixinActivatedAt
    // 维持“有值保留、缺值用传入”：激活写入方 handleWeixinFirstActivation 恰在持久化项缺失时
    // 经 writeContext 落值。单一写入方（persistWeixinContextToken / M2 失效 / 游标写入 / 激活）
    // 本来就读改写最新状态，不受影响。
    const state = await repo.readState();
    const existing = state.bots[context.botId];
    state.bots[context.botId] = {
      ...context,
      weixinContextTokens: existing?.weixinContextTokens,
      weixinGetUpdatesBuf: existing?.weixinGetUpdatesBuf,
      telegramOffset: existing?.telegramOffset,
      ...(existing?.weixinActivatedAt !== undefined
        ? { weixinActivatedAt: existing.weixinActivatedAt }
        : {}),
      updatedAt: Date.now(),
    };
    await repo.writeState(state);
  }

  async function writeDraftContext(
    context: BotContextState,
    draftOptions?: BotDraftOptions,
  ): Promise<BotContextState> {
    // Bugfix: 新建草稿状态以前散落在 /new 和 /workspace 分支里，各自手写 activeTaskId=null。
    // workspace 切换后如果还带着旧 task/pending permission，Telegram 权限按钮会命中错误上下文。
    // 这里把“进入新任务草稿”的服务端状态变更收口到同一个 helper，避免跨 workspace 复用旧任务状态。
    const draftContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions,
      pendingPermissionOptions: undefined,
      pendingElicitation: undefined,
    };
    clearPendingSelectionsForBot(context.botId);
    await writeContext(draftContext);
    return draftContext;
  }

  async function handleWeixinFirstActivation(
    message: BotInboundMessage,
    command: BotCommand,
  ): Promise<BotOutboundMessage[] | null> {
    if (message.actor.provider !== "weixin" || command.type !== "message") {
      return null;
    }
    const state = await repo.readState();
    const existing = state.bots[message.botId];
    if (
      existing?.weixinActivatedAt ||
      existing?.draftOptions ||
      existing?.activeTaskId ||
      existing?.pendingPermissionOptions ||
      existing?.pendingElicitation
    ) {
      return null;
    }
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    if (auth.context.weixinActivatedAt) {
      return null;
    }
    // Bugfix: 微信扫码登录只返回 bot token/id，不返回可投递的用户 id。
    // 第一条微信入站消息用于建立会话目标，因此只回激活说明，不把“你好”这类激活文本误当成任务 prompt。
    await writeContext({
      ...auth.context,
      weixinActivatedAt: Date.now(),
    });
    return [
      createOutbound(
        message.actor,
        [msg(auth.locale, "weixinActivatedWelcome"), buildHelpText(auth.locale, auth.bot)].join(
          "\n\n",
        ),
      ),
    ];
  }

  async function readMessageLocale(): Promise<Locale | undefined> {
    const settings = await deps.settingService?.get().catch(() => null);
    cachedLocale = settings?.locale ?? cachedLocale;
    return cachedLocale;
  }

  function msg(
    locale: Locale | undefined,
    id: BotMessageId,
    values?: Record<string, string | number | undefined>,
  ): string {
    return formatBotMessage(locale, id, values);
  }

  function isSessionExpiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  function formatUserFacingBotError(error: unknown, locale: Locale | undefined): string {
    // Bugfix: 旧 bot 消息或脏 task index 会让协议层抛出 Session not found。
    // 直接把 session id 发给用户不可操作；这里保留日志原文，只引导用户新建任务恢复。
    if (isSessionExpiredError(error)) {
      return msg(locale, "sessionExpiredNewTaskHint");
    }
    return error instanceof Error ? error.message : String(error);
  }

  function formatAttachmentRejectedReason(error: unknown, locale: Locale | undefined): string {
    const message = error instanceof Error ? error.message : String(error);
    // Alpha 6（§5.2）：`/exceeds 5MB/i` 正则耦合随整条 throw 消亡——超限现在是
    // typed 逐文件结果（attachmentTooLargeSkipped 通知），不再经过本函数。
    if (
      /attachment download failed/i.test(message) ||
      /file download failed/i.test(message) ||
      /download .+ failed: HTTP/i.test(message) ||
      /file download timed out/i.test(message) ||
      /attachment download timed out/i.test(message) ||
      /download .+ timed out/i.test(message)
    ) {
      // Bugfix: provider 下载错误会包含 Feishu/Telegram/HTTP 等内部细节，直接回给用户既不友好也不可行动。
      return msg(locale, "attachmentDownloadUnavailable");
    }
    return message;
  }

  /** 微信出站媒体依赖新鲜 context_token；入站时持久化每个 peer 的最新 token（有界，最多 20 个 peer）。 */
  async function persistWeixinContextToken(message: BotInboundMessage): Promise<void> {
    if (message.actor.provider !== "weixin" || !message.actor.providerContextToken?.trim()) {
      return;
    }
    const peerKey = message.actor.chatId?.trim() || message.actor.providerUserId.trim();
    if (!peerKey) return;
    try {
      const state = await repo.readState();
      const existing = state.bots[message.botId];
      if (!existing) return;
      const previous = existing.weixinContextTokens?.[peerKey];
      if (previous?.token === message.actor.providerContextToken) return;
      state.bots[message.botId] = {
        ...existing,
        weixinContextTokens: mergeWeixinContextTokens(
          existing.weixinContextTokens,
          peerKey,
          message.actor.providerContextToken,
          Date.now(),
        ),
      };
      await repo.writeState(state);
      // alpha.5 观测（specs/bot-provider-network.md Amendment 3.14.5-alpha.5）：持久化成功
      // （token 值变化）时打独立 info 行携带指纹——-2 复发时判别「同指纹自愈」（入站后
      // 同一 token 立即可用）vs「轮换」（入站写入新 token）。token 值永不入日志（硬不变量）。
      botsLogger.info(
        undefined,
        `bot weixin context token persisted bot=${message.botId} peer=${peerKey} fp=${computeWeixinTokenFingerprint(message.actor.providerContextToken)}`,
      );
    } catch (error) {
      botsLogger.warn(
        undefined,
        `persist weixin context token failed bot=${message.botId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function readPersistedWeixinContextToken(
    botId: string,
    actor: BotActor,
  ): Promise<string | undefined> {
    const peerKey = actor.chatId?.trim() || actor.providerUserId.trim();
    return readPersistedWeixinPeerToken(botId, peerKey);
  }

  async function readPersistedWeixinPeerToken(
    botId: string,
    peerKey: string,
  ): Promise<string | undefined> {
    // Review NIT：与持久化写入侧的键派生对齐（chatId 优先 + trim 归一），
    // 避免空白差异导致读不到最新 token。派生自 entry 读取器，读/写两侧口径唯一。
    const entry = await readPersistedWeixinPeerTokenEntry(botId, peerKey);
    return entry?.token;
  }

  async function readPersistedWeixinPeerTokenEntry(
    botId: string,
    peerKey: string,
  ): Promise<{ token: string; updatedAt: number } | undefined> {
    // alpha.2 观测（specs/log-diagnostics-hygiene.md）：updatedAt 是该 peer token 的
    // 真实轮换时间（写入侧仅在 token 变化时更新），sendOutbound 用它计算 tokenAgeMs——
    // 探针测 TTL 的数据源。只读，不改任何发送语义。
    const normalizedPeerKey = peerKey.trim();
    if (!normalizedPeerKey) return undefined;
    const state = await repo.readState().catch(() => null);
    return state?.bots[botId]?.weixinContextTokens?.[normalizedPeerKey];
  }

  /**
   * Bugfix（M2，specs/bot-provider-network.md 3.14.5-alpha.4 实测块）：ret=-2 即失效凭据——
   * 发送失败边界无条件删除持久化 peer token 条目，停止对死 API 的 double-hammer（tokenless
   * 重试死态 0/131 永不成功）。瞬时 -2 与会话死 -2 客户端不可分（实测），短暂丢失有效 token
   * 是已接受的权衡：条目缺席时任何入站都会无条件重新持久化（persistWeixinContextToken 的
   * 早退仅在条目存在时生效）。防复活竞态：仅当当前持久化条目的 token 仍等于本次发送实际
   * 尝试的值时才删除——发送在途期间被并发入站刷新的新 token 不得误删。失效不是 revival
   * 触发（不触碰保留缓冲），自身也不得向调用方抛错（在 sendOutbound catch 内包裹调用）。
   * 永不记录 token 值。
   */
  async function invalidateWeixinContextTokenForPeer(
    botId: string,
    peerKey: string,
    attemptedToken: string,
  ): Promise<boolean> {
    const normalizedPeerKey = peerKey.trim();
    if (!normalizedPeerKey) {
      return false;
    }
    const state = await repo.readState();
    const existing = state.bots[botId];
    const tokens = existing?.weixinContextTokens;
    if (!existing || tokens?.[normalizedPeerKey]?.token !== attemptedToken) {
      return false;
    }
    const nextTokens = { ...tokens };
    delete nextTokens[normalizedPeerKey];
    state.bots[botId] = {
      ...existing,
      weixinContextTokens: Object.keys(nextTokens).length > 0 ? nextTokens : undefined,
    };
    await repo.writeState(state);
    return true;
  }

  /**
   * Phase B 单一媒体写出核心（specs/bot-file-delivery.md Phase B 不变量）：/file
   * （source "command"）与 bots/shareFile RPC（source "tool"）都汇聚到这里，是唯一的
   * adapter.sendAttachment 调用点。每次调用重新评估全部准入门槛——与 /file 的
   * withAuthorizedContext 复用同一组原语（findAuthorizedBot / findBoundUser /
   * isUserCommandAllowed），工具路径不另设第二套鉴权；任务中途撤销（禁用 bot、解绑、
   * allowedCommands.file=false）与 /file 同步生效。
   */
  async function deliverWorkspaceFile(
    bot: BotConfig,
    actor: BotActor,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    requestedPath: string,
    opts: { source: "command" | "tool"; taskId?: string },
  ): Promise<DeliverWorkspaceFileResult> {
    const peerKey = actor.chatId?.trim() || actor.providerUserId.trim();
    // Phase C Alpha 2 spec item 8：远程尝试在审计行追加 remote=<workspaceIdentity>；
    // path= 一律是 workspace 相对路径——远程侧用请求原样路径，绝不本地 resolve 出绝对路径。
    const auditSuffix = ` source=${opts.source}${opts.taskId ? ` task=${opts.taskId}` : ""}${context.workspaceIdentity ? ` remote=${context.workspaceIdentity}` : ""}`;
    const auditFailure = (
      reason: BotShareFileFailureReason,
      filename: string,
      sizeBytes: number,
      detail?: string,
    ): DeliverWorkspaceFileResult => {
      // 每次尝试都留审计（specs Phase B 场景 15）：bot、peer、file、size、outcome、source、task、path。
      // §5.8（specs Alpha 0 §9 amendment，3.14.5 Alpha 7）：path= 是唯一路径字段；file= 仅当
      // 与 path= 取值不同才输出（顶层路径/预解析失败处两者同值——不重复打印）。
      botsLogger.warn(
        undefined,
        `bot file delivery failed bot=${bot.id} peer=${peerKey}${filename !== requestedPath ? ` file=${filename}` : ""} size=${sizeBytes} outcome=${reason}${auditSuffix} path=${requestedPath}${detail ? `: ${detail}` : ""}`,
      );
      return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
    };
    const config = await repo.readConfig();
    const authorizedBot = findAuthorizedBot(config, actor);
    if (!authorizedBot || authorizedBot.id !== bot.id) {
      return auditFailure("not-allowed", requestedPath, 0);
    }
    if (actor.chatType !== "private") {
      return auditFailure("not-allowed", requestedPath, 0);
    }
    const user = findBoundUser(authorizedBot, actor);
    if (!user || !isUserCommandAllowed(user, "file")) {
      return auditFailure("not-allowed", requestedPath, 0);
    }
    const adapter = providers[authorizedBot.provider];
    if (!adapter?.sendAttachment) {
      return auditFailure("unsupported-provider", requestedPath, 0);
    }
    let filename: string;
    let sizeBytes: number;
    let localPath: string;
    let auditPath: string;
    let tempDirToCleanup: string | undefined;
    if (context.workspaceIdentity) {
      // Phase C Alpha 2（specs Phase C §1）：adapter 门槛已在上方先行，tool 来源 quota
      // 已在进入本函数前预留——都先于任何文件 IO。远程分支在唯一写出核心内取回字节
      // 并物料化临时文件，adapter 不感知 remoteness（localPath 契约不变）。
      const remote = await fetchRemoteWorkspaceFileForDelivery(
        deps,
        {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        },
        requestedPath,
      );
      if (!remote.ok) {
        return auditFailure(remote.reason, requestedPath, remote.sizeBytes ?? 0, remote.detail);
      }
      filename = remote.filename;
      sizeBytes = remote.sizeBytes;
      localPath = remote.tempFilePath;
      auditPath = requestedPath;
      tempDirToCleanup = remote.tempDir;
    } else {
      const resolved = await resolveWorkspaceFilePath(context.workspacePath, requestedPath);
      if (!resolved.ok) {
        return auditFailure(
          resolved.reason === "outside" ? "outside-workspace" : "not-found",
          requestedPath,
          0,
        );
      }
      const rechecked = await revalidateWorkspaceFileForDelivery(
        context.workspacePath,
        resolved.absolutePath,
      );
      if (!rechecked.ok) {
        return rechecked.reason === "too-large"
          ? auditFailure(
              "too-large",
              requestedPath,
              rechecked.sizeBytes ?? 0,
              formatAttachmentSize(rechecked.sizeBytes ?? 0),
            )
          : auditFailure(rechecked.reason, requestedPath, 0);
      }
      filename = basename(rechecked.absolutePath);
      sizeBytes = rechecked.sizeBytes;
      localPath = rechecked.absolutePath;
      auditPath = relative(context.workspacePath, rechecked.absolutePath);
    }
    const kind = inferOutboundAttachmentKind(filename);
    const attachment: BotOutboundAttachment = {
      kind,
      filename,
      mimeType: inferOutboundAttachmentMime(filename, kind),
      sizeBytes,
      localPath,
    };
    // §5.9（specs Alpha 0 §9 amendment，3.14.5 Alpha 7）：Bot 会话今天仍强制 yolo
    //（BOT_FORCED_MODE 三处生效，权限提示结构性缺席），出站防泄露边界 = workspace-only
    // 路径策略 + 本审计日志 + 5MB 上限；3.15.0 Track B 解除 force-yolo 后本句须再修订。
    // §5.8：file= 仅当与 path= 取值不同（子目录 basename ≠ 相对路径）才输出。
    botsLogger.info(
      undefined,
      `bot file delivery bot=${authorizedBot.id} peer=${peerKey}${filename !== auditPath ? ` file=${filename}` : ""} size=${sizeBytes} kind=${kind} outcome=ok${auditSuffix} path=${auditPath}`,
    );
    const providerContextToken =
      opts.source === "tool"
        ? // 长任务里捕获的 actor token 可能已过期；任何入站 ping 都会刷新持久化 token 表，
          // 因此 tool 路径优先取最新持久化 token，捕获 token 只作兜底（provider 内部
          // ret=-2 无 token 重试逻辑不变，由 adapter 自行处理）。
          ((await readPersistedWeixinContextToken(authorizedBot.id, actor)) ??
          actor.providerContextToken)
        : (actor.providerContextToken ??
          (await readPersistedWeixinContextToken(authorizedBot.id, actor)));
    try {
      await adapter.sendAttachment(
        authorizedBot,
        {
          ...createOutbound(actor, ""),
          ...(providerContextToken ? { providerContextToken } : {}),
          attachments: [attachment],
        },
        attachment,
      );
      return { ok: true, filename, sizeBytes };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return auditFailure("send-failed", filename, sizeBytes, reason);
    } finally {
      if (tempDirToCleanup) {
        // 远程临时文件删除是 best-effort（specs §5）：崩溃最多在 OS tmpdir 残留一个
        // ≤5MB 文件；正常路径（含 send-failed）都在投递后立即清理。
        await rm(tempDirToCleanup, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async function handleFileCommand(
    message: BotInboundMessage,
    value: string,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "file");
    if (!auth.ok) {
      return auth.reply;
    }
    // Phase C Alpha 2（specs Phase C §9）取代 Alpha 0 的回复顺序注释：adapter 渠道门槛
    // 仍最先回复；远程 workspace 不再前置拒绝——已连接时 /file 进入 deliverWorkspaceFile
    // 的远程分支正常投递（字节从远端取回），断连仍由 withAuthorizedContext 内的
    // blockDisconnectedRemoteWorkspace 先回复 /重连 提示（顺序不变）。空路径检查位置不变。
    // 3.14.5 Alpha 0（A3a）：以上快速门槛保持在队列内同步回复；通过后只回 ack，
    // 投递结果改由后台腿回复（见 deliverWorkspaceFileInBackground）。
    const adapter = providers[auth.bot.provider];
    if (!adapter?.sendAttachment) {
      return [createOutbound(message.actor, msg(auth.locale, "fileCommandUnsupported"))];
    }
    const requestedPath = value.trim();
    if (!requestedPath) {
      return [createOutbound(message.actor, msg(auth.locale, "fileMissingPath"))];
    }
    // 3.14.5 Alpha 0（A3a，specs/bot-file-delivery.md「Inbound remote workspaces」）：
    // /file 最坏情况 ~6 分钟（远程 reader 初始化 60s + 取回预算 120s + provider 上传链
    // ~225s）。此前整个投递跑在 enqueueInboundProcessing 的 per-actor 串行队列内，会把
    // 权限回调、/stop 和所有后续消息挂住。现在快速准入（withAuthorizedContext 含断连
    // /重连 门槛、adapter 能力检查、空路径检查——回复文案与顺序逐字不变）完成后立即回
    // ack 并释放队列，deliverWorkspaceFile 与结果回复在后台执行（镜像 sendPromptInBackground
    // 的 fire-and-forget 形态）。不变量：准入每次调用都在 ack 前重新评估；/file 不改写
    // task/context 状态；微信入站 context_token 合并（persistWeixinContextToken）仍在
    // 队列内（先于 dispatch）。去重语义（机制不变，记录行为）：markInboundDelivery 在
    // 处理前落 key，仅当 handleInboundMessage 同步抛错或回复发送失败时才 release；
    // ack 是成功返回，后台腿失败不会重新触发重复处理（key 自然滑出 TTL 窗口）。
    deliverWorkspaceFileInBackground(
      auth.bot,
      message.actor,
      auth.context,
      auth.locale,
      requestedPath,
    );
    return [createOutbound(message.actor, msg(auth.locale, "fileFetchStarted"))];
  }

  /**
   * 3.14.5 Alpha 0（A3a）：/file 投递的后台腿。错误必须全部圈禁在此（镜像
   * sendPromptInBackground 的 catch 形态）——后台异常绝不允许抛入 polling loop；
   * 意外异常用 fileSendFailed 本地化文案经 sendOutbound 如实回复。
   */
  function deliverWorkspaceFileInBackground(
    bot: BotConfig,
    actor: BotActor,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    locale: Locale | undefined,
    requestedPath: string,
  ): void {
    void (async () => {
      const delivered = await deliverWorkspaceFile(bot, actor, context, requestedPath, {
        source: "command",
      });
      // 成功/失败映射沿用 /file 既有本地化文案（specs Phase B 不变量：文案零变化）。
      await sendOutbound(
        bot,
        createFileDeliveryResultReply(actor, locale, requestedPath, delivered),
      );
    })().catch(async (error: unknown) => {
      const reasonText = error instanceof Error ? error.message : String(error);
      botsLogger.warn(
        undefined,
        `bot file delivery background failed bot=${bot.id} peer=${actor.chatId ?? actor.providerUserId} path=${requestedPath}: ${reasonText}`,
      );
      await sendOutbound(
        bot,
        createOutbound(actor, msg(locale, "fileSendFailed", { message: reasonText })),
      ).catch(() => undefined);
    });
  }

  /** /file 投递结果 → 既有本地化回复（与 3.14.4 的同步回复文案逐字一致）。 */
  function createFileDeliveryResultReply(
    actor: BotActor,
    locale: Locale | undefined,
    requestedPath: string,
    delivered: DeliverWorkspaceFileResult,
  ): BotOutboundMessage {
    if (delivered.ok) {
      return createOutbound(
        actor,
        msg(locale, "fileSent", {
          filename: delivered.filename,
          size: formatAttachmentSize(delivered.sizeBytes),
        }),
      );
    }
    // 失败映射回 /file 既有本地化文案（specs Phase B 不变量：/file 行为零变化）。
    switch (delivered.reason) {
      case "unsupported-provider":
        return createOutbound(actor, msg(locale, "fileCommandUnsupported"));
      case "remote-unavailable":
        // Phase C Alpha 2：远程取回失败（bridge 缺席/无路由/初始化失败/超预算）的
        // 如实文案；旧 reason "remote-workspace" 已不再由本 host 产生（enum 保留仅为
        // 旧 CLI 兼容），故不再映射。
        return createOutbound(actor, msg(locale, "fileRemoteUnavailable"));
      case "outside-workspace":
        return createOutbound(actor, msg(locale, "fileOutsideWorkspace", { path: requestedPath }));
      case "not-found":
        return createOutbound(actor, msg(locale, "fileNotFound", { path: requestedPath }));
      case "too-large":
        return createOutbound(
          actor,
          msg(locale, "fileTooLargeOutbound", { size: delivered.detail ?? "" }),
        );
      case "send-failed":
        return createOutbound(
          actor,
          msg(locale, "fileSendFailed", { message: delivered.detail ?? "" }),
        );
      default:
        // not-allowed 等：/file 正常在 withAuthorizedContext 内先行回复，这里是竞态兜底，
        // 对齐 commandNotAllowed 文案。
        return createOutbound(actor, msg(locale, "commandNotAllowed"));
    }
  }

  function buildAttachmentCachePath(params: {
    botId: string;
    providerMessageId?: string;
    attachment: BotInboundAttachment;
  }): string {
    const messageKey = params.providerMessageId?.trim() || `message-${Date.now()}`;
    const digest = createHash("sha256")
      .update(`${params.botId}:${messageKey}:${params.attachment.id}`)
      .digest("hex")
      .slice(0, 16);
    return join(
      getAppConfigDir(),
      "bot-attachments",
      sanitizeAttachmentFilename(params.botId),
      sanitizeAttachmentFilename(messageKey),
      `${digest}-${sanitizeAttachmentFilename(params.attachment.filename)}`,
    );
  }

  async function fetchAttachmentDownloadUrl(
    attachment: BotInboundAttachment,
  ): Promise<Uint8Array | null> {
    if (!attachment.downloadUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
    try {
      // 修复原因：附件 URL 下载此前走裸 fetch，绕过应用代理；统一改走注入的 requester。
      const response = await providerRequester.fetch(attachment.downloadUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`download ${attachment.filename} failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if ((error as { name?: unknown })?.name === "AbortError") {
        // Bugfix: 附件下载卡住时必须尽快失败并回复用户，不能让 bot 回调一直悬挂。
        throw new Error(`download ${attachment.filename} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveAttachmentBytes(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    actor: BotActor,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array } | null> {
    if (attachment.dataBase64) {
      return {
        attachment,
        data: Buffer.from(attachment.dataBase64, "base64"),
      };
    }
    if (attachment.localPath) {
      return {
        attachment,
        data: await readFile(attachment.localPath),
      };
    }
    const provider = providers[bot.provider];
    const downloaded = await provider?.downloadAttachment?.(bot, attachment, actor);
    if (downloaded) {
      return downloaded;
    }
    const fromUrl = await fetchAttachmentDownloadUrl(attachment);
    return fromUrl ? { attachment, data: fromUrl } : null;
  }

  /**
   * Alpha 6（§5.3）：惰性修剪——24h 内存门 + fire-and-forget（绝不 await，
   * 入站延迟不得等待清理）；删除 bot-attachments 根下 mtime > 7 天的文件并
   * 移除清空的目录；错误 warn+swallow（修剪失败绝不能让消息失败）。
   */
  function maybePruneAttachmentCache(): void {
    const now = Date.now();
    if (now - lastAttachmentCachePruneAtMs < BOT_ATTACHMENT_CACHE_PRUNE_INTERVAL_MS) {
      return;
    }
    lastAttachmentCachePruneAtMs = now;
    void pruneBotAttachmentCache().catch((error: unknown) => {
      botsLogger.warn(
        undefined,
        `bot attachment cache prune failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function pruneBotAttachmentCache(): Promise<void> {
    const root = join(getAppConfigDir(), "bot-attachments");
    const expireBefore = Date.now() - BOT_ATTACHMENT_CACHE_MAX_AGE_MS;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // 根目录不存在 = 无可清理；静默返回（首次使用前的正常状态）。
      return;
    }
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        await pruneBotAttachmentCacheDir(entryPath, expireBefore);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const info = await stat(entryPath).catch(() => null);
      if (info && info.mtimeMs < expireBefore) {
        await unlink(entryPath).catch(() => undefined);
      }
    }
  }

  /** 递归删除目录内过期文件；整目录清空后连同目录本身移除（§5.3 空目录清理）。 */
  async function pruneBotAttachmentCacheDir(dirPath: string, expireBefore: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await pruneBotAttachmentCacheDir(entryPath, expireBefore);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const info = await stat(entryPath).catch(() => null);
      if (info && info.mtimeMs < expireBefore) {
        await unlink(entryPath).catch(() => undefined);
      }
    }
    // 目录清空（或本就为空）则移除；非空目录的 ENOTEMPTY/EPERM 忽略——留到下一趟。
    await rmdir(dirPath).catch(() => undefined);
  }

  async function cacheResolvedAttachment(params: {
    bot: BotConfig;
    message: BotInboundMessage;
    attachment: BotInboundAttachment;
    data: Uint8Array;
  }): Promise<BotInboundAttachment> {
    // Alpha 6（§5.15，§7.32 owner 裁定）：无扩展名的**兜底命名**（微信
    // weixin-attachment-N 等 provider 生成名）按内存字节的容器指纹补扩展名 +
    // 修正兜底 mimeType；provider 给过文件名的原样不动（filenameIsFallback
    // 门控，[ulw] 评审 MINOR-2 修复）；识别不出维持无扩展名（不比今天更糟）。
    const sniffed =
      extname(params.attachment.filename) === "" && params.attachment.filenameIsFallback === true
        ? sniffAttachmentContainer(params.data)
        : {};
    const cachedFilename = sniffed.extension
      ? `${params.attachment.filename}${sniffed.extension}`
      : params.attachment.filename;
    const localPath = buildAttachmentCachePath({
      botId: params.bot.id,
      providerMessageId: params.message.actor.providerMessageId,
      attachment: { ...params.attachment, filename: cachedFilename },
    });
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, params.data);
    // Alpha 6（§5.3）：写缓存后顺路修剪（24h 门 + fire-and-forget，绝不 await）。
    maybePruneAttachmentCache();
    return {
      ...params.attachment,
      ...(sniffed.extension
        ? { filename: cachedFilename, mimeType: sniffed.mimeType ?? params.attachment.mimeType }
        : {}),
      localPath,
      sizeBytes: params.data.byteLength,
    };
  }

  /**
   * [ulw] 评审修复（MINOR-1）：附件通知（>4 提示 / 逐文件超限拒绝）随正常处理送达，
   * 中途失败不得让其蒸发。throw 前把已累积通知挂在错误对象上；各 catch 漏斗用
   * takeBotNoticeRepliesFrom 取出并前置到失败回复之前。
   */
  function tagBotNoticeRepliesOn(error: unknown, replies: BotOutboundMessage[]): void {
    if (error instanceof Error && replies.length > 0) {
      (error as Error & { botNoticeReplies?: BotOutboundMessage[] }).botNoticeReplies = replies;
    }
  }

  function takeBotNoticeRepliesFrom(error: unknown): BotOutboundMessage[] {
    if (error instanceof Error) {
      const replies = (error as Error & { botNoticeReplies?: BotOutboundMessage[] })
        .botNoticeReplies;
      if (Array.isArray(replies)) {
        return replies;
      }
    }
    return [];
  }

  async function prepareBotMessageContent(
    bot: BotConfig,
    message: BotInboundMessage,
    locale: Locale | undefined,
  ): Promise<PreparedBotMessageContent> {
    const totalAttachmentCount = message.attachments?.length ?? 0;
    const rawAttachments = (message.attachments ?? []).slice(0, BOT_MAX_ATTACHMENTS_PER_MESSAGE);
    const skippedAttachmentCount = totalAttachmentCount - rawAttachments.length;
    const zcodeAttachments: ZCodePromptAttachment[] = [];
    const fileLines: string[] = [];
    // Alpha 6（§5.1/§5.2）：即时本地化通知回复，随正常处理一起返回给用户。
    const noticeReplies: BotOutboundMessage[] = [];
    let rejectedAttachmentCount = 0;
    if (skippedAttachmentCount > 0) {
      // §5.1：>4 的静默 slice 死亡——slice 先于任何 per-attachment IO，用户与模型都必须知道。
      noticeReplies.push(
        createOutbound(
          message.actor,
          msg(locale, "attachmentCountLimited", {
            max: BOT_MAX_ATTACHMENTS_PER_MESSAGE,
            count: skippedAttachmentCount,
          }),
        ),
      );
      fileLines.push(
        `提示：本条消息共携带 ${totalAttachmentCount} 个附件，仅处理前 ${BOT_MAX_ATTACHMENTS_PER_MESSAGE} 个，其余 ${skippedAttachmentCount} 个未接收（已跳过）。`,
      );
    }
    for (const rawAttachment of rawAttachments) {
      // Alpha 6（§5.2 单次检查语义，§7.32 owner 裁定）：sizeBytes 已知且超限 →
      // 下载前 typed 逐文件拒绝（零下载零缓存零附件）；三家 provider 的消息通知
      // 均已自带 sizeBytes，此处只是看一眼已到手的信息。
      if (
        rawAttachment.sizeBytes !== undefined &&
        rawAttachment.sizeBytes > BOT_MAX_ATTACHMENT_SIZE_BYTES
      ) {
        rejectedAttachmentCount += 1;
        noticeReplies.push(
          createOutbound(
            message.actor,
            msg(locale, "attachmentTooLargeSkipped", { filename: rawAttachment.filename }),
          ),
        );
        fileLines.push(`附件：${rawAttachment.filename} 超过 5MB 上限，已跳过（未下载）。`);
        continue;
      }
      // [ulw] 评审修复（MINOR-1）：下载中途 throw（weixin CDN HTTP 失败 / URL 超时）
      // 不丢已累积的附件通知——挂在错误上随 throw 上抛，由各 catch 漏斗前置送达。
      let resolved;
      try {
        resolved = await resolveAttachmentBytes(bot, rawAttachment, message.actor);
      } catch (error) {
        tagBotNoticeRepliesOn(error, noticeReplies);
        throw error;
      }
      if (!resolved) {
        fileLines.push(
          `附件：${rawAttachment.filename} (${rawAttachment.mimeType}, ${formatAttachmentSize(rawAttachment.sizeBytes)})，未能下载。`,
        );
        continue;
      }
      // §5.2：sizeBytes 元数据缺失时才保留下载后 byteLength 检查（fallback，逐文件拒绝，
      // 不再整条 throw）；元数据已知且合法时绝不复查——每个文件只查一次。
      if (
        rawAttachment.sizeBytes === undefined &&
        resolved.data.byteLength > BOT_MAX_ATTACHMENT_SIZE_BYTES
      ) {
        rejectedAttachmentCount += 1;
        noticeReplies.push(
          createOutbound(
            message.actor,
            msg(locale, "attachmentTooLargeSkipped", {
              filename: resolved.attachment.filename,
            }),
          ),
        );
        fileLines.push(`附件：${resolved.attachment.filename} 超过 5MB 上限，已跳过。`);
        continue;
      }
      // [ulw] 评审修复（MINOR-1）：缓存写盘失败同样不丢已累积通知（同上随错误携带）。
      let cached;
      try {
        cached = await cacheResolvedAttachment({
          bot,
          message,
          attachment: resolved.attachment,
          data: resolved.data,
        });
      } catch (error) {
        tagBotNoticeRepliesOn(error, noticeReplies);
        throw error;
      }
      // §5.11（specs/bot-file-delivery.md「Inbound remote workspaces」invariant amendment，
      // 3.14.5 Alpha 7；R3 rig PASS 2026-10-04 门控，handoff §2h → §7.31 GO）：image/audio
      // 不再携带 dataBase64——owner 已实证手机微信预览 + 桌面 transcript 均按 localPath
      // 渲染，缓存文件刚写入、路径必然存在，base64 重复传输同一份数据就此消亡。渲染
      // 依据 localPath；dataBase64-only 附件（其它来源）在 desktop 包装器仍原样透传。
      if (cached.kind === "image" || cached.kind === "audio") {
        zcodeAttachments.push({
          kind: cached.kind,
          filename: cached.filename,
          mimeType: cached.mimeType,
          // Bugfix：Bot 已把附件缓存到本地，ZCodePromptAttachment 也必须携带该路径。
          // 只在 prompt 文本里描述路径会让下游附件策略无法选择本地文件读取。
          localPath: cached.localPath,
        });
        // Bugfix: bot 附件已经被 gateway 下载并缓存到本地。只把图片作为 ZCode Agent image block 传入时，
        // 下游 agent 可能把内部临时 URL 再 curl 到 /tmp，导致重复下载、额外权限请求和模型安全拦截。
        // 因此同时把本地缓存路径写进 prompt，明确后续工具操作只能围绕本地文件进行。
        fileLines.push(
          `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已作为${cached.kind === "image" ? "图片" : "音频"}输入提供，并保存到：${cached.localPath}。如需读取附件，请直接使用这个本地路径，不要下载或访问临时/远程 URL。`,
        );
        continue;
      }
      // 3.14.5 Alpha 0（specs/bot-file-delivery.md「Inbound remote workspaces」A1）：
      // 修复 owner rig 确认的远程断链——file/pdf/video 之前只写 prompt 行（内嵌桌面本地路径），
      // 远程 workspace 的 desktop-host 包装器（materializeRemotePromptAttachments）在附件列表
      // 为空时直接 no-op，桌面路径原样发给远端 agent，所有工具读取必然失败。现在同样产出真实
      // ZCodePromptAttachment：包装器即可把缓存文件上传到远端 ~/.zcode/tmp/prompt-attachments/
      // 并改写附件与 prompt 行中的路径。kind 映射：入站 video → video；入站 file 且 mimeType 为
      // application/pdf → pdf（CLI mapper 对 pdf 有专门 content-block 处理；入站协议没有 pdf kind）；
      // 其余 file → file。各 kind 一律不携带 dataBase64——CLI 恒优先 localPath，且缓存
      // 文件刚刚写入、路径必然存在；sizeBytes 用缓存字节数（file kind 协议必填）。
      // image/audio 的 dataBase64 strip 见上方 §5.11 注记。
      const promptAttachmentCommonFields = {
        filename: cached.filename,
        mimeType: cached.mimeType,
        sizeBytes: cached.sizeBytes ?? resolved.data.byteLength,
        localPath: cached.localPath,
      };
      const isPdfByMime =
        cached.mimeType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
      const promptAttachment: ZCodePromptAttachment =
        cached.kind === "video"
          ? { kind: "video", ...promptAttachmentCommonFields }
          : isPdfByMime
            ? { kind: "pdf", ...promptAttachmentCommonFields }
            : { kind: "file", ...promptAttachmentCommonFields };
      zcodeAttachments.push(promptAttachment);
      fileLines.push(
        `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已保存到：${cached.localPath}`,
      );
    }
    const trimmed = message.text.trim();
    // §5.2 唯一存活的整条拒绝边界：所有附件都被（超限）拒绝且消息无文字——
    // 绝不创建空任务；R4 钉住该路径零缓存写入（per-file 拒绝先于任何兄弟附件缓存）。
    const wholeRejection =
      rawAttachments.length > 0 && rejectedAttachmentCount === rawAttachments.length && !trimmed;
    const baseContent =
      trimmed ||
      (rawAttachments.length > 0 && !wholeRejection ? msg(locale, "attachmentOnlyPrompt") : "");
    return {
      content: [baseContent, ...fileLines].filter(Boolean).join("\n\n"),
      zcodeAttachments,
      noticeReplies,
      wholeRejection,
    };
  }

  function requiresRemoteWorkspaceRuntime(requestedCommand: BotAuthorizedCommand): boolean {
    return (
      requestedCommand !== "help" &&
      requestedCommand !== "status" &&
      requestedCommand !== "workspace" &&
      requestedCommand !== "reconnect" &&
      requestedCommand !== "reply"
    );
  }

  async function isRemoteWorkspaceConnected(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<boolean> {
    if (!context.workspaceIdentity) {
      return true;
    }
    if (!deps.remoteWorkspaceService) {
      // Bugfix: 远端 workspace 没有注入重连服务时，不能默认当作已连接。
      // 否则 Bot 会继续使用缓存模型创建 task，最终在远端 API 层才暴露“模型不存在”等误导性错误。
      return false;
    }
    return deps.remoteWorkspaceService
      .isConnected({
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => false);
  }

  async function reconnectRemoteWorkspaceForBot(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<BotRemoteWorkspaceReconnectResult> {
    if (!context.workspaceIdentity) {
      return { ok: true };
    }
    if (!deps.remoteWorkspaceService) {
      return {
        ok: false,
        message: "remote reconnect service unavailable",
      };
    }
    return deps.remoteWorkspaceService.ensureConnected({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
  }

  async function resolveZCodeTaskServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<IZCodeTaskService> {
    if (!context.workspaceIdentity) {
      return deps.zcodeTaskService;
    }
    const remoteZCodeTaskService = await deps.remoteWorkspaceService?.getZCodeTaskService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (remoteZCodeTaskService) {
      return remoteZCodeTaskService;
    }
    // Bugfix: 远端 workspace 的 bot 请求不能缺 runtime 时静默走本地 zcodeTaskService。
    // 否则 /root 这类远端路径会在 macOS/Windows 本地 host 创建任务，模型和文件系统都错位。
    throw new Error(
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  async function resolveModelSelectionServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<Pick<IModelSelectionService, "getView">> {
    if (!context.workspaceIdentity) return deps.modelSelectionService;
    const service = await deps.remoteWorkspaceService?.getModelSelectionService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (service) return service;
    throw new Error(
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  async function blockDisconnectedRemoteWorkspace(params: {
    message: BotInboundMessage;
    context: BotContextState;
    locale: Locale | undefined;
    requestedCommand: BotAuthorizedCommand;
  }): Promise<BotOutboundMessage[] | null> {
    if (
      !params.context.workspaceIdentity ||
      !requiresRemoteWorkspaceRuntime(params.requestedCommand) ||
      (await isRemoteWorkspaceConnected(params.context))
    ) {
      return null;
    }
    // Bugfix: 普通消息、配置修改和权限响应不应该隐式改变远端连接状态。
    // 远端恢复只允许显式 /reconnect 触发，避免同一条消息有时执行、有时只是在后台打开连接。
    return [
      createOutbound(
        params.message.actor,
        msg(params.locale, "remoteDisconnected", {
          workspacePath: params.context.workspacePath,
        }),
      ),
    ];
  }

  function currentOptionSuffix(locale: Locale | undefined): string {
    return locale === "en-US" ? "current" : "当前";
  }

  function formatReplyGranularityLabel(
    id: BotReplyGranularity | undefined,
    locale: Locale | undefined,
    provider?: BotProvider,
  ): string {
    const currentId = provider
      ? normalizeBotReplyGranularity(provider, id)
      : (id ?? getDefaultBotReplyGranularity());
    return (
      getReplyGranularityOptions(locale, provider).find((option) => option.id === currentId)
        ?.label ?? currentId
    );
  }

  function clearCandidateCaches(): void {
    cachedWorkspaceRefsByKey.clear();
  }

  function markCurrentSelection(
    selection: SelectionPrompt,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const cancelLabel = msg(locale, "selectionCancelOption");
    if (!selection.currentId) {
      return { ...selection, cancelLabel };
    }
    const suffix = currentOptionSuffix(locale);
    return {
      ...selection,
      cancelLabel,
      options: selection.options.map((option) =>
        option.id === selection.currentId
          ? { ...option, label: `${option.label} · ${suffix}` }
          : option,
      ),
    };
  }

  async function listUserConfigOptions(
    _params: BotUserConfigOptionsParams,
  ): Promise<ZCodeConfigOption[]> {
    return [];
  }
  async function ensureBotStorageMigrated(): Promise<void> {
    // 单向导入已收口到 Repo；这里只等待初始化，不再读取旧模型字段或重写当前状态。
    if (!botStorageMigrationPromise) {
      botStorageMigrationPromise = Promise.all([repo.readConfig(), repo.readState()])
        .then(() => undefined)
        .catch((error: unknown) => {
          botStorageMigrationPromise = null;
          throw error;
        });
    }
    await botStorageMigrationPromise;
  }

  async function listActiveTaskConfigOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
  ): Promise<ZCodeConfigOption[]> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    return zcodeTaskService.getTaskConfigOptions({ taskId });
  }

  function findSelectConfigOption(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): (ZCodeConfigOption & { type: "select" }) | undefined {
    const category = configId === "thoughtLevel" ? "thought_level" : configId;
    return options.find(
      (item): item is ZCodeConfigOption & { type: "select" } =>
        item.type === "select" && (item.category === category || item.id === category),
    );
  }

  function listConfigSelectOptions(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): BotModelOption[] {
    const option = findSelectConfigOption(options, configId);
    return (option?.options ?? []).map((item) => {
      const baseOption = {
        id: item.value,
        label: item.name,
        description: item.description,
      };
      return {
        ...baseOption,
        // 保持 Bot 与工具栏的模式展示一致。
        label: formatConfigOptionLabel(baseOption, {
          configId,
          locale: context.locale,
          provider: context.provider,
        }),
      };
    });
  }

  function getConfigCommandMissingMessageId(configId: "mode" | "thoughtLevel"): BotMessageId {
    return configId === "mode" ? "modeMissing" : "thoughtLevelMissing";
  }

  function getModeDisplayLabel(
    locale: Locale | undefined,
    provider: ZCodeProvider | undefined,
    option: Pick<BotModelOption, "id" | "label">,
  ): string {
    if (!provider) {
      return option.label;
    }
    const isEnglish = locale === "en-US";
    const labels: Partial<Record<ZCodeProvider, Record<string, string>>> = {
      zcode: {
        default: isEnglish ? "Default" : "默认",
        yolo: "Yolo",
        plan: isEnglish ? "Plan" : "计划",
      },
    };
    return labels[provider]?.[option.id] ?? option.label;
  }

  function formatConfigOptionLabel(
    option: BotModelOption,
    context: {
      configId: "model" | "mode" | "thoughtLevel";
      locale?: Locale;
      provider?: ZCodeProvider;
    },
  ): string {
    if (context.configId !== "mode") {
      return option.label;
    }
    return getModeDisplayLabel(context.locale, context.provider, option);
  }

  function createModelSelectionProviderOption(
    provider: ModelSelectionView["providers"][number],
  ): BotModelProviderOption {
    return {
      id: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      models: provider.models.map((model) => ({
        id: encodeCustomModelValue(provider.providerId, model.modelId),
        label: model.modelId,
      })),
    };
  }

  async function readModelSelectionView(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    selection?: ModelSelection,
  ): Promise<ModelSelectionView | null> {
    const service = await resolveModelSelectionServiceForContext(context).catch(() => null);
    if (!service) return null;
    return service.getView
      .call(service, selection ? { selection } : undefined)
      .catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `read model selection view for bot model display failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
  }

  async function listModelSelectionProviderOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<BotModelProviderOption[]> {
    const view = await readModelSelectionView(context);
    // 旧缓存没有 workspaceIdentity 隔离，远端断连时会显示其他 Host 的候选。
    // 当前菜单只消费目标 View；失败留空，下一次正常读取即可恢复，不借本地补选。
    if (!view) return [];
    return view.providers
      .map(createModelSelectionProviderOption)
      .filter((provider) => provider.models.length > 0);
  }

  async function listModelProviderOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    _activeProvider: ZCodeProvider,
  ): Promise<BotModelProviderOption[]> {
    return listModelSelectionProviderOptions(task);
  }

  async function listModelOptionsForProviderFromActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
    providerId: string,
  ): Promise<BotModelOption[]> {
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find(
        (provider) => provider.id === providerId,
      )?.models ?? []
    );
  }

  function readModelProviderSelectionModels(provider: unknown): BotModelOption[] {
    const models = isRecord(provider) ? provider.models : undefined;
    if (!Array.isArray(models)) {
      return [];
    }
    return models.filter(
      (model): model is BotModelOption =>
        isRecord(model) && typeof model.id === "string" && typeof model.label === "string",
    );
  }

  async function listAllModelOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<BotModelOption[]> {
    return (await listModelProviderOptionsForActiveTask(task, activeProvider)).flatMap(
      (provider) => provider.models,
    );
  }

  function readCurrentActiveTaskModel(
    task: Pick<ZCodeTaskMeta, "model">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "model") ?? task.model;
  }

  async function formatStatusModelLabel(
    model: string | undefined,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    locale: Locale | undefined,
  ): Promise<string> {
    if (!model) {
      // specs/bot-inbound-resilience.md §A.2：无模型时显示明确本地化“未设置 / not set”，
      // 替代裸 "-"——让陷阱在首个 prompt 前可见（/status 与 /new ack 共用此处）。
      return msg(locale, "statusModelUnset");
    }
    const customModel = decodeCustomModelValue(model);
    if (customModel?.providerId) {
      const modelSelectionOptions = await listModelSelectionProviderOptions(context);
      const providerLabel = modelSelectionOptions.find(
        (item) => item.id === customModel.providerId,
      )?.label;
      if (providerLabel && customModel.modelName) {
        return `${providerLabel}/${customModel.modelName}`;
      }
      return providerLabel ?? model;
    }
    const separatorIndex = model.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
      return model;
    }
    const providerId = model.slice(0, separatorIndex);
    const modelName = model.slice(separatorIndex + 1);
    const modelSelectionOptions = await listModelSelectionProviderOptions(context);
    const providerLabel = modelSelectionOptions.find((item) => item.id === providerId)?.label;
    // Bugfix: /status 只应该暴露用户能识别的模型供应商名称。
    // 旧 bot-state 或 task config 可能保存成 providerId/modelId，providerId 对用户没有意义。
    return providerLabel ? `${providerLabel}/${modelName}` : model;
  }

  async function readCurrentModelProviderId(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    options: readonly ZCodeConfigOption[],
    activeProvider: ZCodeProvider,
  ): Promise<string | undefined> {
    const currentValue = readCurrentActiveTaskModel(task, options);
    if (!currentValue) {
      return undefined;
    }
    const customModel = decodeCustomModelValue(currentValue);
    if (customModel?.providerId) {
      return customModel.providerId;
    }
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find((provider) =>
        provider.models.some((model) => model.id === currentValue),
      )?.id ?? getNativeModelProviderId(activeProvider)
    );
  }

  function resolveCustomModelRuntimeModelId(
    _activeProvider: ZCodeProvider,
    customModel: { providerId: string; modelName?: string },
  ): string | undefined {
    if (!customModel.modelName) {
      return undefined;
    }
    return customModel.modelName;
  }

  function readConfigSelectCurrentValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): string | undefined {
    const currentValue = findSelectConfigOption(options, configId)?.currentValue;
    return typeof currentValue === "string" ? currentValue : undefined;
  }

  function resolveSupportedDraftMode(
    options: readonly ZCodeConfigOption[],
    mode: string | undefined,
    provider: ZCodeProvider,
  ): string | undefined {
    if (!mode) {
      return undefined;
    }
    return resolveProviderModeIdFromConfigOptions({
      configOptions: options,
      modeId: mode,
      provider,
    })
      ? mode
      : undefined;
  }

  function readConfigSelectCurrentLabel(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    const currentValue = readConfigSelectCurrentValue(options, configId);
    if (!currentValue) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find(
        (option) => option.id === currentValue,
      )?.label ?? currentValue
    );
  }

  function readConfigSelectLabelForValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    value: string | undefined,
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find((option) => option.id === value)
        ?.label ?? value
    );
  }

  function readCurrentActiveTaskMode(
    task: Pick<ZCodeTaskMeta, "mode">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "mode") ?? task.mode;
  }

  async function listProviderConfigOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<ZCodeConfigOption[]> {
    return listUserConfigOptions({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      provider: activeProvider,
    });
  }

  function normalizeBotDraftOptions(draftOptions: BotDraftOptions): BotDraftOptions {
    // Bugfix: bot-state 里可能还残留旧三方 CLI 草稿 provider。
    // 如果直接复用，/new 后首条消息会重新创建第三方 runtime，绕过 ZCode Agent 单一事实源。
    return {
      ...draftOptions,
      provider: normalizeAgentProviderToZCodeAgent(draftOptions.provider),
    };
  }

  async function buildInitializedDraftOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    provider?: ZCodeProvider,
  ): Promise<BotDraftOptions> {
    const requestedProvider = normalizeAgentProviderToZCodeAgent(
      provider ?? DEFAULT_BOT_ZCODE_PROVIDER,
    );
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: 远端断连时初始化草稿也不能偷偷申请远端 ZCode Agent runtime。
      // 只有 /reconnect 能恢复连接；草稿先保留最小默认值，重连成功后再刷新。
      return { provider: requestedProvider };
    }
    const resolvedProvider = requestedProvider;
    return {
      provider: resolvedProvider,
      mode: BOT_FORCED_MODE,
    };
  }

  async function buildActiveTaskDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    const activeTask = await readContextActiveTaskMeta(context);
    if (!context.activeTaskId || !activeTask?.provider) {
      return buildInitializedDraftOptions(context);
    }
    const configOptions = await listActiveTaskConfigOptions(context, context.activeTaskId).catch(
      () => [],
    );
    const resolvedProvider = normalizeAgentProviderToZCodeAgent(activeTask.provider);
    // Bot 硬锁 yolo：继承当前 task 时也强制 yolo，不沿用原 task 的 mode。
    const forcedMode = resolveSupportedDraftMode(configOptions, BOT_FORCED_MODE, resolvedProvider);
    const currentModel = readCurrentActiveTaskModel(activeTask, configOptions);
    const parsedSelection = currentModel ? parseBotModelOptionValue(currentModel) : undefined;
    const reasoningLevel = readConfigSelectCurrentValue(configOptions, "thoughtLevel");
    const modelSelection = parsedSelection
      ? {
          ...parsedSelection,
          ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
        }
      : undefined;
    return {
      provider: resolvedProvider,
      ...(modelSelection ? { modelSelection } : {}),
      ...(forcedMode ? { mode: forcedMode } : {}),
    };
  }

  async function ensureDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    if (context.draftOptions) {
      const normalizedDraftOptions = normalizeBotDraftOptions(context.draftOptions);
      if (normalizedDraftOptions.provider !== context.draftOptions.provider) {
        await writeContext({ ...context, draftOptions: normalizedDraftOptions });
      }
      return normalizedDraftOptions;
    }
    const draftOptions = await buildInitializedDraftOptions(context);
    await writeContext({ ...context, draftOptions });
    return draftOptions;
  }

  async function writeDraftOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
  ): Promise<BotContextState> {
    const normalizedDraftOptions = normalizeBotDraftOptions(draftOptions);
    const nextContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions: normalizedDraftOptions,
    };
    await writeContext(nextContext);
    return nextContext;
  }

  async function resolveDraftOptionsForDisplay(context: BotContextState): Promise<BotDraftOptions> {
    const original = await ensureDraftOptions(context);
    const view = await readModelSelectionView(context, original.modelSelection);
    // 菜单也必须展示派发将使用的身份。这里只返回副本；查看菜单不能写回原草稿。
    return {
      ...original,
      modelSelection:
        (original.modelSelection ? view?.effectiveSelection : view?.preferredSelection) ??
        undefined,
    };
  }

  async function listDraftConfigOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
    resolvedView?: ModelSelectionView | null,
  ): Promise<ZCodeConfigOption[]> {
    const view =
      resolvedView === undefined
        ? await readModelSelectionView(context, draftOptions.modelSelection)
        : resolvedView;
    const selection = draftOptions.modelSelection
      ? view?.effectiveSelection
      : view?.preferredSelection;
    if (!selection) return [];
    const model = view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
    const spec = model?.config.optionSpecs.reasoningLevel;
    if (!spec) return [];
    return [
      {
        id: "thought_level",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: selection.options?.reasoningLevel ?? "",
        options: spec.values.map((value) => ({ value, name: value })),
      },
    ];
  }

  async function applyDraftConfigOptions(
    context: BotContextState,
    taskId: string,
    traceId: string,
  ): Promise<void> {
    const draftOptions = context.draftOptions;
    if (!draftOptions) {
      return;
    }
    // Bugfix: workspace configOptions 描述的是切换前的工作区模型，不能用来校验新 task 的配置。
    // 例如 GLM 的 enabled 会被误下发给刚切换的 DeepSeek，导致首条微信消息回调失败。
    const configOptions = await listActiveTaskConfigOptions(context, taskId);
    const modeOption = configOptions.find(
      (option) => option.category === "mode" && option.type === "select",
    );
    // Bot 硬锁 yolo：无论草稿/继承的 mode 是什么，建 task 时一律下发 yolo。
    // 这是 mode 真正进入 agent session 的唯一咽喉，保证任何 bot task 都免交互权限。
    const forcedDraftMode = resolveSupportedDraftMode(
      configOptions,
      BOT_FORCED_MODE,
      draftOptions.provider,
    );
    if (modeOption?.id && forcedDraftMode) {
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
      await zcodeTaskService.setMode({
        taskId,
        mode: forcedDraftMode as ZCodeTaskMode,
      });
    } else if (modeOption?.id) {
      // provider 不支持 yolo（非 ZCode Agent）：保持其自身默认模式，避免首条消息回调失败。
      botsLogger.debug(
        traceId,
        `skip forced yolo mode unsupported provider=${draftOptions.provider}`,
      );
    }
  }

  function getActorContextKey(actor: BotActor): string {
    return [actor.botId, actor.provider, actor.chatId?.trim() || actor.providerUserId].join("::");
  }

  function clearPendingSelectionsForBot(botId: string): void {
    const matchesBot = (contextKey: string): boolean =>
      contextKey === botId || contextKey.startsWith(`${botId}::`);
    for (const contextKey of pendingSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingTaskSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingTaskSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingWorkspaceSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingWorkspaceSelectionsByContext.delete(contextKey);
      }
    }
  }

  function resolvePendingSelectionOption(
    actor: BotActor,
    action: SelectionPrompt["action"],
    value: string,
  ): SelectionPrompt["options"][number] | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (selection?.action !== action) {
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (option) {
      pendingSelectionsByContext.delete(actorContextKey);
    }
    return option;
  }

  function clearPendingSelection(actor: BotActor): void {
    const actorContextKey = getActorContextKey(actor);
    pendingSelectionsByContext.delete(actorContextKey);
    pendingTaskSelectionsByContext.delete(actorContextKey);
    pendingWorkspaceSelectionsByContext.delete(actorContextKey);
  }

  function resolvePendingSelectionCommand(actor: BotActor, value: string): BotCommand | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (!selection) {
      return null;
    }
    if (actor.provider !== "weixin") {
      // Bugfix: 只有微信没有结构化选项，只能靠“回复数字”承接 pending selection。
      // Telegram/飞书等 provider 有按钮回调，普通文本不应被隐式解析成菜单选择。
      clearPendingSelection(actor);
      return null;
    }
    if (!isSelectionIndexValue(value)) {
      // Bugfix: /task 等列表命令会留下 pending selection。
      // 旧逻辑允许普通文本按 label 命中选项，用户输入与 task 标题同名的消息时会被误切 task。
      // 隐式选择只接受纯数字；按 id/label 选择仍通过显式 /task <value> 等命令完成。
      clearPendingSelection(actor);
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (!option) {
      clearPendingSelection(actor);
      return null;
    }
    pendingSelectionsByContext.delete(actorContextKey);
    switch (selection.action) {
      case "workspace.set":
        return { type: "workspace.set", value: option.id };
      case "model.provider.set":
        return { type: "model.provider.set", value: option.id };
      case "model.set":
        return { type: "model.set", value: option.id };
      case "mode.set":
        return { type: "mode.set", value: option.id };
      case "thoughtLevel.set":
        return { type: "thoughtLevel.set", value: option.id };
      case "task.set":
        return { type: "task.set", value: option.id };
      case "reply.set":
        return { type: "reply.set", value: option.id };
      case "permission.respond":
        return { type: "permission.respond", value };
      case "elicitation.respond":
        return { type: "elicitation.respond", value: option.id };
    }
  }

  function shouldUseTransientInteractionCard(bot: BotConfig, user: BotConfig): boolean {
    const adapter = providers[bot.provider];
    return (
      isFeishuBotProvider(bot.provider) &&
      normalizeBotReplyGranularity(bot.provider, user.replyMode) === "streaming_card" &&
      Boolean(adapter?.createTransientInteractionCard) &&
      Boolean(adapter?.updateTransientInteractionCard)
    );
  }

  async function upsertTransientInteractionCard(
    bot: BotConfig,
    actor: BotActor,
    taskId: string,
    message: BotOutboundMessage,
  ): Promise<void> {
    const adapter = providers[bot.provider];
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    if (existing) {
      // 修复原因：交互推进时 POST 新卡再 DELETE 旧卡会显示撤回痕迹。
      // callback token 更新失败后的降级路径也只能 PATCH 原 message_id，保持单卡身份稳定。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, message);
      return;
    }
    const handle = await adapter?.createTransientInteractionCard?.(bot, message);
    if (!handle) {
      return;
    }
    transientInteractionCards.set(key, { bot, taskId, handle });
  }

  async function finalizeTransientInteractionCard(
    actor: BotActor,
    fallback: BotOutboundMessage,
  ): Promise<boolean> {
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    if (!existing) {
      return false;
    }
    const adapter = providers[existing.bot.provider];
    try {
      // 修复原因：交互完成后撤回卡片会让问答和计划从聊天历史消失，用户无法回看
      // 决策上下文。终态只更新为无控件卡片并释放运行时句柄，后续交互会创建新卡。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, fallback);
    } catch (error) {
      botsLogger.warn(
        undefined,
        `finalize interaction card failed bot=${existing.bot.id} task=${existing.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      transientInteractionCards.delete(key);
    }
    return true;
  }

  function retainedBufferKey(botId: string, peerKey: string): string {
    return `${botId}::${peerKey}`;
  }

  function sumRetainedBufferBytes(buffer: string[]): number {
    return buffer.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }

  /** per-peer 串行化（先例：enqueueInboundProcessing 的 promise chain）。所有保留缓冲的
   * 异步变更与投递（flush 保留 / revival 补发 / force 边界重试）都经由这里，避免并发
   * 取走/追加同一积压造成丢失或重复。 */
  async function withRetainedBufferLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = retainedReplyBufferQueues.get(key) ?? Promise.resolve();
    let releaseQueue = (): void => undefined;
    const current = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseQueue = resolve;
          }),
      );
    retainedReplyBufferQueues.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      releaseQueue();
      if (retainedReplyBufferQueues.get(key) === current) {
        retainedReplyBufferQueues.delete(key);
      }
    }
  }

  /** 追加保留文本并按 utf8 字节 cap 头部截断（~64KB 尾部 + 一次性截断标记）。
   * 必须在 withRetainedBufferLock 内调用。 */
  function appendRetainedTexts(key: string, texts: string[], locale: Locale | undefined): void {
    const buffer = retainedReplyBuffers.get(key) ?? [];
    retainedReplyBuffers.set(key, buffer);
    for (const text of texts) {
      if (text) {
        buffer.push(text);
      }
    }
    let totalBytes = sumRetainedBufferBytes(buffer);
    if (totalBytes <= BOT_RETAINED_BUFFER_MAX_BYTES) {
      return;
    }
    let droppedCount = 0;
    while (buffer.length > 0 && totalBytes > BOT_RETAINED_BUFFER_MAX_BYTES) {
      totalBytes -= Buffer.byteLength(buffer[0]!, "utf8");
      buffer.shift();
      droppedCount += 1;
    }
    const marker = msg(locale, "retainedBacklogTruncatedHead");
    if (buffer[0] !== marker) {
      // 一次性标记：已存在（前次截断遗留）则不重复添加；标记本身体积有限，
      // 允许总量轻微超出 cap（按尾部语义绝不从尾部丢弃）。
      buffer.unshift(marker);
    }
    botsLogger.warn(
      undefined,
      `bot retained buffer head-truncated messages=${droppedCount} backlogMessages=${buffer.length} backlogBytes=${sumRetainedBufferBytes(buffer)}`,
    );
  }

  async function retainReplyTexts(bot: BotConfig, peerKey: string, texts: string[]): Promise<void> {
    const meaningful = texts.filter((text) => text.length > 0);
    if (meaningful.length === 0) {
      return;
    }
    const key = retainedBufferKey(bot.id, peerKey);
    const locale = await readMessageLocale();
    await withRetainedBufferLock(key, async () => {
      appendRetainedTexts(key, meaningful, locale);
      const buffer = retainedReplyBuffers.get(key) ?? [];
      botsLogger.info(
        undefined,
        `bot retained reply enqueued provider=${bot.provider} bot=${bot.id} peer=${peerKey} messages=${meaningful.length} backlogMessages=${buffer.length} backlogBytes=${sumRetainedBufferBytes(buffer)}`,
      );
    });
  }

  /**
   * M1 补发核心（revival 与 force 边界重试共用）：先（可选）发一条序言，再按序投递积压。
   * 逐条分类：channel-dead 停止并重新保留余量（一次不复活代价有界）；content-poison
   * 丢弃该条 + 一次性通知（alpha.1 语义）并继续余量。积压取走后投递，互斥由
   * withRetainedBufferLock 保证；补发本身不 retain（避免双重保留）。
   */
  async function deliverRetainedBacklog(
    bot: BotConfig,
    actor: BotActor,
    options: { withPreamble: boolean },
  ): Promise<void> {
    const peerKey = actor.chatId?.trim() || actor.providerUserId.trim();
    if (!peerKey) {
      return;
    }
    const key = retainedBufferKey(bot.id, peerKey);
    const initialBacklog = retainedReplyBuffers.get(key);
    if (!initialBacklog || initialBacklog.length === 0) {
      return;
    }
    await withRetainedBufferLock(key, async () => {
      const backlog = retainedReplyBuffers.get(key);
      if (!backlog || backlog.length === 0) {
        return;
      }
      const locale = await readMessageLocale();
      if (options.withPreamble) {
        botsLogger.info(
          undefined,
          `bot retained backlog revival attempted bot=${bot.id} peer=${peerKey} messages=${backlog.length}`,
        );
        try {
          // 序言走存活通道且不保留：失败（任意类别）即停止，积压原样保留——
          // 一次不复活的 ping 代价恰为这一次有界尝试（owner 决定 §7.20 + 评审 F4）。
          await sendOutbound(
            bot,
            createOutbound(
              actor,
              msg(locale, "retainedBacklogPreamble", { count: backlog.length }),
            ),
          );
        } catch (error) {
          botsLogger.info(
            undefined,
            `bot retained backlog revival stopped at preamble bot=${bot.id} peer=${peerKey}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
      }
      const pending = backlog;
      retainedReplyBuffers.delete(key);
      let delivered = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const text = pending[index]!;
        try {
          await sendOutbound(bot, createOutbound(actor, text));
          delivered += 1;
        } catch (error) {
          if (classifyBotSendFailure(error) === "channel-dead") {
            const remainder = pending.slice(index);
            appendRetainedTexts(key, remainder, locale);
            botsLogger.info(
              undefined,
              `bot retained backlog delivery stopped channel-dead bot=${bot.id} peer=${peerKey} delivered=${delivered} retained=${remainder.length}`,
            );
            return;
          }
          // content-poison：丢弃该条 + 一次性通知（通道存活，通知可送达），继续余量。
          botsLogger.warn(
            undefined,
            `bot retained backlog message dropped as content-poison bot=${bot.id} peer=${peerKey} index=${index}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await sendOutbound(bot, createOutbound(actor, msg(locale, "replyDeliveryFailed"))).catch(
            () => undefined,
          );
        }
      }
      botsLogger.info(
        undefined,
        `bot retained backlog revival delivered bot=${bot.id} peer=${peerKey} messages=${delivered}`,
      );
    });
  }

  /**
   * M1 revival（specs/bot-message-delivery.md Retention buffer）：触发 = 该 bot+peer 的任意
   * weixin 入站（不 key 于 token 值变化——实测存在不轮换的入站，:1670 早退形态）。
   * 在入站队列内、命令处理前执行，保证积压先于新回合回复（dual-terminal re-watch 序）。
   */
  async function reviveRetainedReplies(message: BotInboundMessage): Promise<void> {
    if (message.actor.provider !== "weixin") {
      return;
    }
    const peerKey = message.actor.chatId?.trim() || message.actor.providerUserId.trim();
    if (!peerKey) {
      return;
    }
    const key = retainedBufferKey(message.botId, peerKey);
    const backlog = retainedReplyBuffers.get(key);
    if (!backlog || backlog.length === 0) {
      return;
    }
    const bot = findBot(await repo.readConfig(), message.botId);
    if (!bot) {
      return;
    }
    // §5.12a：死窗结束判定之一 = 该 peer 的 revival（任意入站触发的保留积压补发开始
    // 投递）——确有 suppressed 计数时在此输出一条汇总并清零（log-only；状态删除保证
    // 后续补发成功触发的"窗口变化"汇总不会重复输出）。
    flushDeadWindowFailureSummary(bot, peerKey);
    await deliverRetainedBacklog(bot, message.actor, { withPreamble: true });
  }

  /** /status 待补发行（保留缓冲非空期间；纯同步读，无 timer）。 */
  function buildRetainedPendingStatusLine(
    botId: string,
    actor: Pick<BotActor, "providerUserId" | "chatId"> | undefined,
    locale: Locale | undefined,
  ): string | null {
    if (!actor) {
      return null;
    }
    const peerKey = actor.chatId?.trim() || actor.providerUserId.trim();
    if (!peerKey) {
      return null;
    }
    const backlog = retainedReplyBuffers.get(retainedBufferKey(botId, peerKey));
    if (!backlog || backlog.length === 0) {
      return null;
    }
    return msg(locale, "statusPendingDelivery", {
      count: backlog.length,
      kb: (sumRetainedBufferBytes(backlog) / 1024).toFixed(1),
    });
  }

  /** alpha.5 观测：token 值 SHA-256 前 8 hex 指纹（specs/bot-provider-network.md Amendment
   * 3.14.5-alpha.5）——不可逆截断哈希；硬不变量：token 值本身永不入任何日志行。 */
  function computeWeixinTokenFingerprint(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
  }

  function getWeixinSendObservation(
    botId: string,
    peerKey: string,
  ): { burstOrdinal: number; sendTimestamps: number[]; lastReadTokenFp: string | undefined } {
    const key = retainedBufferKey(botId, peerKey);
    let observation = weixinSendObservationByPeer.get(key);
    if (!observation) {
      observation = { burstOrdinal: 0, sendTimestamps: [], lastReadTokenFp: undefined };
      weixinSendObservationByPeer.set(key, observation);
    }
    return observation;
  }

  /** alpha.5 观测：记录一次 weixin 出站发送尝试（成功/失败都计）。**每次尝试都计入波内**
   * ——序言、保留积压逐条补发、正文分块、失败通知都打到同一发送 API；2026-10-04 实测
   * -2 复发正是补发波中段（10 连发后第 11 发，handoff §2f.1/§2f.10），位次信号必须
   * 覆盖补发尝试，排除它们会使该判别在最需要的事件类上失明。
   * burstOrdinal +1；时间戳环求值时惰性裁剪 trailing 10s 窗口（>10s 滑出）——无
   * timer/daemon（§5.12 先例）。键与 sendOutbound 读持久化 token 的 peerKey 派生一致。 */
  function recordWeixinSendAttempt(
    botId: string,
    peerKey: string,
  ): { burstOrdinal: number; sendCount10s: number } {
    const observation = getWeixinSendObservation(botId, peerKey);
    observation.burstOrdinal += 1;
    const now = Date.now();
    observation.sendTimestamps = observation.sendTimestamps.filter(
      (sentAt) => now - sentAt <= 10_000,
    );
    observation.sendTimestamps.push(now);
    return {
      burstOrdinal: observation.burstOrdinal,
      sendCount10s: observation.sendTimestamps.length,
    };
  }

  /** alpha.5 观测：归零该 peer 的 burst 计数（触发：该 peer 任意入站；M2 token 失效实际
   * 生效）。sendCount10s 时间戳环不归零——trailing 窗口是事实计数，不随波次重置。 */
  function resetWeixinSendBurstOrdinal(botId: string, peerKey: string): void {
    const observation = weixinSendObservationByPeer.get(retainedBufferKey(botId, peerKey));
    if (observation) {
      observation.burstOrdinal = 0;
    }
  }

  /** alpha.5 观测：记录「该 peer 当前出站波所骑的 token 指纹」——任何为发送而读取到持久化
   * 条目的时刻刷新（含保留积压补发的读取：同一 peer 同一波语义）。失败行 fp= 优先取本次
   * 读取，无读取时回退到该上下文（-2 复发判别「同指纹自愈 vs 轮换」的观测连续性）。 */
  function noteWeixinPeerTokenRead(botId: string, peerKey: string, fp: string): void {
    getWeixinSendObservation(botId, peerKey).lastReadTokenFp = fp;
  }

  function readWeixinPeerTokenFingerprint(botId: string, peerKey: string): string | undefined {
    return weixinSendObservationByPeer.get(retainedBufferKey(botId, peerKey))?.lastReadTokenFp;
  }

  /** alpha.5 观测：波内发送的 ret=-2 使 M2 失效实际生效时，清除波上下文的 token 指纹
   * （条目已删除，后续无读取的失败线不得再携带其旧指纹；下次为发送读取到新条目时重新
   * 刷新——判别「同指纹自愈 vs 轮换」的观测连续性由此保持）。 */
  function clearWeixinPeerTokenFingerprint(botId: string, peerKey: string): void {
    const observation = weixinSendObservationByPeer.get(retainedBufferKey(botId, peerKey));
    if (observation) {
      observation.lastReadTokenFp = undefined;
    }
  }

  // ---- alpha.7 §5.12a（specs/log-diagnostics-hygiene.md Amendment 3.14.5-alpha.7）：
  // 死窗（channel-dead）失败行限频。仅日志密度变化，零行为变化；计数语义（burstOrdinal/
  // sendCount10s/fp 每次尝试仍计数）不变，只是行的发射被合并。无 timer：惰性时间戳比较
  //（先例：weixin typing warn 30s、zcodeTaskIndexSyncer topic-subscribe 60s）。 ----

  /** §5.12a 最小发射间隔：死窗内同 peer 的失败线合并到 30s 一条。 */
  const BOT_DEAD_WINDOW_FAILURE_LOG_MIN_INTERVAL_MS = 30_000;

  function deadWindowFailureLogKey(botId: string, peerKey: string): string {
    return `${botId}:${peerKey}`;
  }

  /** 出站 peer 键（与 createOutbound/失败线 peer= 同口径：chatId 优先、providerUserId 兜底）。 */
  function resolveOutboundPeerKey(actor: Pick<BotActor, "providerUserId" | "chatId">): string {
    return actor.chatId?.trim() || actor.providerUserId.trim();
  }

  /** §5.12a：死窗失败线发射裁决。窗口内第一条照常发射；30s 内后续合并计数不发射。
   *  返回 suppressed = 自上一条发射线以来已合并的条数（>=1 时随下一条件输出：
   *  到期后的新失败线或死窗汇总行）。 */
  function admitDeadWindowFailureLine(
    botId: string,
    peerKey: string,
    nowMs: number,
  ): { emit: true; suppressed: number } | { emit: false } {
    const key = deadWindowFailureLogKey(botId, peerKey);
    const state = deadWindowFailureLogStates.get(key);
    if (!state || nowMs - state.lastEmitAtMs >= BOT_DEAD_WINDOW_FAILURE_LOG_MIN_INTERVAL_MS) {
      const suppressed = state?.suppressedSinceLastEmit ?? 0;
      deadWindowFailureLogStates.set(key, { lastEmitAtMs: nowMs, suppressedSinceLastEmit: 0 });
      return { emit: true, suppressed };
    }
    state.suppressedSinceLastEmit += 1;
    return { emit: false };
  }

  /** §5.12a：死窗结束（该 peer 的 revival 保留积压开始投递，或下一次发送结果不再判
   *  channel-dead）——确有 suppressed 计数时输出一条 info 汇总并清零；零合并时静默
   *  清态。汇总行是 per 死窗一次（状态删除保证 revival + 发送成功两触发点不重复）。 */
  function flushDeadWindowFailureSummary(bot: BotConfig, peerKey: string): void {
    const key = deadWindowFailureLogKey(bot.id, peerKey);
    const state = deadWindowFailureLogStates.get(key);
    if (!state) {
      return;
    }
    deadWindowFailureLogStates.delete(key);
    if (state.suppressedSinceLastEmit > 0) {
      botsLogger.info(
        undefined,
        `bot outbound dead-window summary provider=${bot.provider} peer=${peerKey} suppressed=${state.suppressedSinceLastEmit}`,
      );
    }
  }

  async function sendOutbound(
    bot: BotConfig,
    message: BotOutboundMessage,
    opts?: { retainOnChannelDead?: boolean },
  ): Promise<void> {
    const adapter = providers[bot.provider];
    if (!adapter) {
      return;
    }
    // Bugfix（specs/bot-provider-network.md Alpha 1 F4）：微信文本发送此前沿用 watcher 捕获的
    // actor token——长任务（>~40min 无入站）后 token 过期，完成消息发送直接失败被丢。
    // 与媒体路径（deliverWorkspaceFile tool 分支）对齐：发送前优先读最新持久化 token
    // （任何入站 ping 都会刷新该表），捕获 token 只作兜底；ret=-2 无 token 重试仍由
    // provider 兜底。peerKey 与持久化写入侧一致（chatId 优先）。
    //
    // alpha.2 观测（specs/bot-message-delivery.md F10 amendment）：sendOutbound 是两条
    // 出站路径（缓冲流式回复 + 终态文书）的唯一汇合点，每次调用记一条结果线——成功
    // info、失败 warn 附打标字段与 tokenAgeMs（探针测 TTL 的双侧数据：成功侧给出
    // "仍有效"下界，失败侧给出"已失效"上界）。失败照常上抛，零行为变化。
    let outbound = message;
    let tokenAgeMs: number | undefined;
    // M2：本次发送实际尝试的持久化 token（与 tokenAgeMs 同点捕获）——ret=-2 失效的防复活
    // 竞态凭据；无持久化条目（未覆盖 captured token）时为 undefined，无可失效。
    let attemptedWeixinEntryToken: string | undefined;
    // alpha.5 观测：与 tokenAgeMs 同点（读取过持久化条目才出现）的 token 指纹——失败行
    // fp= 字段的首选数据源；token 值本身永不入日志（硬不变量，测试钉死）。
    let attemptedWeixinTokenFp: string | undefined;
    if (bot.provider === "weixin") {
      const entry = await readPersistedWeixinPeerTokenEntry(bot.id, message.providerUserId);
      if (entry?.token) {
        outbound = { ...message, providerContextToken: entry.token };
        tokenAgeMs = Date.now() - entry.updatedAt;
        attemptedWeixinEntryToken = entry.token;
        attemptedWeixinTokenFp = computeWeixinTokenFingerprint(entry.token);
        noteWeixinPeerTokenRead(bot.id, message.providerUserId.trim(), attemptedWeixinTokenFp);
      }
    }
    // alpha.5 观测：weixin 每次出站发送尝试（成功/失败都计，含积压补发——见
    // recordWeixinSendAttempt 注释）记录 burst 序号与 trailing-10s 计数——成功行不带
    // 这些字段（tokenAgeMs 语义不变），仅失败行随行输出（log-only）。
    const weixinSendStats =
      bot.provider === "weixin"
        ? recordWeixinSendAttempt(bot.id, message.providerUserId.trim())
        : undefined;
    const bytes = Buffer.byteLength(message.text ?? "", "utf8");
    const ageSuffix = tokenAgeMs !== undefined ? ` tokenAgeMs=${tokenAgeMs}` : "";
    try {
      await adapter.send(bot, outbound);
      // §5.12a：发送成功 = 分类窗口变化（该 peer 不再判 channel-dead）——确有死窗
      // 合并计数时补一条汇总行并清零（log-only）。
      const successPeerKey = message.providerUserId.trim();
      if (successPeerKey) {
        flushDeadWindowFailureSummary(bot, successPeerKey);
      }
      botsLogger.info(
        undefined,
        `bot outbound send provider=${bot.provider} peer=${message.providerUserId} bytes=${bytes} ok${ageSuffix}`,
      );
    } catch (error) {
      const tagged = error as {
        weixinRet?: number;
        weixinErrcode?: number;
        weixinHttpStatus?: number;
      };
      const fields = [
        tagged.weixinRet !== undefined ? `ret=${tagged.weixinRet}` : "",
        tagged.weixinErrcode !== undefined ? `errcode=${tagged.weixinErrcode}` : "",
        tagged.weixinHttpStatus !== undefined ? `httpStatus=${tagged.weixinHttpStatus}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      // alpha.5 观测：weixin 失败行附 burstOrdinal/sendCount10s；fp 优先取本次读取，
      // 无读取时回退到该 peer 波上下文的最近读取指纹（观测连续性），波上下文为空
      // （如 M2 失效已清除）则缺席。
      const weixinFp =
        bot.provider === "weixin"
          ? (attemptedWeixinTokenFp ??
            readWeixinPeerTokenFingerprint(bot.id, message.providerUserId.trim()))
          : undefined;
      const weixinObservationSuffix =
        bot.provider === "weixin"
          ? `${weixinSendStats ? ` burstOrdinal=${weixinSendStats.burstOrdinal} sendCount10s=${weixinSendStats.sendCount10s}` : ""}${weixinFp ? ` fp=${weixinFp}` : ""}`
          : "";
      // §5.12a：channel-dead 分类才限频（死窗内 30s 合并为一条；首条照常输出，后续行
      // 计数不发射，下一条件携带 suppressed=）。content-poison 等其它分类永不限频、
      // 逐条输出，且作为分类窗口变化冲刷死窗汇总（若有）。计数语义（burstOrdinal/
      // sendCount10s/fp 每次尝试仍计数）不变——recordWeixinSendAttempt 在上方已无条件记账。
      const failurePeerKey = message.providerUserId.trim();
      const deadWindowAdmission =
        failurePeerKey && classifyBotSendFailure(error) === "channel-dead"
          ? admitDeadWindowFailureLine(bot.id, failurePeerKey, Date.now())
          : undefined;
      if (deadWindowAdmission === undefined && failurePeerKey) {
        flushDeadWindowFailureSummary(bot, failurePeerKey);
      }
      if (deadWindowAdmission?.emit !== false) {
        botsLogger.warn(
          undefined,
          `bot outbound send provider=${bot.provider} peer=${message.providerUserId} bytes=${bytes} failed${ageSuffix}${weixinObservationSuffix}${deadWindowAdmission?.suppressed ? ` suppressed=${deadWindowAdmission.suppressed}` : ""}${fields ? ` ${fields}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Bugfix（M1 缝隙，specs/bot-message-delivery.md 3.14.5-alpha.4）：sendOutbound 是
      // 缓冲 flush 与终态文书直发（16:42 丢失类）的唯一汇合失败缝隙。channel-dead 类失败
      // 且调用方选择保留（flush 分块 / 终态文书直发）时，文本进入 per-peer 保留缓冲等待
      // revival 补发——死通道上重试与通知都必然失败（§8.7）。错误照常上抛，调用方形状不变。
      if (opts?.retainOnChannelDead && classifyBotSendFailure(error) === "channel-dead") {
        const peerKey = message.providerUserId.trim();
        if (peerKey) {
          // Review 收口：保留动作自身不得掩盖原始发送错误（与 M2 失效同规则包裹）。
          await retainReplyTexts(bot, peerKey, [message.text ?? ""]).catch((retainError) => {
            botsLogger.warn(
              undefined,
              `bot retained reply enqueue failed bot=${bot.id} peer=${peerKey}: ${retainError instanceof Error ? retainError.message : String(retainError)}`,
            );
          });
        }
      }
      // Bugfix（M2，specs/bot-provider-network.md 3.14.5-alpha.4 实测块）：weixin ret=-2 即
      // 失效凭据——删除本次发送实际尝试的持久化 peer token 条目（防复活竞态：在途被并发入站
      // 刷新的新 token 保留）。瞬时 -2 的短暂丢失是已接受权衡（条目缺席时任何入站无条件重新
      // 持久化）；失效不是 revival 触发（不触碰保留缓冲）；失效自身不得掩盖原始错误（包裹
      // try/catch），也永不记录 token 值。
      if (bot.provider === "weixin" && tagged.weixinRet === -2 && attemptedWeixinEntryToken) {
        const invalidationPeerKey = message.providerUserId.trim();
        try {
          const invalidated = await invalidateWeixinContextTokenForPeer(
            bot.id,
            invalidationPeerKey,
            attemptedWeixinEntryToken,
          );
          if (invalidated) {
            // alpha.5 观测：M2 失效实际生效 ⇒ 该 peer 的 burst 计数归零重开，并清除波
            // 上下文的 token 指纹（条目已删，后续无读取的失败线不得携带旧指纹；下次
            // 读取到新条目时重新刷新）。specs/log-diagnostics-hygiene.md Amendment
            // 3.14.5-alpha.5，log-only。
            resetWeixinSendBurstOrdinal(bot.id, invalidationPeerKey);
            clearWeixinPeerTokenFingerprint(bot.id, invalidationPeerKey);
            botsLogger.info(
              undefined,
              `bot weixin context token invalidated on ret=-2 bot=${bot.id} peer=${invalidationPeerKey}`,
            );
          }
        } catch (invalidationError) {
          botsLogger.warn(
            undefined,
            `bot weixin context token invalidation failed bot=${bot.id}: ${invalidationError instanceof Error ? invalidationError.message : String(invalidationError)}`,
          );
        }
      }
      throw error;
    }
  }

  function buildInboundDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  // specs/bot-inbound-resilience.md §B.1(b)/§B2：入站消息业务失败后，若会话失败信号
  // （respondElicitation decline+failureReason 等）已“确认送达”到会话，则该消息视为已消费。
  // Worker C（B2 wiring）在 resolve 成功后调用 markInboundSessionSignalConfirmed 标记；
  // 键与 markInboundDelivery 的去重键同构，随同一 2 分钟 TTL 清理，无新 timer。
  const inboundSessionSignalConfirmedKeys = new Set<string>();

  function markInboundSessionSignalConfirmed(message: BotInboundMessage): void {
    const deliveryKey = buildInboundDeliveryKey(message);
    if (deliveryKey) {
      inboundSessionSignalConfirmedKeys.add(deliveryKey);
    }
  }

  function isInboundSessionSignalConfirmed(message: BotInboundMessage): boolean {
    const deliveryKey = buildInboundDeliveryKey(message);
    // 一次性读取即删除（review 2026-10-03）：标记只对应"本次失败判定"这一次消费。
    // 若业务处理慢于 2 分钟 TTL，去重键可能先被 prune 而标记残留——delete-on-read
    // 保证孤儿标记不会把同 id 的后续重投误判为 consumed-session-confirmed。
    if (deliveryKey === null) {
      return false;
    }
    if (!inboundSessionSignalConfirmedKeys.has(deliveryKey)) {
      return false;
    }
    inboundSessionSignalConfirmedKeys.delete(deliveryKey);
    return true;
  }

  async function enqueueInboundProcessing<T>(actor: BotActor, task: () => Promise<T>): Promise<T> {
    const actorContextKey = getActorContextKey(actor);
    const previous = inboundProcessingQueuesByContext.get(actorContextKey) ?? Promise.resolve();
    let releaseQueue = (): void => undefined;
    const current = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseQueue = resolve;
          }),
      );
    inboundProcessingQueuesByContext.set(actorContextKey, current);
    await previous.catch(() => undefined);
    try {
      // Bugfix: 同一个用户可能连续点击 AskUserQuestion 按钮或快速回复多条消息。
      // 这里按 actor 串行化入站处理，避免两个并发请求同时读取同一个 pendingElicitation 并重复 respondElicitation。
      return await task();
    } finally {
      releaseQueue();
      if (inboundProcessingQueuesByContext.get(actorContextKey) === current) {
        inboundProcessingQueuesByContext.delete(actorContextKey);
      }
    }
  }

  function pruneRecentInboundDeliveryDedupe(now: number): void {
    for (const [key, at] of recentInboundDeliveryAtByKey) {
      if (now - at >= BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS) {
        recentInboundDeliveryAtByKey.delete(key);
        // specs/bot-inbound-resilience.md §B.1(b)：会话信号确认标记与去重键同生命周期，
        // 随同一次 TTL 清理过期，避免集合无界增长（无新 timer）。
        inboundSessionSignalConfirmedKeys.delete(key);
      }
    }
  }

  function markInboundDelivery(message: BotInboundMessage): boolean {
    const now = Date.now();
    pruneRecentInboundDeliveryDedupe(now);
    const deliveryKey = buildInboundDeliveryKey(message);
    if (!deliveryKey) {
      return true;
    }
    if (recentInboundDeliveryAtByKey.has(deliveryKey)) {
      return false;
    }
    // Bugfix: 飞书 WebSocket 可能重投同一条 im.message.receive_v1，微信/Telegram 也可能在重试后重放同一 message id。
    // 普通消息有创建/发送任务的副作用，必须在进入业务处理前按 provider message id 幂等，避免同一句 hello 被执行两轮。
    recentInboundDeliveryAtByKey.set(deliveryKey, now);
    return true;
  }

  async function sendTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.sendTyping || !targetId) {
      return;
    }
    await adapter
      .sendTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  async function stopInboundTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.stopTyping || !targetId || !actor.providerMessageId) {
      return;
    }
    const isLongRunningTyping = Array.from(typingTargets.values()).some(
      (typing) =>
        typing.bot.id === bot.id && typing.target.providerMessageId === actor.providerMessageId,
    );
    if (isLongRunningTyping) {
      return;
    }
    // Bugfix: 飞书 sendTyping 只负责给本次入站消息加 Typing reaction。
    // 短命令回复发送完成后必须按同一 messageId 显式删除，避免依赖定时兜底或等下一条命令清理。
    await adapter
      .stopTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  function startTyping(bot: BotConfig, actor: BotActor, taskId: string): void {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter || !targetId || typingTargets.has(taskId) || typingIntervals.has(taskId)) {
      return;
    }
    const target: BotTypingTarget = {
      providerUserId: targetId,
      providerMessageId: actor.providerMessageId,
      providerContextToken: actor.providerContextToken,
    };
    if (adapter.startTyping) {
      typingTargets.set(taskId, { bot, target });
      void adapter.startTyping(bot, target).catch(() => undefined);
      return;
    }
    if (adapter.sendTyping) {
      void adapter.sendTyping(bot, target).catch(() => undefined);
      typingIntervals.set(
        taskId,
        setInterval(() => {
          void adapter.sendTyping?.(bot, target).catch(() => undefined);
        }, BOT_TYPING_INTERVAL_MS),
      );
    }
  }

  function stopTyping(taskId: string): void {
    const activeTyping = typingTargets.get(taskId);
    if (activeTyping) {
      typingTargets.delete(taskId);
      const adapter = providers[activeTyping.bot.provider];
      void adapter?.stopTyping?.(activeTyping.bot, activeTyping.target).catch(() => undefined);
    }
    const intervalId = typingIntervals.get(taskId);
    if (!intervalId) {
      return;
    }
    clearInterval(intervalId);
    typingIntervals.delete(taskId);
  }

  /**
   * F1（specs/bot-message-delivery.md）单一 drain owner：终态处理、/stop、stale 清理和
   * 服务 dispose 四个法定调用点都经由这里拆除 watcher。drain 闭包（watchTaskStream 注册）
   * 依次：force-flush 未送出正文 → 清 live 进度 → 队列外停 typing → 拆订阅。
   * 本函数绝不 enqueue 到 streamEventQueue——串行队列被挂起时 /stop 的 drain 仍即时执行；
   * drain 之后 streamSubscriptions 不再有该键，下一次 watchTaskStream 必然建立全新 watcher。
   */
  async function disposeTaskWatcher(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
    reason: BotTaskWatcherDisposeReason,
  ): Promise<void> {
    const key = [getWorkspaceKey(context.workspacePath, context.workspaceIdentity), taskId].join(
      "::",
    );
    const watcher = taskWatcherDisposals.get(key);
    if (!watcher) {
      return;
    }
    taskWatcherDisposals.delete(key);
    botsLogger.info(undefined, `bot task watcher dispose task=${taskId} reason=${reason}`);
    await watcher.dispose(reason);
  }

  function updateLiveStatusProgress(event: ZCodeStreamEvent): void {
    if (event.type === "agent_message_chunk" || event.type === "agent_thought_chunk") {
      const text = normalizeStatusProgressText(event.content);
      if (!text) {
        return;
      }
      const kind = event.type === "agent_message_chunk" ? "message" : "thought";
      const previous = liveStatusProgressByTaskId.get(event.taskId);
      liveStatusProgressByTaskId.set(event.taskId, {
        kind,
        text: truncateLiveStatusProgressText(
          previous?.kind === kind ? `${previous.text}${text}` : text,
        ),
      });
      return;
    }
    if (event.type === "tool_call" || event.type === "tool_call_update") {
      const text = formatStatusStreamToolProgress(event);
      if (text) {
        liveStatusProgressByTaskId.set(event.taskId, { kind: "tool", text });
      }
    }
  }

  async function broadcastTaskListChange(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
    event: BotTaskBroadcastPayload["event"],
    extras: Partial<
      Pick<
        BotTaskBroadcastPayload,
        | "task"
        | "provider"
        | "configOptions"
        | "prompt"
        | "permissionRequest"
        | "elicitationRequest"
        | "requestId"
        | "error"
      >
    > = {},
  ): Promise<void> {
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          taskId,
          event,
          updatedAt: Date.now(),
          ...extras,
        },
      })
      .catch(() => undefined);
  }

  async function broadcastTaskStreamEvent(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    event: ZCodeStreamEvent,
  ): Promise<void> {
    const payload: BotTaskStreamBroadcastPayload = {
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      taskId: event.taskId,
      event,
      updatedAt: Date.now(),
    };
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_STREAM_BROADCAST_CHANNEL,
        payload,
      })
      .catch(() => undefined);
  }

  async function listWorkspaceRefs(
    params: BotListWorkspaceRefsParams = {},
  ): Promise<BotWorkspaceRef[]> {
    const cacheKey = params.currentWorkspace
      ? getWorkspaceKey(
          params.currentWorkspace.workspacePath,
          params.currentWorkspace.workspaceIdentity,
        )
      : "__default__";
    const nowMs = Date.now();
    const cached = cachedWorkspaceRefsByKey.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value;
    }
    const workspaceByKey = new Map<string, BotWorkspaceRef>();
    if (params.currentWorkspace) {
      workspaceByKey.set(
        getWorkspaceKey(
          params.currentWorkspace.workspacePath,
          params.currentWorkspace.workspaceIdentity,
        ),
        params.currentWorkspace,
      );
    }

    const settings = await deps.settingService?.get().catch(() => null);
    for (const entry of settings?.lastWorkspaceSession ?? []) {
      const workspace = createWorkspaceRef(
        entry.workspacePath,
        entry.kind === "remote" ? entry.workspaceIdentity : undefined,
      );
      workspaceByKey.set(
        getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
        workspace,
      );
    }

    const value = [...workspaceByKey.values()];
    cachedWorkspaceRefsByKey.set(cacheKey, {
      expiresAt: nowMs + BOT_WORKSPACE_REFS_CACHE_TTL_MS,
      value,
    });
    return value;
  }

  function resolveCanonicalContextWorkspace(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "workspaceId">,
    workspaces: readonly BotWorkspaceRef[],
  ): BotWorkspaceRef | null {
    const currentWorkspaceKey = getWorkspaceKey(context.workspacePath, context.workspaceIdentity);
    const exactWorkspace = workspaces.find(
      (workspace) =>
        getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity) ===
        currentWorkspaceKey,
    );
    if (exactWorkspace) {
      return exactWorkspace;
    }
    if (context.workspaceId) {
      const workspaceById = workspaces.find((workspace) => workspace.id === context.workspaceId);
      if (workspaceById) {
        return workspaceById;
      }
    }
    // Bugfix: path-only 旧状态只能靠 path 候选回填 remote identity。
    // 这里只在同 path 候选唯一时才升级，避免把两个不同 remote workspace 错绑到同一身份。
    // 已经带 workspaceIdentity 的远端 context 不能被同路径本地候选降级，否则 /workspace 会丢失远端项。
    if (context.workspaceIdentity) {
      return null;
    }
    const samePathWorkspaces = workspaces.filter(
      (workspace) => workspace.workspacePath === context.workspacePath,
    );
    return samePathWorkspaces.length === 1 ? samePathWorkspaces[0]! : null;
  }

  async function normalizeBotWorkspaceConfig(
    config: BotsConfigFile,
    bot: BotConfig,
    currentWorkspace?: BotWorkspaceRef,
  ): Promise<{
    config: BotsConfigFile;
    bot: BotConfig;
    user: BotConfig;
    workspaces: BotWorkspaceRef[];
  }> {
    const workspaces = await listWorkspaceRefs({ currentWorkspace });
    const nextAllowedWorkspaces = normalizeConfiguredAllowedWorkspaces(
      bot.allowedWorkspaces,
      workspaces,
    );
    const nextBot: BotConfig = {
      ...bot,
      // Bugfix: workspace 候选项现在来自 settings.lastWorkspaceSession，不再写入 bot-config.json。
      // 这里顺手把旧的 path-only workspace 授权升级成 workspaceIdentity key，避免 remote context 自愈后
      // 授权侧还停留在旧路径语义，导致消息链路被误判成 workspaceOutOfScope。
      allowedWorkspaces: nextAllowedWorkspaces,
    };
    const nextConfig: BotsConfigFile = {
      ...config,
      bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
    };
    const shouldWrite = nextBot.allowedWorkspaces.join("\n") !== bot.allowedWorkspaces.join("\n");
    if (shouldWrite) {
      await repo.writeConfig(nextConfig);
    }
    return { config: nextConfig, bot: nextBot, user: nextBot, workspaces };
  }

  async function readTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
  ): Promise<ZCodeTaskMeta | null> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    return tasks.find((task) => task.taskId === taskId) ?? null;
  }

  async function listContextTaskSelectionEntries(
    context: BotContextState,
    user: BotConfig,
  ): Promise<BotTaskSelectionEntry[]> {
    const currentWorkspace = createWorkspaceRef(context.workspacePath, context.workspaceIdentity);
    const currentWorkspaceKey = getWorkspaceKey(context.workspacePath, context.workspaceIdentity);
    const workspaceRefs = await listWorkspaceRefs({ currentWorkspace });
    const allowedWorkspaces = filterAllowedWorkspaces(workspaceRefs, user.allowedWorkspaces);
    const candidateWorkspaces = allowedWorkspaces.filter((workspace) => {
      const workspaceKey = getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity);
      return (
        workspaceKey === currentWorkspaceKey ||
        (!context.workspaceIdentity && workspace.workspacePath === context.workspacePath)
      );
    });
    const workspaces = candidateWorkspaces.length > 0 ? candidateWorkspaces : [currentWorkspace];
    const entries = (
      await Promise.all(
        workspaces.map(async (workspace) => {
          const zcodeTaskService = await resolveZCodeTaskServiceForContext(workspace);
          const tasks = await zcodeTaskService
            .listTasks({
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
            })
            .catch(() => []);
          return tasks.map((task) => ({
            task,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          }));
        }),
      )
    ).flat();
    const entryByKey = new Map<string, BotTaskSelectionEntry>();
    for (const entry of entries) {
      entryByKey.set(
        `${getWorkspaceKey(entry.workspacePath, entry.workspaceIdentity)}:${entry.task.taskId}`,
        entry,
      );
    }
    return [...entryByKey.values()];
  }

  function resolvePendingTaskSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotTaskSelectionEntry | null {
    const actorContextKey = getActorContextKey(actor);
    const directEntry = pendingTaskSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = resolvePendingSelectionOption(actor, "task.set", value);
    if (!option) {
      return null;
    }
    return pendingTaskSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function resolvePendingWorkspaceSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotWorkspaceSelectionEntry | null {
    const actorContextKey = getActorContextKey(actor);
    const directEntry = pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = resolvePendingSelectionOption(actor, "workspace.set", value);
    if (!option) {
      return null;
    }
    return pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function createCurrentWorkspaceRef(context: BotContextState): BotWorkspaceRef {
    return createWorkspaceRef(context.workspacePath, context.workspaceIdentity);
  }

  async function readContextActiveTaskMeta(
    context: BotContextState,
  ): Promise<ZCodeTaskMeta | null> {
    if (!context.activeTaskId) {
      return null;
    }
    const listedTask = await readTaskMeta(context, context.activeTaskId).catch(() => null);
    if (listedTask) {
      return listedTask;
    }
    return (
      (
        await (
          await resolveZCodeTaskServiceForContext(context)
        )
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      )?.meta ?? null
    );
  }

  async function requireActiveTask(
    message: BotInboundMessage,
    auth: {
      context: BotContextState;
      locale: Locale | undefined;
    },
  ): Promise<
    | {
        ok: true;
        taskId: string;
        task: ZCodeTaskMeta;
        configOptions: ZCodeConfigOption[];
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    if (!auth.context.activeTaskId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    const task = await readContextActiveTaskMeta(auth.context);
    if (!task) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    const configOptions = await listActiveTaskConfigOptions(
      auth.context,
      auth.context.activeTaskId,
    );
    return {
      ok: true,
      taskId: auth.context.activeTaskId,
      task,
      configOptions,
    };
  }

  async function broadcastTaskConfigSync(params: {
    context: BotContextState;
    taskId: string;
    task?: ZCodeTaskMeta | null;
    provider?: ZCodeProvider;
    configOptions?: ZCodeConfigOption[];
  }): Promise<void> {
    await broadcastTaskListChange(params.context, params.taskId, "updated", {
      ...(params.task ? { task: params.task } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.configOptions ? { configOptions: params.configOptions } : {}),
    });
  }

  function isTerminalTaskMeta(
    task: ZCodeTaskMeta | null,
    eventType: "task_complete" | "task_error",
  ): boolean {
    if (!task) {
      return false;
    }
    if (eventType === "task_error") {
      return task.status === "error";
    }
    return task.status === "completed";
  }

  async function readTerminalTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
    eventType: "task_complete" | "task_error",
  ): Promise<ZCodeTaskMeta | null> {
    let latestTask = await readTaskMeta(context, taskId).catch(() => null);
    if (isTerminalTaskMeta(latestTask, eventType)) {
      return latestTask;
    }

    for (const retryDelayMs of BOT_TASK_META_RETRY_DELAYS_MS) {
      await delay(retryDelayMs);
      latestTask = await readTaskMeta(context, taskId).catch(() => latestTask);
      if (isTerminalTaskMeta(latestTask, eventType)) {
        return latestTask;
      }
    }

    return latestTask;
  }

  async function processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult> {
    const adapter = providers[provider];
    if (!adapter) {
      return { ok: false, replies: [], status: 400 };
    }
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const callbackBot = findCallbackBot(config, provider, payload);
    const preparedPayload = callbackBot
      ? ((await adapter.prepareCallbackPayload?.(callbackBot, payload).catch((error: unknown) => ({
          zcodeCallbackPrepareError: error instanceof Error ? error.message : String(error),
        }))) ?? payload)
      : payload;
    if (
      isRecord(preparedPayload) &&
      typeof preparedPayload.zcodeCallbackPrepareError === "string"
    ) {
      return {
        ok: false,
        replies: [],
        responseBody: { error: preparedPayload.zcodeCallbackPrepareError },
        status: 401,
      };
    }
    const callbackResponse = callbackBot
      ? await adapter.handleCallbackResponse?.(callbackBot, preparedPayload)
      : null;
    if (callbackResponse?.responseBody !== undefined) {
      return {
        ok: (callbackResponse.status ?? 200) < 400,
        replies: [],
        responseBody: callbackResponse.responseBody,
        status: callbackResponse.status,
      };
    }
    const parsePayload =
      isFeishuBotProvider(provider) && isRecord(preparedPayload)
        ? { zcodeProvider: provider, ...preparedPayload }
        : preparedPayload;
    const parsedInboundMessages = adapter.parseCallback(parsePayload);
    if (isFeishuBotProvider(provider)) {
      // Bugfix: 飞书 WebSocket connected 只代表长连接已建成，不代表事件订阅已经推到本机。
      // 这里记录入口 payload 摘要和解析数量，方便区分“飞书未推事件”和“payload 形状未被解析”。
      botsLogger.debug(
        undefined,
        `provider callback parsed provider=${provider} count=${parsedInboundMessages.length} ${summarizeCallbackPayload(preparedPayload)}`,
      );
    }
    const replies: BotOutboundMessage[] = [];
    let hadUnconsumedFailure = false;
    const inboundSecret =
      isRecord(preparedPayload) && typeof preparedPayload.webhookSecret === "string"
        ? preparedPayload.webhookSecret
        : undefined;
    for (const inbound of parsedInboundMessages) {
      const bot = findBot(config, inbound.botId);
      if (bot?.provider === "webhook" && bot.webhookSecretRef) {
        const expectedSecret = await deps.credentialService.load(bot.webhookSecretRef);
        if (expectedSecret && expectedSecret !== inboundSecret) {
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      if (bot && isFeishuBotProvider(bot.provider) && bot.webhookSecretRef) {
        const expectedToken = await deps.credentialService.load(bot.webhookSecretRef);
        const payloadHeader =
          isRecord(preparedPayload) && isRecord(preparedPayload.header)
            ? preparedPayload.header
            : null;
        const inboundToken =
          isRecord(preparedPayload) && typeof preparedPayload.token === "string"
            ? preparedPayload.token
            : typeof payloadHeader?.token === "string"
              ? payloadHeader.token
              : undefined;
        if (expectedToken && expectedToken !== inboundToken) {
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      let inboundMessage = inbound;
      if (bot && !inbound.actor.displayName && adapter.resolveActorDisplayName) {
        try {
          const displayName = await adapter.resolveActorDisplayName(bot, inbound.actor);
          if (displayName?.trim()) {
            inboundMessage = {
              ...inbound,
              actor: {
                ...inbound.actor,
                displayName: displayName.trim(),
              },
            };
          }
        } catch (error) {
          // Bugfix: 飞书 displayName 需要额外通讯录权限，权限缺失时不能阻断消息处理和绑定。
          botsLogger.debug(
            undefined,
            `resolve actor displayName failed provider=${provider} bot=${inbound.botId} user=${inbound.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!markInboundDelivery(inboundMessage)) {
        botsLogger.info(
          undefined,
          `provider callback duplicated provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
        );
        continue;
      }
      botsLogger.info(
        undefined,
        `provider callback provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId} displayName=${inboundMessage.actor.displayName ?? ""} text=${inboundMessage.text}`,
      );
      let outbound: BotOutboundMessage[];
      let reconnectStartingReply: BotOutboundMessage | null = null;
      let inboundBusinessFailure = false;
      // specs/bot-inbound-resilience.md §B2.1 入站方向：业务失败原因需传入下方失败分支，
      // 作为 decline+failureReason 会话失败信号的 failureReason 载荷。
      let inboundBusinessFailureMessage = "";
      try {
        const command = parseBotCommand(inboundMessage.text);
        if (bot && command.type === "reconnect") {
          outbound = await handleReconnect(inboundMessage, {
            onReconnectStart: async (auth) => {
              reconnectStartingReply = createOutbound(
                inboundMessage.actor,
                msg(auth.locale, "remoteReconnectStarting", {
                  workspacePath: auth.context.workspacePath,
                }),
              );
              await sendOutbound(bot, reconnectStartingReply);
            },
          });
        } else {
          outbound = await service.handleInboundMessage(inboundMessage);
        }
      } catch (error) {
        // specs/bot-inbound-resilience.md §C：业务失败不再释放入站去重键——键随既有
        // 2 分钟 TTL 过期，同 id 重投被去重吞并（配合 §B.2 的一次重投周期静默丢弃）；
        // 用户修复后的真实重试是新 provider message id，永不误伤。
        // 是否计入未消费失败（最终 ok=false）由下方 failure 分支的 consumed 判定决定。
        inboundBusinessFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        inboundBusinessFailureMessage = message;
        const userFacingMessage = formatUserFacingBotError(error, locale);
        botsLogger.warn(
          undefined,
          `provider callback failed provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId}: ${message}`,
        );
        outbound = [
          // [ulw] 评审修复（MINOR-1）：prepare/后续流程中途失败时已累积的附件通知
          // 前置送达（>4 提示与逐文件拒绝不因半途失败蒸发），失败回复本身不变。
          ...takeBotNoticeRepliesFrom(error),
          createOutbound(
            inboundMessage.actor,
            isSessionExpiredError(error)
              ? userFacingMessage
              : msg(locale, "callbackFailed", { message: userFacingMessage }),
          ),
        ];
      }
      if (reconnectStartingReply) {
        replies.push(reconnectStartingReply);
      }
      replies.push(...outbound);
      if (inboundBusinessFailure) {
        // specs/bot-inbound-resilience.md §B2.1 入站方向（先于 consumed 判定）：
        // pending 存在时所有文本即回答路径——回答处理失败时，若该 actor 的 context
        // 存在 owned pendingElicitation，同样以 decline+failureReason resolve（复用
        // respondElicitation seam，无新 wire 类型；整组一次 resolve，无逐题机械）。
        // resolve 确认（confirmed）⇒ markInboundSessionSignalConfirmed，下方 consumed
        // 判定按 B1(b) 分支计为已消费。resolve 的用户侧回复不进入本分支的失败通知
        // 机械（通知发送与计数保持 Worker A 契约不变，replies 丢弃）。
        if (bot) {
          try {
            const failureContext = await readContext(inboundMessage.actor, bot);
            const failurePending = failureContext?.pendingElicitation;
            if (
              failureContext &&
              failurePending &&
              isPendingElicitationOwnedByActor(failurePending, inboundMessage.actor)
            ) {
              const resolved = await submitPendingElicitation(
                { bot, context: failureContext, locale },
                inboundMessage.actor,
                failurePending,
                "decline",
                { failureReason: `answer processing failed: ${inboundBusinessFailureMessage}` },
              );
              if (resolved.confirmed) {
                markInboundSessionSignalConfirmed(inboundMessage);
                botsLogger.info(
                  undefined,
                  `bot inbound failure resolved session signal provider=${provider} bot=${inboundMessage.botId} task=${failurePending.taskId} requestId=${failurePending.requestId}`,
                );
              }
            }
          } catch (sessionSignalError) {
            // resolve 本身失败（如会话链路也断）：pending 保持，consumed 判定回落到
            // 通知送达/洞规则；不吞错因——一行 warn 留痕。
            botsLogger.warn(
              undefined,
              `bot inbound failure session signal resolve failed provider=${provider} bot=${inboundMessage.botId}: ${sessionSignalError instanceof Error ? sessionSignalError.message : String(sessionSignalError)}`,
            );
          }
        }
        // specs/bot-inbound-resilience.md §B.1：失败消息的 consumed 判定只认“确认送达”：
        // (a) 失败通知 sendOutbound 成功；或 (b) 会话失败信号确认（B2 hook）。“尝试过”不算。
        // consumed ⇒ 消息计入已处理：本条 continue（批内后续消息继续），最终 ok=true 让
        // runtime 照常提交游标（weixin buf / telegram offset / feishu ACK——失败带通知即 ACK，
        // 旧交互按钮可能残留，requestId first-wins 使其无害，spec §B.5 接受）。
        let noticeDeliveredCount = 0;
        if (bot) {
          for (const outboundMessage of outbound) {
            await sendOutbound(bot, outboundMessage)
              .then(() => {
                noticeDeliveredCount += 1;
              })
              .catch((sendError: unknown) => {
                botsLogger.warn(
                  undefined,
                  `provider callback failure notice failed provider=${provider} bot=${bot.id}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
                );
              });
          }
          await stopInboundTyping(bot, inboundMessage.actor).catch(() => undefined);
        }
        const noticeDelivered = noticeDeliveredCount === outbound.length && outbound.length > 0;
        const sessionSignalConfirmed = isInboundSessionSignalConfirmed(inboundMessage);
        const outcome = noticeDelivered
          ? "consumed-notice-delivered"
          : sessionSignalConfirmed
            ? "consumed-session-confirmed"
            : "hole-not-consumed";
        // 每个 consumed 判定恰好一行 info（specs/bot-inbound-resilience.md Invariants，
        // 遵守 log-diagnostics-hygiene 的 level 契约：一次性决策用 info）。
        botsLogger.info(
          undefined,
          `provider callback failure outcome=${outcome} provider=${provider} bot=${inboundMessage.botId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
        );
        if (outcome === "hole-not-consumed") {
          // 洞规则（§B.2）：通知未送达且无会话信号 ⇒ NOT consumed ⇒ 保持 abort-不提交。
          // 配合 §C 的去重保留，同 id 首次重投被去重吞并 ⇒ ok=true ⇒ 游标提交，
          // 毒批在一次重投周期内被静默丢弃（有界自愈）。
          hadUnconsumedFailure = true;
        }
        continue;
      }
      if (bot) {
        const transientCard = transientInteractionCards.get(
          getActorContextKey(inboundMessage.actor),
        );
        const handledByFeishuSynchronousCardAction =
          isFeishuBotProvider(provider) &&
          isRecord(preparedPayload) &&
          preparedPayload.zcodeFeishuSynchronousCardAction === true &&
          Boolean(outbound[0]);
        // Bugfix: 只做空 ACK 会让 Telegram 顶部 loading 消失但没有任何可见反馈。
        // 这里在业务处理后把结果写进 answerCallbackQuery 的 toast，即使后续 sendMessage 失败，用户也能看到按钮结果。
        const callbackText = outbound[0]?.text ?? msg(locale, "received");
        let acknowledgeResult:
          | Awaited<ReturnType<NonNullable<typeof adapter.acknowledgeCallback>>>
          | undefined;
        const acknowledgeController = new AbortController();
        const acknowledgeTimeout = setTimeout(() => {
          acknowledgeController.abort(
            new Error(
              `Bot provider callback acknowledgement timed out after ${BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS}ms.`,
            ),
          );
        }, BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS);
        try {
          acknowledgeResult = await Promise.race([
            handledByFeishuSynchronousCardAction || (transientCard && !outbound[0]?.elicitation)
              ? Promise.resolve(undefined)
              : adapter.acknowledgeCallback?.(
                  bot,
                  preparedPayload,
                  callbackText,
                  outbound[0],
                  acknowledgeController.signal,
                ),
            new Promise<never>((_resolve, reject) => {
              acknowledgeController.signal.addEventListener(
                "abort",
                () => reject(acknowledgeController.signal.reason),
                { once: true },
              );
            }),
          ]);
        } catch (error) {
          // 修复原因：飞书第二题原本必须等待 card/update 完成；credential 或 SDK 内部
          // 任一步骤悬挂都会压住 fallback。主流程自己设 deadline，超时后立即另发下一题。
          botsLogger.warn(
            undefined,
            `provider callback acknowledge failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearTimeout(acknowledgeTimeout);
        }
        const callbackHandledByCardUpdate =
          handledByFeishuSynchronousCardAction || acknowledgeResult?.handled === true;
        if (
          !handledByFeishuSynchronousCardAction &&
          callbackHandledByCardUpdate &&
          transientCard &&
          outbound[0]?.elicitation
        ) {
          // 修复原因：真实飞书日志确认 card/update 返回成功后客户端仍可能停在旧题。
          // callback token 负责点击 ACK，随后再 PATCH 同一 message_id 强制刷新可见结构；
          // 两次写入始终指向同一张卡，禁止退回“新建后撤回”的闪烁方案。
          await providers[transientCard.bot.provider]
            ?.updateTransientInteractionCard?.(transientCard.bot, transientCard.handle, outbound[0])
            .catch((error) => {
              // 业务回答已被 Agent 接受且 callback token 已完成 ACK，PATCH 失败不能让
              // Telegram/微信式外部游标重试整次回答，否则会重复提交同一交互。
              botsLogger.warn(
                undefined,
                `refresh transient interaction card failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        if (
          callbackHandledByCardUpdate &&
          transientCard &&
          outbound[0]?.elicitation?.status !== "pending"
        ) {
          // 修复原因：card_update_token 已把同一消息更新为只读终态，此时只释放内存句柄，
          // 不能再 PATCH、DELETE 或另发结果卡。
          transientInteractionCards.delete(getActorContextKey(inboundMessage.actor));
        }
        // Bugfix: /reconnect 的“正在重连”必须在 ensureConnected 前实时发送。
        // handleReconnect 只返回最终结果，避免重连完成后才把过期的开始状态一起吐给用户。
        // specs/bot-inbound-resilience.md §C：本段发送失败直接上抛（abort-不提交游标，行为
        // 不变），且不再释放入站去重键——键随既有 2 分钟 TTL 过期。
        for (const outboundMessage of callbackHandledByCardUpdate ? [] : outbound) {
          if (transientCard) {
            if (outboundMessage.selection || outboundMessage.elicitation?.status === "pending") {
              await upsertTransientInteractionCard(
                bot,
                inboundMessage.actor,
                transientCard.taskId,
                outboundMessage,
              );
              continue;
            }
            if (
              outboundMessage.elicitation ||
              /^\/(?:approve|deny)(?:\s|$)/u.test(inboundMessage.text)
            ) {
              await finalizeTransientInteractionCard(inboundMessage.actor, outboundMessage);
              continue;
            }
          }
          await sendOutbound(bot, outboundMessage);
        }
        await stopInboundTyping(bot, inboundMessage.actor);
      }
    }
    return {
      // specs/bot-inbound-resilience.md §B.1：ok=true 当且仅当批内所有失败都已消费
      // （通知送达或会话信号确认）；未消费失败（洞）才携带 503 阻止游标提交。
      ok: !hadUnconsumedFailure,
      replies,
      ...(hadUnconsumedFailure ? { status: 503 } : {}),
    };
  }

  function createAssistantReplyBlocks(
    parts: readonly ZCodeAssistantMessagePart[],
    toolCalls: ReadonlyMap<string, BotReplyToolCallState>,
    mode: BotReplyGranularity | undefined,
    changeSummary: ZCodeTaskMeta["changeSummary"] | null | undefined,
  ): BotAssistantReplyBlock[] {
    const blocks: BotAssistantReplyBlock[] = [];
    const resolvedMode = mode ?? getDefaultBotReplyGranularity();
    const presentation = buildZCodeAssistantPresentation({
      content: "",
      toolCalls: [...toolCalls.values()].map((toolCall) => ({
        ...toolCall,
        kind: toolCall.kind ?? "tool",
        input: toolCall.input,
        status: toolCall.status ?? "pending",
      })),
      parts,
    });

    if (resolvedMode === "summary_changes") {
      if (presentation.latestPart?.content.trim()) {
        blocks.push({
          type: "content",
          content: presentation.latestPart.content,
        });
      }
    } else {
      for (const block of presentation.blocks) {
        if (block.type === "content" && block.content.trim()) {
          blocks.push({ type: "content", content: block.content });
          continue;
        }
        if (resolvedMode !== "assistant_toolcalls_changes" || block.type !== "tool-call") {
          continue;
        }
        const toolCall = toolCalls.get(block.toolCall.toolId);
        if (toolCall) {
          blocks.push({ type: "tool-call", toolCall });
        }
      }
    }

    if (changeSummary && changeSummary.fileCount > 0 && changeSummary.files.length > 0) {
      blocks.push({ type: "change-summary", changeSummary });
    }
    return blocks;
  }

  function normalizeBotElicitationQuestions(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    locale: Locale | undefined,
  ): ZCodeElicitationQuestion[] {
    const schema = isRecord(event.schema) ? event.schema : null;
    const isPlanApproval = schema?.interaction === "plan_approval";
    if (isPlanApproval) {
      return [
        {
          question: msg(locale, "planApprovalTitle"),
          header: msg(locale, "planApprovalHeader"),
          options: [
            {
              value: "approve",
              label: msg(locale, "planApprovalApprove"),
              description: msg(locale, "planApprovalApproveDescription"),
            },
          ],
        },
      ];
    }
    const sourceQuestions =
      event.questions && event.questions.length > 0
        ? event.questions
        : [
            {
              question: event.message,
              header: event.header ?? event.message,
              options: event.options,
              ...(event.multiSelect ? { multiSelect: true } : {}),
            },
          ];
    return sourceQuestions.map((question) => ({
      question: question.question,
      header: question.header || question.question,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label || option.value,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    }));
  }

  function readBotElicitationRenderContext(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
  ): BotPendingElicitation["renderContext"] {
    const schema = isRecord(event.schema) ? event.schema : null;
    if (
      schema?.interaction !== "plan_approval" ||
      typeof schema.plan !== "string" ||
      !schema.plan.trim()
    ) {
      return undefined;
    }
    return { kind: "plan_approval", plan: schema.plan.trim() };
  }

  function createPendingElicitationSchema(
    pending: BotPendingElicitation,
  ): Record<string, unknown> | undefined {
    return pending.renderContext?.kind === "plan_approval"
      ? { interaction: "plan_approval", plan: pending.renderContext.plan }
      : undefined;
  }

  function getElicitationAnswerKey(questionIndex: number): string {
    return String(questionIndex);
  }

  function readElicitationAnswerValues(
    pending: BotPendingElicitation,
    questionIndex: number,
  ): string[] {
    return pending.answers[getElicitationAnswerKey(questionIndex)] ?? [];
  }

  function getPendingElicitationSelectionToken(pending: BotPendingElicitation): string {
    return createHash("sha256")
      .update(
        [pending.taskId, pending.runId, pending.requestId, pending.currentQuestionIndex].join("::"),
      )
      .digest("hex")
      .slice(0, 12);
  }

  function getPendingElicitationSkipOptionId(pending: BotPendingElicitation): string {
    return `${BOT_ELICITATION_SKIP_OPTION_ID}:${getPendingElicitationSelectionToken(pending)}`;
  }

  function parseElicitationResponseValue(value: string): {
    token?: string;
    value: string;
  } {
    const trimmed = value.trim();
    const [maybeToken, ...rest] = trimmed.split(/\s+/u);
    if (maybeToken && rest.length > 0 && /^[a-f0-9]{12}$/iu.test(maybeToken)) {
      return { token: maybeToken.toLowerCase(), value: rest.join(" ") };
    }
    return { value: trimmed };
  }

  function parseElicitationFormValues(value: string): string[] | null {
    if (!value.startsWith(BOT_ELICITATION_FORM_VALUE_PREFIX)) {
      return null;
    }
    const encoded = value.slice(BOT_ELICITATION_FORM_VALUE_PREFIX.length);
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  function mergeElicitationFormValues(
    question: ZCodeElicitationQuestion,
    selectedValues: readonly string[],
    formValues: readonly string[],
  ): string[] {
    const customValues = formValues.filter(Boolean);
    if (!question.multiSelect) {
      return customValues.length > 0 ? customValues.slice(0, 1) : selectedValues.slice(0, 1);
    }
    const merged: string[] = [];
    for (const value of [...selectedValues, ...customValues]) {
      if (!value || merged.includes(value)) {
        continue;
      }
      merged.push(value);
    }
    return merged;
  }

  function toggleElicitationCustomAnswerExpanded(
    pending: BotPendingElicitation,
  ): BotPendingElicitation {
    const current = new Set(pending.expandedCustomAnswerQuestionIndexes ?? []);
    if (current.has(pending.currentQuestionIndex)) {
      current.delete(pending.currentQuestionIndex);
    } else {
      current.add(pending.currentQuestionIndex);
    }
    return {
      ...pending,
      expandedCustomAnswerQuestionIndexes: [...current].sort((left, right) => left - right),
    };
  }

  function resolveElicitationQuestionValue(
    question: ZCodeElicitationQuestion,
    value: string,
    options: { includeSubmit?: boolean } = {},
  ): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    const normalized = normalizeText(trimmed);
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
      ["submit", "done", "完成", "提交", BOT_ELICITATION_SUBMIT_OPTION_ID].includes(normalized)
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
    const option = resolveOptionByValue(
      question.options.map((item) => ({ id: item.value, label: item.label })),
      trimmed,
    );
    if (option) {
      return option.id;
    }
    const index = Number.parseInt(trimmed, 10);
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
      /^[1-9]\d*$/u.test(trimmed) &&
      index === question.options.length + 1
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
    return trimmed;
  }

  function isPendingElicitationOwnedByActor(
    pending: BotPendingElicitation,
    actor: BotActor,
  ): boolean {
    return !pending.actorKey || pending.actorKey === getActorContextKey(actor);
  }

  function clearPendingElicitationSelection(pending: BotPendingElicitation): void {
    const token = getPendingElicitationSelectionToken(pending);
    for (const [contextKey, selection] of pendingSelectionsByContext) {
      if (
        selection.action === "elicitation.respond" &&
        (selection.token === token || selection.id.startsWith(`elicitation-${pending.requestId}-`))
      ) {
        pendingSelectionsByContext.delete(contextKey);
      }
    }
  }

  function buildBotElicitationContent(
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"] = pending.answers,
  ): Record<string, unknown> {
    // 修复原因：Bot 与桌面共用“缺少 key 表示跳过”的问答契约；未答题不能写成
    // 空字符串，否则 Agent 会把它误判为用户提供的偏好。
    const answerEntries = pending.questions.flatMap((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
      const text = values.join(", ").trim();
      return text ? [[question.question, text]] : [];
    });
    const content: Record<string, unknown> = {
      answers: Object.fromEntries(answerEntries),
    };
    pending.questions.forEach((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
      if (values.length > 0) {
        content[`answer_${index}`] = question.multiSelect ? values : values[0];
      }
    });
    if (pending.questions.length === 1) {
      const values = answers[getElicitationAnswerKey(0)] ?? [];
      if (values.length > 0) {
        content.answer = pending.questions[0]?.multiSelect ? values : values[0];
      }
    }
    return content;
  }

  function createBotElicitationRequestSnapshot(
    pending: BotPendingElicitation,
  ): ZCodeElicitationRequest {
    const currentQuestion = pending.questions[pending.currentQuestionIndex] ?? pending.questions[0];
    const answerDrafts = Object.fromEntries(
      Object.entries(pending.answers).map(([index, values]) => [`answer_${index}`, values]),
    );
    return {
      type: "elicitation_request",
      taskId: pending.taskId,
      traceId: pending.runId,
      requestId: pending.requestId,
      ...(pending.origin ? { origin: pending.origin } : {}),
      message: currentQuestion?.question ?? "",
      header: currentQuestion?.header,
      options: currentQuestion?.options ?? [],
      ...(currentQuestion?.multiSelect ? { multiSelect: true } : {}),
      questions: pending.questions,
      currentQuestionIndex: pending.currentQuestionIndex,
      answerDrafts,
      ...(createPendingElicitationSchema(pending)
        ? { schema: createPendingElicitationSchema(pending) }
        : {}),
    };
  }

  async function broadcastPendingElicitationProgress(
    context: BotContextState,
    pending: BotPendingElicitation,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      broadcastTaskListChange(context, pending.taskId, "elicitation_request", {
        elicitationRequest: createBotElicitationRequestSnapshot(pending),
        requestId: pending.requestId,
      }).then(() => "broadcast" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(
          () => resolve("timeout"),
          BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome === "timeout") {
      // 修复原因：v4/UI 进度广播只是辅助同步。广播 RPC 悬挂时若一直 await，
      // 飞书按钮回调无法生成下一题，也到不了 card/update，用户会永久停在第一题。
      botsLogger.warn(
        undefined,
        `elicitation progress broadcast timed out task=${pending.taskId} request=${pending.requestId}`,
      );
    }
  }

  function formatBotElicitationTitle(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): string {
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return pending.requestId;
    }
    const isCustomAnswerExpanded =
      pending.expandedCustomAnswerQuestionIndexes?.includes(pending.currentQuestionIndex) === true;
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: Feishu 卡片能直接消费 schema.plan，但 Telegram/微信只渲染 message.text。
      // 在共享出站标题中投影完整计划，确保所有纯文本渠道都保留审批上下文。
      return [
        pending.renderContext.plan,
        "------",
        msg(locale, "planApprovalTitle"),
        isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n\n");
    }
    const parts = [
      pending.questions.length > 1
        ? `${pending.currentQuestionIndex + 1}/${pending.questions.length}`
        : null,
      question.header && question.header !== question.question ? question.header : null,
      question.question,
      question.multiSelect ? msg(locale, "elicitationMultiSelectHint") : null,
      isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      msg(locale, "elicitationTextHint"),
    ].filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.join("\n");
  }

  function createBotElicitationSelection(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const question = pending.questions[pending.currentQuestionIndex];
    const selectedValues = new Set(
      readElicitationAnswerValues(pending, pending.currentQuestionIndex),
    );
    const options: SelectionPrompt["options"] =
      question?.options.map((option) => ({
        id: option.value,
        label: question.multiSelect
          ? `${selectedValues.has(option.value) ? "[x]" : "[ ]"} ${option.label}`
          : option.label,
        // Plan approval 的说明属于语义元数据；纯文本渠道只展示批准/自定义两个动作，
        // 避免把“退出计划模式”展开成额外正文，保持与 Feishu 卡片一致。
        description:
          pending.renderContext?.kind === "plan_approval" ? undefined : option.description,
      })) ?? [];
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: Feishu provider 会自行补自定义回答表单，但 Telegram/微信依赖共享 selection。
      // Plan approval 必须在这里补入口，避免非卡片渠道只能批准、无法提交修改意见。
      options.push({
        id: BOT_ELICITATION_CUSTOM_OPTION_ID,
        label: msg(locale, "elicitationCustomOption"),
      });
    }
    if (question?.multiSelect) {
      options.push({
        id: BOT_ELICITATION_SUBMIT_OPTION_ID,
        label: msg(locale, "elicitationSubmitOption"),
      });
    } else if (question) {
      options.push({
        id: getPendingElicitationSkipOptionId(pending),
        label: msg(locale, "elicitationSkipOption"),
      });
    }
    return {
      id: `elicitation-${pending.requestId}-${pending.currentQuestionIndex}`,
      token: getPendingElicitationSelectionToken(pending),
      title: formatBotElicitationTitle(pending, locale),
      action: "elicitation.respond",
      options,
    };
  }

  async function createElicitationReply(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    status: NonNullable<BotOutboundMessage["elicitation"]>["status"] = "pending",
  ): Promise<BotOutboundMessage[]> {
    const currentQuestionIndex =
      status === "pending"
        ? pending.currentQuestionIndex
        : Math.max(0, pending.questions.length - 1);
    return createSelectionReply(actor, createBotElicitationSelection(pending, locale), locale, {
      locale,
      elicitation: {
        requestId: pending.requestId,
        taskId: pending.taskId,
        runId: pending.runId,
        currentQuestionIndex,
        questions: pending.questions,
        answers: pending.answers,
        status,
        ...(pending.expandedCustomAnswerQuestionIndexes?.length
          ? {
              expandedCustomAnswerQuestionIndexes: pending.expandedCustomAnswerQuestionIndexes,
            }
          : {}),
        ...(createPendingElicitationSchema(pending)
          ? { schema: createPendingElicitationSchema(pending) }
          : {}),
      },
    });
  }

  function createCompletedElicitationOutbound(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    action: "accept" | "decline" | "cancel",
  ): BotOutboundMessage {
    const status = action === "cancel" ? "cancelled" : "completed";
    return createOutbound(
      actor,
      msg(locale, action === "accept" ? "elicitationSubmitted" : "elicitationCancelled"),
      undefined,
      {
        locale,
        elicitation: {
          requestId: pending.requestId,
          taskId: pending.taskId,
          runId: pending.runId,
          currentQuestionIndex: Math.max(0, pending.questions.length - 1),
          questions: pending.questions,
          answers: pending.answers,
          status,
          ...(createPendingElicitationSchema(pending)
            ? { schema: createPendingElicitationSchema(pending) }
            : {}),
        },
      },
    );
  }

  async function clearPendingElicitationForRequest(
    context: BotContextState,
    requestId: string,
  ): Promise<void> {
    if (context.pendingElicitation?.requestId !== requestId) {
      return;
    }
    clearPendingElicitationSelection(context.pendingElicitation);
    await writeContext({ ...context, pendingElicitation: undefined });
  }

  // specs/bot-inbound-resilience.md §B2.1：submitPendingElicitation 一次 respondElicitation
  // 调用 resolve 整个 pending 组（多题一组，无逐题机械）。旧返回 BotOutboundMessage[]
  // 无法区分"respondElicitation 真正 resolve（确认送达）"与 expired/handled 兜底回复——
  // B2 会话失败信号的 consumed 判定（B1(b)）只认前者，这里改为携带 confirmed 判别。
  interface SubmitPendingElicitationResult {
    /** respondElicitation 是否真正 resolve（确认送达）；expired/handled/no-pending ⇒ false。 */
    confirmed: boolean;
    replies: BotOutboundMessage[];
  }

  async function submitPendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<SubmitPendingElicitationResult> {
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return {
        confirmed: false,
        replies: [createOutbound(actor, msg(auth.locale, "elicitationExpired"))],
      };
    }
    if (pending.handledAt) {
      return {
        confirmed: false,
        replies: [createOutbound(actor, msg(auth.locale, "elicitationHandled"))],
      };
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
    const submitted = await zcodeTaskService.respondElicitation({
      taskId: pending.taskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
      runId: pending.runId,
      requestId: pending.requestId,
      action,
      content,
    });
    // 修复原因：v4 resolveInteraction 才是业务确认点。若在 ACK 前写 handledAt，
    // 瞬时失败后的同一按钮重试会被误判为已处理，Agent 将永久停在等待用户输入。
    const handledAt = Date.now();
    await writeContext({
      ...auth.context,
      pendingElicitation: { ...pending, handledAt },
    });
    clearPendingElicitationSelection(pending);
    await writeContext({ ...auth.context, pendingElicitation: undefined });
    await broadcastTaskListChange(auth.context, pending.taskId, "elicitation_resolved", {
      requestId: pending.requestId,
    });
    if (!submitted) {
      return {
        confirmed: false,
        replies: [createOutbound(actor, msg(auth.locale, "elicitationHandled"))],
      };
    }
    if (action === "accept") {
      startTyping(auth.bot, actor, pending.taskId);
      // Bugfix: AskUserQuestion 只是在回复问题，不属于命令配置成功；这里保留原问答提交文案，避免误回 /status。
      return {
        confirmed: true,
        replies: [createCompletedElicitationOutbound(actor, pending, auth.locale, action)],
      };
    }
    // Bugfix: 取消/拒绝问答也应使用问答自己的结果文案，避免第三方 Bot 里出现无关的任务状态。
    return {
      confirmed: true,
      replies: [createCompletedElicitationOutbound(actor, pending, auth.locale, action)],
    };
  }

  async function advancePendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"],
  ): Promise<BotOutboundMessage[]> {
    if (pending.currentQuestionIndex >= pending.questions.length - 1) {
      // B2 重构：submitPendingElicitation 改回 result object；既有回答路径只消费 replies，
      // confirmed 仅供失败信号路径（B2）消费，行为不变。
      const submitted = await submitPendingElicitation(
        auth,
        actor,
        { ...pending, answers },
        "accept",
        buildBotElicitationContent(pending, answers),
      );
      return submitted.replies;
    }
    const nextPending: BotPendingElicitation = {
      ...pending,
      currentQuestionIndex: pending.currentQuestionIndex + 1,
      answers,
    };
    await writeContext({ ...auth.context, pendingElicitation: nextPending });
    // Bugfix: Bot 侧代选 AskUserQuestion 后，UI 只收到最终响应会停留在旧本地草稿。
    // 每次推进题号都同步当前题号和已选答案，让桌面/移动 Web 能保持同一选中态。
    await broadcastPendingElicitationProgress(auth.context, nextPending);
    return createElicitationReply(actor, nextPending, auth.locale);
  }

  async function handlePendingElicitationValue(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    value: string,
  ): Promise<BotOutboundMessage[]> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    const parsedValue = parseElicitationResponseValue(value);
    if (actor.provider !== "weixin") {
      const expectedToken = getPendingElicitationSelectionToken(pending);
      if (!parsedValue.token || parsedValue.token !== expectedToken) {
        // Bugfix: Telegram/飞书/Webhook 的旧按钮可能在新一轮 AskUserQuestion 后才送达。
        // 非微信通道必须带本轮短 token，避免把上一轮按钮编号误当成当前问题的答案。
        return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
      }
    }
    if (parsedValue.value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const formValues = parseElicitationFormValues(parsedValue.value);
    if (formValues) {
      const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
      const nextValues = mergeElicitationFormValues(
        question,
        readElicitationAnswerValues(pending, pending.currentQuestionIndex),
        formValues,
      );
      if (nextValues.length === 0) {
        return createElicitationReply(actor, pending, auth.locale);
      }
      // Bugfix: 飞书/Lark 平铺选项由按钮维护草稿，表单只负责提交和自定义输入。
      // 提交时需要合并当前 radio/checkbox 草稿和自定义输入，避免空表单把已选项覆盖掉。
      return advancePendingElicitation(auth, actor, pending, {
        ...pending.answers,
        [answerKey]: nextValues,
      });
    }
    const selectionOption = resolvePendingSelectionOption(
      actor,
      "elicitation.respond",
      parsedValue.value,
    );
    if (selectionOption?.id === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const selectedValue = resolveElicitationQuestionValue(
      question,
      selectionOption?.id ?? parsedValue.value,
    );
    if (!selectedValue) {
      return createElicitationReply(actor, pending, auth.locale);
    }
    if (selectedValue === BOT_ELICITATION_SUBMIT_OPTION_ID) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    if (selectedValue === BOT_ELICITATION_CUSTOM_OPTION_ID) {
      const nextPending = toggleElicitationCustomAnswerExpanded(pending);
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
    if (question.multiSelect) {
      const currentValues = readElicitationAnswerValues(pending, pending.currentQuestionIndex);
      const nextValues = currentValues.includes(selectedValue)
        ? currentValues.filter((item) => item !== selectedValue)
        : [...currentValues, selectedValue];
      const nextPending = {
        ...pending,
        answers: { ...pending.answers, [answerKey]: nextValues },
      };
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      // Bugfix: 多选题在 Bot 里 toggle 后不会触发 ZCode Agent response，必须主动同步草稿给 UI。
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: [selectedValue],
    });
  }

  async function handlePendingElicitationText(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    text: string,
  ): Promise<BotOutboundMessage[] | null> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return null;
    }
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return null;
    }
    const value = text.trim();
    if (!value) {
      return createElicitationReply(actor, pending, auth.locale);
    }
    if (value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (
      !question.multiSelect &&
      /^[1-9]\d*$/u.test(value) &&
      Number.parseInt(value, 10) === question.options.length + 1
    ) {
      // 修复原因：自由文本必须保留为用户数据；只有菜单显示的额外序号才是跳过，
      // 避免吞掉名为 skip/next/跳过/__skip__ 的合法选项或自定义答案。
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const values = question?.multiSelect
      ? value
          .split(/[,\n，、]/u)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) =>
            resolveElicitationQuestionValue(question, item, {
              includeSubmit: false,
            }),
          )
      : [resolveElicitationQuestionValue(question, value, { includeSubmit: false })];
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: values,
    });
  }

  async function handleStructuredElicitationResponse(
    message: BotInboundMessage,
    response: BotStructuredElicitationResponse,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.requestId !== response.requestId) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (!isPendingElicitationOwnedByActor(pending, message.actor)) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
    // B2 重构：此处为结构化回执的正常提交路径，只消费 replies（行为不变）。
    const submitted = await submitPendingElicitation(
      auth,
      message.actor,
      pending,
      response.action,
      response.content,
    );
    return submitted.replies;
  }

  async function handleElicitationRequest(
    bot: BotConfig,
    user: BotConfig,
    actor: BotActor,
    context: BotContextState,
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
  ): Promise<void> {
    const locale = await readMessageLocale();
    stopTyping(event.taskId);
    const pendingElicitation: BotPendingElicitation = {
      taskId: event.taskId,
      requestId: event.requestId,
      runId: event.traceId,
      // Bugfix：subagent 发起的 elicitation 必须保留 origin；否则 Bot 广播和后续响应
      // 无法还原请求归属，rebase 后只剩顶层 stream event 带 origin。
      ...(event.origin ? { origin: event.origin } : {}),
      actorKey: getActorContextKey(actor),
      currentQuestionIndex: 0,
      // 修复原因：ExitPlanMode 的协议问题和选项使用稳定英文；如果直接复用，中文 Bot 卡片会中英混杂。
      // Bot 在出站边界按 App locale 本地化整组审批文案，普通 AskUserQuestion 保持模型原文。
      questions: normalizeBotElicitationQuestions(event, locale),
      answers: {},
      // 修复原因：Feishu/Lark 会在自定义回答、完成和重启恢复时重建原卡片；
      // 只把 schema 作为首次发送参数会让后续更新丢失 plan 并退回通用 Question 卡片。
      ...(readBotElicitationRenderContext(event)
        ? { renderContext: readBotElicitationRenderContext(event) }
        : {}),
    };
    // Bugfix: Bot 原先只消费 permission_request，没有把 ZCode Agent 的
    // AskUserQuestion/elicitation_request 转成第三方可回答消息，任务会一直卡在等待用户输入。
    if (context.pendingElicitation) {
      clearPendingElicitationSelection(context.pendingElicitation);
    }
    Object.assign(context, { pendingElicitation });
    await writeContext({ ...context, pendingElicitation });
    await broadcastPendingElicitationProgress(context, pendingElicitation);
    try {
      for (const reply of await createElicitationReply(actor, pendingElicitation, locale)) {
        if (shouldUseTransientInteractionCard(bot, user)) {
          await upsertTransientInteractionCard(bot, actor, event.taskId, reply);
        } else {
          await sendOutbound(bot, reply);
        }
      }
    } catch (error) {
      // specs/bot-inbound-resilience.md §B2.1 出站方向：提问发送失败（死通道）时，
      // host↔agent 会话链路仍存活——失败信号必须送达会话而非只丢给聊天侧。
      // 立即以 decline+failureReason resolve 刚写入的该 pending（复用既有
      // respondElicitation seam，additive，无新 wire 类型）并清除 pending，agent
      // 看到"未获得用户回答：<原因>"后可改道（重问/默认/放弃）。整组语义：
      // submitPendingElicitation 一次调用 resolve 整个 pending 组。
      const sendFailureReason = error instanceof Error ? error.message : String(error);
      let signalConfirmed = false;
      let signalFailure: string | undefined;
      try {
        const resolved = await submitPendingElicitation(
          { bot, context, locale },
          actor,
          pendingElicitation,
          "decline",
          { failureReason: `question send failed: ${sendFailureReason}` },
        );
        signalConfirmed = resolved.confirmed;
      } catch (resolveError) {
        signalFailure = resolveError instanceof Error ? resolveError.message : String(resolveError);
      }
      // 恰好一行 warn（sendOutbound 自身的失败 warn 属既有出站机械，不在此重复）。
      botsLogger.warn(
        undefined,
        `bot elicitation question send failed provider=${bot.provider} bot=${bot.id} task=${event.taskId} requestId=${event.requestId} signalConfirmed=${signalConfirmed}${signalFailure ? ` signalFailure=${signalFailure}` : ""}: ${sendFailureReason}`,
      );
    }
  }

  async function watchTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
  ): Promise<void> {
    if (!context.activeTaskId) {
      return;
    }
    // 闭包内保留收窄后的任务 id（context 属性收窄不会流入下方回调闭包）。
    const watchedTaskId: string = context.activeTaskId;
    const streamSubscriptionKey = [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
    ].join("::");
    if (streamSubscriptions.has(streamSubscriptionKey)) {
      return;
    }
    let assistantParts: ZCodeAssistantMessagePart[] = [];
    let assistantReplyBuffer = "";
    let sentAnyAssistantReply = false;
    const assistantPartToolIds = new Set<string>();
    const toolCalls = new Map<string, BotReplyToolCallState>();
    const sentToolCallReplyIds = new Set<string>();
    const getMode = () => normalizeBotReplyGranularity(bot.provider, user.replyMode);
    let streamingCardHandle: BotStreamingReplyCardHandle | null = null;
    let streamingCardSegmentIndex = 0;
    const streamingCardBlocks: StreamingCardTimelineBlock[] = [];
    let streamingCardStatus: "running" | "sealed" | "completed" | "error" = "running";
    let streamingCardLastUpdateAt = 0;
    let streamingCardConsecutiveFailures = 0;
    let streamingCardNextAttemptAt = 0;
    let streamingCardCircuitOpen = false;
    let streamingCardQueue: Promise<void> = Promise.resolve();
    const supportsStreamingCardReply = () => {
      const adapter = providers[bot.provider];
      return (
        getMode() === "streaming_card" &&
        isFeishuBotProvider(bot.provider) &&
        Boolean(adapter?.createStreamingReplyCard) &&
        Boolean(adapter?.updateStreamingReplyCard)
      );
    };
    const buildStreamingToolSummaryTitle = (locale: Locale | undefined): string =>
      msg(locale, "streamingToolSummaries");
    const appendStreamingCardMessageChunk = (content: string): void => {
      if (!content) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "message") {
        lastBlock.text += content;
        return;
      }
      streamingCardBlocks.push({ type: "message", text: content });
    };
    const appendStreamingCardMessages = (messages: readonly string[]): void => {
      for (const message of messages.map((item) => item.trim()).filter(Boolean)) {
        const lastBlock = streamingCardBlocks.at(-1);
        if (lastBlock?.type === "message" && lastBlock.text.trim()) {
          lastBlock.text = `${lastBlock.text.trim()}\n\n${message}`;
        } else {
          streamingCardBlocks.push({ type: "message", text: message });
        }
      }
    };
    const hasStreamingCardMessageText = (): boolean =>
      streamingCardBlocks.some((block) => block.type === "message" && block.text.trim().length > 0);
    const appendStreamingCardTool = (toolId: string): void => {
      const existingBlock = streamingCardBlocks.find(
        (block) => block.type === "tools" && block.toolIds.includes(toolId),
      );
      if (existingBlock) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "tools") {
        lastBlock.toolIds.push(toolId);
        return;
      }
      streamingCardBlocks.push({ type: "tools", toolIds: [toolId] });
    };
    const buildStreamingCardBlocks = (locale: Locale | undefined): BotStreamingReplyCardBlock[] => {
      const toolSummaryTitle = buildStreamingToolSummaryTitle(locale);
      const latestToolBlockIndex = streamingCardBlocks.reduce(
        (latestIndex, block, index) => (block.type === "tools" ? index : latestIndex),
        -1,
      );
      const blocks: BotStreamingReplyCardBlock[] = [];
      for (const [index, block] of streamingCardBlocks.entries()) {
        if (block.type === "message") {
          const text = block.text.trim();
          if (text) {
            blocks.push({ type: "message", text });
          }
          continue;
        }
        const summaries = block.toolIds
          .map((toolId) => toolCalls.get(toolId))
          .filter((toolCall): toolCall is BotReplyToolCallState => Boolean(toolCall))
          .map((toolCall) =>
            formatBotToolCallSummaryLine(toolCall, {
              workspacePath: context.workspacePath,
              locale,
            }),
          );
        if (summaries.length === 0) {
          continue;
        }
        blocks.push({
          type: "tools",
          title: toolSummaryTitle,
          summaries,
          expanded: streamingCardStatus === "running" && index === latestToolBlockIndex,
        });
      }
      if (blocks.length === 0) {
        blocks.push({
          type: "message",
          text: msg(locale, "streamingWorking"),
        });
      }
      return blocks;
    };
    const syncStreamingCardReply = async (
      trigger: string,
      force = false,
      options?: { halfOpen?: boolean },
    ): Promise<boolean> => {
      if (!supportsStreamingCardReply()) {
        return false;
      }
      const now = Date.now();
      // Bugfix：旧实现只在成功后更新时间基准，Feishu 失败时每个 stream event 都会真实发请求；
      // force 路径还会绕过普通节流。失败退避和熔断必须先于 force 判断，避免单次 400 被放大成风暴。
      // F5（specs/bot-message-delivery.md）：halfOpen 仅供终态 task_complete 渲染——熔断打开时
      // 也必尝试一次（half-open），否则完成任务会永远冻结在 Running 卡片上。
      if (!options?.halfOpen && (streamingCardCircuitOpen || now < streamingCardNextAttemptAt)) {
        return false;
      }
      if (
        streamingCardHandle &&
        !force &&
        now - streamingCardLastUpdateAt < FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS
      ) {
        return false;
      }
      if (options?.halfOpen && streamingCardCircuitOpen) {
        botsLogger.info(
          undefined,
          `Feishu streaming card circuit half-open final attempt task=${context.activeTaskId} trigger=${trigger}`,
        );
      }
      const adapter = providers[bot.provider];
      const locale = await readMessageLocale();
      const state = {
        providerUserId: actor.providerUserId,
        locale,
        blocks: buildStreamingCardBlocks(locale),
        status: streamingCardStatus,
      };
      const states = adapter?.splitStreamingReplyCardStates?.(state) ?? [state];
      // 返回值携带本次尝试是否成功（F5 终态降级判定）；链尾吞掉值保持串行化语义不变。
      const run = streamingCardQueue
        .catch(() => undefined)
        .then(async () => {
          let operation = streamingCardHandle ? "update" : "create";
          const requestController = new AbortController();
          streamingCardRequestControllers.add(requestController);
          const timeoutId = setTimeout(() => {
            requestController.abort(new Error("Feishu streaming card request timed out."));
          }, FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS);
          try {
            for (
              let index = Math.min(streamingCardSegmentIndex, states.length - 1);
              index < states.length;
              index += 1
            ) {
              const segmentState = states[index]!;
              operation = streamingCardHandle ? "update" : "create";
              const request = !streamingCardHandle
                ? adapter?.createStreamingReplyCard?.(bot, segmentState, requestController.signal)
                : adapter?.updateStreamingReplyCard?.(
                    bot,
                    streamingCardHandle,
                    segmentState,
                    requestController.signal,
                  );
              const result = await Promise.race([
                request,
                new Promise<never>((_, reject) => {
                  requestController.signal.addEventListener(
                    "abort",
                    () => reject(requestController.signal.reason),
                    { once: true },
                  );
                }),
              ]);
              if (!streamingCardHandle) {
                streamingCardHandle = result ?? null;
                if (!streamingCardHandle) {
                  // Bug 根因：飞书创建接口可能 code=0 却不返回 message_id。若把这种静默失败
                  // 当成成功推进 segmentIndex，未投递的中间段会被永久跳过；必须统一进入退避重试。
                  throw new Error("Feishu create streaming card returned no message_id.");
                }
              }
              if (index < states.length - 1) {
                // 修复原因：当前卡片达到飞书元素预算后必须保留为 sealed 历史段，
                // 后续 block 只写入新卡片，不能把已展示内容再次发送或继续更新旧 message_id。
                streamingCardSegmentIndex = index + 1;
                streamingCardHandle = null;
              }
            }
            streamingCardLastUpdateAt = Date.now();
            streamingCardConsecutiveFailures = 0;
            streamingCardNextAttemptAt = 0;
            if (streamingCardCircuitOpen) {
              // Bugfix（F5 specs/bot-message-delivery.md）：旧实现成功后只清计数不清熔断标志，
              // 熔断一旦打开就永远打开，卡片冻结 Running、完成态永不渲染。成功同步必须关闸。
              streamingCardCircuitOpen = false;
              botsLogger.info(
                undefined,
                `Feishu streaming card circuit reset task=${context.activeTaskId} trigger=${trigger}`,
              );
            }
            return true;
          } catch (error) {
            // Bugfix: 第三方卡片只是 best-effort 展示，超时/失败不能阻塞 task_complete、
            // task_error 或 typing 清理等生命周期事件。
            streamingCardConsecutiveFailures += 1;
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (
              streamingCardConsecutiveFailures >= FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD
            ) {
              streamingCardCircuitOpen = true;
              botsLogger.warn(
                undefined,
                `Feishu streaming card circuit opened task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures}: ${errorMessage}`,
              );
            } else {
              const retryDelayMs =
                FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS *
                2 ** (streamingCardConsecutiveFailures - 1);
              streamingCardNextAttemptAt = Date.now() + retryDelayMs;
              botsLogger.warn(
                undefined,
                `Feishu streaming card sync failed task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures} retryDelayMs=${retryDelayMs}: ${errorMessage}`,
              );
            }
            return false;
          } finally {
            clearTimeout(timeoutId);
            streamingCardRequestControllers.delete(requestController);
          }
        });
      streamingCardQueue = run.then(() => undefined);
      return await run;
    };
    const sealStreamingCardReply = async (): Promise<void> => {
      if (!streamingCardHandle) {
        return;
      }
      // 修复原因：阻塞交互前的 Agent 输出与交互后的 continuation 属于两个可读段落。
      // 旧实现继续复用同一 message_id，导致问题/Plan 卡夹在中间但后续正文回写到旧卡。
      streamingCardStatus = "sealed";
      await syncStreamingCardReply("seal", true);
      streamingCardHandle = null;
      streamingCardSegmentIndex = 0;
      streamingCardBlocks.length = 0;
      streamingCardStatus = "running";
      streamingCardLastUpdateAt = 0;
    };
    const flushAssistantReplyBuffer = async (force = false): Promise<void> => {
      if (getMode() === "summary_changes" || supportsStreamingCardReply()) {
        return;
      }
      if (force) {
        // Bugfix（M1，specs/bot-message-delivery.md Retention buffer）：force 边界对保留文本
        // 做一次有界重试（积压早于当前缓冲 → 先补发再 flush 当前缓冲）；无序言（非 revival）。
        await deliverRetainedBacklog(bot, actor, { withPreamble: false });
      }
      if (!assistantReplyBuffer) {
        return;
      }
      const extracted = extractBotAssistantResponseMessages(assistantReplyBuffer, force);
      // F2 trim-on-success（specs/bot-message-delivery.md）：缓冲只推进到提取后的剩余；
      // 已成功送出的分块绝不重发，失败分块按下方预算处理。
      assistantReplyBuffer = extracted.rest;
      if (extracted.messages.length === 0) {
        return;
      }
      if (force) {
        // F10 观测：强制 flush 的规模（taskId / 分块数 / 字节数）。
        botsLogger.info(
          undefined,
          `bot forced reply flush task=${context.activeTaskId} chunks=${extracted.messages.length} bytes=${extracted.messages.reduce((total, text) => total + text.length, 0)}`,
        );
      }
      for (const [index, text] of extracted.messages.entries()) {
        let delivered = false;
        let channelDead = false;
        // Bugfix（F2）：旧实现先清缓冲再发送，发送被拒时正文被静默销毁（extract-before-send
        // 丢失）。改为有界重试：每个失败分块至多 BOT_REPLY_FLUSH_MAX_ATTEMPTS 次尝试、
        // 单次 ~1s 退避，预算按构造有界，毒丸消息不可能拖住串行事件队列。
        for (let attempt = 1; attempt <= BOT_REPLY_FLUSH_MAX_ATTEMPTS && !delivered; attempt += 1) {
          if (attempt > 1) {
            await delay(BOT_REPLY_FLUSH_RETRY_BACKOFF_MS);
          }
          try {
            // M1：flush 分块是法定的缝隙保留调用点（channel-dead 时当前分块文本由
            // sendOutbound 缝隙保留，下面只需保留兄弟分块与缓冲尾部）。
            await sendOutbound(bot, createOutbound(actor, text), { retainOnChannelDead: true });
            delivered = true;
            sentAnyAssistantReply = true;
          } catch (error) {
            if (classifyBotSendFailure(error) === "channel-dead") {
              // Bugfix（M1，specs/bot-message-delivery.md F2.3 修订）：channel-dead 首败即停
              // ——死通道上第二次尝试与丢弃通知都必然失败（§8.7），只重复锤打死 API。
              channelDead = true;
              break;
            }
            // content-poison 落入下方预算判定（alpha.1 语义不变）。
          }
        }
        if (channelDead) {
          // M1：当前分块已由缝隙保留；未发送的兄弟分块与缓冲尾部一并进入保留缓冲，
          // 清空回复缓冲（防止滞留到下一 force 边界反复重试）。
          const unsent = [...extracted.messages.slice(index + 1), extracted.rest];
          assistantReplyBuffer = "";
          const peerKey = actor.chatId?.trim() || actor.providerUserId.trim();
          if (peerKey) {
            await retainReplyTexts(bot, peerKey, unsent);
          }
          return;
        }
        if (!delivered) {
          // 决定语义（owner 已评审）：预算耗尽即丢弃剩余（含未发送分块与缓冲尾部）并送达
          // 一次性本地化通知；毒丸余量不得滞留到下一个 force 边界反复重试。
          const droppedChunks = extracted.messages.length - index;
          assistantReplyBuffer = "";
          botsLogger.warn(
            undefined,
            `bot reply flush dropped remainder task=${context.activeTaskId} chunks=${droppedChunks} restBytes=${extracted.rest.length}`,
          );
          const locale = await readMessageLocale();
          await sendOutbound(bot, createOutbound(actor, msg(locale, "replyDeliveryFailed"))).catch(
            (error: unknown) => {
              botsLogger.warn(
                undefined,
                `bot reply delivery failure notice failed task=${context.activeTaskId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            },
          );
          return;
        }
      }
    };
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const handleStreamEvent = async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      if (event.type === "task_stream_mirror_batch") {
        if (shouldBroadcast) {
          await broadcastTaskStreamEvent(context, event);
        }
        // Bugfix: 共享 host / 远控下 UI 收到的是 workspace 级 mirror batch。
        // 旧逻辑只识别裸 stream event，导致 UI 正常流式显示但 Bot channel 没有任何可发送回复。
        for (const op of event.ops) {
          if (op.kind === "stream_event") {
            await handleStreamEvent(op.event, false);
          }
        }
        return;
      }
      if (shouldBroadcast) {
        await broadcastTaskStreamEvent(context, event);
      }
      // Bugfix: 第三方默认回复需要随 AssistantMessageResponse 流式发送；
      // 但 /status Progress 仍然要独立缓存，避免受发送颗粒度影响。
      updateLiveStatusProgress(event);
      if (event.type === "agent_message_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "content",
          content: event.content,
        });
        if (supportsStreamingCardReply()) {
          appendStreamingCardMessageChunk(event.content);
          await syncStreamingCardReply(event.type, false);
          return;
        }
        if (getMode() !== "summary_changes") {
          assistantReplyBuffer += event.content;
          // 第三方平台消息是离散气泡；formatter 负责把当前 buffer 按长度约束拆成可发送消息。
          await flushAssistantReplyBuffer(false);
        }
        return;
      }
      if (event.type === "agent_thought_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "thought",
          content: event.content,
        });
      }
      if (event.type === "tool_call" || event.type === "tool_call_update") {
        if (supportsStreamingCardReply()) {
          appendStreamingCardTool(event.toolId);
        }
        if (!supportsStreamingCardReply()) {
          await flushAssistantReplyBuffer(true);
        }
        // Bugfix: summary_changes 完成消息需要参考 UI latestPart。
        // tool_call_update 可能在缺少 tool_call 首帧时先到，需像 UI 一样补一个 tool-call part 边界。
        if (!assistantPartToolIds.has(event.toolId)) {
          assistantPartToolIds.add(event.toolId);
          assistantParts = appendAssistantMessagePart(assistantParts, {
            type: "tool-call",
            toolId: event.toolId,
          });
        }
      }
      updateBotReplyToolCalls(toolCalls, event);
      if (event.type === "tool_call" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, true);
      }
      if (event.type === "tool_call_update" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, isBotToolCallReplyTerminal(event.status));
      }
      if (
        event.type === "tool_call_update" &&
        getMode() === "assistant_toolcalls_changes" &&
        isBotToolCallReplyTerminal(event.status) &&
        !sentToolCallReplyIds.has(event.toolId)
      ) {
        const toolCall = toolCalls.get(event.toolId);
        if (toolCall) {
          sentToolCallReplyIds.add(event.toolId);
          sentAnyAssistantReply = true;
          await sendOutbound(
            bot,
            createOutbound(
              actor,
              formatBotToolCallReply(toolCall, {
                workspacePath: context.workspacePath,
                locale: await readMessageLocale(),
              }),
            ),
          );
        }
      }
      if (event.type === "permission_request") {
        const locale = await readMessageLocale();
        stopTyping(event.taskId);
        // Bugfix（F3 specs/bot-message-delivery.md）：交互边界必须先落正文——卡片 provider seal，
        // 文本 provider 强制 flush，否则问题前正文滞留缓冲，与回答后的 continuation 粘成一条。
        if (supportsStreamingCardReply()) {
          await sealStreamingCardReply();
        } else {
          await flushAssistantReplyBuffer(true);
        }
        await broadcastTaskListChange(context, event.taskId, "permission_request", {
          permissionRequest: event,
        });
        // Bugfix: UI 会把 ZCode Agent 原始权限选项规整成“允许/始终允许/拒绝”的固定顺序和文案；
        // 机器人之前直接展示 provider 原始英文 name，还额外加取消按钮，导致同一个权限请求在飞书和 UI 看起来不一致。
        const permissionOptions = sortBotPermissionOptions(event.options);
        const permissionSelection: SelectionPrompt = {
          id: `permission-${event.requestId}`,
          title: formatBotPermissionRequestSummary(event, {
            locale,
            workspacePath: context.workspacePath,
          }),
          action: "permission.respond",
          showCancel: false,
          options: permissionOptions.map((option) => {
            const isDenyOption = isBotPermissionRejectOption(option);
            return {
              id: isDenyOption
                ? `/deny ${event.requestId}`
                : `/approve ${event.requestId} ${option.optionId}`,
              label: formatBotPermissionOptionLabel(option, locale),
              description: formatBotPermissionOptionDescription(option, event, locale),
            };
          }),
        };
        // Bugfix: Telegram callback_data 只有 64 字节，真实 toolCallId/requestId 可能过长。
        // 因此按钮只回传短序号，真实 requestId/optionId 暂存在当前 bot context 中再解析。
        const pendingPermissionOptions = permissionOptions.map((option) => {
          const isDenyCommand = isBotPermissionRejectOption(option);
          return {
            requestId: event.requestId,
            optionId: option.optionId,
            command: isDenyCommand ? ("deny" as const) : ("approve" as const),
            label: formatBotPermissionOptionLabel(option, locale),
            response: option.response,
          };
        });
        Object.assign(context, { pendingPermissionOptions });
        await writeContext({ ...context, pendingPermissionOptions });
        const [permissionReply] = await createSelectionReply(
          actor,
          permissionSelection,
          await readMessageLocale(),
        );
        if (permissionReply) {
          try {
            if (shouldUseTransientInteractionCard(bot, user)) {
              await upsertTransientInteractionCard(bot, actor, event.taskId, permissionReply);
            } else {
              await sendOutbound(bot, permissionReply);
            }
          } catch (error) {
            // specs/bot-inbound-resilience.md §B2.3 权限休眠分支（双向，为 3.15.0 Track B
            // 预铺；bot force-yolo 下 CLI 不发权限事件，生产不触发，测试直驱）：
            // 权限提示发送失败（死通道）⇒ 用户永远无法应答 ⇒ 必须 STOP agent
            // （owner 决策 13）：stopGeneration（task）+ respondPermission deny-shaped
            // 终局记录（复用 pendingPermissionOptions 中 deny 选项的 optionId+response，
            // 与 /deny seam 同构）+ 清除 pendingPermissionOptions，恰好一行 warn。
            const sendFailureReason = error instanceof Error ? error.message : String(error);
            const denyOption = pendingPermissionOptions.find((option) => option.command === "deny");
            const permissionTaskService = await resolveZCodeTaskServiceForContext(context);
            let stopped = false;
            let denied = false;
            try {
              await permissionTaskService.stopGeneration({ taskId: event.taskId });
              stopped = true;
            } catch (stopError) {
              botsLogger.warn(
                undefined,
                `bot permission stop after send failure failed provider=${bot.provider} bot=${bot.id} task=${event.taskId}: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
              );
            }
            try {
              await permissionTaskService.respondPermission({
                taskId: event.taskId,
                requestId: event.requestId,
                optionId:
                  denyOption?.optionId ??
                  // 合成兜底 optionId（review 2026-10-03）：正常 pendingPermissionOptions
                  // 必含 deny 选项；缺失属异常形态，合成 "deny" 仅作 deny-shaped 终局
                  // 记录的占位（respondPermission 消费的是 requestId 寻址，非选项校验）。
                  // Track B（3.15.0）继承此分支时应知晓该合成形状。
                  "deny",
                response:
                  denyOption?.response ??
                  ({ decision: "deny", reason: "Permission prompt delivery failed" } as const),
              });
              denied = true;
            } catch (denyError) {
              botsLogger.warn(
                undefined,
                `bot permission deny after send failure failed provider=${bot.provider} bot=${bot.id} task=${event.taskId}: ${denyError instanceof Error ? denyError.message : String(denyError)}`,
              );
            }
            Object.assign(context, { pendingPermissionOptions: undefined });
            await writeContext({ ...context, pendingPermissionOptions: undefined });
            botsLogger.warn(
              undefined,
              `bot permission prompt send failed provider=${bot.provider} bot=${bot.id} task=${event.taskId} requestId=${event.requestId} stopped=${stopped} denied=${denied}: ${sendFailureReason}`,
            );
          }
        }
        return;
      }
      if (event.type === "elicitation_request") {
        // Bugfix（F3 specs/bot-message-delivery.md）：与 permission_request 同一交互边界语义。
        if (supportsStreamingCardReply()) {
          await sealStreamingCardReply();
        } else {
          await flushAssistantReplyBuffer(true);
        }
        await handleElicitationRequest(bot, user, actor, context, event);
        return;
      }
      if (event.type === "elicitation_response") {
        await clearPendingElicitationForRequest(context, event.requestId);
        await broadcastTaskListChange(context, event.taskId, "elicitation_resolved", {
          requestId: event.requestId,
        });
        return;
      }
      if (event.type === "task_complete" || event.type === "task_error") {
        runningTasks.delete(event.taskId);
        liveStatusProgressByTaskId.delete(event.taskId);
        stopTyping(event.taskId);
        if (context.pendingElicitation?.taskId === event.taskId) {
          clearPendingElicitationSelection(context.pendingElicitation);
          await writeContext({ ...context, pendingElicitation: undefined });
        }
        const transientCard = transientInteractionCards.get(getActorContextKey(actor));
        if (transientCard?.taskId === event.taskId) {
          const pendingElicitation = context.pendingElicitation;
          await finalizeTransientInteractionCard(
            actor,
            pendingElicitation
              ? createCompletedElicitationOutbound(
                  actor,
                  pendingElicitation,
                  await readMessageLocale(),
                  "cancel",
                )
              : createOutbound(
                  actor,
                  event.type === "task_error"
                    ? msg(await readMessageLocale(), "taskFailed", {
                        message: event.error,
                      })
                    : msg(await readMessageLocale(), "received"),
                ),
          );
        }
        // Bugfix（F1+F7 specs/bot-message-delivery.md）：终态先经单一 drain owner 拆除 watcher——
        // 它会先把未送出正文作为独立消息送达（文本优先、文书靠后），再在串行队列之外停
        // typing、清 live 进度并拆除订阅。旧实现先读 task meta/快照再 flush，与 /status 的
        // RPC 在同一刚收尾的 session 上争用（协议 deadline 3 分钟），正是「/status 卡死完成
        // 消息」的复现路径；此后续读 meta/快照只影响 change summary 等后续气泡。
        await disposeTaskWatcher(context, watchedTaskId, "terminal");
        // Bugfix: ZCode Agent 终态事件可能先于 task index/meta 落盘广播到 Bots。
        // 如果这里立刻用旧 meta 更新 sidebar，随后列表再刷新到终态 meta，会出现状态/摘要跳一下。
        // 因此终态广播前短重试读取一次稳定 meta，尽量用同一帧完成 UI 增量更新。
        const completedTask = await readTerminalTaskMeta(context, event.taskId, event.type).catch(
          () => null,
        );
        await broadcastTaskListChange(
          context,
          event.taskId,
          event.type === "task_error" ? "error" : "completed",
          {
            ...(completedTask ? { task: completedTask } : {}),
            ...(event.type === "task_error" ? { error: event.error } : {}),
          },
        );
        // Phase B：流到终态后投递目标随之失效；晚到的 share_file RPC 按 no-target 拒绝。
        taskDeliveryRegistry.forget(event.taskId);
        if (event.type === "task_error") {
          if (supportsStreamingCardReply()) {
            streamingCardStatus = "error";
            if (!hasStreamingCardMessageText()) {
              appendStreamingCardMessages([
                msg(await readMessageLocale(), "taskFailed", {
                  message: event.error,
                }),
              ]);
            }
            // Bugfix（F5 specs/bot-message-delivery.md）：错误终态与完成终态同一病理——
            // 熔断打开时 plain force 会静默跳过，卡片冻结 Running 且错误永不送达。
            // half-open 必尝试；仍失败则诚实降级为标准文本失败通知。
            const errorRendered = await syncStreamingCardReply(event.type, true, {
              halfOpen: true,
            });
            if (!errorRendered) {
              botsLogger.warn(
                undefined,
                `Feishu streaming card error render failed, degrading to text task=${context.activeTaskId}`,
              );
              await sendOutbound(
                bot,
                createOutbound(
                  actor,
                  msg(await readMessageLocale(), "taskFailed", {
                    message: event.error,
                  }),
                ),
              ).catch(() => undefined);
            }
            return;
          }
          // M1：终态文书直发（16:42 丢失类）选择缝隙保留——channel-dead 时由 sendOutbound
          // 缝隙进入保留缓冲等待 revival；错误仍上抛（enqueueStreamEvent warn 接住）。
          await sendOutbound(
            bot,
            createOutbound(
              actor,
              msg(await readMessageLocale(), "taskFailed", {
                message: event.error,
              }),
            ),
            { retainOnChannelDead: true },
          );
          return;
        }

        const mode = getMode();
        const locale = await readMessageLocale();
        const completedSnapshot = await zcodeTaskService
          .getTaskSnapshot({
            taskId: event.taskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null);
        const latestTurnChangeSummary = readLatestAssistantTurnChangeSummary(completedSnapshot);
        if (supportsStreamingCardReply()) {
          const changeSummaryMessages = formatBotAssistantReplyBlocks(
            createAssistantReplyBlocks([], new Map(), mode, latestTurnChangeSummary),
            {
              workspacePath: context.workspacePath,
              locale,
            },
          );
          if (changeSummaryMessages.length > 0) {
            appendStreamingCardMessages(changeSummaryMessages);
          }
          streamingCardStatus = "completed";
          // Bugfix（F5 specs/bot-message-delivery.md）：终态渲染带 half-open——熔断打开时也
          // 必尝试一次；若仍失败则诚实降级为标准文本完成消息，不得让卡片冻结在 Running。
          const finalRendered = await syncStreamingCardReply(event.type, true, { halfOpen: true });
          if (finalRendered) {
            sentAnyAssistantReply = true;
            return;
          }
          botsLogger.warn(
            undefined,
            `Feishu streaming card final render failed, degrading to text task=${context.activeTaskId}`,
          );
          if (changeSummaryMessages.length > 0) {
            for (const text of changeSummaryMessages) {
              sentAnyAssistantReply = true;
              await sendOutbound(bot, createOutbound(actor, text));
            }
            return;
          }
          if (!sentAnyAssistantReply) {
            await sendOutbound(
              bot,
              createOutbound(actor, locale === "en-US" ? "Task completed." : "任务已完成。"),
            );
          }
          return;
        }
        let replyMessages: string[] = [];
        if (mode === "summary_changes") {
          const replyBlocks = createAssistantReplyBlocks(
            assistantParts,
            toolCalls,
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(replyBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        } else {
          await flushAssistantReplyBuffer(true);
          const changeSummaryBlocks = createAssistantReplyBlocks(
            [],
            new Map(),
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(changeSummaryBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        }
        if (replyMessages.length === 0 && !sentAnyAssistantReply) {
          await sendOutbound(
            bot,
            createOutbound(actor, locale === "en-US" ? "Task completed." : "任务已完成。"),
            // M1：完成回执 fallback 直发同样选择缝隙保留（channel-dead ⇒ 保留）。
            { retainOnChannelDead: true },
          );
          return;
        }
        for (const text of replyMessages) {
          sentAnyAssistantReply = true;
          await sendOutbound(bot, createOutbound(actor, text), {
            // M1：完成 change-summary 文书直发同样选择缝隙保留（channel-dead ⇒ 保留）。
            retainOnChannelDead: true,
          });
        }
      }
    };
    let streamEventQueue: Promise<void> = Promise.resolve();
    const enqueueStreamEvent = (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
    ): Promise<void> => {
      const nextStreamEvent = streamEventQueue.then(() => handleStreamEvent(event));
      // Bugfix: ZCode Agent 事件分发不保证等待 async listener。微信这类离散消息如果并发发送，
      // task_complete 的 Change summary 可能抢在前面正文 flush 之前到达客户端，所以这里按任务串行消费。
      streamEventQueue = nextStreamEvent.catch((error: unknown) => {
        // §5.12a：本 warn 与 sendOutbound 失败线共享同一死窗限频状态（per bot+peer，
        // 30s 合并）——channel-dead 分类才限频；其它错误逐条输出并作为分类窗口变化
        // 冲刷死窗汇总（若有）。log-only，队列语义不变。
        const streamPeerKey = resolveOutboundPeerKey(actor);
        if (streamPeerKey && classifyBotSendFailure(error) === "channel-dead") {
          const admission = admitDeadWindowFailureLine(bot.id, streamPeerKey, Date.now());
          if (!admission.emit) {
            return;
          }
          botsLogger.warn(
            event.traceId,
            `bot task stream event failed task=${event.taskId}${admission.suppressed ? ` suppressed=${admission.suppressed}` : ""}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        if (streamPeerKey) {
          flushDeadWindowFailureSummary(bot, streamPeerKey);
        }
        botsLogger.warn(
          event.traceId,
          `bot task stream event failed task=${event.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return streamEventQueue;
    };
    const dynamicTaskEvent = (
      zcodeTaskService as Partial<Pick<IZCodeTaskService, "onDynamicTaskEvent">>
    ).onDynamicTaskEvent;
    // Bugfix: 远控/共享 host 场景会通过 workspace+task mirror 分发流事件。
    // 这里优先订阅 workspace 级事件，避免只监听本地 taskId relay 时漏掉 channel 回复。
    const streamDisposable = dynamicTaskEvent
      ? dynamicTaskEvent({
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          taskId: context.activeTaskId,
          // Bugfix: Bot channel 使用 direct stream 语义。
          // 手机远控 replayable 的 mirror replay / snapshot gap recovery 会改变 bot 回复边界，
          // 这里使用 bot 专属 continuous 订阅，避免远控恢复逻辑影响飞书/微信等 channel。
          deliveryKind: "bot-channel-continuous",
        })(enqueueStreamEvent)
      : zcodeTaskService.onDynamicStreamEvent(context.activeTaskId)(enqueueStreamEvent);
    streamSubscriptions.set(streamSubscriptionKey, {
      dispose() {
        streamDisposable.dispose();
      },
    });
    // F1（specs/bot-message-delivery.md）：drain 闭包与订阅同键注册，disposeTaskWatcher 是
    // 唯一调用方（terminal/stop/stale/dispose 四个法定调用点）。flush 走 F2 契约；
    // stopTyping 在串行 streamEventQueue 之外执行——drain 从不入队，队列被挂起时
    // /stop 仍即时排干；拆除后下一次 watchTaskStream 必然建立全新 watcher。
    taskWatcherDisposals.set(streamSubscriptionKey, {
      dispose: async (reason: BotTaskWatcherDisposeReason) => {
        if (assistantReplyBuffer) {
          botsLogger.info(
            undefined,
            `bot task watcher drains pending reply task=${watchedTaskId} reason=${reason}`,
          );
          await flushAssistantReplyBuffer(true);
        }
        liveStatusProgressByTaskId.delete(watchedTaskId);
        stopTyping(watchedTaskId);
        streamSubscriptions.get(streamSubscriptionKey)?.dispose();
        streamSubscriptions.delete(streamSubscriptionKey);
      },
    });
    botsLogger.info(undefined, `bot task watcher create task=${context.activeTaskId}`);
    startTyping(bot, actor, context.activeTaskId);
  }

  async function createSelectionReply(
    actor: BotActor,
    selection: SelectionPrompt,
    locale?: Locale,
    extras: Pick<BotOutboundMessage, "elicitation" | "locale"> = {},
  ): Promise<BotOutboundMessage[]> {
    const markedSelection = markCurrentSelection(selection, locale);
    // Bugfix: 微信没有原生选项卡能力，只能走纯文本编号选项。
    // 之前纯文本 fallback 会同时展示标题里的“当前”和选项上的“当前”标记，
    // 微信回复看起来像重复状态文案；这里让标题负责说明当前状态，列表只保留可回复的编号。
    const supportsStructuredSelection = actor.provider !== "weixin";
    // Bugfix: 微信 /model 第一层选择的是供应商，之前复用 description 把模型列表也拼进同一行，
    // 导致用户还没选供应商就看到两层信息。纯文本通道先只展示供应商，模型放到下一层再展示。
    const textSelection = stripModelProviderDescriptionsForTextSelection(selection);
    const displaySelection = supportsStructuredSelection
      ? markedSelection
      : { ...textSelection, cancelLabel: markedSelection.cancelLabel };
    pendingSelectionsByContext.set(getActorContextKey(actor), displaySelection);
    // 其他 provider 保留 selection，让 Telegram/飞书/Lark 渲染原生选项，也让 Webhook 接收结构化选项。
    const text = supportsStructuredSelection
      ? displaySelection.title
      : formatSelectionFallback(displaySelection, locale);
    return [
      createOutbound(actor, text, supportsStructuredSelection ? displaySelection : undefined, {
        ...extras,
        locale,
      }),
    ];
  }

  async function handleSelectionCancel(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    const actorContextKey = getActorContextKey(message.actor);
    const pendingSelection = pendingSelectionsByContext.get(actorContextKey);
    if (pendingSelection?.action === "elicitation.respond") {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      const pending = auth.context.pendingElicitation;
      if (!pending) {
        clearPendingSelection(message.actor);
        return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
      }
      clearPendingSelection(message.actor);
      // B2 重构：取消路径只消费 replies（行为不变）。
      const cancelled = await submitPendingElicitation(auth, message.actor, pending, "cancel");
      return cancelled.replies;
    }
    if (!pendingSelectionsByContext.has(actorContextKey)) {
      const auth = await withAuthorizedContext(message, "message");
      if (auth.ok && auth.context.pendingElicitation) {
        const cancelled = await submitPendingElicitation(
          auth,
          message.actor,
          auth.context.pendingElicitation,
          "cancel",
        );
        return cancelled.replies;
      }
      return [createOutbound(message.actor, msg(locale, "unknownCommand", { command: "0" }))];
    }
    clearPendingSelection(message.actor);
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  function buildRemoteReconnectCommandKey(
    actor: BotActor,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId ?? actor.providerUserId,
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
    ].join("::");
  }

  function buildRemoteReconnectDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  function pruneRecentRemoteReconnectDeliveryDedupe(now: number): void {
    for (const [key, at] of recentRemoteReconnectDeliveryAtByKey) {
      if (now - at >= REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS) {
        recentRemoteReconnectDeliveryAtByKey.delete(key);
      }
    }
  }

  async function performRemoteReconnect(
    message: BotInboundMessage,
    auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
  ): Promise<BotOutboundMessage[]> {
    let result: BotRemoteWorkspaceReconnectResult;
    try {
      result = await reconnectRemoteWorkspaceForBot(auth.context);
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok) {
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "remoteReconnectFailed", {
            workspacePath: auth.context.workspacePath,
            message: result.message ?? "unknown",
          }),
        ),
      ];
    }
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await buildInitializedDraftOptions(auth.context);
      await writeContext({ ...auth.context, draftOptions });
    }
    // 成功重连后统一回完整状态，避免命令完成文案和 /status 内容分裂。
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function handleReconnect(
    message: BotInboundMessage,
    options: {
      onReconnectStart?: (
        auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
      ) => Promise<void>;
    } = {},
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.workspaceIdentity) {
      return [createOutbound(message.actor, msg(auth.locale, "remoteReconnectLocal"))];
    }
    if (!deps.remoteWorkspaceService) {
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "remoteReconnectUnavailable", {
            workspacePath: auth.context.workspacePath,
          }),
        ),
      ];
    }

    const now = Date.now();
    pruneRecentRemoteReconnectDeliveryDedupe(now);
    const deliveryKey = buildRemoteReconnectDeliveryKey(message);
    if (deliveryKey && recentRemoteReconnectDeliveryAtByKey.has(deliveryKey)) {
      return [];
    }
    if (deliveryKey) {
      // Bugfix: 飞书/微信/Telegram 都可能重投同一条 provider message。
      // /reconnect 有副作用，必须在真正执行前就按 provider message id 幂等，
      // 否则重投会再次命中“已连接”分支，用户会看到重复的成功提示。
      recentRemoteReconnectDeliveryAtByKey.set(deliveryKey, now);
    }

    const reconnectKey = buildRemoteReconnectCommandKey(message.actor, auth.context);
    const pendingReconnect = pendingRemoteReconnectsByKey.get(reconnectKey);
    if (pendingReconnect) {
      await pendingReconnect.catch(() => []);
      return [];
    }
    const recentReconnectAt = recentRemoteReconnectAtByKey.get(reconnectKey);
    if (
      recentReconnectAt !== undefined &&
      now - recentReconnectAt < REMOTE_RECONNECT_DEDUPE_TTL_MS
    ) {
      return [];
    }
    if (await isRemoteWorkspaceConnected(auth.context)) {
      return createStatusReply(message.actor, auth.context, auth.locale);
    }

    // Bugfix: Feishu/Lark/Webhook 这类 provider 可能把同一条 /reconnect 在短时间内重复投递。
    // /reconnect 本身有副作用，必须按 bot+用户+workspace 做幂等，否则会同时出现“已连接”和“正在重连”等互相打架的状态。
    const reconnectPromise = (async () => {
      if (options.onReconnectStart) {
        try {
          await options.onReconnectStart(auth);
        } catch (error) {
          // Bugfix: “正在重连”只是即时状态提示，发送失败不能中断真正的远端重连。
          botsLogger.warn(
            undefined,
            `send reconnect starting failed provider=${message.actor.provider} bot=${message.botId} user=${message.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return performRemoteReconnect(message, auth);
    })();
    pendingRemoteReconnectsByKey.set(reconnectKey, reconnectPromise);
    try {
      const replies = await reconnectPromise;
      recentRemoteReconnectAtByKey.set(reconnectKey, Date.now());
      return replies;
    } finally {
      pendingRemoteReconnectsByKey.delete(reconnectKey);
    }
  }

  async function withAuthorizedContext(
    message: BotInboundMessage,
    requestedCommand: BotAuthorizedCommand,
  ): Promise<
    | {
        ok: true;
        config: BotsConfigFile;
        bot: BotConfig;
        user: BotConfig;
        context: BotContextState;
        locale: Locale | undefined;
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const bot = findAuthorizedBot(config, message.actor);
    if (!bot || bot.id !== message.botId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "botDisabled"))],
      };
    }
    if (message.actor.chatType !== "private") {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "privateChatOnly"))],
      };
    }
    const user = findBoundUser(bot, message.actor);
    if (!user) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "userNotBound"))],
      };
    }
    if (!isUserCommandAllowed(user, requestedCommand)) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "commandNotAllowed"))],
      };
    }
    const context = await readContext(message.actor, bot);
    if (!context) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "noWorkspaceAllowed"))],
      };
    }
    const synced = await normalizeBotWorkspaceConfig(config, bot, {
      id: context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      label: getWorkspaceLabel(context.workspacePath),
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (
      context.workspaceId &&
      !isWorkspaceAllowed(context.workspaceId, synced.user.allowedWorkspaces)
    ) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "workspaceOutOfScope"))],
      };
    }
    const remoteDisconnectedReply = await blockDisconnectedRemoteWorkspace({
      message,
      context,
      locale,
      requestedCommand,
    });
    if (remoteDisconnectedReply) {
      return { ok: false, reply: remoteDisconnectedReply };
    }
    if (isFeishuBotProvider(bot.provider)) {
      // Bugfix: 飞书短命令 typing 现在由同步回复完成后显式删除。
      // 这里必须等 reaction 创建完成，否则 stopInboundTyping 可能先执行，最终留下无法清理的 Typing reaction。
      await sendTyping(bot, message.actor);
    } else {
      void sendTyping(bot, message.actor);
    }
    return {
      ok: true,
      config: synced.config,
      bot: synced.bot,
      user: synced.user,
      context,
      locale,
    };
  }

  async function handleBind(
    message: BotInboundMessage,
    code: string,
  ): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    if (message.actor.chatType !== "private") {
      return [createOutbound(message.actor, msg(locale, "bindPrivateOnly"))];
    }
    const record = bindCodes.get(code.trim().toUpperCase());
    if (!record || record.expiresAt <= Date.now() || record.botId !== message.botId) {
      return [createOutbound(message.actor, msg(locale, "bindCodeInvalid"))];
    }
    const config = await repo.readConfig();
    const bot = findBot(config, record.botId);
    if (!bot) {
      return [createOutbound(message.actor, msg(locale, "bindBotMissing"))];
    }
    // Bot 配置化后 /bind 只绑定当前 bot，不再向 bot 追加 allowedUsers。
    // 重新绑定会覆盖旧 providerUserId，保证一个 bot 同一时间只有一个沟通对象。
    const nextBot: BotConfig = {
      ...bot,
      providerUserId: message.actor.providerUserId,
      displayName: message.actor.displayName,
      allowedWorkspaces: normalizeAllowedWorkspaces(record.allowedWorkspaces),
      allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
      replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
    };
    validateBotConfig(config, nextBot);
    await repo.writeConfig({
      ...config,
      bots: config.bots.map((item) => (item.id === nextBot.id ? nextBot : item)),
    });
    bindCodes.delete(record.code);
    return [
      createOutbound(
        message.actor,
        [msg(locale, "bindSuccess"), buildHelpText(locale, nextBot)].join("\n\n"),
      ),
    ];
  }

  async function handleStatus(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "status");
    if (!auth.ok) {
      return auth.reply;
    }
    return [
      createOutbound(
        message.actor,
        await buildStatusText(auth.context, auth.locale, message.actor),
        undefined,
        {
          locale: auth.locale,
        },
      ),
    ];
  }

  async function createStatusReply(
    actor: BotActor,
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<BotOutboundMessage[]> {
    return [
      createOutbound(actor, await buildStatusText(context, locale, actor), undefined, {
        locale,
      }),
    ];
  }

  function formatStatusLine(
    locale: Locale | undefined,
    labelId: BotMessageId,
    value: string,
  ): string {
    // Bugfix: /status 文案由服务层拼接，标签和值都要跟随 bot 当前 locale。
    return `${msg(locale, labelId)}: ${value}`;
  }

  function formatStatusStateValue(locale: Locale | undefined, state: string): string {
    if (locale === "en-US") {
      return state;
    }
    switch (state) {
      case "draft":
        return msg(locale, "statusDraft");
      case "remote disconnected":
        return msg(locale, "statusRemoteDisconnected");
      case "running":
        return msg(locale, "streamingStatusRunning");
      case "completed":
        return msg(locale, "streamingStatusCompleted");
      case "error":
      case "failed":
        return msg(locale, "streamingStatusFailed");
      case "cancelled":
        return msg(locale, "statusCancelled");
      case "stopped":
        return msg(locale, "statusStopped");
      default:
        return state;
    }
  }

  async function buildStatusText(
    context: BotContextState,
    locale: Locale | undefined,
    actor?: Pick<BotActor, "botId" | "providerUserId" | "chatId">,
  ): Promise<string> {
    const workspace = (await listWorkspaceRefs()).find((item) => item.id === context.workspaceId);
    // M1（specs/bot-message-delivery.md Retention buffer）：保留缓冲非空期间追加待补发行
    //（条数 + 约 KB 数，owner 决定 §7.20）；空缓冲时不追加——健康路径逐字节不变。
    const pendingDeliveryLine = buildRetainedPendingStatusLine(context.botId, actor, locale);
    if (!(await isRemoteWorkspaceConnected(context))) {
      const draftOptions = context.draftOptions;
      return [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        formatStatusLine(
          locale,
          "statusModel",
          await formatStatusModelLabel(
            formatBotModelSelectionValue(draftOptions?.modelSelection),
            context,
            locale,
          ),
        ),
        "------",
        formatStatusLine(locale, "statusTask", context.activeTaskId ?? msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, "remote disconnected"),
        ),
        msg(locale, "remoteDisconnectedStatus", {
          workspacePath: context.workspacePath,
        }),
        ...(pendingDeliveryLine ? [pendingDeliveryLine] : []),
      ].join("\n");
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    const activeTask = context.activeTaskId
      ? tasks.find((task) => task.taskId === context.activeTaskId)
      : null;
    const activeTaskSnapshot = context.activeTaskId
      ? await zcodeTaskService
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      : null;
    // Bugfix: activeTaskId 来自 bot context，不应依赖 listTasks 必然返回同一条任务。
    // 某些筛选/索引时序下 listTasks 找不到 active task，之前会跳过 snapshot，导致 Progress 永远缺失。
    const statusTask = activeTask ?? activeTaskSnapshot?.meta ?? null;
    // Bugfix: 任务结束后 /status 只保留最终状态，避免把最后一次工具/思考进度误看成仍在执行。
    const latestProgress =
      context.activeTaskId && (!statusTask || taskStatus(statusTask) === "running")
        ? (liveStatusProgressByTaskId.get(context.activeTaskId)?.text ??
          readLatestTaskProgress(activeTaskSnapshot))
        : null;
    const workedDurationMs = statusTask
      ? readTaskWorkedDurationMs(activeTaskSnapshot, statusTask)
      : null;
    const activeTaskConfigOptions = context.activeTaskId
      ? await listActiveTaskConfigOptions(context, context.activeTaskId)
      : [];
    const isDraftStatus = context.mode === "draft" || !context.activeTaskId;
    const draftOptions = !statusTask && isDraftStatus ? await ensureDraftOptions(context) : null;
    // Bot Draft 属于 Select：未显式固定模型时只展示目标 Host 当前首选，不把默认值写回配置。
    const draftView = draftOptions
      ? await readModelSelectionView(context, draftOptions.modelSelection)
      : null;
    const draftEffectiveSelection = draftOptions?.modelSelection
      ? draftView?.effectiveSelection
      : draftView?.preferredSelection;
    // specs/bot-inbound-resilience.md §A.2：无解析结果时不再兜底裸 "-"，
    // 交给 formatStatusModelLabel 显示明确本地化“未设置”文案。
    const statusModel =
      readConfigSelectCurrentValue(activeTaskConfigOptions, "model") ??
      statusTask?.model ??
      formatBotModelSelectionValue(draftEffectiveSelection ?? undefined);
    const statusModelLabel = await formatStatusModelLabel(statusModel, context, locale);
    return (
      [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        // Bugfix: active task 显示真实 task 状态；草稿态显示 draftOptions。
        // /new 后草稿继承自当前 task，继续显示 "-" 会让用户误以为继承失败。
        formatStatusLine(locale, "statusModel", statusModelLabel),
        "------",
        statusTask
          ? formatStatusTaskLine(statusTask, msg(locale, "statusTask"))
          : formatStatusLine(locale, "statusTask", msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, statusTask ? taskStatus(statusTask) : "draft"),
        ),
        workedDurationMs !== null
          ? formatStatusLine(locale, "statusWorked", formatTaskRunningDuration(workedDurationMs))
          : null,
        latestProgress ? formatStatusLine(locale, "statusProgress", latestProgress) : null,
        pendingDeliveryLine,
      ].filter(Boolean) as string[]
    ).join("\n");
  }

  async function handleHelp(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    return [createOutbound(message.actor, buildHelpText(auth.locale, auth.bot))];
  }

  function buildHelpText(
    locale: Locale | undefined,
    bot: Pick<BotConfig, "allowedCommands">,
  ): string {
    const lines = [msg(locale, "helpTitle")];
    for (const command of BOT_MENU_COMMAND_ORDER) {
      if (command === "help" || command === "bind") {
        lines.push(msg(locale, helpMessageByCommand[command]));
        continue;
      }
      if (bot.allowedCommands[command] === false) {
        continue;
      }
      lines.push(msg(locale, helpMessageByCommand[command]));
    }
    return lines.join("\n");
  }

  function sendPromptInBackground(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    taskId: string,
    traceId: string,
    content: string,
    attachments: ZCodePromptAttachment[],
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget,
    modelSelection?: ModelSelection,
  ): void {
    // Bugfix: Telegram polling 是单循环顺序处理 update。如果这里 await session/prompt，
    // 权限按钮 callback 会一直排队到整轮任务结束，导致用户点 inline keyboard 没反应。
    // 因此 prompt 必须后台跑，polling loop 才能继续接收 /permission 回调。
    void resolveZCodeTaskServiceForContext(context)
      .then((zcodeTaskService) =>
        zcodeTaskService.sendPrompt({
          taskId,
          traceId,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
          botDeliveryTarget,
          modelSelection,
        }),
      )
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const locale = await readMessageLocale();
        const userFacingMessage = formatUserFacingBotError(error, locale);
        runningTasks.delete(taskId);
        stopTyping(taskId);
        // Review 修复（stale registry）：sendPrompt 失败即任务终态，注册表必须遗忘该
        // taskId——终态任务不再有投递目标，晚到的 share_file RPC 只能按 no-target 拒绝。
        taskDeliveryRegistry.forget(taskId);
        await broadcastTaskListChange(context, taskId, "error", {
          error: message,
        });
        await sendOutbound(
          bot,
          createOutbound(
            actor,
            isSessionExpiredError(error)
              ? userFacingMessage
              : msg(locale, "taskFailed", { message: userFacingMessage }),
          ),
        ).catch(() => undefined);
      });
  }

  async function handleMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) {
      return auth.reply;
    }
    let deletedTaskId: string | undefined;
    if (auth.context.mode === "task" && auth.context.activeTaskId) {
      const taskService = await resolveZCodeTaskServiceForContext(auth.context);
      const deletedTaskIds = await taskService.listDeletedTaskIds({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
      });
      if (deletedTaskIds.includes(auth.context.activeTaskId)) {
        // 桌面软删除只留下 tombstone，CLI 仍可恢复旧 session。
        // Bot 不能只凭 activeTaskId 续跑隐藏任务；先清旧交互，再复用当前草稿有效选择和 V4 首发。
        // 仅以删除记录为准，不能把列表过滤、归档或查询失败当成删除。
        deletedTaskId = auth.context.activeTaskId;
        auth.context = await writeDraftContext(auth.context);
      }
    }
    const elicitationReply = await handlePendingElicitationText(auth, message.actor, message.text);
    if (elicitationReply) {
      return elicitationReply;
    }
    if (
      auth.context.mode === "task" &&
      auth.context.activeTaskId &&
      (await isContextActiveTaskRunning(auth.context))
    ) {
      return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
    }
    let preparedMessage: PreparedBotMessageContent;
    try {
      preparedMessage = await prepareBotMessageContent(auth.bot, message, auth.locale);
    } catch (error) {
      // [ulw] 评审修复（MINOR-1）：prepare 中途失败时，已累积的附件通知前置送达。
      return [
        ...takeBotNoticeRepliesFrom(error),
        createOutbound(
          message.actor,
          msg(auth.locale, "attachmentRejected", {
            message: formatAttachmentRejectedReason(error, auth.locale),
          }),
        ),
      ];
    }
    // Alpha 6（§5.2）：全部附件被拒且无文字 → 整条拒绝（逐个点名的通知即整条拒绝
    // 回复），绝不创建空任务，也不进入任何 prompt 发送路径。
    if (preparedMessage.wholeRejection) {
      return preparedMessage.noticeReplies;
    }
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions =
        auth.context.draftOptions ?? (await buildInitializedDraftOptions(auth.context));
      // 原因：直接提交旧账号身份会绕过统一解析。只在首次创建前解析原意图；
      // 后续创建、配置和首发固定这份结果；绑定后以 Session 原选择解析下一次新输入。
      const selectionView = await readModelSelectionView(auth.context, draftOptions.modelSelection);
      const submissionModelSelection = draftOptions.modelSelection
        ? selectionView?.effectiveSelection
        : selectionView?.preferredSelection;
      if (
        !submissionModelSelection ||
        (draftOptions.modelSelection && selectionView?.selectionIssue)
      ) {
        // specs/bot-inbound-resilience.md §A.1：无模型/失效选择草稿不得 throw——§2b 事故中
        // 该 throw 经通用 catch 变成失败通知，曾驱动无限重投死锁。改为与其他用户可见回复
        // 相同的出站链路返回本地化指引；无有效模型时无法启动，不创建 task（保持不变）。
        // 文案区分“从未选择”（无 preferred 可解析）与“已保存但失效”（selectionIssue）。
        // Alpha 6（§5.1/§5.2）：附件通知仍须随该指引一起送达（通知不替代正常处理）。
        return [
          ...preparedMessage.noticeReplies,
          createOutbound(
            message.actor,
            msg(
              auth.locale,
              draftOptions.modelSelection ? "draftModelInvalid" : "draftModelMissing",
            ),
          ),
        ];
      }
      const submissionDraftOptions: BotDraftOptions = {
        ...draftOptions,
        modelSelection: {
          providerId: submissionModelSelection.providerId,
          modelId: submissionModelSelection.modelId,
          ...(submissionModelSelection.options
            ? { options: { ...submissionModelSelection.options } }
            : {}),
        },
      };
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
      const task = await zcodeTaskService.createTask({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
        provider: draftOptions.provider,
        modelSelection: submissionDraftOptions.modelSelection,
        // 修复原因：Bot 旧 createTask 走 legacy session/create，却紧接着用 v4 sendText，
        // 内存标志与 v4 draft 持久化边界不一致，session_input 会触发 FK。改为先创建
        // v4 draft，再沿既有能力校验应用配置，最后通过 v4 sendText 首发。
        v4Create: true,
      });
      const taskTitle = deriveTaskTitle(preparedMessage.content, preparedMessage.zcodeAttachments);
      const broadcastTask = taskTitle ? { ...task, title: taskTitle } : task;
      const traceId = generateTraceId(task.taskId);
      try {
        await applyDraftConfigOptions(
          { ...auth.context, draftOptions: submissionDraftOptions },
          task.taskId,
          traceId,
        );
      } catch (error) {
        // Bugfix: 初始配置失败时旧流程已把 context 切到 task，留下无法继续的空任务。
        // 在持久化 Bot task 状态前完成配置，并删除临时 task，让用户修正配置后可以直接重试。
        await zcodeTaskService
          .deleteTask({
            taskId: task.taskId,
            workspacePath: auth.context.workspacePath,
            workspaceIdentity: auth.context.workspaceIdentity,
          })
          .catch(() => undefined);
        // [ulw] 评审修复（MINOR-1）：附件通知随错误携带，由回调层 catch 漏斗前置送达。
        tagBotNoticeRepliesOn(error, preparedMessage.noticeReplies);
        throw error;
      }
      const context = {
        ...auth.context,
        mode: "task" as const,
        activeTaskId: task.taskId,
        draftOptions: undefined,
      };
      await writeContext(context);
      // Bugfix: Bot 首发不经过 UI 本地 deriveTaskTitle/optimistic cache。
      // 如果 created 广播继续携带 createTask 的空标题，侧栏会一直显示 New task，直到整表刷新。
      await broadcastTaskListChange(context, task.taskId, "created", {
        task: broadcastTask,
      });
      if (deletedTaskId) {
        botsLogger.info(
          undefined,
          `replaced deleted Bot task bot=${auth.bot.id} oldTask=${deletedTaskId} newTask=${task.taskId} workspace=${getWorkspaceKey(context.workspacePath, context.workspaceIdentity)}`,
        );
        // 切换已经持久化；通知失败不能让 callback 释放去重记录并重跑原消息。
        await sendOutbound(
          auth.bot,
          createOutbound(message.actor, msg(auth.locale, "deletedTaskReplaced")),
        ).catch((error: unknown) => {
          botsLogger.warn(
            undefined,
            `deleted task replacement notice failed bot=${auth.bot.id} task=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      runningTasks.add(task.taskId);
      // Phase B：仅对话式入站触发的任务在此记录 share_file 投递目标；automation/off-peak
      // 复用会话不得重新武装（见 watchAutomationRun 的 forget）。
      taskDeliveryRegistry.remember(task.taskId, {
        botId: auth.bot.id,
        actor: message.actor,
        workspacePath: context.workspacePath,
        ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      });
      await watchTaskStream(auth.bot, message.actor, context, auth.user);
      await broadcastTaskListChange(context, task.taskId, "prompt_sent", {
        task: broadcastTask,
        prompt: {
          content: preparedMessage.content,
          attachments:
            preparedMessage.zcodeAttachments.length > 0
              ? preparedMessage.zcodeAttachments
              : undefined,
          messageId: `bot-${traceId}`,
          sentAt: Date.now(),
        },
      });
      sendPromptInBackground(
        auth.bot,
        message.actor,
        context,
        task.taskId,
        traceId,
        preparedMessage.content,
        preparedMessage.zcodeAttachments,
        resolveAutomationBotDeliveryTarget(message.actor),
        submissionDraftOptions.modelSelection,
      );
      // Alpha 6（§5.1/§5.2）：>4 通知与逐文件超限通知随正常处理一起返回（不替代它）。
      return preparedMessage.noticeReplies;
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
    await zcodeTaskService.resumeTask({
      taskId: auth.context.activeTaskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
    });
    // Bot 只是同一 Session 的输入端。菜单可能过滤无效值，不能拿它反推原选择，
    // 更不能重新套用 Bot 创建默认值。解析只确定本次输入，不在此改写 Session。
    const originalSelection = await zcodeTaskService.getTaskModelSelection({
      taskId: auth.context.activeTaskId,
    });
    const selectionView = originalSelection
      ? await readModelSelectionView(auth.context, originalSelection)
      : null;
    const effectiveSelection = selectionView?.effectiveSelection;
    if (!effectiveSelection || selectionView?.selectionIssue) {
      // [ulw] 评审修复（MINOR-1）：附件通知随错误携带，由回调层 catch 漏斗前置送达
      //（throw 语义本身不变——仍按 §7.12 的 consumed/abort 分类处理）。
      const error = new Error(msg(auth.locale, "sessionModelUnavailable"));
      tagBotNoticeRepliesOn(error, preparedMessage.noticeReplies);
      throw error;
    }
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "resumed");
    runningTasks.add(auth.context.activeTaskId);
    // Phase B：续跑轮同样是对话式入站触发，刷新该任务的投递目标（actor 携带最新 chat/token）。
    taskDeliveryRegistry.remember(auth.context.activeTaskId, {
      botId: auth.bot.id,
      actor: message.actor,
      workspacePath: auth.context.workspacePath,
      ...(auth.context.workspaceIdentity
        ? { workspaceIdentity: auth.context.workspaceIdentity }
        : {}),
    });
    await watchTaskStream(auth.bot, message.actor, auth.context, auth.user);
    const traceId = generateTraceId(auth.context.activeTaskId);
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "prompt_sent", {
      prompt: {
        content: preparedMessage.content,
        attachments:
          preparedMessage.zcodeAttachments.length > 0
            ? preparedMessage.zcodeAttachments
            : undefined,
        messageId: `bot-${traceId}`,
        sentAt: Date.now(),
      },
    });
    sendPromptInBackground(
      auth.bot,
      message.actor,
      auth.context,
      auth.context.activeTaskId,
      traceId,
      preparedMessage.content,
      preparedMessage.zcodeAttachments,
      resolveAutomationBotDeliveryTarget(message.actor),
      effectiveSelection,
    );
    // Alpha 6（§5.1/§5.2）：>4 通知与逐文件超限通知随正常处理一起返回（不替代它）。
    return preparedMessage.noticeReplies;
  }

  async function handleTaskList(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "task");
    if (!auth.ok) {
      return auth.reply;
    }
    if (await isContextActiveTaskRunning(auth.context)) {
      // Bugfix: 运行中展示 /task 列表会让用户继续点选其它 task，
      // 即使后续切换被拒绝，也会留下误导性的 pending selection。
      return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
    }
    const taskEntries = (await listContextTaskSelectionEntries(auth.context, auth.user)).slice(
      0,
      10,
    );
    const tasks = taskEntries.map((entry) => entry.task);
    const activeTask = auth.context.activeTaskId
      ? tasks.find((task) => task.taskId === auth.context.activeTaskId)
      : null;
    const selection: SelectionPrompt = {
      id: `task-${Date.now()}`,
      title: msg(auth.locale, "taskSelectTitle", {
        task: activeTask ? `${activeTask.title} (${activeTask.taskId})` : "draft",
      }),
      currentId: auth.context.activeTaskId ?? undefined,
      action: "task.set",
      options: taskEntries.map((entry) => ({
        id: entry.task.taskId,
        label: entry.task.title,
        description: taskStatus(entry.task),
      })),
    };
    if (taskEntries.length > 0) {
      // Bugfix: 远端 task 展示时必须把 workspaceIdentity 一起缓存。
      // 否则点击 /task 的序号后只剩 taskId，后续二次查询会退回 path-only 语义并提示 Task not found。
      pendingTaskSelectionsByContext.set(
        getActorContextKey(message.actor),
        new Map(taskEntries.map((entry) => [entry.task.taskId, entry])),
      );
    } else {
      pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
    }
    return tasks.length > 0
      ? createSelectionReply(message.actor, selection, auth.locale)
      : [createOutbound(message.actor, msg(auth.locale, "noHistoryTasks"))];
  }

  async function resolveTaskSelectionEntry(
    message: BotInboundMessage,
    context: BotContextState,
    user: BotConfig,
    value: string,
  ): Promise<BotTaskSelectionEntry | null> {
    const pendingEntry = resolvePendingTaskSelectionEntry(message.actor, value);
    if (pendingEntry) {
      return pendingEntry;
    }
    const entries = await listContextTaskSelectionEntries(context, user);
    const selected = resolveOptionByValue(
      entries.map((entry) => ({
        id: entry.task.taskId,
        label: entry.task.title,
        entry,
      })),
      value,
    );
    if (selected) {
      return selected.entry;
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const snapshot = await zcodeTaskService
      .getTaskSnapshot({
        taskId: value.trim(),
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => null);
    return snapshot
      ? {
          task: snapshot.meta,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        }
      : null;
  }

  async function isContextActiveTaskRunning(context: BotContextState): Promise<boolean> {
    if (!context.activeTaskId) {
      return false;
    }
    if (!runningTasks.has(context.activeTaskId)) {
      return false;
    }
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: /workspace 这类本地命令只是在切换上下文，不能为了确认旧任务状态而创建远端 runtime。
      // 断连时把内存 running 状态视为不可确认，交给显式 /reconnect 后再恢复查询。
      return false;
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const activeTaskSnapshot = await zcodeTaskService
      .getTaskSnapshot({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => null);
    if (
      activeTaskSnapshot?.meta.status === "completed" ||
      activeTaskSnapshot?.meta.status === "error"
    ) {
      // Bugfix: Bots 进程内 runningTasks 可能因重启/流式终态事件丢失而和持久化状态不一致。
      // ZCode Agent 历史任务的 status 为空也可能只是旧数据，不代表 UI 仍在运行；只有本进程确实发起
      // 且尚未观察到终态的 task 才阻止 /task、/new 等上下文切换。
      runningTasks.delete(context.activeTaskId);
      stopTyping(context.activeTaskId);
      // Bugfix（F1 specs/bot-message-delivery.md）：终态事件丢失时 watcher 仍武装且缓冲扣着
      // 未送正文（跨聊天续跑还会把回复路由给旧聊天）。这里经单一 drain owner 拆除 watcher
      // 并把部分回复送达其所属聊天；拆除后新一轮 watchTaskStream 建立全新 watcher。
      await disposeTaskWatcher(context, context.activeTaskId, "stale");
      // Review 修复（stale registry）：这里检测到「本进程以为在跑、持久化状态已是终态」，
      // 说明流终态事件已丢失——taskDeliveryRegistry 里的投递目标同样必须失效，终态任务
      // 不能继续应答 share_file（晚到 RPC 按 no-target 拒绝）。
      taskDeliveryRegistry.forget(context.activeTaskId);
      return false;
    }
    return true;
  }

  function warnAutomationDeliveryOnce(params: {
    target: ZCodeAutomationBotDeliveryTarget;
    reason: string;
  }): void {
    const key = `${params.target.provider}:${params.target.botId}:${params.reason}`;
    const now = Date.now();
    const previousAt = automationDeliveryWarningAtByKey.get(key) ?? 0;
    if (now - previousAt < BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS) return;
    automationDeliveryWarningAtByKey.set(key, now);
    botsLogger.warn(
      undefined,
      `automation Bot delivery skipped provider=${params.target.provider} bot=${params.target.botId} reason=${params.reason}`,
    );
  }

  async function watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void> {
    // Phase B：automation 复用 bot 会话（targetTaskId）运行时必须撤销对话式投递目标——
    // 该轮次没有新的入站对话上下文，share_file 只能按 no-target 拒绝（specs Phase B 场景 3）。
    taskDeliveryRegistry.forget(params.taskId);
    const config = await repo.readConfig();
    const bot = findBot(config, params.target.botId);
    if (!bot) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_missing" });
      return;
    }
    if (!bot.enabled) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_disabled" });
      return;
    }
    if (bot.provider !== params.target.provider) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "provider_mismatch" });
      return;
    }
    const actor: BotActor = {
      provider: params.target.provider,
      botId: params.target.botId,
      providerUserId: params.target.providerUserId,
      chatType: params.target.chatType,
    };
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      mode: "task",
      activeTaskId: params.taskId,
      updatedAt: Date.now(),
    };
    // Automation 回推固定为终态摘要；不能复用用户当前 replyMode，否则 streaming/card
    // 会在后台任务执行过程中向原会话持续发送中间过程。
    await watchTaskStream(bot, actor, context, {
      ...bot,
      replyMode: "summary_changes",
    });
  }

  service = {
    async syncAppRuntimePreferences(preferences) {
      await deps.remoteWorkspaceService?.syncAppRuntimePreferences?.(preferences);
    },
    async getStatus() {
      const config = await repo.readConfig();
      const state = await repo.readState();
      return {
        botsCount: config.bots.length,
        enabledBotsCount: config.bots.filter((bot) => bot.enabled).length,
        contextsCount: Object.keys(state.bots).length,
        botRuntime: config.bots.map((bot) => {
          const runtime = runtimeByBotId.get(bot.id);
          return (
            runtime ?? {
              botId: bot.id,
              provider: bot.provider,
              status: bot.enabled ? "idle" : "disabled",
              message: bot.enabled ? "Bot is configured." : "Bot is disabled.",
              offset: state.bots[bot.id]?.telegramOffset,
            }
          );
        }),
      };
    },
    getConfig: () => repo.readConfig(),
    listWorkspaceRefs,
    getUserConfigOptions: listUserConfigOptions,
    beginFeishuRegistration(params) {
      return beginFeishuAppRegistration(providerRequester, params?.domain);
    },
    pollFeishuRegistration(params) {
      return pollFeishuAppRegistration({ ...params, requester: providerRequester });
    },
    beginWeixinRegistration() {
      return beginWeixinQrRegistration(providerRequester);
    },
    pollWeixinRegistration(params) {
      return pollWeixinQrRegistration({ ...params, requester: providerRequester });
    },
    async saveConfig(config) {
      const savedConfig = await repo.writeConfig(normalizeConfigBots(config));
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return savedConfig;
    },
    async listBots() {
      return (await repo.readConfig()).bots;
    },
    async saveBot(params: BotSaveBotParams): Promise<BotSaveBotResult> {
      const config = await repo.readConfig();
      let bot: BotConfig = {
        ...params.bot,
        id: params.bot.id.trim(),
        name: params.bot.name.trim(),
        allowedWorkspaces: normalizeAllowedWorkspaces(params.bot.allowedWorkspaces),
        allowedCommands: normalizeBotCommandPolicy(params.bot.allowedCommands),
        currentOptions: normalizeBotCurrentOptions(params.bot.currentOptions),
        replyMode: normalizeBotReplyGranularity(params.bot.provider, params.bot.replyMode),
      };
      // F0：凭据校验失败不阻塞保存，但要把原因带回给调用方（见下方赋值点）。
      let resolveNameError: string | undefined;
      if (params.credentialValue?.trim()) {
        const key = buildBotCredentialKey(bot.id);
        await deps.credentialService.save(key, params.credentialValue.trim());
        bot = { ...bot, credentialRef: key };
      }
      if (params.webhookSecretValue?.trim()) {
        const key = buildBotWebhookSecretKey(bot.id);
        await deps.credentialService.save(key, params.webhookSecretValue.trim());
        bot = { ...bot, webhookSecretRef: key };
      }
      if (params.credentialValue?.trim() || !bot.name.trim()) {
        const adapter = providers[bot.provider];
        const resolveRetryDelaysMs = isFeishuBotProvider(bot.provider) ? [0, 800, 1_800] : [0];
        let resolvedName: string | null | undefined = null;
        let lastResolveNameError: unknown;
        for (const retryDelayMs of resolveRetryDelaysMs) {
          if (retryDelayMs > 0) {
            // Bugfix: 飞书 / Lark 扫码创建应用后，应用信息接口可能短暂不可读；重试后再回填 Bot 名称。
            await delay(retryDelayMs);
          }
          try {
            resolvedName = await adapter?.resolveName?.(bot);
            if (resolvedName?.trim()) {
              break;
            }
          } catch (error) {
            lastResolveNameError = error;
          }
        }
        if (resolvedName?.trim()) {
          bot = { ...bot, name: resolvedName.trim() };
        } else if (lastResolveNameError) {
          // Bugfix（事故 2026-10-01）：resolveName 失败此前只 warn 就继续，添加流程完全
          // 感知不到不可达的 token。配置仍然保存（本地配置是事实源），但把失败原因通过
          // 返回值带回给添加流程做非阻塞提示（F0 add-time fail-fast）。
          resolveNameError =
            lastResolveNameError instanceof Error
              ? lastResolveNameError.message
              : String(lastResolveNameError);
          botsLogger.warn(undefined, `resolve bot name failed bot=${bot.id}: ${resolveNameError}`);
        }
      }
      bot = normalizeBotConfig(bot);
      validateBotConfig(config, bot);
      const bots = config.bots.filter((item) => item.id !== bot.id);
      bots.push(bot);
      const savedConfig = await repo.writeConfig({ ...config, bots });
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return resolveNameError ? { ...bot, resolveNameError } : bot;
    },
    async removeBotSecret(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      if (bot.provider === "telegram") {
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (isFeishuBotProvider(bot.provider)) {
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      // Bugfix: 只移除密钥时如果保留旧绑定身份，UI 会显示“已连通”，但运行时已经没有 token 可用。
      // 这里同步清理绑定状态，让 Bot token 行回到可重新添加的状态。
      const nextBot = normalizeBotConfig({
        ...bot,
        credentialRef: undefined,
        webhookSecretRef: undefined,
        providerUserId: undefined,
        displayName: undefined,
        feishuAppId: isFeishuBotProvider(bot.provider) ? undefined : bot.feishuAppId,
      });
      const savedConfig = await repo.writeConfig({
        ...config,
        bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
      });
      const state = await repo.readState();
      delete state.bots[bot.id];
      await repo.writeState(state);
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      if (bot.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
      return nextBot;
    },
    async deleteBot(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (bot?.provider === "telegram") {
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (bot && isFeishuBotProvider(bot.provider)) {
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot?.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      await repo.writeConfig({
        ...config,
        bots: config.bots.filter((item) => item.id !== botId),
      });
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh();
      weixinRuntime.scheduleRefresh();
      const state = await repo.readState();
      delete state.bots[botId];
      await repo.writeState(state);
      if (bot?.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot?.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
    },
    async testBot(botId: string): Promise<BotTestResult> {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        return { ok: false, message: "Bot not found." };
      }
      const adapter = providers[bot.provider];
      if (!adapter) {
        return {
          ok: false,
          message: `${bot.provider} is reserved for a future version.`,
          provider: bot.provider,
        };
      }
      return { ...(await adapter.test(bot)), provider: bot.provider };
    },
    async createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult> {
      const config = await repo.readConfig();
      const botId = params.botId ?? params.botId;
      if (!botId) {
        throw new Error("Bot id is required.");
      }
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      const code = createCode();
      const expiresAt = Date.now() + (params.ttlMs ?? BOT_BIND_CODE_TTL_MS);
      const allowedWorkspaces = normalizeAllowedWorkspaces(
        params.allowedWorkspaces ?? [ALL_BOT_WORKSPACES],
      );
      bindCodes.set(code, {
        botId: botId,
        code,
        allowedWorkspaces,
        expiresAt,
      });
      return { code, expiresAt };
    },
    async getBotStates() {
      return Object.values((await repo.readState()).bots);
    },
    async resetBotState(contextKey: string) {
      const state = await repo.readState();
      delete state.bots[contextKey];
      await repo.writeState(state);
    },
    watchAutomationRun,
    /**
     * bots/shareFile RPC 的 Host 侧裁决入口（specs/bot-file-delivery.md Phase B §2）：
     * 收件人只从 taskDeliveryRegistry 解析（协议参数绝不携带目标字段）；注册表未命中
     * （未知/终态/automation 复用任务）→ no-target。quota 只作用于该 tool 路径，
     * /file 命令不走这里、永不受配额限制。
     */
    async shareFileForTask(
      params: { taskId: string; path: string },
      opts?: BotShareFileTaskDeliveryOptions,
    ): Promise<BotShareFileResult> {
      const entry = taskDeliveryRegistry.get(params.taskId);
      if (!entry) {
        return { ok: false, reason: "no-target" };
      }
      // Phase C Alpha 3 跨 Host 钉扎：桌面窗口 Host 的 forward handler 传入连接作用域
      // （来自连接注册表的事实，绝非远端自报）。注册表条目的 (workspacePath,
      // workspaceIdentity) 必须落在该连接服务的 workspace 集合内——被入侵的远端不能
      // 借本连接投递别的 workspace / 别的机器的会话。判定先于配额预留与任何文件 IO，
      // 按 not-allowed fail-closed；本地 workspace 条目（无 identity）永不匹配远程作用域。
      const restrictToWorkspaces = opts?.restrictToWorkspaces;
      if (
        restrictToWorkspaces &&
        !restrictToWorkspaces.some(
          (scope) =>
            scope.workspacePath === entry.workspacePath &&
            (scope.workspaceIdentity ?? undefined) === (entry.workspaceIdentity ?? undefined),
        )
      ) {
        botsLogger.warn(
          undefined,
          // Review 修复：去掉与 path= 重复的 file= 字段（同一值打印两次）。
          `bot file delivery rejected bot=${entry.botId} size=0 outcome=not-allowed source=forward-pin task=${params.taskId} path=${params.path}: registry entry workspace is not served by the forwarding connection`,
        );
        return { ok: false, reason: "not-allowed" };
      }
      const actor = entry.actor;
      const peerKey = actor.chatId?.trim() || actor.providerUserId.trim();
      // Review 修复（并行 share_file TOCTOU）：配额必须在任何文件 IO 之前「原子预留」。
      // share_file 是 concurrentSafe 工具，调度器并行执行多个调用；原先 allows() 判定与
      // 投递完成后的 record() 落账之间存在窗口，N 个并行调用会在彼此落账前全部通过判定，
      // 绕过窗口上限。现在每个在途调用先占一个槽位（reserve 同步完成判定 + 占位），
      // 投递失败时按预留时间戳精确释放（release），对外语义保持「只有成功投递消耗配额」。
      const reservedAt = Date.now();
      if (peerKey && !shareFileQuota.reserve(entry.botId, peerKey, reservedAt)) {
        botsLogger.warn(
          undefined,
          // §5.8（Alpha 7）：file= 与 path= 同值（预解析拒绝）——只留 path=，不重复打印。
          `bot file delivery rejected bot=${entry.botId} peer=${peerKey} size=0 outcome=quota-exceeded source=tool task=${params.taskId} path=${params.path}`,
        );
        return { ok: false, reason: "quota-exceeded" };
      }
      const releaseReservedQuota = (): void => {
        if (peerKey) {
          shareFileQuota.release(entry.botId, peerKey, reservedAt);
        }
      };
      try {
        const config = await repo.readConfig();
        const bot = findBot(config, entry.botId);
        if (!bot) {
          releaseReservedQuota();
          return { ok: false, reason: "not-allowed" };
        }
        const delivered = await deliverWorkspaceFile(
          bot,
          actor,
          {
            workspacePath: entry.workspacePath,
            ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
          },
          params.path.trim(),
          { source: "tool", taskId: params.taskId },
        );
        if (!delivered.ok) {
          // 失败投递不消耗配额：预留槽位归还（sendAttachment 失败、路径/体积拒绝等全部适用）。
          releaseReservedQuota();
        }
        return delivered;
      } catch (error) {
        // Review 修复（honest failure prose）：deliverWorkspaceFile 只守卫 sendAttachment
        // await；repo.readConfig 等投递前置阶段的 Host 侧异常（如配置 IO 失败）会原样
        // 抛出到这里——它们从未触达 provider，必须如实标注为投递前的 Host 错误，
        // 不能让 CLI 侧把 -32602/-32603 传输错误误读成 provider 侧失败。
        releaseReservedQuota();
        const reasonText = error instanceof Error ? error.message : String(error);
        botsLogger.warn(
          undefined,
          // §5.8（Alpha 7）：file= 与 path= 同值（投递前 Host 错误）——只留 path=。
          `bot file delivery failed bot=${entry.botId} peer=${peerKey} size=0 outcome=send-failed source=tool task=${params.taskId} path=${params.path}: host error before delivery: ${reasonText}`,
        );
        return {
          ok: false,
          reason: "send-failed",
          detail: `host error before delivery: ${reasonText}`,
        };
      }
    },
    async handleInboundMessage(message: BotInboundMessage) {
      return enqueueInboundProcessing(message.actor, async () => {
        // 微信出站媒体依赖新鲜 context_token；必须在任何 context 读改写之前落库，避免被后续 writeContext 覆盖。
        await persistWeixinContextToken(message);
        // alpha.5 观测（specs/log-diagnostics-hygiene.md Amendment 3.14.5-alpha.5）：该 peer
        // 的任意入站归零 weixin burst 计数——不依赖 token 存在（入站可以不带 token），
        // 且必须先于 revival 补发，使 revival 的失败线从 1 重新计数。log-only。
        if (message.actor.provider === "weixin") {
          resetWeixinSendBurstOrdinal(
            message.botId,
            message.actor.chatId?.trim() || message.actor.providerUserId.trim(),
          );
        }
        // Bugfix（M1 revival，specs/bot-message-delivery.md 3.14.5-alpha.4）：触发 = 该
        // bot+peer 的任意 weixin 入站（不 key 于 token 值变化——实测存在不轮换的入站）；
        // 在入站队列内、命令处理前补发积压，保证积压先于新回合回复（dual-terminal
        // re-watch 序：dispose → ping → 新回合，补发必须先于新回合回复）。
        await reviveRetainedReplies(message);
        if (message.elicitationResponse) {
          return handleStructuredElicitationResponse(message, message.elicitationResponse);
        }
        const parsedCommand = parseBotCommand(message.text);
        const command =
          parsedCommand.type === "message"
            ? (resolvePendingSelectionCommand(message.actor, parsedCommand.text) ?? parsedCommand)
            : parsedCommand.type === "selection.cancel" &&
                message.actor.provider !== "weixin" &&
                message.text.trim() === "0"
              ? (clearPendingSelection(message.actor),
                { type: "message", text: message.text } as const)
              : parsedCommand;
        const weixinActivationReply = await handleWeixinFirstActivation(message, command);
        if (weixinActivationReply) {
          return weixinActivationReply;
        }
        switch (command.type) {
          case "selection.cancel":
            return handleSelectionCancel(message);
          case "bind":
            return handleBind(message, command.code);
          case "help":
            return handleHelp(message);
          case "status":
            return handleStatus(message);
          case "reconnect":
            return handleReconnect(message);
          case "file":
            return handleFileCommand(message, command.value);
          case "new": {
            const auth = await withAuthorizedContext(message, "new");
            if (!auth.ok) return auth.reply;
            if (await isContextActiveTaskRunning(auth.context)) {
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            const context = await writeDraftContext(
              auth.context,
              await buildActiveTaskDraftOptions(auth.context),
            );
            return createStatusReply(message.actor, context, auth.locale);
          }
          case "workspace.list": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            if (await isContextActiveTaskRunning(auth.context)) {
              // Bugfix: task 运行中不展示 workspace 选择，避免用户误以为可以切换上下文。
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
            const visibleWorkspaces = filterAllowedWorkspaces(
              synced.workspaces,
              synced.user.allowedWorkspaces,
            );
            const options = visibleWorkspaces.map((workspace) => ({
              id: workspace.id,
              // Bugfix: Telegram/飞书等按钮通道只展示 label，不展示 description。
              // 远端标识必须合进 label，避免 /workspace 列表看不出哪些项目来自远端。
              label: formatWorkspaceOptionLabel(workspace, auth.locale),
            }));
            if (options.length === 0) {
              pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            }
            // Bugfix: 远端 workspace 选项必须在展示时保留 workspaceIdentity。
            // Telegram/飞书按钮会把点击变成 /workspace 序号，切换阶段若重新从 settings 解析，
            // current remote context 可能不在候选列表里，最终表现成 /workspace 不支持远端。
            pendingWorkspaceSelectionsByContext.set(
              getActorContextKey(message.actor),
              new Map(visibleWorkspaces.map((workspace) => [workspace.id, { workspace }])),
            );
            return createSelectionReply(
              message.actor,
              {
                id: `workspace-${Date.now()}`,
                title: msg(auth.locale, "workspaceSelectTitle", {
                  workspace:
                    visibleWorkspaces.find((workspace) => workspace.id === auth.context.workspaceId)
                      ?.label ?? auth.context.workspacePath,
                }),
                currentId: auth.context.workspaceId,
                action: "workspace.set",
                options,
              },
              auth.locale,
            );
          }
          case "workspace.set": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            if (await isContextActiveTaskRunning(auth.context)) {
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
            const workspace =
              resolvePendingWorkspaceSelectionEntry(message.actor, command.value)?.workspace ??
              resolveWorkspaceByValue(
                synced.workspaces,
                command.value,
                synced.user.allowedWorkspaces,
              );
            if (!workspace)
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            const context = {
              ...auth.context,
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
              workspaceId: workspace.id,
            };
            const draftContext = await writeDraftContext(
              context,
              await buildInitializedDraftOptions(context),
            );
            pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, draftContext, auth.locale);
          }
          case "model.list": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            if (await isContextActiveTaskRunning(auth.context)) {
              // Bugfix: task 运行中不展示模型选择，避免产生运行中不可用的 pending selection。
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
              const providers = await listModelProviderOptionsForActiveTask(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                draftOptions.provider,
              );
              if (providers.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
              const currentProviderId = await readCurrentModelProviderId(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                [],
                draftOptions.provider,
              );
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelProviderSelectTitle", {
                    model: await formatStatusModelLabel(
                      formatBotModelSelectionValue(draftOptions.modelSelection),
                      auth.context,
                      auth.locale,
                    ),
                  }),
                  currentId: currentProviderId,
                  action: "model.provider.set",
                  options: providers,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
            if (providers.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            const currentProviderId = await readCurrentModelProviderId(
              active.task,
              active.configOptions,
              activeProvider,
            );
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelProviderSelectTitle", {
                  model: await formatStatusModelLabel(currentValue, active.task, auth.locale),
                }),
                currentId: currentProviderId,
                action: "model.provider.set",
                options: providers,
              },
              auth.locale,
            );
          }
          case "model.provider.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            if (await isContextActiveTaskRunning(auth.context)) {
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
              const draftTask = {
                model: formatBotModelSelectionValue(draftOptions.modelSelection),
                workspacePath: auth.context.workspacePath,
                workspaceIdentity: auth.context.workspaceIdentity,
              };
              const providers = await listModelProviderOptionsForActiveTask(
                draftTask,
                draftOptions.provider,
              );
              const provider =
                resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
                resolveOptionByValue(providers, command.value);
              const providerId = provider?.id;
              if (!providerId) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
              const providerModels = readModelProviderSelectionModels(provider);
              const options =
                providerModels.length > 0
                  ? providerModels
                  : await listModelOptionsForProviderFromActiveTask(
                      draftTask,
                      draftOptions.provider,
                      providerId,
                    );
              if (options.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelModelSelectTitle", {
                    model: formatBotModelSelectionValue(draftOptions.modelSelection) ?? "-",
                  }),
                  currentId: options.some(
                    (option) =>
                      option.id === formatBotModelSelectionValue(draftOptions.modelSelection),
                  )
                    ? formatBotModelSelectionValue(draftOptions.modelSelection)
                    : undefined,
                  action: "model.set",
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
            const provider =
              resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
              resolveOptionByValue(providers, command.value);
            const providerId = provider?.id;
            if (!providerId) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providerModels = readModelProviderSelectionModels(provider);
            const options =
              providerModels.length > 0
                ? providerModels
                : await listModelOptionsForProviderFromActiveTask(
                    active.task,
                    activeProvider,
                    providerId,
                  );
            if (options.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelModelSelectTitle", {
                  model: currentValue ?? "-",
                }),
                currentId: options.some((option) => option.id === currentValue)
                  ? currentValue
                  : undefined,
                action: "model.set",
                options,
              },
              auth.locale,
            );
          }
          case "model.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            if (await isContextActiveTaskRunning(auth.context)) {
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const model =
                resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
                resolveOptionByValue(
                  await listAllModelOptionsForActiveTask(
                    {
                      model: formatBotModelSelectionValue(draftOptions.modelSelection),
                      workspacePath: auth.context.workspacePath,
                      workspaceIdentity: auth.context.workspaceIdentity,
                    },
                    draftOptions.provider,
                  ),
                  command.value,
                );
              if (!model) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
              const identity = parseBotModelOptionValue(model.id);
              const view = await readModelSelectionView(auth.context);
              const selection =
                view && identity ? completeNewModelSelection(view, identity) : undefined;
              // Bot 的主动选模也须取目标最高档；旧菜单失效/读取失败不能清掉已保存选择。
              if (!selection)
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                // 模型身份切换必须构造全新的 Selection，不能把旧模型的显式 options 带过去。
                modelSelection: selection,
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const model =
              resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
              resolveOptionByValue(
                await listAllModelOptionsForActiveTask(active.task, activeProvider),
                command.value,
              );
            if (!model) return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            const nextModel = model.id;
            const customModel = decodeCustomModelValue(nextModel);
            const targetModel = customModel
              ? resolveCustomModelRuntimeModelId(activeProvider, customModel)
              : nextModel;
            if (!targetModel) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const targetIdentity = customModel?.modelName
              ? {
                  // Bugfix: bot /model 选择 custom provider 时，targetModel 会被降成纯模型名。
                  // legacy task facade 必须额外拿到原始 provider 身份，否则同名模型会退回 zcode/native。
                  providerId: customModel.providerId,
                  modelId: customModel.modelName,
                }
              : { providerId: activeProvider, modelId: targetModel };
            const view = await readModelSelectionView(active.task);
            const targetModelSelection = view
              ? completeNewModelSelection(view, targetIdentity)
              : undefined;
            if (!targetModelSelection)
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(active.task);
            const configOptions = await zcodeTaskService.setModel({
              taskId: active.taskId,
              traceId,
              modelSelection: targetModelSelection,
            });
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: activeProvider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "mode.list":
          case "thoughtLevel.list": {
            const commandName = command.type === "mode.list" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
            if (command.type === "mode.list") {
              // Bot 硬锁 yolo：不提供模式选择。
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            if (await isContextActiveTaskRunning(auth.context)) {
              // Bugfix: task 运行中不展示模式/思考级别选择，避免和正在执行的上下文配置混淆。
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const optionSource = await listDraftConfigOptions(auth.context, draftOptions);
              const rawCurrentValue =
                commandName === "mode"
                  ? draftOptions.mode
                  : findSelectConfigOption(optionSource, commandName)?.currentValue;
              const currentValue =
                typeof rawCurrentValue === "string" ? rawCurrentValue : undefined;
              const currentLabel = readConfigSelectLabelForValue(
                optionSource,
                commandName,
                currentValue,
                { locale: auth.locale, provider: draftOptions.provider },
              );
              const selectOption = findSelectConfigOption(optionSource, commandName);
              const options = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
              if (options.length === 0) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                  title:
                    commandName === "mode"
                      ? msg(auth.locale, "modeSelectTitle", {
                          mode: currentLabel ?? "-",
                        })
                      : msg(auth.locale, "thoughtLevelSelectTitle", {
                          level: currentLabel ?? "-",
                        }),
                  currentId: currentValue,
                  action: `${commandName}.set` as SelectionPrompt["action"],
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(
                    active.task,
                    normalizeAgentProviderToZCodeAgent(active.task.provider),
                  )
                : active.configOptions;
            const currentValue =
              commandName === "mode"
                ? readCurrentActiveTaskMode(active.task, active.configOptions)
                : readConfigSelectCurrentValue(active.configOptions, commandName);
            const currentLabel =
              commandName === "mode"
                ? readConfigSelectLabelForValue(optionSource, commandName, currentValue, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  })
                : readConfigSelectCurrentLabel(active.configOptions, commandName, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  });
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const options = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
            });
            if (options.length === 0) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            return createSelectionReply(
              message.actor,
              {
                id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                title:
                  commandName === "mode"
                    ? msg(auth.locale, "modeSelectTitle", {
                        mode: currentLabel ?? "-",
                      })
                    : msg(auth.locale, "thoughtLevelSelectTitle", {
                        level: currentLabel ?? "-",
                      }),
                currentId: currentValue,
                action: `${commandName}.set` as SelectionPrompt["action"],
                options,
              },
              auth.locale,
            );
          }
          case "mode.set":
          case "thoughtLevel.set": {
            const commandName = command.type === "mode.set" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
            if (command.type === "mode.set") {
              // Bot 硬锁 yolo：拒绝任何模式切换请求。
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            if (await isContextActiveTaskRunning(auth.context)) {
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const originalOptions = await ensureDraftOptions(auth.context);
              const view = await readModelSelectionView(
                auth.context,
                originalOptions.modelSelection,
              );
              const optionSource = await listDraftConfigOptions(
                auth.context,
                originalOptions,
                view,
              );
              // 同一个快照给出候选与当前模型；失效原意图不能因副本为空退回 preferred。
              const draftOptions = {
                ...originalOptions,
                modelSelection:
                  (originalOptions.modelSelection
                    ? view?.effectiveSelection
                    : view?.preferredSelection) ?? undefined,
              };
              const displayOptions = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
              const option =
                resolvePendingSelectionOption(
                  message.actor,
                  `${commandName}.set` as SelectionPrompt["action"],
                  command.value,
                ) ?? resolveOptionByValue(displayOptions, command.value);
              if (option && !displayOptions.some((candidate) => candidate.id === option.id)) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              if (!option) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                ...(commandName === "mode"
                  ? { mode: option.id }
                  : draftOptions.modelSelection
                    ? {
                        modelSelection: {
                          ...draftOptions.modelSelection,
                          options: {
                            ...draftOptions.modelSelection.options,
                            reasoningLevel: option.id,
                          },
                        },
                      }
                    : {}),
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(active.task, active.task.provider)
                : active.configOptions;
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const displayOptions = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: active.task.provider,
            });
            const option =
              resolvePendingSelectionOption(
                message.actor,
                `${commandName}.set` as SelectionPrompt["action"],
                command.value,
              ) ?? resolveOptionByValue(displayOptions, command.value);
            if (!option) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            if (!selectOption?.id) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const configOptions = await zcodeTaskService.setConfigOption({
              taskId: active.taskId,
              traceId,
              configId: selectOption.id,
              value: option.id,
            });
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: active.task.provider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "task.list":
            return handleTaskList(message);
          case "task.set": {
            const auth = await withAuthorizedContext(message, "task");
            if (!auth.ok) return auth.reply;
            const taskEntry = await resolveTaskSelectionEntry(
              message,
              auth.context,
              auth.user,
              command.value,
            );
            if (!taskEntry) return [createOutbound(message.actor, msg(auth.locale, "taskMissing"))];
            const { task } = taskEntry;
            if (
              auth.context.activeTaskId !== task.taskId &&
              (await isContextActiveTaskRunning(auth.context))
            ) {
              // Bugfix: 运行中的旧 task 已经建立了第三方 stream 订阅。
              // 如果此时允许 /task 改写 activeTaskId，后续输入会落到新 task，
              // 但旧 task 输出仍会继续回到同一 bot 会话，用户会误以为消息串线。
              return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
            }
            const nextContext = {
              ...auth.context,
              workspacePath: taskEntry.workspacePath,
              workspaceIdentity: taskEntry.workspaceIdentity,
              workspaceId: getWorkspaceKey(taskEntry.workspacePath, taskEntry.workspaceIdentity),
              mode: "task",
              activeTaskId: task.taskId,
            } satisfies BotContextState;
            await writeContext(nextContext);
            pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, nextContext, auth.locale);
          }
          case "reply.list": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            return createSelectionReply(
              message.actor,
              {
                id: `reply-${Date.now()}`,
                title: msg(auth.locale, "replySelectTitle", {
                  mode: formatReplyGranularityLabel(
                    auth.bot.replyMode,
                    auth.locale,
                    auth.bot.provider,
                  ),
                }),
                currentId: normalizeBotReplyGranularity(auth.bot.provider, auth.bot.replyMode),
                action: "reply.set",
                options: getReplyGranularityOptions(auth.locale, auth.bot.provider),
              },
              auth.locale,
            );
          }
          case "reply.set": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            const replyGranularity = resolveReplyGranularityByValue(
              command.value,
              auth.locale,
              auth.bot.provider,
            );
            if (!replyGranularity)
              return [createOutbound(message.actor, msg(auth.locale, "replyMissing"))];
            await service.saveBot({
              bot: {
                ...auth.bot,
                replyMode: replyGranularity.id,
              },
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "stop": {
            const auth = await withAuthorizedContext(message, "stop");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId) {
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            }
            try {
              const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
              await zcodeTaskService.stopGeneration({
                taskId: auth.context.activeTaskId,
              });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : String(error);
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, "taskFailed", { message: messageText }),
                ),
              ];
            }
            runningTasks.delete(auth.context.activeTaskId);
            // Bugfix（F1 specs/bot-message-delivery.md）：/stop 是 watcher 的法定 drain 点。
            // 顺序为 stopGeneration → drain → 状态回复：drain 把未送出的部分回复作为独立
            // 消息立即送达（owner 决定语义：文本已在桌面 UI 可见，丢弃即信息损失，扣押它
            // 正是卡消息 bug），随后停 typing、拆除订阅；晚到的终态通知由它取代——订阅已拆，
            // 不会再发。drain 不入串行事件队列，事件队列被挂起也不影响 /stop。
            await disposeTaskWatcher(auth.context, auth.context.activeTaskId, "stop");
            stopTyping(auth.context.activeTaskId);
            await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "updated");
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "permission.respond": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const optionIndex = Number.parseInt(command.value, 10) - 1;
            const option = Number.isFinite(optionIndex)
              ? auth.context.pendingPermissionOptions?.[optionIndex]
              : undefined;
            botsLogger.info(
              undefined,
              `permission callback task=${auth.context.activeTaskId} user=${message.actor.providerUserId} optionIndex=${optionIndex + 1} pending=${auth.context.pendingPermissionOptions?.length ?? 0} option=${option ? `${option.command}:${option.optionId}` : "missing"} handled=${option?.handledAt ? "yes" : "no"}`,
            );
            if (!option)
              return [createOutbound(message.actor, msg(auth.locale, "permissionExpired"))];
            if (option.handledAt)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: option.requestId,
              optionId: option.optionId,
              response: option.response,
            });
            // 修复原因：权限和问答必须以同一个 v4 ACK 为提交点。ACK 失败前不能持久化
            // handledAt，否则 Telegram/文本序号按钮无法重试，runtime 仍会继续等待权限。
            const handledAt = Date.now();
            const nextPermissionOptions = auth.context.pendingPermissionOptions?.map((item) =>
              item.requestId === option.requestId ? { ...item, handledAt } : item,
            );
            botsLogger.info(
              undefined,
              `permission callback respond task=${auth.context.activeTaskId} requestId=${option.requestId} optionId=${option.optionId} submitted=${submitted}`,
            );
            if (!submitted) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
            await writeContext({
              ...auth.context,
              pendingPermissionOptions: nextPermissionOptions,
            });
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: option.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [
              createOutbound(
                message.actor,
                msg(
                  auth.locale,
                  option.command === "deny" ? "permissionDenied" : "permissionSubmitted",
                ),
              ),
            ];
          }
          case "elicitation.respond": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            return handlePendingElicitationValue(auth, message.actor, command.value);
          }
          case "elicitation.submit": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            const pending = auth.context.pendingElicitation;
            if (!pending) {
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            if (message.actor.provider !== "weixin") {
              // Bugfix: 非微信通道的“完成”应从带 token 的按钮进入 elicitation.respond。
              // 直接 /elicitation submit 没有轮次标识，可能误提交上一轮 AskUserQuestion。
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            // B2 重构：微信"完成"直提路径只消费 replies（行为不变）。
            const submitted = await submitPendingElicitation(
              auth,
              message.actor,
              pending,
              "accept",
              buildBotElicitationContent(pending),
            );
            return submitted.replies;
          }
          case "approve": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) =>
                option.requestId === command.requestId && option.optionId === command.optionId,
            );
            if (!pendingOption) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: command.optionId,
              response: pendingOption.response,
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionSubmitted"))];
          }
          case "deny": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) => option.requestId === command.requestId && option.command === "deny",
            );
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: "deny",
              response: pendingOption?.response ?? {
                decision: "deny",
                reason: "Denied by bot command",
              },
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionDenied"))];
          }
          case "unknown":
            return [
              createOutbound(
                message.actor,
                msg(await readMessageLocale(), "unknownCommand", {
                  command: command.name,
                }),
              ),
            ];
          case "message":
            return handleMessage(message);
        }
      });
    },
    async handleProviderCallback(provider: BotProvider, payload: unknown) {
      return (await processProviderCallback(provider, payload)).replies;
    },
    async handleProviderCallbackResponse(provider: BotProvider, payload: unknown) {
      return processProviderCallback(provider, payload);
    },
    disposeAll() {
      void service.disposeAllAndWait().catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `dispose Bot runtimes failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    disposeAllAndWait() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      memoryDiagnostics.dispose();
      for (const controller of streamingCardRequestControllers) {
        controller.abort(new Error("Bot service disposed."));
      }
      streamingCardRequestControllers.clear();
      // Bugfix（F1 specs/bot-message-delivery.md）：服务关闭同样经由单一 drain owner 拆除
      // watcher（尽力排干未送正文，flush 受 F2 预算约束；随后的 runtime dispose 可能中止
      // 在途请求，属可接受的最佳努力）。不 await——关闭路径不得被发送链路拖延。
      const watchers = [...taskWatcherDisposals.values()];
      taskWatcherDisposals.clear();
      for (const watcher of watchers) {
        void watcher
          .dispose("dispose")
          .catch((error: unknown) =>
            botsLogger.warn(
              undefined,
              `dispose bot task watcher failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
      for (const subscription of streamSubscriptions.values()) {
        subscription.dispose();
      }
      streamSubscriptions.clear();
      taskDeliveryRegistry.clear();
      transientInteractionCards.clear();
      for (const intervalId of typingIntervals.values()) {
        clearInterval(intervalId);
      }
      typingIntervals.clear();
      for (const [taskId] of typingTargets) {
        stopTyping(taskId);
      }
      runningTasks.clear();
      liveStatusProgressByTaskId.clear();
      pendingRemoteReconnectsByKey.clear();
      recentRemoteReconnectAtByKey.clear();
      recentRemoteReconnectDeliveryAtByKey.clear();
      recentInboundDeliveryAtByKey.clear();
      automationDeliveryWarningAtByKey.clear();
      inboundProcessingQueuesByContext.clear();
      // M1（specs/bot-message-delivery.md Retention buffer）：服务 dispose 时保留缓冲静默
      // 丢失（与桌面会话一致的已接受残余，spec 记录在案）。
      retainedReplyBuffers.clear();
      retainedReplyBufferQueues.clear();
      // Bugfix：host 的异步资源回收会优先调用 disposeAllAndWait。保留统一 Promise，确保并发关闭
      // 只执行一次，并在返回前等三类 Provider runtime 的请求、WebSocket 和跨进程锁全部收口。
      shutdownPromise = Promise.allSettled([
        telegramRuntime.dispose(),
        weixinRuntime.dispose(),
        feishuRuntime.dispose(),
      ]).then(() => undefined);
      return shutdownPromise;
    },
  };
  if (runStartupBackgroundTasks) {
    void telegramRuntime.refresh();
    void weixinRuntime.refresh();
    void feishuRuntime.refresh();
    // Alpha 6（§5.3）：启动单趟修剪（复用同一 24h 门与 fire-and-forget 形态；
    // harness 测试关闭 startup tasks 时该趟不跑，由 cacheResolvedAttachment piggyback 覆盖）。
    maybePruneAttachmentCache();
    void ensureBotStorageMigrated().catch((error: unknown) => {
      // 首次读取失败必须可见，不能产生未处理 rejection；交互入口仍直接收到该错误。
      botsLogger.error(
        undefined,
        `Bot storage initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  return service;
}
