import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IDisposable } from "@zcode/rpc";
import type {
  BotConfig,
  BotCurrentOptions,
  BotInboundMessage,
  BotOutboundMessage,
} from "@zcode/shared";
import { BOT_PERMISSION_TIMER_SCALE_ENV, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { createBotsService } from "../src/bots/botsService.js";
import {
  BOTS_CONFIG_FILE,
  BOTS_STATE_FILE,
  BOTS_V2_STATE_FILE,
  BOTS_V3_STATE_FILE,
} from "../src/bots/config.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";
import type { IBotsService } from "../src/bots/bots.js";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { ISettingService } from "../src/setting/setting.js";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import type { BotProviderAdapter } from "../src/bots/providers/types.js";

/**
 * specs/bot-permissions.md（3.15.0 Track B alpha.0）§7 验收场景红测（W1 提交、
 * 随 W2/W4 worker 转绿），harness 复制自 botInboundResilience.test.ts（weixin
 * 专用简化版）：
 *
 * - 场景 1/2（§7.1-§7.2 解锁）：无配置模式的 bot 草稿首发 setMode("build")
 *   （红：今 BOT_FORCED_MODE 强制 yolo）；currentOptions.mode="plan" 的 bot
 *   setMode("plan"）。
 * - 场景 3（§7.3 迁移）：v3 状态 yolo draft 加载后 mode 翻转 build，weixin
 *   cursor/token 字段原样保留。
 * - 场景 4（§7.7 permission_response 清理）：CLI 侧 deny 经 permission_response
 *   事件到达 ⇒ 清除 pendingPermissionOptions。
 * - 场景 5（§7.8 终态清理）：task_complete 清空 pendingPermissionOptions。
 * - 场景 13（§7.13 迟到点击）：自动拒绝（或他端应答）后文本 /deny ⇒
 *   respondPermission=false ⇒ 本地化「已被处理/已自动拒绝」反馈 + pending 清扫。
 * - 场景 6（§7.12 /status 模式行）：/status 回复包含模式行。
 * - W3b（§3a/§3c）：createTask permissionAutoDenyMs 传递 + 场景 9（reminder
 *   恰一次/短 deadline 无 reminder）+ 场景 10（非保留）+ 场景 11（elicitation
 *   边界 guard）+ 场景 15（禁用抑制）。
 */

const WEIXIN_BOT_ID = "bot-wx-perms";
/** messages.ts zh 文案钉住值（§3c.1 reminder/deny-note；场景 9/10/15 断言用）。 */
const PERMISSION_REMINDER_ZH = "权限请求将在 2 分钟后自动拒绝";
const PERMISSION_AUTO_DENIED_ZH = "权限超时未应答，已自动拒绝";
/** botChannelRetention.test.ts 同款 revival 序言（zh）——场景 10 断言其缺席。 */
const RETAINED_PREAMBLE_PREFIX_ZH = "断线期间积压的";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function baseAllowedCommands() {
  return {
    status: true,
    new: true,
    workspace: true,
    model: true,
    thoughtLevel: true,
    reply: true,
    file: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(50);
  }
  return condition();
}

interface TaskServiceControls {
  sentMessages: BotOutboundMessage[];
  sendAttempts: string[];
  /** 场景10 旋钮：命中 failPattern 的出站 throw（errorFactory 缺省用通用错误）。 */
  sendControl: { failPattern?: RegExp; errorFactory?: () => Error };
  createTaskCalls: string[];
  /** W3b（§3a.2）：fake createTask 捕获的 permissionAutoDenyMs（未携带 = undefined）。 */
  createTaskPermissionAutoDenyMs: Array<number | undefined>;
  sendPromptCalls: string[];
  /** setMode 调用记录：场景 1/2 断言建任务咽喉下发的模式（今天被 fake 忽略）。 */
  setModeCalls: Array<{ taskId: string; mode: string }>;
  /** F4（§7.22）：fake setConfigOption 捕获（active-task /mode set 往返）。 */
  setConfigOptionCalls: Array<{ taskId: string; configId: string; value: string }>;
  streamEventHandlers: Map<string, (event: unknown) => Promise<void>>;
  /** 场景13 旋钮：fake respondPermission 返回值（false = 已被 CLI 自动拒绝/他端收口）。 */
  respondPermissionResult: boolean;
  /** 场景6b：fake listTasks 返回值（active-task /status 形态需要真实 task meta）。 */
  listTasksResult: unknown[];
}

function buildFakeTaskService(controls: TaskServiceControls) {
  let createdCount = 0;
  return {
    listDeletedTaskIds: async () => [] as string[],
    resumeTask: async () => undefined,
    createTask: async (params?: { permissionAutoDenyMs?: number }) => {
      controls.createTaskCalls.push(`create-${controls.createTaskCalls.length + 1}`);
      controls.createTaskPermissionAutoDenyMs.push(params?.permissionAutoDenyMs);
      createdCount += 1;
      return { taskId: `task-created-${createdCount}` };
    },
    deleteTask: async () => undefined,
    stopGeneration: async () => undefined,
    respondPermission: async () => controls.respondPermissionResult,
    respondElicitation: async () => true,
    getTaskModelSelection: async () => ({
      providerId: ZCODE_AGENT_PROVIDER,
      modelId: "glm-test",
    }),
    // 关键（Track B 红测前置）：applyDraftConfigOptions 只在 configOptions 里存在
    // mode select 选项时才走 setMode 咽喉；返回空数组会让整个 dispatch 跳过
    // setMode，场景 1/2 将以错误原因变红。
    getTaskConfigOptions: async () => [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "build",
        options: [
          { value: "build", name: "Build" },
          { value: "plan", name: "Plan" },
          { value: "yolo", name: "Yolo" },
        ],
      },
    ],
    listTasks: async () => controls.listTasksResult as never,
    getTaskSnapshot: async () => null,
    sendPrompt: async (request: { taskId: string }) => {
      controls.sendPromptCalls.push(request.taskId);
    },
    setMode: async (params: { taskId: string; mode: string }) => {
      controls.setModeCalls.push({ taskId: params.taskId, mode: params.mode });
    },
    setConfigOption: async (params: { taskId: string; configId: string; value: string }) => {
      controls.setConfigOptionCalls.push({
        taskId: params.taskId,
        configId: params.configId,
        value: params.value,
      });
      // 真实链路返回应用后的 configOptions；fake 复用 getTaskConfigOptions 同一形状。
      return [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: params.value,
          options: [
            { value: "build", name: "Build" },
            { value: "plan", name: "Plan" },
            { value: "yolo", name: "Yolo" },
          ],
        },
      ];
    },
    onDynamicStreamEvent:
      (taskId: string) =>
      (handler: (event: unknown) => Promise<void>): IDisposable => {
        controls.streamEventHandlers.set(taskId, handler);
        return {
          dispose: () => {
            controls.streamEventHandlers.delete(taskId);
          },
        };
      },
  };
}

function buildModelSelectionService(withModelInView?: boolean) {
  const modelSelection = {
    providerId: ZCODE_AGENT_PROVIDER,
    modelId: "glm-test",
  };
  return {
    getView: async () =>
      ({
        revision: 1,
        // F4（§7.22）：withModelInView=true 时 view 可解析出所选模型（含 reasoning
        // spec，thoughtLevel 同源可用）——draft /mode 的「已配模型」形态；缺省保持
        // 原 harness 形态（providers 空 = 模型不可解析 = model-less 边界 pin）。
        providers: withModelInView
          ? [
              {
                providerId: ZCODE_AGENT_PROVIDER,
                models: [
                  {
                    modelId: "glm-test",
                    config: {
                      optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } },
                    },
                  },
                ],
              },
            ]
          : [],
        preferredSelection: modelSelection,
        effectiveSelection: modelSelection,
      }) as unknown as Awaited<ReturnType<IModelSelectionService["getView"]>>,
  };
}

async function prepareWorkspaceDirs(prefix: string): Promise<{
  dataRoot: string;
  workspace: string;
  configDir: string;
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), `${prefix}-`));
  setDataBaseDir(dataRoot);
  const workspace = await mkdtemp(join(tmpdir(), `${prefix}-ws-`));
  await writeFile(join(workspace, "out.txt"), "hello");
  const configDir = getAppConfigDir();
  await mkdir(configDir, { recursive: true });
  return { dataRoot, workspace, configDir };
}

function botDefaults() {
  return {
    enabled: true,
    allowedWorkspaces: ["*"],
    allowedCommands: baseAllowedCommands(),
    currentOptions: {} as BotCurrentOptions,
  };
}

/** 草稿模式 state entry：普通消息走 createTask 首发路径（activeTaskId 必须显式 null）。 */
function draftStateEntry(botId: string, workspace: string, isWeixin: boolean) {
  return {
    botId,
    workspacePath: workspace,
    mode: "draft",
    activeTaskId: null,
    ...(isWeixin ? { weixinActivatedAt: 1 } : {}),
    updatedAt: 1,
  };
}

interface TaskStateEntryOptions {
  activeTaskId: string;
  isWeixin?: boolean;
  pendingPermissionOptions?: Array<Record<string, unknown>>;
  /**
   * F2（§8.2）：state entry 携带的持久化冻结 deadline（建任务时写入的
   * permissionAutoDenyMs）。缺省 = miss 形态（任务早于字段/映射丢失 ⇒ 不武装）。
   */
  permissionAutoDenyMs?: number;
}

/** task 模式 state entry：场景 4/5 在既有任务上驱动 permission 事件。 */
function taskStateEntry(botId: string, workspace: string, options: TaskStateEntryOptions) {
  return {
    botId,
    workspacePath: workspace,
    mode: "task",
    activeTaskId: options.activeTaskId,
    ...(options.isWeixin ? { weixinActivatedAt: 1 } : {}),
    ...(options.pendingPermissionOptions
      ? { pendingPermissionOptions: options.pendingPermissionOptions }
      : {}),
    ...(options.permissionAutoDenyMs !== undefined
      ? { permissionAutoDenyMs: options.permissionAutoDenyMs }
      : {}),
    updatedAt: 1,
  };
}

async function writeBotFiles(
  configDir: string,
  botConfig: BotConfig,
  stateEntry: Record<string, unknown>,
  stateFile?: { name: string; version: number },
): Promise<void> {
  await writeFile(
    join(configDir, BOTS_CONFIG_FILE),
    JSON.stringify({ version: 3, bots: [botConfig] }),
  );
  await writeFile(
    join(configDir, stateFile?.name ?? BOTS_STATE_FILE),
    JSON.stringify({ version: stateFile?.version ?? 3, bots: { [botConfig.id]: stateEntry } }),
  );
}

/**
 * 迁移后的 state entry 读取：优先最高版本号的 bot-state 文件（W2 迁移 v3→v4 后
 * 文件可能改名；红测聚焦行为而非文件名），原子写中途的解析竞态按候选重试。
 */
async function readStateBotEntryAnywhere(
  configDir: string,
  botId: string,
): Promise<Record<string, unknown>> {
  const candidates: Array<{ path: string; version: number }> = [];
  for (const name of await readdir(configDir)) {
    const match = /^bot-state\.(?:v(\d+)\.)?json$/.exec(name);
    if (match) {
      candidates.push({
        path: join(configDir, name),
        version: match[1] ? Number(match[1]) : 0,
      });
    }
  }
  candidates.sort((a, b) => b.version - a.version);
  for (const candidate of candidates) {
    try {
      const state = JSON.parse(await readFile(candidate.path, "utf8")) as {
        bots?: Record<string, Record<string, unknown>>;
      };
      const entry = state.bots?.[botId];
      if (entry) {
        return entry;
      }
    } catch {
      // 文件原子写替换中途或损坏：尝试下一候选。
    }
  }
  return {};
}

