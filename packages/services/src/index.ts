// Descriptors & collection (browser-safe)
export { type ServiceDescriptor, createServiceDescriptor } from "./descriptors.js";
export { ServiceCollection } from "./collection.js";
export {
  IModelSelectionService,
  IProviderSettingsService,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type DiscoveryModelHints,
  type DiscoverModelsForEndpointInput,
  type DiscoverTemplateModelsInput,
  type DiscoverTemplateModelsResult,
  type ProviderSettingsProviderView,
  type ProviderSettingsView,
} from "./model-provider/providerFacadeServices.js";
// P3 C4 供应商账号删除：IAccountRequestAuthService 及其工厂 re-export
// （accountRequestAuthService.ts）已随 runtime-headers accountAccess 分支移除。
export { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
export {
  collectServiceMemoryDiagnostics,
  memoryDiagnosticsRegistry,
  registerMemoryDiagnosticsProvider,
} from "./memoryDiagnostics.js";

// Accessor
export type { IServiceAccessor } from "./accessor.js";
// P5 W4：会话分享服务（发布/导入/能力面）已删除；错误信封、进度事件、选择与
// preflight 类型随选择 UI 一并移除。本地导出见下方 conversation-export。
export {
  IConversationExportService,
  conversationExportConnectionScopeFactory,
  isConnectionScopableConversationExportService,
  scopeConversationExportServiceForConnection,
  type ConnectionScopableConversationExportService,
  type ConversationExportAgentService,
  type ConversationExportInput,
  type ConversationExportResult,
} from "./conversation-export/conversationExport.js";
export {
  readConversationExportErrorKind,
  type ConversationExportErrorKind,
} from "./conversation-export/conversationExportError.js";

// File service — IFileService is both a type (interface) and value (descriptor)
export { IFileService } from "./file/file.js";
export { IMediaPreviewService } from "./media-preview/mediaPreview.js";
export type { MediaPreviewPreparation } from "./media-preview/mediaPreview.js";

// Git service — IGitService is both a type (interface) and value (descriptor)
export { IGitService } from "./git/git.js";
export { IGitCheckpointService } from "./git/gitCheckpoint.js";

// System service — ISystemService is both a type (interface) and value (descriptor)
export { ISystemService } from "./system/system.js";

// Terminal service — ITerminalService is both a type (interface) and value (descriptor)
export { ITerminalService } from "./terminal/terminal.js";

// Setting service — ISettingService is both a type (interface) and value (descriptor)
export { ISettingService } from "./setting/setting.js";

// Credential service — ICredentialService is both a type (interface) and value (descriptor)
export { ICredentialService } from "./credential/credential.js";

// Broadcast service — IBroadcastService is both a type (interface) and value (descriptor)
export { IBroadcastService } from "./broadcast/broadcast.js";

// Onboarding 完成记录服务（本地持久化，后续上传服务器）
export { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
export type {
  CreateOnboardingRecordServiceOptions,
  OnboardingRecordServiceFactory,
} from "./onboarding/onboardingRecord.js";
// 这里只能导出 descriptor 和类型。根 index 会被 renderer 经 value import 拉进浏览器包，
// 若 value 导出 createOnboardingRecordService，会连带 fs/atomicFileUtils → @zcode/shared/node →
// node:timers/promises 整条 Node 链进浏览器，模块加载直接抛错导致整个应用黑屏。
// 工厂函数由 host 侧（node.ts）与测试从实现文件路径直接导入，与 createSettingService 同惯例。
export type {
  BroadcastClaimAcquireResult,
  BroadcastClaimLease,
  BroadcastMessage,
} from "./broadcast/broadcast.js";

// ZCode task wrapper service — task 列表/置顶/归档等 app 侧包装状态入口。
export { IZCodeTaskService } from "./session/zcodeTaskService.js";
export type {
  ZCodeArchivedTaskDeletionResult,
  ZCodeModelTrajectory,
  ZCodeModelTrajectoryCallSource,
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
  ZCodeTaskListKind,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeTaskReadyOutcome,
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "./session/zcodeTaskService.js";
export type { ZCodeTaskListItem } from "./session/zcodeTaskListTypes.js";

export { IWindowControllerService } from "./window-controller/windowController.js";
export type {
  WindowHostControllerFrame,
  WindowHostControllerMutation,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
} from "./window-controller/windowController.js";

// ZCode agent service — IZCodeAgentService is both a type (interface) and value (descriptor)
export {
  IZCodeAgentService,
  type ZCodeAgentLocalRuntimeChildProcesses,
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
} from "./zcode-agent/zcodeAgent.js";
export {
  isZCodeAgentMcpStatusModeUnsupportedError,
  ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  ZCodeAgentMcpStatusModeUnsupportedError,
} from "./zcode-agent/zcodeAgentErrors.js";
export {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "./zcode-agent/zcodeAgentConnectionScope.js";
export type {
  ZCodeAgentConnectionScope,
  ZCodeAgentV4ClientMode,
  ZCodeAgentV4ConnectionContext,
} from "./zcode-agent/zcodeAgentConnectionScope.js";
export type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentInitializeResult,
  ZCodeAgentStorageStartupSnapshot,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentRuntimePolicy,
  ZCodeAgentReadSessionParams,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentRunAutomationNowResult,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentSendPromptParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcode-agent/zcodeAgent.js";

// ZCode session service — app-facing session facade without ZCode Agent naming.
export { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
export type {
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionInitializeResult,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionResumeParams,
  ZCodeSessionServiceEvent,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeSessionSubscribeParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "./zcode-session/zcodeSession.js";

// Bots service — IBotsService is both a type (interface) and value (descriptor).
// bots 子模块的公共入口是 bots/contract.ts（architecture-policy publicEntrypoints）；
// 根入口只做再导出，保持单一入口路径。
export {
  IBotsService,
  IBotWorkspaceFileService,
  IBotShareFileForwardService,
} from "./bots/contract.js";
export type {
  BotBindCodeResult,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotSaveBotResult,
  BotTestResult,
  BotWorkspaceFileV4Forwarder,
  BotShareFileForwarder,
} from "./bots/contract.js";
// 说明（沿承既有约定）：上面两个窄化 channel 只导出 descriptor 与类型；实现工厂
// （createBotWorkspaceFileService 等）留在 node 装配，renderer 经根 index 拉进浏览器
// 包时不会连带 Node 依赖。

// Hooks service — IHooksService is both a type (interface) and value (descriptor).
export { IHooksService } from "./hooks/hooks.js";

// Memory service — IMemoryService is both a type (interface) and value (descriptor).
export {
  IMemoryService,
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "./memory/memory.js";
export type { ProjectMemoryFileSummary, ProjectMemoryWorkspaceSummary } from "./memory/memory.js";

export type { SessionRealtimePort } from "./session/sessionRealtimePort.js";

// FileWatcher service — IFileWatcherService is both a type (interface) and value (descriptor)
export { IFileWatcherService } from "./fileWatcher/fileWatcher.js";

// UsageStats service — IUsageStatsService is both a type (interface) and value (descriptor)
export { IUsageStatsService } from "./usage-stats/usageStats.js";

// Storage（资源管理器「存储」tab）：数据类型在 @zcode/shared；这里只导出服务接口与卷分组纯函数
export type { IStorageService } from "./storage/contract.js";

// P3 C2 供应商套餐/计费面删除：ICodingPlanSubscriptionService（购买/企业订单/灰度快照
// 服务描述符）与 OffPeakClientConfig 已随 coding-plan-subscription 目录整体删除。
// P5 D-P5.4：IClientScenesService 及 ClientScene* 类型已随 endpoint web / clientScenes 链删除。
// isValidCronExpr 的 barrel 导出已删除（唯一外部消费方 useAutomationTemplates 随模板链路移除；
// services 内部 automationService 仍经模块路径使用）。
// 闲时任务管理服务（与 automation 服务面独立）；接口/描述符 browser-safe。
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export type { OffPeakUpdateTaskParams } from "./session/offPeakTask.js";
export { createOffPeakInteractionPolicy } from "./session/offPeakInteractionPolicy.js";

// Skills service — ISkillsService is both a type (interface) and value (descriptor)
export { ISkillsService } from "./skills/skills.js";
export { ISkillSyncService } from "./skill-sync/skillSync.js";
export { IMcpSyncService } from "./mcp-sync/mcpSync.js";
// app 级本地运行时服务端口（browser-safe：type-only 引用 node 实现侧类型）。
export { ILocalRuntimeService } from "./runtime-tools/local-runtime/port.js";
export type {
  LocalRuntimeArtifactClassId,
  LocalRuntimeKindId,
  LocalRuntimeMirrorCandidateInfo,
} from "./runtime-tools/local-runtime/port.js";
export type {
  LocalRuntimeInstallResult,
  LocalRuntimeProbeSnapshot,
  LocalRuntimeReverifyResult,
  LocalRuntimeStatusSnapshot,
  LocalRuntimeUpdateCheck,
} from "./runtime-tools/local-runtime/port.js";
export { IPluginSyncService } from "./plugin-sync/pluginSync.js";
export {
  ICuaPermissionService,
  type CuaPermissionState,
  type CuaPermissionRestartOptions,
  type CuaPermissionStatus,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
  type CuaPermissionStatusUnavailable,
  isCuaPermissionStatusAvailable,
} from "./cua-permission-broker/cuaPermissionService.js";
export {
  ICuaPipSessionService,
  type CuaPipSessionService,
} from "./cua-permission-broker/cuaPipSession.js";

// Plugins service — IPluginsService is both a type (interface) and value (descriptor)
export { IPluginsService } from "./plugins/plugins.js";
// 设置页插件管理薄服务（UI 平台能力面不再直触 zcodeAgentService）
export { IPluginManagementService } from "./plugins/pluginManagement.js";

// Subagents service — ISubagentsService is both a type (interface) and value (descriptor)
export { ISubagentsService } from "./subagents/subagents.js";

// Commands service — ICommandsService is both a type (interface) and value (descriptor)
export { ICommandsService } from "./commands/commands.js";

export { ISettingsSyncService } from "./settings-sync/settingsSync.js";

// P2：内置反馈中心服务（feedbackService / HTTP client / 本地工单存储 / 日志归档）已整体删除，
// 反馈改为外部 GitHub Issues 跳转（@zcode/shared buildGitHubIssueUrl）。
export { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
export type {
  PromptAttachmentStageParams,
  PromptAttachmentStageResult,
  PromptAttachmentTransferPhase,
  PromptAttachmentTransferProgress,
} from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
// P3 C5 供应商 client/configs 拉取删除：IClientConfigService 导出已随服务删除。
