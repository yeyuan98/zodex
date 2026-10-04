export type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  FileTextSlice,
  FileWatchEvent,
  WorkspaceFileEntry,
  SystemInfo,
  AppSettings,
  ElectronReleaseChannel,
  IntegratedTerminalShellDialect,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  Locale,
  LocalePreference,
  ZCodeInteractionBehavior,
  TabId,
  TabState,
  ResourceUsageCategory,
  ResourceUsageBaseGroupKey,
  ResourceUsageProcess,
  HostResourceUsageProcess,
  ResourceUsageSnapshot,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
  PersistedWorkspaceSessionEntry,
} from "./protocol.js";
export type { WorkspacePurpose } from "./workspacePurpose.js";
export { DEFAULT_LOCALE } from "./protocol.js";
export { ZCODE_VERSION, ZCODE_COMMIT, ZCODE_BUILD_TIME } from "./version.js";
export type { HelloMessage, HelloAckMessage } from "./handshake.js";
export type { ZCodeEnv, ZCodeProductFlavor } from "./env.js";
export type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
export type {
  RemoteResourcePackageId,
  RemoteResourcePackageSelection,
} from "./remoteResourcePackages.js";
export type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
export { stripRemoteTargetSecrets, isSameRemoteTarget } from "./remoteTarget.js";
export { buildSshRemoteHostKey } from "./remoteSshHostKey.js";
export { buildRemoteEnvironmentKey } from "./remoteEnvironmentKey.js";
export type {
  ShortcutChannel,
  ShortcutCommandEntry,
  ShortcutCommandId,
  ParsedShortcutBinding,
} from "./shortcutCommands.js";
export {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  isValidShortcutBinding,
  normalizeShortcutKey,
  parseShortcutBinding,
  serializeShortcutBinding,
} from "./shortcutCommands.js";
export {
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_APP_VERSION_ENV,
  ZCODE_BUILD_COMMIT_ID_ENV,
  // P3 C3：自 official-mcp-auth.ts 迁入（官方 MCP 服务删除后保留的通用 workspace 身份常量）。
  ZCODE_WORKSPACE_IDENTITY_ENV,
  RUNTIME_ZCODE_DEBUG,
  normalizeZCodeEnv,
  normalizeZCodeProductFlavor,
  // P5 D-P5.4：自 zcodeEndpoint.ts 迁入（endpoint 解析链删除；CLI 请求头仍在消费）。
  resolveRuntimeZCodeEnv,
} from "./env.js";
export * from "./errors.js";
export type { SessionCreateSource } from "./sessionCreateSource.js";
export { resolveSafeEndpointHostname } from "./endpointHostname.js";
export * from "./rendererActionTrace.js";
export * from "./validation.js";
export * from "./api.js";
export * from "./zcode-protocol/index.js";
// re-home：旧协议承重面的幸存文件（消费者继续走 barrel，零感知）
export * from "./zcode-protocol-legacy-types.js";
export * from "./zcode-task-types-core.js";
export * from "./task-realtime-core.js";
export * from "./remote-workspace-identity.js";
export * from "./zcode-api-retry-status.js";
export * from "./zcode-network-debug-status.js";
export * from "./zcode-session-visible-content.js";
// P3 C3：官方 MCP（Z.ai 托管）服务删除，official-mcp-auth.ts 与 official-mcp-tool-error.ts
// 整文件移除；通用常量 ZCODE_WORKSPACE_IDENTITY_ENV 已迁至 env.ts。
export * from "./conversation-message-projection-policy.js";
// P5 W4：会话分享协议（conversation-share.ts）整体删除，decodeConversationShareRows 无存续消费方。
export * from "./conversation-preview-artifacts.js";
export * from "./zcode-session-task-status.js";
export * from "./zcode-tool-projection-memory.js";
export * from "./zcode-slash-command-help.js";
// P5 D-P5.4：zcodeEndpoint.js（endpoint origin 解析）与 zcode-source-headers.js
// （平台来源信任头）已随 endpoint web / clientScenes 链整体删除；resolveRuntimeZCodeEnv 迁至 env.js。
export * from "./zcode-agent-policy.js";
export * from "./zcode-media-policy.js";
export * from "./media-preview.js";
export * from "./plugin-display-name.js";
export * from "./zcode-agent-runtime.js";
export * from "./runtimeEnv.js";
export * from "./dynamic-workflow-feature.js";
export * from "./markdown-artifact-images.js";
export * from "./serviceAuthority.js";
export * from "./server-remote.js";