/** 读取 bot-state.v3.json 中指定 bot entry 的指定字段（终态事实轮询）。 */
async function waitForStateBotField(
  botId: string,
  pick: (entry: Record<string, unknown>) => unknown,
  timeoutMs = 10_000,
): Promise<unknown> {
  const path = join(getAppConfigDir(), BOTS_STATE_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(path, "utf8")) as {
        bots?: Record<string, Record<string, unknown>>;
      };
      const entry = state.bots?.[botId];
      if (entry) {
        const value = pick(entry);
        if (value !== undefined) {
          return value;
        }
      }
    } catch {
      // 文件尚不存在或原子写替换中途：重试。
    }
    await sleep(50);
  }
  return undefined;
}

interface PermissionsHarnessOptions {
  /** 覆盖默认草稿 state entry（场景 3 迁移 / 场景 4-5 task 模式 fixture）。 */
  stateEntry?: (botId: string, workspace: string) => Record<string, unknown>;
  /** bot 配置 currentOptions（场景 2：mode "plan"；W3b：permissionTimeoutMinutes）。 */
  currentOptions?: BotCurrentOptions;
  /** 场景13：fake respondPermission 初始返回值（false = 已收口，迟到点击）。 */
  respondPermissionResult?: boolean;
  /**
   * 场景3b 迁移矩阵：自定义状态文件名与顶层 version（缺省写 version 3 内容到
   * bot-state.v4.json——既有 harness 形态，按内容 version 触发迁移）。
   */
  stateFile?: { name: string; version: number };
  /** 场景6b：注入 settingService locale（en-US 断言用；缺省无 settingService = zh）。 */
  locale?: "en-US";
  /** F4（§7.22）：view 中包含所选模型（draft /mode「已配模型」形态）。 */
  modelInView?: boolean;
  /**
   * F2（§7.19 重启重武装）：复用既有数据目录建第二个服务实例（模拟服务重启；状态
   * 文件保留在磁盘上）。传入时不再写初始 bot 文件。
   */
  reuseDirs?: { dataRoot: string; workspace: string; configDir: string };
}

interface PermissionsHarness {
  service: IBotsService & { disposeAllAndWait(): Promise<void> };
  configDir: string;
  /** F2 重启用：数据三目录（dispose(true) 后可经 reuseDirs 复用）。 */
  dirs: { dataRoot: string; workspace: string; configDir: string };
  sentMessages: BotOutboundMessage[];
  sendAttempts: string[];
  sendControl: { failPattern?: RegExp; errorFactory?: () => Error };
  createTaskCalls: string[];
  createTaskPermissionAutoDenyMs: Array<number | undefined>;
  sendPromptCalls: string[];
  setModeCalls: Array<{ taskId: string; mode: string }>;
  setConfigOptionCalls: Array<{ taskId: string; configId: string; value: string }>;
  streamEventHandlers: Map<string, (event: unknown) => Promise<void>>;
  /** 场景13：运行中翻转 fake respondPermission 返回值（false = 已被收口）。 */
  setRespondPermissionResult(value: boolean): void;
  /** 场景6b：运行中替换 fake listTasks 返回值（active-task /status 形态）。 */
  setListTasksResult(tasks: unknown[]): void;
  /** 场景15：直接覆写 bot-config.v3.json 顶层字段（enabled:false 等）。 */
  overwriteBotConfig(patch: Record<string, unknown>): Promise<void>;
  dispose(): Promise<void>;
  /**
   * F2（§7.19 重启重武装）：dispose 但保留数据目录（供 reuseDirs 建第二个服务实例）。
   */
  dispose(keepDirs?: boolean): Promise<void>;
  dispose(): Promise<void>;
}

async function createPermissionsHarness(
  options: PermissionsHarnessOptions,
): Promise<PermissionsHarness> {
  let dataRoot: string;
  let workspace: string;
  let configDir: string;
  if (options.reuseDirs) {
    ({ dataRoot, workspace, configDir } = options.reuseDirs);
    setDataBaseDir(dataRoot);
  } else {
    ({ dataRoot, workspace, configDir } = await prepareWorkspaceDirs("zcode-bot-perms"));
  }

  const botConfig: BotConfig = {
    id: WEIXIN_BOT_ID,
    name: "Weixin Permissions Bot",
    provider: "weixin",
    credentialRef: "weixin-token-ref",
    providerUserId: "wx-bot-self",
    ...botDefaults(),
    ...(options.currentOptions ? { currentOptions: options.currentOptions } : {}),
    replyMode: "assistant_changes",
  };
  if (!options.reuseDirs) {
    await writeBotFiles(
      configDir,
      botConfig,
      options.stateEntry?.(botConfig.id, workspace) ??
        draftStateEntry(botConfig.id, workspace, true),
      options.stateFile,
    );
  }

  const controls: TaskServiceControls = {
    sentMessages: [],
    sendAttempts: [],
    sendControl: {},
    createTaskCalls: [],
    createTaskPermissionAutoDenyMs: [],
    sendPromptCalls: [],
    setModeCalls: [],
    setConfigOptionCalls: [],
    streamEventHandlers: new Map(),
    respondPermissionResult: options.respondPermissionResult ?? true,
    listTasksResult: [],
  };
  const fakeTaskService = buildFakeTaskService(controls);
  const modelSelectionService = buildModelSelectionService(options.modelInView);
  const credentialService = {
    load: async () => "wx-token-perms",
  } as unknown as ICredentialService;

  // 与 weixinProvider.buildInboundMessage 对齐：私聊消息必须完全省略 chatId（带 chatId
  // 会被解析成群聊，走“暂不支持群聊”分支）。
  const fakeWeixinAdapter: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "stub" }),
    send: async (_bot, message) => {
      controls.sendAttempts.push(message.text);
      if (controls.sendControl.failPattern?.test(message.text)) {
        throw controls.sendControl.errorFactory
          ? controls.sendControl.errorFactory()
          : new Error("provider send rejected (test)");
      }
      controls.sentMessages.push(message);
    },
    parseCallback: (payload): BotInboundMessage[] => {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = typeof payload.botId === "string" ? payload.botId : "";
      if (!botId) {
        return [];
      }
      const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
      const parsed: BotInboundMessage[] = [];
      for (const raw of rawMessages) {
        if (!isRecord(raw)) {
          continue;
        }
        const text = typeof raw.text === "string" ? raw.text.trim() : "";
        const providerUserId = typeof raw.from === "string" ? raw.from.trim() : "";
        if (!text || !providerUserId) {
          continue;
        }
        parsed.push({
          botId,
          text,
          actor: {
            provider: "weixin",
            botId,
            providerUserId,
            chatType: "private",
            providerMessageId:
              typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined,
          },
        });
      }
      return parsed;
    },
  };

  const service = createBotsService({
    credentialService,
    zcodeTaskService: fakeTaskService as unknown as IZCodeTaskService,
    modelSelectionService,
    // 场景6b：注入 settingService locale（缺省 undefined ⇒ readMessageLocale 走 zh 默认）。
    ...(options.locale
      ? {
          settingService: {
            get: async () => ({ locale: options.locale }),
          } as unknown as ISettingService,
        }
      : {}),
    runStartupBackgroundTasks: false,
    providerOverrides: { weixin: fakeWeixinAdapter },
  });

  return {
    service,
    configDir,
    dirs: { dataRoot, workspace, configDir },
    sentMessages: controls.sentMessages,
    sendAttempts: controls.sendAttempts,
    sendControl: controls.sendControl,
    createTaskCalls: controls.createTaskCalls,
    createTaskPermissionAutoDenyMs: controls.createTaskPermissionAutoDenyMs,
    sendPromptCalls: controls.sendPromptCalls,
    setModeCalls: controls.setModeCalls,
    setConfigOptionCalls: controls.setConfigOptionCalls,
    streamEventHandlers: controls.streamEventHandlers,
    setRespondPermissionResult(value: boolean) {
      controls.respondPermissionResult = value;
    },
    setListTasksResult(tasks: unknown[]) {
      controls.listTasksResult = tasks;
    },
    async overwriteBotConfig(patch: Record<string, unknown>) {
      const path = join(configDir, BOTS_CONFIG_FILE);
      const config = JSON.parse(await readFile(path, "utf8")) as {
        bots: Array<Record<string, unknown>>;
      };
      config.bots = config.bots.map((bot) =>
        bot.id === WEIXIN_BOT_ID ? { ...bot, ...patch } : bot,
      );
      await writeFile(path, JSON.stringify(config));
    },
    async dispose(keepDirs?: boolean) {
      await service.disposeAllAndWait().catch(() => undefined);
      setDataBaseDir(null);
      if (keepDirs) {
        return;
      }
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

function weixinInboundPayload(
  messages: Array<{
    id: string;
    text: string;
    from?: string;
  }>,
): unknown {
  return {
    botId: WEIXIN_BOT_ID,
    messages: messages.map((message) => ({
      id: message.id,
      from: message.from ?? "wx-user-1",
      text: message.text,
    })),
  };
}

// ---- 场景 1（§7.1 解锁默认）：无配置模式 ⇒ setMode("build") ----

test("场景1（红·解锁默认）：无 currentOptions.mode 的 bot 草稿首发 ⇒ 建任务咽喉 setMode 下发 build（今强制 yolo）", async () => {
  const harness = await createPermissionsHarness({});
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-unlock-1", text: "开始分析" }]),
    );
    assert.equal(result.ok, true, "前置：草稿首发必须成功");
    assert.ok(
      await waitForCondition(() => harness.createTaskCalls.length >= 1, 5000),
      "前置：必须创建 task",
    );
    assert.ok(
      await waitForCondition(() => harness.setModeCalls.length >= 1, 5000),
      "前置：建任务咽喉必须调用 setMode（mode 选项已在 getTaskConfigOptions 中）",
    );
    assert.ok(
      harness.setModeCalls.some((call) => call.mode === "build"),
      "未配置 currentOptions.mode 的 bot 默认模式必须是 build（spec §1.2/§7.1；今天 BOT_FORCED_MODE 强制 yolo）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 2（§7.2 bot 配置模式）：currentOptions.mode="plan" ⇒ setMode("plan") ----

test("场景2（红·bot 配置模式）：currentOptions.mode=plan 的 bot ⇒ draft 继承 plan 且 setMode 下发 plan（今强制 yolo）", async () => {
  const harness = await createPermissionsHarness({
    currentOptions: { mode: "plan" },
  });
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-unlock-plan-1", text: "开始分析" }]),
    );
    assert.equal(result.ok, true, "前置：草稿首发必须成功");
    assert.ok(
      await waitForCondition(() => harness.createTaskCalls.length >= 1, 5000),
      "前置：必须创建 task",
    );
    assert.ok(
      await waitForCondition(() => harness.setModeCalls.length >= 1, 5000),
      "前置：建任务咽喉必须调用 setMode",
    );
    assert.ok(
      harness.setModeCalls.some((call) => call.mode === "plan"),
      "currentOptions.mode=plan 的 bot 草稿必须继承 plan 并经 setMode 下发（spec §1.2/§7.2；今天强制 yolo 无视配置）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 14（§7.14 回归 guard）：yolo 配置 bot 派发 yolo（解锁后仍绿） ----

test("场景14（guard·yolo 配置）：currentOptions.mode=yolo 的 bot ⇒ 建任务咽喉 setMode 下发 yolo（解锁后仍绿）", async () => {
  const harness = await createPermissionsHarness({
    currentOptions: { mode: "yolo" },
  });
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-guard-yolo-1", text: "开始分析" }]),
    );
    assert.equal(result.ok, true, "前置：草稿首发必须成功");
    assert.ok(
      await waitForCondition(() => harness.createTaskCalls.length >= 1, 5000),
      "前置：必须创建 task",
    );
    assert.ok(
      await waitForCondition(() => harness.setModeCalls.length >= 1, 5000),
      "前置：建任务咽喉必须调用 setMode",
    );
    assert.ok(
      harness.setModeCalls.some((call) => call.mode === "yolo"),
      "currentOptions.mode=yolo 的 bot 草稿必须继承 yolo 并经 setMode 下发（spec §7.14 guard；yolo=用户显式配置的全自动，解锁不得改变该回归）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 3（§7.3 迁移）：v3 yolo draft ⇒ 加载后翻转 build，cursor/token 原样 ----

test("场景3（红·迁移）：v3 状态文件 yolo draft 加载 ⇒ mode 翻转为 build，weixin cursor/token 字段原样保留", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) => ({
      botId,
      workspacePath: workspace,
      mode: "draft",
      activeTaskId: null,
      weixinActivatedAt: 1,
      draftOptions: {
        provider: ZCODE_AGENT_PROVIDER,
        mode: "yolo",
        modelSelection: {
          providerId: ZCODE_AGENT_PROVIDER,
          modelId: "glm-test",
        },
      },
      weixinGetUpdatesBuf: "buf-keep",
      weixinContextTokens: { "wx-user-1": { token: "tok-keep", updatedAt: 1 } },
      updatedAt: 1,
    }),
  });
  try {
    // /status 触发 readContext ⇒ repo.readState（状态加载即迁移点，spec §2.1）。
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-mig-1", text: "/status" }]),
    );
    assert.equal(result.ok, true, "前置：/status 必须触发 context（状态文件）加载");

    const deadline = Date.now() + 5000;
    let entry: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      entry = await readStateBotEntryAnywhere(harness.configDir, WEIXIN_BOT_ID);
      const mode = (entry.draftOptions as { mode?: string } | undefined)?.mode;
      if (mode === "build") {
        break;
      }
      await sleep(50);
    }
    assert.equal(
      (entry.draftOptions as { mode?: string } | undefined)?.mode,
      "build",
      "v3 yolo draft 加载时必须一次性迁移为 build（spec §2.1/§7.3；今天原样保留 yolo）",
    );
    assert.equal(
      entry.weixinGetUpdatesBuf,
      "buf-keep",
      "迁移必须原样保留 weixin getUpdates 游标 buf（writeContext 单写者规则，M5 先例）",
    );
    assert.deepEqual(
      entry.weixinContextTokens,
      { "wx-user-1": { token: "tok-keep", updatedAt: 1 } },
      "迁移必须原样保留 weixin context token",
    );
  } finally {
    await harness.dispose();
  }
});

/** 迁移矩阵（场景3b）共用：yolo 草稿 entry（v2/v3/v4 手写文件同形）。 */
function yoloDraftStateEntry(botId: string, workspace: string): Record<string, unknown> {
  return {
    botId,
    workspacePath: workspace,
    mode: "draft",
    activeTaskId: null,
    weixinActivatedAt: 1,
    draftOptions: {
      provider: ZCODE_AGENT_PROVIDER,
      mode: "yolo",
      modelSelection: {
        providerId: ZCODE_AGENT_PROVIDER,
        modelId: "glm-test",
      },
    },
    updatedAt: 1,
  };
}

/** 读取指定状态文件（场景3b 迁移矩阵断言；文件必须已存在）。 */
async function readStateFile(configDir: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(configDir, name), "utf8")) as Record<string, unknown>;
}

