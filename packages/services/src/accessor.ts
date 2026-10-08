import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { IFileService } from "./file/file.js";
import type { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { IGitService } from "./git/git.js";
import type { IGitCheckpointService } from "./git/gitCheckpoint.js";
import type { ISystemService } from "./system/system.js";
import type { ITerminalService } from "./terminal/terminal.js";
import type { ISettingService } from "./setting/setting.js";
import type { ICredentialService } from "./credential/credential.js";
import type { IBroadcastService } from "./broadcast/broadcast.js";
import type { IZCodeTaskService } from "./session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import type { ICuaPermissionService } from "./cua-permission-broker/cuaPermissionService.js";
import type { IConversationExportService } from "./conversation-export/conversationExport.js";
import type { IBotsService } from "./bots/contract.js";
import type { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import type { IUsageStatsService } from "./usage-stats/usageStats.js";
// P3 C5 供应商 client/configs 拉取删除：IClientConfigService 已随配置面移除。
// P5 D-P5.4：IClientScenesService 已随 endpoint web / clientScenes 链删除。
import type { ISkillsService } from "./skills/skills.js";
import type { ISkillSyncService } from "./skill-sync/skillSync.js";
import type { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import type { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import type { IPluginsService } from "./plugins/plugins.js";
import type { IPluginManagementService } from "./plugins/pluginManagement.js";
import type { ISubagentsService } from "./subagents/subagents.js";
import type { ICommandsService } from "./commands/commands.js";
import type { IHooksService } from "./hooks/hooks.js";
import type { IMemoryService } from "./memory/memory.js";
import type { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import type { ILocalRuntimeService } from "./runtime-tools/local-runtime/port.js";
import type { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IWindowControllerService } from "./window-controller/windowController.js";
import type { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";

/** UI 层消费的统一服务接口 */
export interface IServiceAccessor {
  readonly fileService: IFileService;
  readonly mediaPreviewService?: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  /** Onboarding 完成记录（本地持久化）；旧测试 double / 不支持的 host 可不提供。 */
  readonly onboardingRecordService?: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  /** 窗口 Host 聚合面；旧 server wire 或测试 double 可暂不提供。 */
  readonly windowControllerService?: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // CUA 是 opt-in 内测特性：local macOS host 提供，远端 等 host 没有。可选避免连锁必填。
  readonly cuaPermissionService?: ICuaPermissionService;
  /** 本地会话 Markdown 导出（P5 W4：替代已删除的 conversationShareService）。 */
  readonly conversationExportService: IConversationExportService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  /** 当前 Environment 的 Provider 配置与设置视图。 */
  readonly providerSettingsService: IProviderSettingsService;
  /** 当前 Environment Registry 发布的唯一模型选择 View。 */
  readonly modelSelectionService: IModelSelectionService;
  readonly usageStatsService: IUsageStatsService;
  // P3 C5：clientConfigService（供应商 client/configs 快照）已删除，不再暴露。
  // P5 D-P5.4：clientScenesService（client scenes 场景配置）已随 endpoint web 删除。
  /** 闲时任务管理（独立服务面）。 */
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  /** 设置页插件管理（UI 不再直触 zcodeAgentService 的 plugins/* 面） */
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly settingsSyncService: ISettingsSyncService;
  /**
   * app 级本地运行时（A2′「运行时环境」卡）：仅 desktop local host 注册；
   * 远端 host / 测试 double 可不提供。卡必须经 base/local workspace services 取用
   * （本机全局事实源），不得按 workspace 路由。
   */
  readonly localRuntimeService?: ILocalRuntimeService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;
}