export interface ICredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export * from "./test-ids.js";
export * from "./test-ids-workflow.js";
export * from "./channels.js";
export * from "./storage.js";
export * from "./user.js";
export * from "./credential.js";
export * from "./desktopMenu.js";
// P2：内置反馈中心（packages/shared/src/feedback.ts）已删除，反馈改为外部 GitHub Issues 预填跳转。
export * from "./githubIssueUrl.js";
export * from "./e2e-test-bridge.js";
export * from "./remoteAppConfig.js";
export * from "./helpAppConfig.js";
export * from "./remoteAssetInstallMode.js";
export * from "./onboardingRecord.js";
export * from "./remoteResourcePackages.js";
export {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  BROWSER_VIEW_RESTORE_BOOTSTRAP_URL,
  LOCAL_MEDIA_PREVIEW_SCHEME,
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  createOpenInEditorRemoteTarget,
} from "./platform.js";
export type { LaunchMarks } from "./launchMarks.js";
export { LAUNCH_MARKS_QUERY_KEY, parseLaunchMarks, serializeLaunchMarks } from "./launchMarks.js";
export type {
  CancelPendingRemoteConnectionRequest,
  BindRemoteWorkspaceSessionContextRequest,
  BotRemoteWorkspaceReconnectedEvent,
  BrowserTabResidencyState,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewOperationPayload,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  ChromeBrowserDataImportError,
  ChromeBrowserDataImportOptions,
  ChromeBrowserDataImportResult,
  ConnectRemoteRequest,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  DesktopCommandId,
  CuaOsSupport,
  DesktopWindowChromeState,
  DesktopTitleBarTheme,
  DockerContainerInfo,
  EditorInfo,
  ApplicationIconInfo,
  ApplicationIconLocator,
  ApplicationIconRequest,
  BrowserGuestAttachRejectReason,
  BrowserGuestAttachResult,
  EmbeddedBrowserDataClearResult,
  EmbeddedBrowserOpenUrlRequest,
  IPlatformService,
  OpenFeedbackContext,
  OpenInEditorRemoteTarget,
  OpenInEditorOptions,
  PostUpdateReleaseNotesPayload,
  RemoteConnectionRuntimeLog,
  RemoteSessionClosedEvent,
  RemoteServiceSession,
  SSHConfigAliasOption,
  TaskNotificationPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  WSLDistro,
  ZCodeStdioTapDevState,
} from "./platform.js";
export type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";
export type { ZCodeTaskCreateResult } from "./zcode-task-types.js";
export * from "./zcode-task-types.js";
export * from "./automation-types.js";
export * from "./off-peak-types.js";
export * from "./off-peak-window.js";
export * from "./background-task-control-merge.js";
export * from "./background-task-controls.js";
export * from "./background-task-notifications.js";
export * from "./background-bash-jobs.js";
export * from "./zcode-agent-model-state.js";
export * from "./task-realtime.js";
export { formatTimestamp, formatLogPrefix } from "./log-format.js";
export * from "./model-provider-types.js";
// P3 C4 供应商 family/specs 删除：model-provider-family.ts（zai/bigmodel family 目录、
// OAuth provider 身份与可见性 helper）已随账号套餐概念移除。
export * from "./provider-provisioning.js";
export * from "./custom-model-value.js";
export * from "./model-selection-types.js";
export * from "./model-selection-key.js";
export * from "./model-selection.js";
export * from "./skills-types.js";
export * from "./skill-sync.js";
export * from "./mcp-sync.js";
export * from "./plugin-sync.js";
export * from "./remote-sync.js";
export * from "./plugin-types.js";
export * from "./subagents-types.js";
export * from "./settings-source.js";
export * from "./settings-errors.js";
export * from "./app-runtime-preferences.js";
export * from "./command-types.js";
export * from "./plugin-marketplaces.js";
export * from "./lineChangeStat.js";
export * from "./process-names.js";
export * from "./mcp.js";
export * from "./runtime-tool-runtime.js";
export * from "./git.js";
export * from "./bots.js";
// Bot 出站投递远端 workspace 读取的纯路径/配额策略（Phase C Alpha 2）；
// 无 Node 依赖，路径语义由调用方注入（远端 CLI 传自己的 node:path）。
export * from "./botWorkspaceFilePolicy.js";
// 入站附件容器 sniff（3.14.5 Alpha 6 §5.15）：按文件头 magic 指纹识别，
// 纯函数零 IO，供 botsService 缓存无名附件时补扩展名/修正 mimeType。
export * from "./attachmentContainerSniff.js";
export * from "./assistant-message-parts.js";
export * from "./zcodePersistedMessageMerge.js";
export * from "./assistant-presentation.js";
export * from "./tool-call-summary.js";
export * from "./tool-identity.js";
export * from "./streaming-tool-input-preview.js";
export * from "./tool-plan-adapter.js";
export * from "./permission-request-preview.js";
export * from "./settings-sync.js";
export * from "./uuid.js";
// P3 供应商套餐/配额面删除：usage-stats.ts（vendor 半边）与 usage-quota.ts 已删除，
// 仅保留通用 App Usage 形状（app-usage.ts）。
export * from "./app-usage.js";
// P3 C2 供应商套餐/计费面删除：coding-plan-subscription.ts（购买/企业订单协议类型）
// 已整体删除。P5 更新域硬切：forceUpdate.ts（强更 gate 最小类型）与 updateFeedPolicy.ts
// （厂商 manifest feed 策略开关）已随 GitHub provider 切换删除。
export * from "./intranetProbe.js";
export * from "./intranetDefaults.js";
export * from "./hooks.js";
export * from "./openrouter-attribution.js";
export * from "./workspaceSessionRestore.js";
export * from "./skill-scan-policy.js";
export * from "./browser-use/index.js";

export {
  parseSubagentMarkdownSelection,
  formatSubagentMarkdownModel,
} from "./subagent-markdown-selection.js";
export * from "./memoryDiagnostics.js";
export * from "./database-startup.js";
export * from "./execution-state.js";

export { bashOutputDisplaySchema } from "./bash-output-display.js";

export * from "./localTtft.js";
// P3 C5：clientConfig.ts（/api/v1/client/configs 快照解析）已随供应商配置拉取删除；
// pluginStoreOrder 仅保留本地排序类型，供打包默认排序与 UI 使用。
export * from "./pluginStoreOrder.js";
export * from "./pluginStoreOrdering.js";
export * from "./session-debug.js";
export { redactFeedbackText } from "./feedbackPrivacy.js";