test("场景3b（迁移矩阵 pin，§2.1/§7.3）：v4 版本守卫不翻转用户重选的 yolo、翻转结果幂等重读、v2 legacy 导入 flip、v3 文件名双文件路径", async () => {
  // (a)-1 幂等重读：手写 v4 文件 mode=build（v3→v4 翻转后的落盘形状）→ 加载 ⇒
  // 原样通过（version 守卫 passthrough，不重复动作、不回翻）。
  {
    const harness = await createPermissionsHarness({
      stateFile: { name: BOTS_STATE_FILE, version: 4 },
      stateEntry: (botId, workspace) => ({
        ...yoloDraftStateEntry(botId, workspace),
        draftOptions: {
          provider: ZCODE_AGENT_PROVIDER,
          mode: "build",
          modelSelection: { providerId: ZCODE_AGENT_PROVIDER, modelId: "glm-test" },
        },
      }),
    });
    try {
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-mig3b-idem", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：v4 文件加载必须成功");
      const state = await readStateFile(harness.configDir, BOTS_STATE_FILE);
      assert.equal(state.version, 4, "v4 文件不得被降版本重写");
      const entry = (state.bots as Record<string, { draftOptions?: { mode?: string } }>)[
        WEIXIN_BOT_ID
      ];
      assert.equal(entry.draftOptions?.mode, "build", "已翻转的 v4 build 幂等重读必须保持 build");
    } finally {
      await harness.dispose();
    }
  }

  // (a)-2 版本守卫：手写 v4 文件 mode=yolo（解锁后用户经 /mode 重选）→ 加载 ⇒
  // 不得被再次翻转（迁移只认 version===3；用户显式选择的 yolo 受保护）。
  {
    const harness = await createPermissionsHarness({
      stateFile: { name: BOTS_STATE_FILE, version: 4 },
      stateEntry: (botId, workspace) => yoloDraftStateEntry(botId, workspace),
    });
    try {
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-mig3b-yolo4", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：v4 yolo 文件加载必须成功");
      const state = await readStateFile(harness.configDir, BOTS_STATE_FILE);
      const entry = (state.bots as Record<string, { draftOptions?: { mode?: string } }>)[
        WEIXIN_BOT_ID
      ];
      assert.equal(
        entry.draftOptions?.mode,
        "yolo",
        "v4 中用户重选的 yolo 不得被版本守卫之外的逻辑翻转（spec §2.1 幂等 + 版本守卫即迁移）",
      );
    } finally {
      await harness.dispose();
    }
  }

  // (b) v2 legacy 导入：bot-state.v2.json（yolo 草稿）→ 加载 ⇒ 同一 flip 落 v4 build。
  {
    const harness = await createPermissionsHarness({
      stateFile: { name: BOTS_V2_STATE_FILE, version: 2 },
      stateEntry: (botId, workspace) => yoloDraftStateEntry(botId, workspace),
    });
    try {
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-mig3b-v2", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：v2 legacy 导入必须成功");
      const state = await readStateFile(harness.configDir, BOTS_STATE_FILE);
      assert.equal(state.version, 4, "v2 legacy 导入必须落 v4 文件");
      const entry = (state.bots as Record<string, { draftOptions?: { mode?: string } }>)[
        WEIXIN_BOT_ID
      ];
      assert.equal(
        entry.draftOptions?.mode,
        "build",
        "迟到的 v2 legacy 导入同样应用 yolo→build flip（spec §2.1 不得重新引入 yolo）",
      );
    } finally {
      await harness.dispose();
    }
  }

  // (c) 真实双文件路径：bot-state.v3.json 在场 + v4 缺席 → 加载并翻转，v4 文件生成。
  {
    const harness = await createPermissionsHarness({
      stateFile: { name: BOTS_V3_STATE_FILE, version: 3 },
      stateEntry: (botId, workspace) => yoloDraftStateEntry(botId, workspace),
    });
    try {
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-mig3b-v3file", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：v3 文件名路径加载必须成功");
      const state = await readStateFile(harness.configDir, BOTS_STATE_FILE);
      assert.equal(state.version, 4, "v3 文件加载必须生成 v4 文件（v4 缺席时迁移写回）");
      const entry = (state.bots as Record<string, { draftOptions?: { mode?: string } }>)[
        WEIXIN_BOT_ID
      ];
      assert.equal(entry.draftOptions?.mode, "build", "v3 文件名路径同样应用 yolo→build flip");
    } finally {
      await harness.dispose();
    }
  }
});

// ---- 场景 4（§7.7 permission_response 清理） ----

