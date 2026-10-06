import {
  botsStateFileSchema,
  decodeCustomModelValue,
  modelSelectionSchema,
  ZCODE_AGENT_PROVIDER,
  type BotsStateFile,
  type ModelSelection,
} from "@zcode/shared";
import { normalizeBotCurrentOptions, normalizeBotDraftOptions } from "./config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只在 v3 文件不存在时调用；不是当前 Bot Options 的兼容读取器。 */
function migrateSelection(options: Record<string, unknown>): ModelSelection | undefined {
  if (Object.hasOwn(options, "modelSelection")) {
    // Bug 根因：旧 thoughtLevel 曾覆盖已保存的新档位；新字段存在时禁止回读旧字段。
    const parsed = modelSelectionSchema.safeParse(options.modelSelection);
    if (!parsed.success) return undefined;
    // builtin: 前缀只剩已废弃的 GLM 旧身份且无迁移目标，直接丢弃，不把死 ID 写进 v3。
    return parsed.data.providerId.startsWith("builtin:") ? undefined : parsed.data;
  }
  const value = typeof options.model === "string" ? options.model.trim() : "";
  const custom = decodeCustomModelValue(value);
  const separator = value.indexOf("/");
  const oldProviderId =
    custom?.providerId ?? (separator > 0 ? value.slice(0, separator) : undefined);
  const modelId = custom?.modelName ?? (separator > 0 ? value.slice(separator + 1) : undefined);
  if (!oldProviderId || !modelId) return undefined;
  // 仅接受明确身份，不再按模型名唯一匹配其他供应商，也不把裸模型名解释为 Agent Provider。
  // Bug 根因：候选为空时曾把明确旧选择永久写空到 v3；迁移只搬意图，不能检查当前可用性。
  // builtin: 前缀只剩已废弃的 GLM 旧身份且无迁移目标，直接丢弃。
  if (oldProviderId.startsWith("builtin:")) return undefined;
  const reasoningLevel =
    typeof options.thoughtLevel === "string" ? options.thoughtLevel.trim() : "";
  return {
    providerId: oldProviderId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export function importLegacyBotConfig(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.bots)) return value;
  return {
    ...value,
    version: 3,
    bots: value.bots.map((bot) => {
      if (!isRecord(bot)) return bot;
      const options = isRecord(bot.currentOptions) ? bot.currentOptions : {};
      return {
        ...bot,
        currentOptions: normalizeBotCurrentOptions({
          ...options,
          modelSelection: migrateSelection(options),
        }),
      };
    }),
  };
}

/**
 * Bugfix（specs/bot-permissions.md §2.1，3.15.0 Track B 迁移）：解锁 force-yolo 后，
 * v3 状态里历史 yolo 草稿在加载时一次性翻转为 build。只按 version===3 触发——
 * 解锁后用户经 /mode 显式选择的 yolo 已存为 v4，不得被再次翻转（幂等 + 版本守卫即迁移）。
 * 无 draftOptions 的 context 原样跳过；cursor/token 等兄弟字段按单写者规则原样保留。
 */
function flipLegacyYoloDraftModes(bots: unknown): unknown {
  if (!isRecord(bots)) {
    return bots;
  }
  return Object.fromEntries(
    Object.entries(bots).map(([id, state]) => {
      if (!isRecord(state) || !isRecord(state.draftOptions)) return [id, state];
      if (state.draftOptions.mode !== "yolo") return [id, state];
      return [id, { ...state, draftOptions: { ...state.draftOptions, mode: "build" } }];
    }),
  );
}

/**
 * 状态文件 v3→v4 迁移（specs/bot-permissions.md §2.1）：v3 内容翻转 yolo 草稿后以
 * v4 通过 schema 校验返回；v4 内容原样通过。changed 标记是否需要把迁移结果写回磁盘
 *（v4 原样通过时不写回，避免读路径写抖动）。
 */
export function migrateBotStateFileToV4(value: unknown): {
  state: BotsStateFile;
  changed: boolean;
} {
  if (isRecord(value) && value.version === 3) {
    return {
      state: botsStateFileSchema.parse({
        ...value,
        version: 4,
        bots: flipLegacyYoloDraftModes(value.bots),
      }),
      changed: true,
    };
  }
  return { state: botsStateFileSchema.parse(value), changed: false };
}

export function importLegacyBotState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.bots)) return value;
  const bots = Object.entries(value.bots).map(([id, state]) => {
    if (!isRecord(state) || !isRecord(state.draftOptions)) return [id, state];
    const options = state.draftOptions;
    const draftOptions = normalizeBotDraftOptions({
      provider: ZCODE_AGENT_PROVIDER,
      modelSelection: migrateSelection(options),
      ...(typeof options.mode === "string" ? { mode: options.mode } : {}),
    });
    // Bugfix（specs/bot-permissions.md §2.1）：迟到的 v2 legacy 导入同样不得重新引入
    // yolo——与 v3→v4 迁移应用同一 flip，输出直接落在 v4。
    return [
      id,
      {
        ...state,
        draftOptions:
          draftOptions.mode === "yolo" ? { ...draftOptions, mode: "build" } : draftOptions,
      },
    ];
  });
  return { ...value, version: 4, bots: Object.fromEntries(bots) };
}
