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

function buildModelSelectionService() {
  const modelSelection = {
    providerId: ZCODE_AGENT_PROVIDER,
    modelId: "glm-test",
  };
  return {
    getView: async () =>
      ({
        revision: 1,
        providers: [],
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
}

interface PermissionsHarness {
  service: IBotsService & { disposeAllAndWait(): Promise<void> };
  configDir: string;
  sentMessages: BotOutboundMessage[];
  sendAttempts: string[];
  sendControl: { failPattern?: RegExp; errorFactory?: () => Error };
  createTaskCalls: string[];
  createTaskPermissionAutoDenyMs: Array<number | undefined>;
  sendPromptCalls: string[];
  setModeCalls: Array<{ taskId: string; mode: string }>;
  streamEventHandlers: Map<string, (event: unknown) => Promise<void>>;
  /** 场景13：运行中翻转 fake respondPermission 返回值（false = 已被收口）。 */
  setRespondPermissionResult(value: boolean): void;
  /** 场景6b：运行中替换 fake listTasks 返回值（active-task /status 形态）。 */
  setListTasksResult(tasks: unknown[]): void;
  /** 场景15：直接覆写 bot-config.v3.json 顶层字段（enabled:false 等）。 */
  overwriteBotConfig(patch: Record<string, unknown>): Promise<void>;
  dispose(): Promise<void>;
}

async function createPermissionsHarness(
  options: PermissionsHarnessOptions,
): Promise<PermissionsHarness> {
  const { dataRoot, workspace, configDir } = await prepareWorkspaceDirs("zcode-bot-perms");

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
  await writeBotFiles(
    configDir,
    botConfig,
    options.stateEntry?.(botConfig.id, workspace) ?? draftStateEntry(botConfig.id, workspace, true),
    options.stateFile,
  );

  const controls: TaskServiceControls = {
    sentMessages: [],
    sendAttempts: [],
    sendControl: {},
    createTaskCalls: [],
    createTaskPermissionAutoDenyMs: [],
    sendPromptCalls: [],
    setModeCalls: [],
    streamEventHandlers: new Map(),
    respondPermissionResult: options.respondPermissionResult ?? true,
    listTasksResult: [],
  };
  const fakeTaskService = buildFakeTaskService(controls);
  const modelSelectionService = buildModelSelectionService();
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
    sentMessages: controls.sentMessages,
    sendAttempts: controls.sendAttempts,
    sendControl: controls.sendControl,
    createTaskCalls: controls.createTaskCalls,
    createTaskPermissionAutoDenyMs: controls.createTaskPermissionAutoDenyMs,
    sendPromptCalls: controls.sendPromptCalls,
    setModeCalls: controls.setModeCalls,
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
    async dispose() {
      await service.disposeAllAndWait().catch(() => undefined);
      setDataBaseDir(null);
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
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-perm-9a", isWeixin: true }),
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
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-perm-9b", isWeixin: true }),
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
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-perm-10", isWeixin: true }),
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
      stateEntry: (botId, workspace) => ({
        ...taskStateEntry(botId, workspace, { activeTaskId: "task-perm-11", isWeixin: true }),
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
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-perm-15", isWeixin: true }),
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
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-perm-ghost", isWeixin: true }),
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
    // 前半：deadline 前的用户 deny——通用文案（既有语义 guard）。
    const beforeDeadline = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-perm-r12a", isWeixin: true }),
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
    const afterDeadline = await createPermissionsHarness({
      stateEntry: (botId, workspace) =>
        taskStateEntry(botId, workspace, { activeTaskId: "task-perm-r12b", isWeixin: true }),
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