test("场景4（红·permission_response 清理）：CLI deny 经 permission_response 事件到达 ⇒ pendingPermissionOptions 清除", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, {
        activeTaskId: "task-perm-1",
        isWeixin: true,
        pendingPermissionOptions: [
          {
            requestId: "req-perm-1",
            optionId: "allow_once",
            command: "approve",
            label: "允许",
            response: { decision: "allow" },
          },
        ],
      }),
  });
  try {
    // 普通消息续跑任务并建立 stream watcher（botInboundResilience 场景9 同构）。
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-perm-resp-1", text: "开始分析" }]),
    );
    assert.equal(result.ok, true);
    assert.ok(
      await waitForCondition(() => harness.streamEventHandlers.has("task-perm-1"), 5000),
      "前置：必须建立 task stream watcher",
    );
    // CLI 登记表自动拒绝（或任意客户端应答）以 permission_response 事件上行。
    await harness.streamEventHandlers
      .get("task-perm-1")?.({
        type: "permission_response",
        taskId: "task-perm-1",
        traceId: "run-1",
        requestId: "req-perm-1",
        optionId: "deny",
        response: { decision: "deny" },
      })
      .catch(() => undefined);
    const cleared = await waitForStateBotField(
      WEIXIN_BOT_ID,
      (entry) => (entry.pendingPermissionOptions === undefined ? "cleared" : undefined),
      5000,
    );
    assert.equal(
      cleared,
      "cleared",
      "permission_response 必须清除 pendingPermissionOptions（spec §4.1/§7.7；今天 watcher 无该 case，pending 原样滞留）",
    );
    // 非瞬态（微信文本）提示渠道的退休注记：best-effort、非保留（spec §4.1/§3c.2）。
    // transient interaction card 的 finalize-on-permission_response 为 Feishu streaming_card
    // 专属路径，本 weixin harness 不覆盖（诚实披露该缺口；由 permissionResolved 文案路径钉住
    // 退休语义）。
    assert.ok(
      await waitForCondition(
        () =>
          harness.sentMessages.some((message) => (message.text ?? "").includes("该权限请求已处理")),
        5000,
      ),
      "permission_response 必须在非瞬态提示渠道补发一条本地化退休注记（spec §4.1/§7.7）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 5（§7.8 终态清理） ----

test("场景5（红·终态清理）：task_complete ⇒ 清空 pendingPermissionOptions（今终态只清 pendingElicitation）", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, {
        activeTaskId: "task-perm-1",
        isWeixin: true,
        pendingPermissionOptions: [
          {
            requestId: "req-perm-1",
            optionId: "allow_once",
            command: "approve",
            label: "允许",
            response: { decision: "allow" },
          },
        ],
      }),
  });
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-perm-term-1", text: "开始分析" }]),
    );
    assert.equal(result.ok, true);
    assert.ok(
      await waitForCondition(() => harness.streamEventHandlers.has("task-perm-1"), 5000),
      "前置：必须建立 task stream watcher",
    );
    // 终态事件（task_complete）：终态清理必须覆盖 pendingPermissionOptions。
    await harness.streamEventHandlers
      .get("task-perm-1")?.({
        type: "task_complete",
        taskId: "task-perm-1",
        traceId: "run-1",
      })
      .catch(() => undefined);
    const cleared = await waitForStateBotField(
      WEIXIN_BOT_ID,
      (entry) => (entry.pendingPermissionOptions === undefined ? "cleared" : undefined),
      5000,
    );
    assert.equal(
      cleared,
      "cleared",
      "task_complete 必须清空 pendingPermissionOptions（spec §4.2/§7.8；今天终态只清 pendingElicitation）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 13（§7.13 迟到点击）：自动拒绝后文本 /deny ⇒ 吞并 + 反馈 + pending 清扫 ----

test("场景13（迟到点击）：已收口后文本 /deny ⇒ respondPermission=false ⇒ 本地化反馈 + pending 清扫", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, {
        activeTaskId: "task-perm-late",
        isWeixin: true,
        pendingPermissionOptions: [
          {
            requestId: "req-late-1",
            optionId: "allow_once",
            command: "approve",
            label: "允许",
            response: { decision: "allow" },
          },
          {
            requestId: "req-late-1",
            optionId: "deny",
            command: "deny",
            label: "拒绝",
            response: { decision: "deny" },
          },
        ],
      }),
    // CLI 登记表已自动拒绝（或他端已应答）：respondPermission 返回 false = 迟到点击。
    respondPermissionResult: false,
  });
  try {
    // 普通消息续跑任务并建立 stream watcher（场景 4/5 同构前置）。
    const warmup = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-perm-late-0", text: "开始分析" }]),
    );
    assert.equal(warmup.ok, true);
    assert.ok(
      await waitForCondition(() => harness.streamEventHandlers.has("task-perm-late"), 5000),
      "前置：必须建立 task stream watcher",
    );
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-perm-late-1", text: "/deny req-late-1" }]),
    );
    assert.equal(result.ok, true, "前置：/deny 迟到点击必须被吞并处理");
    const feedback = result.replies[0]?.text ?? "";
    assert.ok(
      feedback.includes("已被处理"),
      "迟到点击必须回本地化「已被处理/已自动拒绝」反馈（spec §4.3/§7.13；今天回复 permissionHandled 文案且 pending 滞留）",
    );
    const cleared = await waitForStateBotField(
      WEIXIN_BOT_ID,
      (entry) => (entry.pendingPermissionOptions === undefined ? "cleared" : undefined),
      5000,
    );
    assert.equal(
      cleared,
      "cleared",
      "迟到点击吞并后必须清扫 pendingPermissionOptions orphan（spec §4.1；今天滞留到下一次 permission_request 覆盖）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 6（§7.12 /status 模式行） ----

test("场景6（红·/status 模式行）：/status 回复必须包含带非空值的模式行（今无模式行）", async () => {
  const harness = await createPermissionsHarness({});
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-status-mode-1", text: "/status" }]),
    );
    assert.equal(result.ok, true, "前置：/status 必须成功");
    const statusText = result.replies[0]?.text ?? "";
    assert.ok(
      statusText.includes("模式"),
      "/status 必须新增模式行（spec §5：draft 显示 draftOptions.mode；今天 buildStatusText 无模式行）",
    );
    const modeLine = statusText.split("\n").find((line) => line.includes("模式"));
    assert.match(
      modeLine ?? "",
      /模式[:：]\s*\S+/u,
      "模式行必须带非空模式值（解锁后默认 build；缺失显示未设置/not set fallback，spec §5）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 6b（/status 形态 pin，§5）：active-task 模式行 + 未设置 fallback + en ----

test("场景6b（/status 形态 pin）：active task 模式行、过渡形态优先 draftOptions.mode、草稿未设置 fallback、en 文案", async () => {
  // 1) active task：listTasks 返回运行中任务 ⇒ 模式行显示其实际模式（build）。
  {
    const harness = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-status-active", isWeixin: true }),
    });
    try {
      harness.setListTasksResult([
        {
          taskId: "task-status-active",
          traceId: "trace-status-active",
          title: "Active task",
          workspacePath: "/tmp/zcode-status-ws",
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now(),
          mode: "build",
          status: "running",
        },
      ]);
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-status-active", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：active-task /status 必须成功");
      const modeLine = (result.replies[0]?.text ?? "")
        .split("\n")
        .find((line) => line.includes("模式"));
      assert.match(
        modeLine ?? "",
        /模式[:：]\s*build/u,
        "active task 的 /status 必须显示模式行且带其实际模式（spec §5）",
      );
    } finally {
      await harness.dispose();
    }
  }

  // 2) 过渡形态（activeTaskId 在场 + 草稿 mode、任务索引暂不可见）：优先 draftOptions.mode
  //    （下一次提交真正使用的值），而非 config select 的 currentValue（[ulw] 评审 R1-8）。
  {
    const harness = await createPermissionsHarness({
      stateEntry: (botId, workspace) => ({
        botId,
        workspacePath: workspace,
        mode: "draft",
        activeTaskId: "task-status-transitional",
        weixinActivatedAt: 1,
        draftOptions: { provider: ZCODE_AGENT_PROVIDER, mode: "plan" },
        updatedAt: 1,
      }),
    });
    try {
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-status-trans", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：过渡形态 /status 必须成功");
      const modeLine = (result.replies[0]?.text ?? "")
        .split("\n")
        .find((line) => line.includes("模式"));
      assert.match(
        modeLine ?? "",
        /模式[:：]\s*plan/u,
        "activeTaskId+草稿过渡形态必须优先显示 draftOptions.mode（plan），不得回落任务侧 config current-value（build）",
      );
    } finally {
      await harness.dispose();
    }
  }

  // 3) 未设置 fallback：草稿无 mode（legacy 导入形状）⇒「未设置」。
  {
    const harness = await createPermissionsHarness({
      stateEntry: (botId, workspace) => ({
        botId,
        workspacePath: workspace,
        mode: "draft",
        activeTaskId: null,
        weixinActivatedAt: 1,
        draftOptions: { provider: ZCODE_AGENT_PROVIDER },
        updatedAt: 1,
      }),
    });
    try {
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-status-unset", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：无 mode 草稿 /status 必须成功");
      const modeLine = (result.replies[0]?.text ?? "")
        .split("\n")
        .find((line) => line.includes("模式"));
      assert.match(
        modeLine ?? "",
        /模式[:：]\s*未设置/u,
        "草稿缺 mode 必须显示「未设置」fallback（spec §5，formatStatusModelLabel 同款形态）",
      );
    } finally {
      await harness.dispose();
    }
  }

  // 4) en locale：模式行 label 与未设置 fallback 的英文形态（cheap pin）。
  {
    const harness = await createPermissionsHarness({
      locale: "en-US",
      stateEntry: (botId, workspace) => ({
        botId,
        workspacePath: workspace,
        mode: "draft",
        activeTaskId: null,
        weixinActivatedAt: 1,
        draftOptions: { provider: ZCODE_AGENT_PROVIDER },
        updatedAt: 1,
      }),
    });
    try {
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-status-en", text: "/status" }]),
      );
      assert.equal(result.ok, true, "前置：en /status 必须成功");
      const modeLine = (result.replies[0]?.text ?? "")
        .split("\n")
        .find((line) => line.startsWith("Mode:"));
      assert.match(
        modeLine ?? "",
        /Mode:\s*not set/u,
        "en locale 模式行必须显示「Mode: not set」fallback（spec §5 zh/en keys）",
      );
    } finally {
      await harness.dispose();
    }
  }
});

// ---- W3b（§3a/§3c）：deadline 传递 + 提醒/自动拒绝文案 + 超时配置 ----

/**
 * 策略 timer 的 E2E 时钟缩放（spec §3c；先例 = ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV）：
 * 仅在 ZCODE_ENV=test 且显式设置 BOT_PERMISSION_TIMER_SCALE_ENV 时生效；必须在
 * createPermissionsHarness（服务创建期解析系数）之前设置，测试结束恢复现场。
 */
async function withPermissionTimerScale(scale: string, run: () => Promise<void>): Promise<void> {
  const previousZcodeEnv = process.env.ZCODE_ENV;
  const previousScale = process.env[BOT_PERMISSION_TIMER_SCALE_ENV];
  process.env.ZCODE_ENV = "test";
  process.env[BOT_PERMISSION_TIMER_SCALE_ENV] = scale;
  try {
    await run();
  } finally {
    if (previousZcodeEnv === undefined) {
      delete process.env.ZCODE_ENV;
    } else {
      process.env.ZCODE_ENV = previousZcodeEnv;
    }
    if (previousScale === undefined) {
      delete process.env[BOT_PERMISSION_TIMER_SCALE_ENV];
    } else {
      process.env[BOT_PERMISSION_TIMER_SCALE_ENV] = previousScale;
    }
  }
}

function permissionRequestEvent(taskId: string, requestId: string): unknown {
  return {
    type: "permission_request",
    taskId,
    traceId: "trace-perm-w3b",
    requestId,
    description: "run a command",
    kind: "execute",
    options: [
      {
        optionId: "option-allow",
        kind: "allow",
        name: "Allow",
        response: { decision: "allow" },
      },
      {
        optionId: "option-deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny" },
      },
    ],
    raw: {},
  };
}

/** 场景 9/10/11/15 通用前置：task 模式 warmup（建立 stream watcher）。 */
async function warmupTaskWatcher(
  harness: PermissionsHarness,
  taskId: string,
  messageId: string,
): Promise<void> {
  const result = await harness.service.handleProviderCallbackResponse(
    "weixin",
    weixinInboundPayload([{ id: messageId, text: "开始分析" }]),
  );
  assert.equal(result.ok, true, "前置：warmup 消息必须成功");
  assert.ok(
    await waitForCondition(() => harness.streamEventHandlers.has(taskId), 5000),
    "前置：必须建立 task stream watcher",
  );
}

/** channel-dead 判别源（botChannelRetention.test.ts 同款）：weixinRet=-2 打标错误。 */
function channelDeadWeixinRetError(): Error {
  const error = new Error("Weixin iLink /sendmessage failed: ret=-2");
  (error as Error & { weixinRet?: number }).weixinRet = -2;
  return error;
}

test("场景 createTask 传递（§3a.2）：permissionTimeoutMinutes=7 ⇒ permissionAutoDenyMs=420000；缺省 ⇒ 600000（读取时默认 10）", async () => {
  const configured = await createPermissionsHarness({
    currentOptions: { permissionTimeoutMinutes: 7 },
  });
  try {
    const result = await configured.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-deadline-7", text: "开始分析" }]),
    );
    assert.equal(result.ok, true, "前置：草稿首发必须成功");
    assert.ok(
      await waitForCondition(() => configured.createTaskCalls.length >= 1, 5000),
      "前置：必须创建 task",
    );
    assert.equal(
      configured.createTaskPermissionAutoDenyMs.at(-1),
      7 * 60_000,
      "createTask 必须携带 permissionAutoDenyMs = 分钟×60000（spec §3a.2；7 分钟 ⇒ 420000）",
    );
  } finally {
    await configured.dispose();
  }

  const unconfigured = await createPermissionsHarness({});
  try {
    const result = await unconfigured.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-deadline-default", text: "开始分析" }]),
    );
    assert.equal(result.ok, true, "前置：草稿首发必须成功");
    assert.ok(
      await waitForCondition(() => unconfigured.createTaskCalls.length >= 1, 5000),
      "前置：必须创建 task",
    );
    assert.equal(
      unconfigured.createTaskPermissionAutoDenyMs.at(-1),
      600_000,
      "未配置 permissionTimeoutMinutes 的 bot 建任务也必须携带默认 deadline（读取时默认 10 分钟 ⇒ 600000；缺省无倒计时会造成 bot 侧文案与 CLI 事实脱节）",
    );
  } finally {
    await unconfigured.dispose();
  }
});

