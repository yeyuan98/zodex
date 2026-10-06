import type { BotConfig, BotProviderCallbackResult, BotsConfigFile } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { BotProviderAdapter } from "./providers/types.js";
import type { BotProviderRequester } from "./providers/providerRequest.js";
import {
  acquireTelegramPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  createPollErrorBackoff,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
  waitForPollErrorBackoff,
} from "./channelRuntime.js";

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: unknown[];
  description?: string;
}

// Telegram 服务端长轮询最多等待 25 秒；客户端额外预留传输时间，但必须覆盖响应体读取，
// 避免半开连接永久占用 polling lock，导致配置刷新无法接管 runtime。
const TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS = 40_000;

interface TelegramChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  telegramProvider: BotProviderAdapter | null;
  /** Telegram 长轮询出站请求的唯一出口（specs/bot-provider-network.md F1）。 */
  requester: BotProviderRequester;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  readTelegramOffset(botId: string): Promise<number | undefined>;
  writeTelegramOffset(botId: string, offset: number): Promise<void>;
  processProviderCallback(
    provider: "telegram",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createTelegramChannelRuntime(deps: TelegramChannelRuntimeDeps) {
  const { fetchBotProvider, fetchBotProviderJson } = deps.requester;

  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  const runtimes = new Map<string, RuntimeEntry>();
  const refreshQueue = createLatestRuntimeRefreshQueue();

  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function syncCommands(bot: BotConfig): Promise<void> {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：desktop-attached 远端不拥有 Telegram runtime；
      // 删除或禁用 bot 时也不能为了清命令访问第三方 API。
      return;
    }
    await deps.telegramProvider?.syncCommands?.(bot).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `sync Telegram commands failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef ? await deps.credentialService.load(bot.credentialRef) : null;
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "telegram",
        status: "error",
        messageId: "bots.runtime.telegramTokenMissing",
        message: "Telegram bot token is missing.",
      });
      return;
    }

    // F0b 自愈标记：pollBot 生命周期内出现过 provider 网络错误后，需要在一个成功的
    // getUpdates 周期（error→polling 转换）后补一次 syncCommands。必须声明在外层
    // while 之外：catch-all 路径会退出内层循环并重启外层迭代，标记不能随之丢失。
    let needsCommandResync = false;
    // specs/bot-inbound-resilience.md §D：poll 错误退避与 needsCommandResync 同理，必须声明在
    // 外层 while 之外跨 catch 周期存活（且在使用它的 try 块之外，TS2304 块级作用域）。
    // 内层 getUpdates 循环的三个 error-catch 等待共用一个实例；409 专属 10s 与
    // lock 竞争等待保持既有语义、不进此状态。
    const pollErrorBackoff = createPollErrorBackoff();
    // §D：内层 getUpdates 循环三个 error-catch 等待的统一入口——409 保持专属 10s、
    // 不进退避状态；其余错误递增退避，每次失败恰好一行 warn（次数 + 下次等待）。
    const waitForPollError = (status?: number): Promise<void> =>
      status === 409
        ? waitFor(10_000, signal)
        : waitForPollErrorBackoff(deps.logger, pollErrorBackoff, "telegram", bot.id, signal);
    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireTelegramPollingLock>>;
      try {
        lock = await acquireTelegramPollingLock(token, bot.id);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // Bugfix: 锁目录/rename 的瞬时 I/O 异常发生在轮询 try 之外时会终止后台 Promise。
        // 锁也是 runtime 生命周期的一部分，必须可观测、可取消地退避重试。
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          message: `Telegram polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "idle",
          messageId: "bots.runtime.telegramLongPollingHandledElsewhere",
          message: "Telegram long polling is handled by another Zodex window.",
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      // F0b 自愈标记的使用点见 pollBot 顶部的 needsCommandResync 声明。
      try {
        try {
          await fetchBotProvider(`https://api.telegram.org/bot${token}/deleteWebhook`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ drop_pending_updates: false }),
            signal,
          });
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          // Bugfix（事故 2026-10-01）：这里此前裸 catch 丢弃 deleteWebhook 的失败原因。
          // 真正的连接故障随后会由 getUpdates 的 catch 呈现；先用 debug 记录避免完全静默。
          deps.logger.debug(
            undefined,
            `Telegram deleteWebhook failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "polling",
          // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
          message: "Telegram long polling is running.",
          messageId: "bots.runtime.telegramLongPollingRunning",
          offset: await deps.readTelegramOffset(bot.id),
        });

        while (!signal.aborted) {
          const offset = await deps.readTelegramOffset(bot.id);
          const response = await fetchBotProviderJson<TelegramGetUpdatesResponse>(
            `https://api.telegram.org/bot${token}/getUpdates`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                timeout: 25,
                ...(offset !== undefined ? { offset } : {}),
                allowed_updates: ["message", "callback_query"],
              }),
              signal,
            },
            TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS,
          );
          if (!response.ok) {
            needsCommandResync = true;
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message:
                response.status === 409
                  ? "Telegram token is already used by another polling client."
                  : `Telegram getUpdates failed: HTTP ${response.status}`,
              offset,
            });
            // §D：409（另一轮询客户端冲突）保持专属 10s、不进退避；其余 HTTP 错误递增退避。
            await waitForPollError(response.status);
            continue;
          }
          const payload = response.payload;
          if (payload?.ok !== true || !Array.isArray(payload.result)) {
            needsCommandResync = true;
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message: payload?.description ?? "Telegram getUpdates returned an invalid response.",
              offset,
            });
            // §D：无效响应计入递增退避；每次失败恰好一行 warn（次数 + 下次等待）。
            await waitForPollError();
            continue;
          }
          if (signal.aborted) {
            return;
          }
          for (const update of payload.result) {
            if (signal.aborted) {
              return;
            }
            const updateId =
              isRecord(update) && typeof update.update_id === "number" ? update.update_id : null;
            const callbackResult = await deps.processProviderCallback("telegram", {
              botId: bot.id,
              update,
            });
            assertBotCallbackSucceeded("Telegram", callbackResult);
            if (updateId !== null) {
              // Bugfix: offset 是 Telegram 外部队列的消费确认点。业务回调失败前推进会让
              // 用户消息、权限和 elicitation 响应永久跳过；成功后逐条提交才能安全重试。
              await deps.writeTelegramOffset(bot.id, updateId + 1);
            }
          }
          if (needsCommandResync) {
            // Bugfix（事故发现）：连接断开期间 setMyCommands 可能一直失败，恢复后 Telegram
            // 命令菜单会保持空白直到重启。这里在一个成功周期（error→polling 转换）后补一次
            // syncCommands；标记复位保证每次恢复只触发一次，持续故障期间不反复轰炸。
            needsCommandResync = false;
            void syncCommands(bot);
          }
          // §D：本周期 getUpdates 成功且 update 全部处理完毕，视为成功 poll 周期，复位退避。
          pollErrorBackoff.recordSuccess();
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "telegram",
            status: "polling",
            // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
            message: "Telegram long polling is running.",
            messageId: "bots.runtime.telegramLongPollingRunning",
            offset: await deps.readTelegramOffset(bot.id),
          });
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        needsCommandResync = true;
        // Bugfix（事故 2026-10-01）：此前的裸 catch 丢弃了错误对象，运行状态只剩固定文案，
        // owner 机器上真实网络原因（fetch failed/ETIMEDOUT 等）完全不可见。这里绑定错误：
        // 保留 messageId 摘要（前端按语言渲染），把原始原因追加进 message 供 UI 展示详情，
        // 并以 warn 落日志。
        const cause = error instanceof Error ? error.message : String(error);
        deps.logger.warn(undefined, `Telegram polling failed bot=${bot.id}: ${cause}`);
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          messageId: "bots.runtime.telegramPollingFailedRetrying",
          message: `Telegram polling failed; retrying. (${cause})`,
          offset: await deps.readTelegramOffset(bot.id),
        });
        // §D：catch-all 网络异常与内层两个错误分支共用同一退避实例；每次失败恰好一行 warn。
        await waitForPollError();
      } finally {
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Telegram polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  async function stopPolling(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.telegramLongPollingStopped",
        message: "Telegram long polling is stopped.",
      });
    }
  }

  function startPolling(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: "telegram",
      status: "polling",
      messageId: "bots.runtime.telegramLongPollingStarting",
      message: "Telegram long polling is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = pollBot(bot, controller.signal)
      .catch((error: unknown) => {
        // Bugfix: 后台 runtime 的最终 Promise 必须显式收口，避免异常升级为 host 未处理 rejection。
        deps.logger.warn(
          undefined,
          `Telegram polling stopped unexpectedly bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (runtimes.get(bot.id) === runtime) {
          runtimes.delete(bot.id);
          const previous = deps.statusSink.getRuntimeStatus(bot.id);
          if (previous?.status === "polling") {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "idle",
              messageId: "bots.runtime.telegramLongPollingStopped",
              message: "Telegram long polling is stopped.",
              offset: previous.offset,
            });
          }
        }
      });
    runtimes.set(bot.id, runtime);
  }

  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    // Bugfix: polling 游标和微信 buf 会写入 bot-state.v4.json。
    // 启动轮询前必须先完成旧 state 迁移，否则迁移写回可能覆盖刚更新的第三方游标。
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeTelegramIds = new Set(
      currentConfig.bots
        .filter((bot) => bot.provider === "telegram" && bot.enabled && bot.credentialRef)
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeTelegramIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (bot.provider === "telegram" && bot.enabled && bot.credentialRef) {
        await syncCommands(bot);
        if (!isLatest()) {
          return;
        }
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: Bot id 不变不代表连接身份不变。必须等旧 token 的轮询和锁完全退出，
          // 再启动新凭据，避免配置已更新但后台仍消费旧账号或两个实例短暂并行。
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startPolling(bot, fingerprint);
      } else if (bot.provider === "telegram" && !bot.enabled) {
        await syncCommands(bot);
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：配置变更后的轮询刷新也是 bot runtime 后台任务；
      // attached remote 不能绕过构造期保护启动 Telegram polling。
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Telegram polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：服务销毁返回前必须等长轮询退出并释放 token 锁，避免新 host 被迫等待下一轮重试。
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  return {
    dispose,
    refresh,
    scheduleRefresh,
    stopPolling,
    syncCommands,
  };
}
