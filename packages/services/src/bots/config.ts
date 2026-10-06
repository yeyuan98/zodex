import {
  DEFAULT_BOT_COMMANDS,
  DEFAULT_BOT_REPLY_GRANULARITY,
  modelSelectionSchema,
  normalizeBotReplyGranularity,
  type BotCurrentOptions,
  type BotDraftOptions,
  type BotCommandPolicy,
  type BotsConfigFile,
  type BotProvider,
} from "@zcode/shared";
export { BOT_BIND_CODE_TTL_MS } from "@zcode/shared";

// 回滚兼容：旧 App 对 Options 严格解析，旧文件仅作升级前快照，不得持续回写。
export const BOTS_CONFIG_FILE = "bot-config.v3.json";
export const BOTS_LEGACY_CONFIG_FILE = "bot-config.json";
export const BOTS_LEGACY_STATE_FILE = "bot-state.json";
export const BOTS_V2_STATE_FILE = "bot-state.v2.json";
// Bugfix（specs/bot-permissions.md §2.1）：状态文件 v3→v4（yolo 草稿迁移）；
// v3 文件降级为只读快照，与 v2 同规则——绝不回写，v4 存在即唯一事实源。
export const BOTS_V3_STATE_FILE = "bot-state.v3.json";
export const BOTS_STATE_FILE = "bot-state.v4.json";
export const BOTS_LEGACY_MODEL_CACHE_FILE = "bots-model-cache.json";
export const BOTS_MODEL_CACHE_FILE = "bots-model-cache.v2.json";
const BOT_CREDENTIAL_PREFIX = "bot";

export function createDefaultBotsConfig(): BotsConfigFile {
  return {
    version: 3,
    bots: [],
  };
}

export function createDefaultBotCommands(): BotCommandPolicy {
  return { ...DEFAULT_BOT_COMMANDS };
}

export function normalizeBotCommandPolicy(
  commands: Partial<BotCommandPolicy> & { cli?: unknown } = {},
): BotCommandPolicy {
  // Bugfix: /cli 命令已经移除，历史 bot-config.json 里残留的 cli 字段不能继续被保存回新配置。
  return {
    ...DEFAULT_BOT_COMMANDS,
    status: commands.status ?? DEFAULT_BOT_COMMANDS.status,
    new: commands.new ?? DEFAULT_BOT_COMMANDS.new,
    workspace: commands.workspace ?? DEFAULT_BOT_COMMANDS.workspace,
    model: commands.model ?? DEFAULT_BOT_COMMANDS.model,
    mode: commands.mode ?? DEFAULT_BOT_COMMANDS.mode,
    thoughtLevel: commands.thoughtLevel ?? DEFAULT_BOT_COMMANDS.thoughtLevel,
    sandboxMode: commands.sandboxMode ?? DEFAULT_BOT_COMMANDS.sandboxMode,
    approvalPolicy: commands.approvalPolicy ?? DEFAULT_BOT_COMMANDS.approvalPolicy,
    reply: commands.reply ?? DEFAULT_BOT_COMMANDS.reply,
    // /file 开关缺省允许；这里必须透传显式 false，否则 isUserCommandAllowed 的 !== false 判断永远看不到关闭值。
    file: commands.file ?? undefined,
  };
}

export function normalizeBotCurrentOptions(
  options: Partial<BotCurrentOptions> & {
    cli?: unknown;
    model?: unknown;
    thoughtLevel?: unknown;
  } = {},
): BotCurrentOptions {
  const parsedSelection = modelSelectionSchema.safeParse(options.modelSelection);
  const modelSelection = parsedSelection.success ? parsedSelection.data : undefined;
  // 旧 model/thoughtLevel 只在 Repository 的一次性导入读取，普通保存只认新字段。
  // Bugfix: /cli 命令移除后，历史 currentOptions.cli 只作为旧配置兼容读取，不再保存。
  // specs/bot-permissions.md §3a.1：permissionTimeoutMinutes 透传已配置值；写入侧不注入
  // 默认（读取时默认经 shared normalizePermissionTimeoutMinutes 归一，W2 先例）。
  return {
    ...(modelSelection ? { modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    ...(options.permissionTimeoutMinutes !== undefined
      ? { permissionTimeoutMinutes: options.permissionTimeoutMinutes }
      : {}),
  };
}

export function normalizeBotDraftOptions(options: BotDraftOptions): BotDraftOptions {
  const parsedSelection = modelSelectionSchema.safeParse(options.modelSelection);
  const modelSelection = parsedSelection.success ? parsedSelection.data : undefined;
  return {
    provider: options.provider,
    ...(modelSelection ? { modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };
}

export function getDefaultBotReplyGranularity(provider?: BotProvider) {
  return provider
    ? normalizeBotReplyGranularity(provider, undefined)
    : DEFAULT_BOT_REPLY_GRANULARITY;
}

export function buildBotCredentialKey(botId: string): string {
  return `${BOT_CREDENTIAL_PREFIX}:${botId}:credential`;
}

export function buildBotWebhookSecretKey(botId: string): string {
  return `${BOT_CREDENTIAL_PREFIX}:${botId}:webhook-secret`;
}