test("场景9a（§7.9）：deadline 10min（缩放后 600ms）⇒ 恰一次 T-2min 提醒先于 deny-note", async () => {
  await withPermissionTimerScale("1000", async () => {
    const harness = await createPermissionsHarness({
      // F2 后武装只读持久化冻结值：fixture 直接携带建任务时冻结的 600000（10min）。
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-9a",
          isWeixin: true,
          permissionAutoDenyMs: 600_000,
        }),
    });
    try {
      await warmupTaskWatcher(harness, "task-perm-9a", "wx-msg-perm-9a-0");
      await harness.streamEventHandlers
        .get("task-perm-9a")?.(permissionRequestEvent("task-perm-9a", "req-perm-9a"))
        .catch(() => undefined);
      assert.ok(
        await waitForCondition(
          () =>
            harness.sentMessages.some((message) =>
              (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
            ) &&
            harness.sentMessages.some((message) =>
              (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
            ),
          5000,
        ),
        "deadline 10min（缩放后 600ms）：reminder 与 deny-note 都必须发出",
      );
      const reminderCount = harness.sentMessages.filter((message) =>
        (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
      ).length;
      const denyNoteCount = harness.sentMessages.filter((message) =>
        (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
      ).length;
      assert.equal(reminderCount, 1, "reminder 必须恰发一次（spec §3c.1/§7.9）");
      assert.equal(denyNoteCount, 1, "deny-note 必须恰发一次（spec §3c.1）");
      assert.ok(
        harness.sentMessages
          .map((message) => message.text ?? "")
          .findIndex((text) => text.includes(PERMISSION_REMINDER_ZH)) <
          harness.sentMessages
            .map((message) => message.text ?? "")
            .findIndex((text) => text.includes(PERMISSION_AUTO_DENIED_ZH)),
        "reminder（deadline − 2min）必须先于 deny-note（deadline）",
      );
    } finally {
      await harness.dispose();
    }
  });
});

test("场景9b（§7.9）：deadline 1min（缩放后 60ms，≤5min）⇒ 无提醒，deny-note 照发", async () => {
  await withPermissionTimerScale("1000", async () => {
    const harness = await createPermissionsHarness({
      currentOptions: { permissionTimeoutMinutes: 1 },
      // F2 后武装只读持久化冻结值：fixture 携带建任务时冻结的 60000（1min，≤5min ⇒ 无 reminder）。
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-9b",
          isWeixin: true,
          permissionAutoDenyMs: 60_000,
        }),
    });
    try {
      await warmupTaskWatcher(harness, "task-perm-9b", "wx-msg-perm-9b-0");
      await harness.streamEventHandlers
        .get("task-perm-9b")?.(permissionRequestEvent("task-perm-9b", "req-perm-9b"))
        .catch(() => undefined);
      assert.ok(
        await waitForCondition(
          () =>
            harness.sentMessages.some((message) =>
              (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
            ),
          5000,
        ),
        "deadline 1min：deny-note 必须照发（缩放后 ~60ms）",
      );
      // deny-note 已到 ⇒ deadline 已过；再等一个缩放后窗口确认 reminder 始终不发。
      await sleep(200);
      assert.equal(
        harness.sentMessages.filter((message) =>
          (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
        ).length,
        0,
        "deadline ≤ 5 分钟必须整体跳过 reminder（spec §3c.1/§7.9）",
      );
    } finally {
      await harness.dispose();
    }
  });
});

test("场景10（§7.10 非保留）：reminder/deny-note 发送失败（channel-dead）⇒ 保留缓冲零新增条目", async () => {
  await withPermissionTimerScale("1000", async () => {
    const harness = await createPermissionsHarness({
      // F2 后武装只读持久化冻结值：fixture 携带 600000（10min）——两条 timer 都需武装。
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-10",
          isWeixin: true,
          permissionAutoDenyMs: 600_000,
        }),
    });
    try {
      await warmupTaskWatcher(harness, "task-perm-10", "wx-msg-perm-10-0");
      // 只让两条策略 timer 文案失败（权限提示本身照常送达，timer 正常武装）。
      harness.sendControl.failPattern = new RegExp(
        `${PERMISSION_REMINDER_ZH.slice(0, 6)}|${PERMISSION_AUTO_DENIED_ZH.slice(0, 6)}`,
        "u",
      );
      harness.sendControl.errorFactory = channelDeadWeixinRetError;
      await harness.streamEventHandlers
        .get("task-perm-10")?.(permissionRequestEvent("task-perm-10", "req-perm-10"))
        .catch(() => undefined);
      assert.ok(
        await waitForCondition(
          () =>
            harness.sendAttempts.some((text) => text.includes(PERMISSION_REMINDER_ZH)) &&
            harness.sendAttempts.some((text) => text.includes(PERMISSION_AUTO_DENIED_ZH)),
          5000,
        ),
        "前置：两条策略 timer 都必须真实尝试发送（失败路径已被走到）",
      );
      // 通道恢复 + 任意 weixin 入站 ⇒ revival 扫描：保留缓冲若被写入必发序言+补发。
      harness.sendControl.failPattern = undefined;
      harness.sendControl.errorFactory = undefined;
      await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-perm-10-revive", text: "继续" }]),
      );
      await sleep(200);
      assert.equal(
        harness.sentMessages.filter((message) =>
          (message.text ?? "").startsWith(RETAINED_PREAMBLE_PREFIX_ZH),
        ).length,
        0,
        "策略 timer 文案失败不得进入保留缓冲（revival 无序言 = 零积压条目；spec §3c.2/§7.10）",
      );
      assert.equal(
        harness.sentMessages.some((message) =>
          (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
        ),
        false,
        "失败的 reminder 不得经 revival 迟到补发（即时性消息，延迟到达令人困惑）",
      );
      assert.equal(
        harness.sentMessages.some((message) =>
          (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
        ),
        false,
        "失败的 deny-note 不得经 revival 迟到补发",
      );
    } finally {
      await harness.dispose();
    }
  });
});

test("场景11（§7.11 边界 guard）：permission deadline 触发不触碰 pending user input（elicitation 原样存活）", async () => {
  await withPermissionTimerScale("1000", async () => {
    // pendingElicitation 归属另一 actor（actorKey 不同）：warmup 文本不被问答路径吞并，
    // 场景聚焦「permission timer 与问题类 pending 互不影响」的边界（spec §3e.1）。
    const otherActorKey = `${WEIXIN_BOT_ID}::weixin::wx-other-user`;
    const pendingElicitation = {
      taskId: "task-perm-11",
      requestId: "req-el-11",
      runId: "run-el-11",
      actorKey: otherActorKey,
      currentQuestionIndex: 0,
      questions: [
        {
          question: "选颜色？",
          header: "颜色",
          options: [
            { value: "red", label: "红" },
            { value: "blue", label: "蓝" },
          ],
        },
      ],
      answers: {},
    };
    const harness = await createPermissionsHarness({
      // F2 后武装只读持久化冻结值：fixture 携带 600000（默认 10min）。
      stateEntry: (botId, workspace) => ({
        ...taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-11",
          isWeixin: true,
          permissionAutoDenyMs: 600_000,
        }),
        pendingElicitation,
      }),
    });
    try {
      await warmupTaskWatcher(harness, "task-perm-11", "wx-msg-perm-11-0");
      await harness.streamEventHandlers
        .get("task-perm-11")?.(permissionRequestEvent("task-perm-11", "req-perm-11"))
        .catch(() => undefined);
      assert.ok(
        await waitForCondition(
          () =>
            harness.sentMessages.some((message) =>
              (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
            ),
          5000,
        ),
        "前置：permission deadline（缩放后 ~60ms 默认走 10min=600ms）必须触发 deny-note",
      );
      const entry = await readStateBotEntryAnywhere(harness.configDir, WEIXIN_BOT_ID);
      assert.deepEqual(
        entry.pendingElicitation,
        pendingElicitation,
        "permission deadline 触发后 pendingElicitation 必须原样存活（spec §3e.1：deadline 只作用于 permission kind；问题类行为不变）",
      );
    } finally {
      await harness.dispose();
    }
  });
});

test("场景15（§7.15）：deadline 前禁用 bot ⇒ note 抑制不发送（禁用覆写先于 scaled deadline 确定性完成）", async () => {
  await withPermissionTimerScale("1000", async () => {
    const harness = await createPermissionsHarness({
      // [ulw] 评审 R2 竞态窗口 pin：默认 10 分钟 deadline（缩放后 600ms），禁用覆写
      //（小文件写）确定性落在 deadline 之前；原 1 分钟（60ms）窗口下覆写可能迟到。
      // F2 后武装只读持久化冻结值：fixture 携带 600000（默认 10min）。
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-15",
          isWeixin: true,
          permissionAutoDenyMs: 600_000,
        }),
    });
    try {
      await warmupTaskWatcher(harness, "task-perm-15", "wx-msg-perm-15-0");
      // await 整个事件处理器 ⇒ 提示已送达且策略 timer 已武装（arm 在处理器同步尾部）。
      const armedAt = Date.now();
      await harness.streamEventHandlers
        .get("task-perm-15")?.(permissionRequestEvent("task-perm-15", "req-perm-15"))
        .catch(() => undefined);
      assert.ok(
        harness.sendAttempts.some((text) => text.includes("允许") || text.includes("拒绝")),
        "前置：权限提示必须已送达（timer 已武装）",
      );
      // deadline（缩放后 600ms）前覆写 bot 配置禁用——触发时重读配置 ⇒ 抑制。
      await harness.overwriteBotConfig({ enabled: false });
      assert.ok(
        Date.now() < armedAt + 500,
        "前置：禁用覆写必须确定性完成于 scaled deadline（600ms）之前",
      );
      // 跨过 reminder（480ms）与 deny-note（600ms）两个触发点再断言。
      await sleep(900);
      assert.equal(
        harness.sendAttempts.some((text) => text.includes(PERMISSION_REMINDER_ZH)),
        false,
        "bot 禁用后 reminder 必须同样抑制（spec §3c 生命周期表/§7.15）",
      );
      assert.equal(
        harness.sendAttempts.some((text) => text.includes(PERMISSION_AUTO_DENIED_ZH)),
        false,
        "bot 禁用后到期必须抑制 note（不向已禁用 bot 的频道发送；spec §3c 生命周期表/§7.15）",
      );
      assert.equal(
        harness.sentMessages.some(
          (message) =>
            (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH) ||
            (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
        ),
        false,
        "禁用抑制 = 零投递（含 revival 等任何迟到路径）",
      );
    } finally {
      await harness.dispose();
    }
  });
});

// ---- [ulw] 评审 R1-1（MAJOR）：并发权限幽灵文案——timer 清除不得被空 pending 拦截 ----

