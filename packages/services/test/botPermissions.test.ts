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
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { createBotsService } from "../src/bots/botsService.js";
import { BOTS_CONFIG_FILE, BOTS_STATE_FILE } from "../src/bots/config.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";
import type { IBotsService } from "../src/bots/bots.js";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import type { BotProviderAdapter } from "../src/bots/providers/types.js";

/**
 * specs/bot-permissions.md（3.15.0 Track B alpha.0）§7 验收场景红测（W1 提交、
 * 随 W2/W4 worker 转绿），harness 复制自 botInboundResilience.test.ts（weixin
 * 专用简化版）：
 *
 * - 场景 1/2（§7.1-§7.2 解锁）：无配置模式的 bot 草稿首发 setMode("build")
 *   （红：今 BOT_FORCED_MODE 强制 yolo）；currentOptions.mode="plan" 的 bot
 *   setMode("plan")（红：今 yolo）。
 * - 场景 3（§7.3 迁移）：v3 状态 yolo draft 加载后 mode 翻转 build，weixin
 *   cursor/token 字段原样保留（红：今原样保留 yolo）。
 * - 场景 4（§7.7 permission_response 清理）：CLI 侧 deny 经 permission_response
 *   事件到达 ⇒ 清除 pendingPermissionOptions（红：今 watcher 无该 case）。
 * - 场景 5（§7.8 终态清理）：task_complete 清空 pendingPermissionOptions
 *   （红：今终态只清 pendingElicitation）。
 * - 场景 6（§7.12 /status 模式行）：/status 回复包含模式行（红：今
 *   buildStatusText 无模式行）。
 */

const WEIXIN_BOT_ID = "bot-wx-perms";

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
  createTaskCalls: string[];
  sendPromptCalls: string[];
  /** setMode 调用记录：场景 1/2 断言建任务咽喉下发的模式（今天被 fake 忽略）。 */
  setModeCalls: Array<{ taskId: string; mode: string }>;
  streamEventHandlers: Map<string, (event: unknown) => Promise<void>>;
}

function buildFakeTaskService(controls: TaskServiceControls) {
  let createdCount = 0;
  return {
    listDeletedTaskIds: async () => [] as string[],
    resumeTask: async () => undefined,
    createTask: async () => {
      controls.createTaskCalls.push(`create-${controls.createTaskCalls.length + 1}`);
      createdCount += 1;
      return { taskId: `task-created-${createdCount}` };
    },
    deleteTask: async () => undefined,
    stopGeneration: async () => undefined,
    respondPermission: async () => true,
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
    listTasks: async () => [],
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
): Promise<void> {
  await writeFile(
    join(configDir, BOTS_CONFIG_FILE),
    JSON.stringify({ version: 3, bots: [botConfig] }),
  );
  await writeFile(
    join(configDir, BOTS_STATE_FILE),
    JSON.stringify({ version: 3, bots: { [botConfig.id]: stateEntry } }),
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
  /** bot 配置 currentOptions（场景 2：mode "plan"）。 */
  currentOptions?: BotCurrentOptions;
}

interface PermissionsHarness {
  service: IBotsService & { disposeAllAndWait(): Promise<void> };
  configDir: string;
  sentMessages: BotOutboundMessage[];
  createTaskCalls: string[];
  sendPromptCalls: string[];
  setModeCalls: Array<{ taskId: string; mode: string }>;
  streamEventHandlers: Map<string, (event: unknown) => Promise<void>>;
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
  );

  const controls: TaskServiceControls = {
    sentMessages: [],
    createTaskCalls: [],
    sendPromptCalls: [],
    setModeCalls: [],
    streamEventHandlers: new Map(),
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
    runStartupBackgroundTasks: false,
    providerOverrides: { weixin: fakeWeixinAdapter },
  });

  return {
    service,
    configDir,
    sentMessages: controls.sentMessages,
    createTaskCalls: controls.createTaskCalls,
    sendPromptCalls: controls.sendPromptCalls,
    setModeCalls: controls.setModeCalls,
    streamEventHandlers: controls.streamEventHandlers,
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
