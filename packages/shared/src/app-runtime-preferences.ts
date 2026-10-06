import { z } from "zod";

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";
/**
 * specs/bot-permissions.md §3c（3.15.0 Track B）：bot 侧权限提醒/deny-note 策略 timer 的
 * E2E 时钟缩放 env（先例 = ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV）：仅 ZCODE_ENV=test
 * 生效，值域 1..1000，时长除以该系数。生产读取不到 ⇒ 系数 1（行为零变化）。
 */
export const BOT_PERMISSION_TIMER_SCALE_ENV = "ZCODE_E2E_BOT_PERMISSION_TIMER_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoFullRetentionEnabled: z.boolean().default(false),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