test("场景R1-1（并发权限）：A 武装 → B 覆盖 pending → B 应答清空 → A 应答命中空 pending ⇒ A 的 reminder/deny-note 永不补发", async () => {
  await withPermissionTimerScale("1000", async () => {
    const harness = await createPermissionsHarness({
      // F2 后武装只读持久化冻结值：fixture 携带 600000（默认 10min，缩放后 600ms）。
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-ghost",
          isWeixin: true,
          permissionAutoDenyMs: 600_000,
        }),
    });
    try {
      await warmupTaskWatcher(harness, "task-perm-ghost", "wx-msg-perm-ghost-0");
      // 并发权限复现（[ulw] 评审 R1-1）：A 先到（武装 timer，deadline 缩放后 600ms），
      // B 随后覆盖 pendingPermissionOptions。
      await harness.streamEventHandlers
        .get("task-perm-ghost")?.(permissionRequestEvent("task-perm-ghost", "req-ghost-a"))
        .catch(() => undefined);
      await harness.streamEventHandlers
        .get("task-perm-ghost")?.(permissionRequestEvent("task-perm-ghost", "req-ghost-b"))
        .catch(() => undefined);
      // B 被应答 ⇒ pending（此时只剩 B 的记录）被过滤清空。
      await harness.streamEventHandlers
        .get("task-perm-ghost")?.({
          type: "permission_response",
          taskId: "task-perm-ghost",
          traceId: "trace-perm-w3b",
          requestId: "req-ghost-b",
          optionId: "option-deny",
          response: { decision: "deny" },
        })
        .catch(() => undefined);
      // A 随后被另一端应答 ⇒ permission_response 到达时 pending 已空——今天 helper
      // early-return 不清 timer，A 的 reminder/deny-note 会补发幽灵文案（红测点）。
      await harness.streamEventHandlers
        .get("task-perm-ghost")?.({
          type: "permission_response",
          taskId: "task-perm-ghost",
          traceId: "trace-perm-w3b",
          requestId: "req-ghost-a",
          optionId: "option-allow",
          response: { decision: "allow" },
        })
        .catch(() => undefined);
      // 跨过 A 的原始 scaled deadline（默认 10 分钟 ⇒ 600ms；reminder 480ms）再观察。
      await sleep(900);
      assert.equal(
        harness.sentMessages.filter((message) =>
          (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
        ).length,
        0,
        "A 已被应答后 reminder 不得补发（幽灵文案；spec §3c「先答后不发」）",
      );
      assert.equal(
        harness.sentMessages.filter((message) =>
          (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
        ).length,
        0,
        "A 已被应答后 deny-note 不得补发（timer 清除不得被空 pending early-return 拦截）",
      );
      // 终态事件之后同样不得有任何补发（生命周期表「终态：清除 + pending 清空」）。
      await harness.streamEventHandlers
        .get("task-perm-ghost")?.({
          type: "task_complete",
          taskId: "task-perm-ghost",
          traceId: "trace-perm-w3b",
        })
        .catch(() => undefined);
      await sleep(200);
      assert.equal(
        harness.sentMessages.filter(
          (message) =>
            (message.text ?? "").includes(PERMISSION_REMINDER_ZH) ||
            (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
        ).length,
        0,
        "终态事件后 reminder/deny-note 均不得补发",
      );
    } finally {
      await harness.dispose();
    }
  });
});

// ---- [ulw] 评审 R1-2：迟到 deny 的超时文案选择（事件驱动，非仅依赖 deny-note timer） ----

test("场景R1-2（迟到 deny 文案）：deadline 后到达的 permission_response(deny) ⇒ 超时文案；deadline 前用户 deny ⇒ 通用已处理文案", async () => {
  await withPermissionTimerScale("1000", async () => {
    // 前半：deadline 前的用户 deny——通用文案（既有语义 guard）。F2 后武装只读持久化
    // 冻结值：fixture 携带 600000（默认 10min，缩放后 600ms）。
    const beforeDeadline = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-r12a",
          isWeixin: true,
          permissionAutoDenyMs: 600_000,
        }),
    });
    try {
      await warmupTaskWatcher(beforeDeadline, "task-perm-r12a", "wx-msg-perm-r12a-0");
      await beforeDeadline.streamEventHandlers
        .get("task-perm-r12a")?.(permissionRequestEvent("task-perm-r12a", "req-r12a"))
        .catch(() => undefined);
      // deadline（缩放后 600ms）远未到：立即驱动用户 deny。
      await beforeDeadline.streamEventHandlers
        .get("task-perm-r12a")?.({
          type: "permission_response",
          taskId: "task-perm-r12a",
          traceId: "trace-perm-w3b",
          requestId: "req-r12a",
          optionId: "option-deny",
          response: { decision: "deny" },
        })
        .catch(() => undefined);
      assert.ok(
        await waitForCondition(
          () =>
            beforeDeadline.sentMessages.some((message) =>
              (message.text ?? "").includes("该权限请求已处理"),
            ),
          5000,
        ),
        "deadline 前的用户 deny 必须回通用「该权限请求已处理」注记（spec §4.1）",
      );
      assert.equal(
        beforeDeadline.sentMessages.some((message) =>
          (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
        ),
        false,
        "deadline 前的 deny 不得误用超时文案",
      );
    } finally {
      await beforeDeadline.dispose();
    }

    // 后半：deadline 后到达的 deny（CLI 自动拒绝竞态 / 迟到用户 deny）——超时文案。
    // F2 后武装只读持久化冻结值：fixture 携带 600000（武装 deadline 在场才能命中「已过」）。
    const afterDeadline = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, {
          activeTaskId: "task-perm-r12b",
          isWeixin: true,
          permissionAutoDenyMs: 600_000,
        }),
    });
    try {
      await warmupTaskWatcher(afterDeadline, "task-perm-r12b", "wx-msg-perm-r12b-0");
      await afterDeadline.streamEventHandlers
        .get("task-perm-r12b")?.(permissionRequestEvent("task-perm-r12b", "req-r12b"))
        .catch(() => undefined);
      // await 已保证武装完成（arm 在事件处理器内）⇒ 实际 deadlineAt ≤ handlerDoneAt + 600。
      const handlerDoneAt = Date.now();
      // 同步自旋跨过 scaled deadline（默认 10 分钟 ⇒ 600ms）：阻塞事件循环 ⇒ bot 侧
      // deny-note timer 无法触发、登记仍在，随后直驱 permission_response——处理器在
      // 清除登记前同步读取武装 deadline ⇒ 必须命中「已过」并选择超时文案（红测点：
      // 修复前发通用 permissionResolved）。
      while (Date.now() < handlerDoneAt + 700) {
        // 纯同步自旋，不得 await（否则事件循环得到轮转、deny-note timer 抢先触发）。
      }
      await afterDeadline.streamEventHandlers
        .get("task-perm-r12b")?.({
          type: "permission_response",
          taskId: "task-perm-r12b",
          traceId: "trace-perm-w3b",
          requestId: "req-r12b",
          optionId: "option-deny",
          response: { decision: "deny" },
        })
        .catch(() => undefined);
      assert.ok(
        await waitForCondition(
          () =>
            afterDeadline.sentMessages.some((message) =>
              (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
            ),
          5000,
        ),
        "deadline 后到达的 deny 必须发「权限超时未应答，已自动拒绝」超时文案（spec §0 拒绝可见/§3c.2 选择规则）",
      );
      assert.equal(
        afterDeadline.sentMessages.some((message) =>
          (message.text ?? "").includes("该权限请求已处理"),
        ),
        false,
        "deadline 后的 deny 不得再发通用「已处理」文案（超时事实先于用户意图）",
      );
    } finally {
      await afterDeadline.dispose();
    }
  });
});

// =====================================================================================
// alpha.1（rig-221723）红测套件——specs/bot-permissions.md §7.16-§7.22 / §8 F1-F4。
// W1 提交、未实现必红；随 W2（F1+F4）/W3（F2+F3）转绿。guard 用例（今天即绿）钉住
// 修复不得破坏的边界，文件头 harness 约定不变。
// =====================================================================================

/**
 * F1/F§7.18 watcher 直驱探针事件：description 用作提示文案唯一标记（经
 * formatBotPermissionRequestSummary → preview.title 进入 selection 回复正文），
 * 供「重复抑制/并发不互踩/unknown 不去重」按标记计数渲染次数。
 */
function probePermissionRequestEvent(taskId: string, requestId: string, marker: string): unknown {
  return {
    type: "permission_request",
    taskId,
    traceId: "trace-alpha1-probe",
    requestId,
    description: marker,
    kind: "execute",
    options: [
      {
        optionId: "option-allow",
        kind: "allow",
        name: "Allow",
        response: { decision: "allow" },
      },
      {
        optionId: "option-deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny" },
      },
    ],
    raw: {},
  };
}

/** §7.18 计数辅助：正文含 marker 的出站消息数（每次提示渲染恰发一条 selection 回复）。 */
function countPromptRenders(harness: PermissionsHarness, marker: string): number {
  return harness.sentMessages.filter((message) => (message.text ?? "").includes(marker)).length;
}

// ---- 场景 18（§7.18 / §8.1 F1 watcher 有界 seen-map 防御） ----

test("场景18a（红·F1 watcher 重复抑制）：同 requestId 重复 permission_request ⇒ 第二次渲染必须抑制；空 map 首提示必渲染（安全网不掩盖 host 回归）", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, { activeTaskId: "task-f1-dup", isWeixin: true }),
  });
  try {
    await warmupTaskWatcher(harness, "task-f1-dup", "wx-msg-f1-dup-0");
    // 首提示（seen-map 为空）：必须渲染——防御网存在的原因是双通道，不是吞首提示。
    await harness.streamEventHandlers
      .get("task-f1-dup")?.(
        probePermissionRequestEvent("task-f1-dup", "req-f1-dup", "probe-f1-dup"),
      )
      .catch(() => undefined);
    assert.ok(
      await waitForCondition(() => countPromptRenders(harness, "probe-f1-dup") >= 1, 5000),
      "前置（guard）：空 seen-map 下首提示必须渲染（spec §8.1：安全网不得掩盖 host 回归）",
    );
    // 同 requestId 重复（host 收口失效/混版窗口下的 belt-and-braces）：必须抑制。
    await harness.streamEventHandlers
      .get("task-f1-dup")?.(
        probePermissionRequestEvent("task-f1-dup", "req-f1-dup", "probe-f1-dup"),
      )
      .catch(() => undefined);
    await sleep(300);
    assert.equal(
      countPromptRenders(harness, "probe-f1-dup"),
      1,
      "同 requestId 的重复 permission_request 在 watcher 必须抑制第二次渲染（spec §8.1 watcher 防御；今天无 seen-map ⇒ 双发 = Telegram 双卡根因的 watcher 侧复现）",
    );
  } finally {
    await harness.dispose();
  }
});

