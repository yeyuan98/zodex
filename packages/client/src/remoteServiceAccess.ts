import { ProxyChannel, type IChannelClient } from "@zcode/rpc";
import {
  IFileService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  ICuaPermissionService,
  IConversationExportService,
  IBotsService,
  IFileWatcherService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  IUsageStatsService,
  // P3 C5 供应商 client/configs 拉取删除：IClientConfigService 代理已随服务移除。
  // P5 D-P5.4：IClientScenesService 代理已随 endpoint web / clientScenes 链删除。
  IOffPeakTaskService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  ISettingsSyncService,
  ILocalRuntimeService,
  IPromptAttachmentTransferService,
  IWindowControllerService,
  type IServiceAccessor,
} from "@zcode/services";

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
export class RemoteServiceAccess implements IServiceAccessor {
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly onboardingRecordService: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // cuaPermissionService 在 IServiceAccessor 上是可选（远端/bots host 不提供），但桌面 renderer
  // 经 RPC 一定能拿到（main host 始终注册此 descriptor；非 macOS / 未启用时方法返回 available:false）。
  readonly cuaPermissionService: ICuaPermissionService;
  // P5 W4b：本地会话 Markdown 导出（替代已删除的 conversationShareService 代理）。
  readonly conversationExportService: IConversationExportService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly usageStatsService: IUsageStatsService;
  // P3 C5：clientConfigService（供应商 client/configs 快照代理）已删除。
  // P5 D-P5.4：clientScenesService 代理已随 endpoint web / clientScenes 链删除。
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly settingsSyncService: ISettingsSyncService;
  /** app 级本地运行时（A2′ 运行时环境卡）；仅 desktop local host 注册，可选面。 */
  readonly localRuntimeService?: ILocalRuntimeService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  constructor(channelClient: IChannelClient) {
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.onboardingRecordService = ProxyChannel.toService<IOnboardingRecordService>(
      channelClient.getChannel(IOnboardingRecordService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.zcodeTaskService = ProxyChannel.toService<IZCodeTaskService>(
      channelClient.getChannel(IZCodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    this.zcodeAgentService = ProxyChannel.toService<IZCodeAgentService>(
      channelClient.getChannel(IZCodeAgentService.channelName),
    );
    this.zcodeSessionService = ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(IZCodeSessionService.channelName),
    );
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.conversationExportService = ProxyChannel.toService<IConversationExportService>(
      channelClient.getChannel(IConversationExportService.channelName),
    );
    this.botsService = ProxyChannel.toService<IBotsService>(
      channelClient.getChannel(IBotsService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    // P3 C5：clientConfigService 代理创建已随供应商 client/configs 配置面删除。
    // P5 D-P5.4：clientScenesService 代理创建已随 endpoint web 删除。
    this.offPeakTaskService = ProxyChannel.toService<IOffPeakTaskService>(
      channelClient.getChannel(IOffPeakTaskService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    // A2′ 运行时环境卡（specs/agent-runtimes.md §4.6/§4.7）：仅 desktop local host
    // 注册该 channel；远端连接上代理调用会失败，卡只经 base services 取用本机 host。
    this.localRuntimeService = ProxyChannel.toService<ILocalRuntimeService>(
      channelClient.getChannel(ILocalRuntimeService.channelName),
    );
    // P2：feedbackService 代理随内置反馈中心删除；反馈不再走 RPC 服务通道。
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }
}