test("场景18b（红·F1 并发不互踩）：A→B 并发后 A 的重复 ⇒ pending 仍属 B（不得被 A 的重复渲染覆盖）", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, { activeTaskId: "task-f1-conc", isWeixin: true }),
  });
  try {
    await warmupTaskWatcher(harness, "task-f1-conc", "wx-msg-f1-conc-0");
    await harness.streamEventHandlers
      .get("task-f1-conc")?.(
        probePermissionRequestEvent("task-f1-conc", "req-conc-a", "probe-conc-a"),
      )
      .catch(() => undefined);
    await harness.streamEventHandlers
      .get("task-f1-conc")?.(
        probePermissionRequestEvent("task-f1-conc", "req-conc-b", "probe-conc-b"),
      )
      .catch(() => undefined);
    // A 的重复到达（同 requestId 再渲染）：seen-map 必须抑制，且不得覆盖 B 的 pending。
    await harness.streamEventHandlers
      .get("task-f1-conc")?.(
        probePermissionRequestEvent("task-f1-conc", "req-conc-a", "probe-conc-a"),
      )
      .catch(() => undefined);
    await sleep(300);
    const entry = await readStateBotEntryAnywhere(harness.configDir, WEIXIN_BOT_ID);
    const pendingRequestIds = (
      (entry.pendingPermissionOptions as Array<{ requestId: string }> | undefined) ?? []
    ).map((option) => option.requestId);
    assert.ok(pendingRequestIds.length > 0, "前置：并发 B 之后 pending 必须有记录");
    assert.deepEqual(
      [...new Set(pendingRequestIds)],
      ["req-conc-b"],
      "A 的重复渲染不得覆盖 B 的 pendingPermissionOptions（spec §8.1：seen-map 不得键于只存最新请求的 pendingPermissionOptions——重复 A 会把 pending 拖回 A；今天重复 A 直接重写 pending ⇒ [req-conc-a]）",
    );
  } finally {
    await harness.dispose();
  }
});

test('场景18c（guard·F1 unknown 不去重）：requestId="unknown" 的两条 distinct 提示 ⇒ 都必须渲染（adapter 合成兜底永不去重）', async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, { activeTaskId: "task-f1-unknown", isWeixin: true }),
  });
  try {
    await warmupTaskWatcher(harness, "task-f1-unknown", "wx-msg-f1-unknown-0");
    // adapter 对缺失 requestId/toolCallId 的合成兜底是字面量 "unknown"（zcodeTaskServiceAdapter
    // permissionPayloadToStreamEvent）：混版旧 CLI 窗口可能出现两条 distinct 提示同携
    // "unknown"——dedupe 键永不得取该字面量（spec §8.1 陷阱 b）。
    await harness.streamEventHandlers
      .get("task-f1-unknown")?.(
        probePermissionRequestEvent("task-f1-unknown", "unknown", "probe-unknown-one"),
      )
      .catch(() => undefined);
    await harness.streamEventHandlers
      .get("task-f1-unknown")?.(
        probePermissionRequestEvent("task-f1-unknown", "unknown", "probe-unknown-two"),
      )
      .catch(() => undefined);
    await sleep(300);
    assert.equal(countPromptRenders(harness, "probe-unknown-one"), 1, "unknown-id 提示一必须渲染");
    assert.equal(
      countPromptRenders(harness, "probe-unknown-two"),
      1,
      'unknown-id 提示二必须同样渲染——"unknown" requestId 永不去重（spec §8.1 陷阱 b；guard 今天即绿，W2/W3 引入 seen-map 后必须跳过该字面量）',
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 19（§7.19 / §8.2 F2 deadline 冻结持久化） ----

test("场景19a（红·F2 冻结武装）：建任务(timeout=10min)后配置调低至 1min ⇒ 后续提示武装仍按冻结 10min（E7），不读活配置", async () => {
  await withPermissionTimerScale("1000", async () => {
    const harness = await createPermissionsHarness({});
    try {
      // 1) 草稿首发：createTask 携带默认 600000，context 切 task 模式并建 watcher。
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-f2a-1", text: "开始分析" }]),
      );
      assert.equal(result.ok, true, "前置：草稿首发必须成功");
      assert.ok(
        await waitForCondition(() => harness.createTaskCalls.length >= 1, 5000),
        "前置：必须创建 task",
      );
      assert.equal(
        harness.createTaskPermissionAutoDenyMs.at(-1),
        600_000,
        "前置：默认配置 ⇒ createTask 冻结值 600000",
      );
      const taskId = "task-created-1";
      assert.ok(
        await waitForCondition(() => harness.streamEventHandlers.has(taskId), 5000),
        "前置：watcher 建立",
      );
      // 2) 终态 drain watcher——复现 E7 的真实形态：下一轮消息以新读配置重建 watcher
      //    （watchTaskStream 捕获的 bot 是 watcher 建立时的配置快照）。
      await harness.streamEventHandlers
        .get(taskId)?.({ type: "task_complete", taskId, traceId: "trace-f2a" })
        .catch(() => undefined);
      // 3) E7：任务运行期间把超时调低到 1 分钟。
      await harness.overwriteBotConfig({
        currentOptions: { permissionTimeoutMinutes: 1 },
      });
      // 4) 续跑消息重建 watcher + 新权限提示。
      const resumed = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-f2a-2", text: "继续" }]),
      );
      assert.equal(resumed.ok, true, "前置：续跑消息必须成功");
      assert.ok(
        await waitForCondition(() => harness.streamEventHandlers.has(taskId), 5000),
        "前置：watcher 重建",
      );
      await harness.streamEventHandlers
        .get(taskId)?.(probePermissionRequestEvent(taskId, "req-f2a", "probe-f2a-frozen"))
        .catch(() => undefined);
      // 5) 冻结语义：任务建于 10min ⇒ reminder 必须发出（10min > 5min 阈值；缩放后
      //    reminder ~480ms）。今天渲染点重读活配置 1min ⇒ 无 reminder 且 deny-note
      //    60ms 早发（E7 虚假「已自动拒绝」的测试内复现）。
      assert.ok(
        await waitForCondition(
          () =>
            harness.sentMessages.some((message) =>
              (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
            ),
          5000,
        ),
        "建任务时冻结的 10min deadline 必须决定武装（reminder 发出，spec §8.2；今天渲染点读活配置 1min ⇒ 整体跳过 reminder）",
      );
    } finally {
      await harness.dispose();
    }
  });
});

test("场景19b（红·F2 重启重武装）：服务重启后按持久化冻结值武装（不读活配置、不重读）", async () => {
  await withPermissionTimerScale("1000", async () => {
    let dirs: { dataRoot: string; workspace: string; configDir: string } | undefined;
    const first = await createPermissionsHarness({});
    try {
      const result = await first.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-f2b-1", text: "开始分析" }]),
      );
      assert.equal(result.ok, true, "前置：草稿首发必须成功");
      assert.ok(
        await waitForCondition(() => first.createTaskCalls.length >= 1, 5000),
        "前置：必须创建 task",
      );
      assert.equal(first.createTaskPermissionAutoDenyMs.at(-1), 600_000);
      const persisted = await waitForStateBotField(
        WEIXIN_BOT_ID,
        (entry) => (entry.activeTaskId === "task-created-1" ? "task" : undefined),
        5000,
      );
      assert.equal(persisted, "task", "前置：task 模式 context 必须已持久化到状态文件");
      // 重启前配置调低（磁盘上的 bot-config 即第二个实例将读到的活配置）。
      await first.overwriteBotConfig({
        currentOptions: { permissionTimeoutMinutes: 1 },
      });
      dirs = first.dirs;
    } finally {
      await first.dispose(true);
    }
    const second = await createPermissionsHarness({ reuseDirs: dirs });
    try {
      const resumed = await second.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-f2b-2", text: "继续" }]),
      );
      assert.equal(resumed.ok, true, "前置：重启后续跑消息必须成功");
      assert.ok(
        await waitForCondition(() => second.streamEventHandlers.has("task-created-1"), 5000),
        "前置：重启后 watcher 重建",
      );
      await second.streamEventHandlers
        .get("task-created-1")?.(
          probePermissionRequestEvent("task-created-1", "req-f2b", "probe-f2b-restart"),
        )
        .catch(() => undefined);
      assert.ok(
        await waitForCondition(
          () =>
            second.sentMessages.some((message) =>
              (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
            ),
          5000,
        ),
        "重启后必须按持久化的冻结 600000 重武装（reminder 发出）；今天读活配置 1min ⇒ 无 reminder（spec §8.2：渲染/武装只读持久值）",
      );
    } finally {
      await second.dispose();
    }
  });
});

test("场景19c（红·F2 miss 不武装）：无持久化 deadline（任务早于字段/映射丢失）⇒ deny-note 不武装，绝不活配置重武装", async () => {
  await withPermissionTimerScale("1000", async () => {
    const harness = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-f2c", isWeixin: true }),
    });
    try {
      await warmupTaskWatcher(harness, "task-f2c", "wx-msg-f2c-0");
      await harness.streamEventHandlers
        .get("task-f2c")?.(probePermissionRequestEvent("task-f2c", "req-f2c", "probe-f2c-miss"))
        .catch(() => undefined);
      // 跨过缩放后的默认 10min（600ms）与 reminder（480ms）两个触发点。
      await sleep(900);
      assert.equal(
        harness.sentMessages.filter((message) =>
          (message.text ?? "").includes(PERMISSION_AUTO_DENIED_ZH),
        ).length,
        0,
        "无持久化 deadline ⇒ deny-note 不得武装（spec §8.2 miss 不武装、「不补发避免误导」；今天活配置默认 10min 武装并在 ~600ms 发出「已自动拒绝」——对 miss 任务该文案无事实依据）",
      );
      assert.equal(
        harness.sentMessages.filter((message) =>
          (message.text ?? "").includes(PERMISSION_REMINDER_ZH),
        ).length,
        0,
        "miss ⇒ reminder 同样不武装",
      );
    } finally {
      await harness.dispose();
    }
  });
});

// ---- 场景 21（§7.21 / §8.3 F3 单确认：自答 ack / 外来解析 note） ----
// CLI 自动拒绝 ⇒ permissionAutoDenied note 的 §3c.2 选择规则由既有场景R1-2 钉住；
// 迟到点击反馈（permissionLateHandled）不变由既有场景13 钉住，此处不重复。

test("场景21a（红·F3 自答单确认·按钮路径）：/permission 1 自答 ack 后 CLI permission_response 回程 ⇒ permissionResolved note 必须抑制", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, { activeTaskId: "task-f3btn", isWeixin: true }),
  });
  try {
    await warmupTaskWatcher(harness, "task-f3btn", "wx-msg-f3btn-0");
    await harness.streamEventHandlers
      .get("task-f3btn")?.(
        probePermissionRequestEvent("task-f3btn", "req-f3btn", "probe-f3-button"),
      )
      .catch(() => undefined);
    assert.ok(
      harness.sendAttempts.some((text) => text.includes("允许") || text.includes("拒绝")),
      "前置：权限提示必须已送达",
    );
    // 按钮路径（permission.respond 序号 1 = 排序后的 allow 选项）。
    const answered = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-f3btn-1", text: "/permission 1" }]),
    );
    assert.equal(answered.ok, true, "前置：按钮应答必须成功");
    assert.ok(
      (answered.replies[0]?.text ?? "").includes("已提交权限响应"),
      "前置：自答必须回命令 ack（permissionSubmitted——单确认，spec §8.3）",
    );
    // CLI 的 permission.resolved（allow 生效）竞速回程到 watcher。
    await harness.streamEventHandlers
      .get("task-f3btn")?.({
        type: "permission_response",
        taskId: "task-f3btn",
        traceId: "trace-f3btn",
        requestId: "req-f3btn",
        optionId: "option-allow",
        response: { decision: "allow" },
      })
      .catch(() => undefined);
    await sleep(300);
    assert.equal(
      harness.sentMessages.filter((message) => (message.text ?? "").includes("该权限请求已处理"))
        .length,
      0,
      "自答的 permission_response 回程不得再发 permissionResolved note（spec §8.3：自答以 ack 为单确认；今天按钮路径 pending 滞留 handledAt 条目 ⇒ hadPendingPrompt=true ⇒ 双确认 D4）",
    );
  } finally {
    await harness.dispose();
  }
});

test("场景21a2（红·F3 自答单确认·文本路径）：/approve 自答 ack 后回程 note 必须抑制（今 watcher 侧 pending 副本未随文本清理解 ⇒ 双确认）", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, { activeTaskId: "task-f3txt", isWeixin: true }),
  });
  try {
    await warmupTaskWatcher(harness, "task-f3txt", "wx-msg-f3txt-0");
    await harness.streamEventHandlers
      .get("task-f3txt")?.(probePermissionRequestEvent("task-f3txt", "req-f3txt", "probe-f3-text"))
      .catch(() => undefined);
    const answered = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-f3txt-1", text: "/approve req-f3txt option-allow" }]),
    );
    assert.equal(answered.ok, true, "前置：文本应答必须成功");
    assert.ok(
      (answered.replies[0]?.text ?? "").includes("已提交权限响应"),
      "前置：文本自答必须回命令 ack",
    );
    await harness.streamEventHandlers
      .get("task-f3txt")?.({
        type: "permission_response",
        taskId: "task-f3txt",
        traceId: "trace-f3txt",
        requestId: "req-f3txt",
        optionId: "option-allow",
        response: { decision: "allow" },
      })
      .catch(() => undefined);
    await sleep(300);
    assert.equal(
      harness.sentMessages.filter((message) => (message.text ?? "").includes("该权限请求已处理"))
        .length,
      0,
      "文本自答的回程 note 必须抑制（spec §8.3；实测今天 watcher 闭包持有的 pending 副本不随文本路径清理 ⇒ hadPendingPrompt=true ⇒ 双确认 D4 的文本路径形态——W3 必须经 recently-self-answered 集合抑制，不得依赖 pending 清理竞态）",
    );
  } finally {
    await harness.dispose();
  }
});

test("场景21b（guard·F3 外来解析）：跨端/桌面应答（聊天未自答）⇒ permissionResolved note 照发恰一条", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, { activeTaskId: "task-f3x", isWeixin: true }),
  });
  try {
    await warmupTaskWatcher(harness, "task-f3x", "wx-msg-f3x-0");
    await harness.streamEventHandlers
      .get("task-f3x")?.(probePermissionRequestEvent("task-f3x", "req-f3x", "probe-f3-cross"))
      .catch(() => undefined);
    // 桌面 UI/手机远控应答：聊天侧只收到 permission_response 事件（无自答）。
    await harness.streamEventHandlers
      .get("task-f3x")?.({
        type: "permission_response",
        taskId: "task-f3x",
        traceId: "trace-f3x",
        requestId: "req-f3x",
        optionId: "option-allow",
        response: { decision: "allow" },
      })
      .catch(() => undefined);
    assert.ok(
      await waitForCondition(
        () =>
          harness.sentMessages.some((message) => (message.text ?? "").includes("该权限请求已处理")),
        5000,
      ),
      "外来解析（跨端应答）必须仍发 permissionResolved note——聊天内唯一的确认消息（spec §8.3：note 仅对外来解析；guard 今天即绿，W3 抑制集合不得误伤）",
    );
  } finally {
    await harness.dispose();
  }
});

// ---- 场景 22（§7.22 / §8.4 F4 /mode 选项源） ----

/** active-task /mode 用任务元数据（provider 必须在场：ZCode-Agent 任务才会命中死 stub 分支）。 */
function activeTaskMetaFixture(taskId: string, workspaceIdentity?: string) {
  return [
    {
      taskId,
      traceId: `trace-${taskId}`,
      title: "Active task",
      workspacePath: "/tmp/zcode-mode-ws",
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      mode: "build",
      status: "completed",
      provider: ZCODE_AGENT_PROVIDER,
    },
  ];
}

test("场景22a（红·F4 draft 合成）：已配模型 draft 的 /mode ⇒ 列出模式选择（build/plan/yolo），当前值 build；今只合成 thought_level ⇒ modeMissing", async () => {
  const harness = await createPermissionsHarness({
    modelInView: true,
    stateEntry: (botId, workspace) => draftStateEntry(botId, workspace, true),
  });
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-mode-draft", text: "/mode" }]),
    );
    assert.equal(result.ok, true, "前置：/mode 必须成功");
    const replyText = result.replies[0]?.text ?? "";
    assert.ok(
      replyText.includes("选择模式"),
      "draft /mode 必须列出模式选择（spec §8.4：listDraftConfigOptions 从 getZCodeAgentAvailableModes 合成 mode select；今天只合成 thought_level ⇒ 回「未找到模式。」）",
    );
    assert.ok(replyText.includes("build"), "模式列表必须包含 build（读取时默认/当前值）");
    assert.ok(!replyText.includes("未找到模式"), "已配模型的 draft 不得回 modeMissing");
  } finally {
    await harness.dispose();
  }
});

test("场景22a2（guard·F4 model-less 边界）：模型不可解析的 draft /mode ⇒ 仍不列选项（modeMissingNoModel，与 thoughtLevel 平权）", async () => {
  // 3.16.0 PR1 rider §7.38③（行为有意变更）：无模型草稿 /mode 从 modeMissing 短文案
  // 换为 modeMissingNoModel 可行动指引；空选项行为不变（仍不列选项，不得凭空合成）。
  const harness = await createPermissionsHarness({
    // 缺省 modelInView=false：view providers 为空 = 模型不可解析。
    stateEntry: (botId, workspace) => draftStateEntry(botId, workspace, true),
  });
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-mode-boundary", text: "/mode" }]),
    );
    assert.equal(result.ok, true, "前置：/mode 必须成功");
    assert.ok(
      (result.replies[0]?.text ?? "").includes(
        "尚未选择模型：请先通过 /model 选择模型，再设置协作模式。",
      ),
      "无模型 draft 的 /mode 必须回复 modeMissingNoModel 可行动文案（spec §8.4 rider §7.38③——仍不列选项；合成不得对 model-less draft 凭空列选项）",
    );
    assert.ok(
      !(result.replies[0]?.text ?? "").includes("未找到模式"),
      "无模型 draft 的 /mode 不得再回落旧 modeMissing 短文案",
    );
  } finally {
    await harness.dispose();
  }
});

test("场景22a3（红·rider B 无模型文案 zh）：无模型 draft /mode ⇒ modeMissingNoModel 新文案（今回「未找到模式。」）", async () => {
  // specs/agent-runtimes.md §7.2（handoff §7.38③）：无模型草稿 /mode 的回复必须给出
  // 可行动指引（先 /model 选模型），不得再复用其他空选项路径共享的 modeMissing 短文案。
  // 空选项行为不变（仍不列选项）；仅文案换成新键 modeMissingNoModel。W4 落地后
  // 场景22a2 的既有断言将随之更新（行为对 no-model 场景按 owner 裁定有意变更）。
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) => draftStateEntry(botId, workspace, true),
  });
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-mode-nomodel-zh", text: "/mode" }]),
    );
    assert.equal(result.ok, true, "前置：/mode 必须成功");
    assert.ok(
      (result.replies[0]?.text ?? "").includes(
        "尚未选择模型：请先通过 /model 选择模型，再设置协作模式。",
      ),
      "无模型 draft 的 /mode 必须回复 modeMissingNoModel 新文案（zh-CN 钉串；今天回「未找到模式。」）",
    );
  } finally {
    await harness.dispose();
  }
});

test("场景22a3-en（红·rider B 无模型文案 en）：无模型 draft /mode ⇒ modeMissingNoModel 新文案（en-US）", async () => {
  const harness = await createPermissionsHarness({
    locale: "en-US",
    stateEntry: (botId, workspace) => draftStateEntry(botId, workspace, true),
  });
  try {
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-mode-nomodel-en", text: "/mode" }]),
    );
    assert.equal(result.ok, true, "前置：/mode 必须成功");
    assert.ok(
      (result.replies[0]?.text ?? "").includes(
        "No model selected yet. Pick a model with /model first, then set the collaboration mode.",
      ),
      '无模型 draft 的 /mode 必须回复 modeMissingNoModel 新文案（en-US 钉串；今天回 "Mode option not found."）',
    );
  } finally {
    await harness.dispose();
  }
});

test("场景22b（红·F4 active 列表+设置往返）：active task 的 /mode 列表来自 active.configOptions；/mode plan ⇒ setConfigOption(mode,plan)（今走死 stub 恒空）", async () => {
  // (1) 列表：task meta 带 remote-shaped workspaceIdentity（远端形态负载经同一 stub 缝）。
  {
    const harness = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-mode-active", isWeixin: true }),
    });
    try {
      harness.setListTasksResult(activeTaskMetaFixture("task-mode-active", "remote:ssh:host-1/ws"));
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-mode-active", text: "/mode" }]),
      );
      assert.equal(result.ok, true, "前置：active-task /mode 必须成功");
      const replyText = result.replies[0]?.text ?? "";
      assert.ok(
        replyText.includes("选择模式"),
        "active-task /mode 必须从 active.configOptions 列出模式选择（spec §8.4；今天 listProviderConfigOptionsForActiveTask → listUserConfigOptions 死 stub return [] ⇒ modeMissing，rig RC1 本地/远端同形失败）",
      );
      assert.ok(replyText.includes("build"), "列表必须含 build（configOptions 当前值）");
    } finally {
      await harness.dispose();
    }
  }
  // (2) 设置往返：/mode plan ⇒ 经 setConfigOption(configId=mode, value=plan) 下发。
  {
    const harness = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-mode-set", isWeixin: true }),
    });
    try {
      harness.setListTasksResult(activeTaskMetaFixture("task-mode-set"));
      const result = await harness.service.handleProviderCallbackResponse(
        "weixin",
        weixinInboundPayload([{ id: "wx-msg-mode-set", text: "/mode plan" }]),
      );
      assert.equal(result.ok, true, "前置：/mode plan 必须成功");
      assert.ok(
        harness.setConfigOptionCalls.some(
          (call) =>
            call.taskId === "task-mode-set" && call.configId === "mode" && call.value === "plan",
        ),
        "active-task /mode 设置必须经 active.configOptions 解析选项并下发 setConfigOption(mode, plan)（spec §8.4；今天选项源为死 stub ⇒ 解析失败回「未找到模式。」）",
      );
    } finally {
      await harness.dispose();
    }
  }
});

test("场景22c（guard·F4 taskRunning 拒绝不变）：任务运行中 /mode ⇒ taskRunning 拒绝（解锁语义 guard）", async () => {
  const harness = await createPermissionsHarness({
    stateEntry: (botId, workspace) =>
      taskStateEntry(botId, workspace, { activeTaskId: "task-mode-running", isWeixin: true }),
  });
  try {
    // warmup 续跑消息把任务置 running（runningTasks）并建 watcher。
    await warmupTaskWatcher(harness, "task-mode-running", "wx-msg-mode-running-0");
    const result = await harness.service.handleProviderCallbackResponse(
      "weixin",
      weixinInboundPayload([{ id: "wx-msg-mode-running-1", text: "/mode" }]),
    );
    assert.equal(result.ok, true, "前置：运行中 /mode 必须成功处理（拒绝路径）");
    assert.ok(
      (result.replies[0]?.text ?? "").includes("当前任务正在运行"),
      "任务运行中 /mode 必须保持 taskRunning 拒绝（spec §0/§8.4：模式属于下一次提交；guard 今天即绿）",
    );
  } finally {
    await harness.dispose();
  }
});
