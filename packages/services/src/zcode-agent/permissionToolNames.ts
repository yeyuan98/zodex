/**
 * F1（specs/bot-permissions.md §8.1，rig-221723）：AskUserQuestion / ExitPlanMode 的
 * permission.requested 只是 core 的等待态标记（requestId 属问题类），真正的交互经
 * interaction/requestUserInput 到达。host 侧通道 A 标记与 adapter 投影必须共用同一
 * 判定，避免问题类标记污染权限登记表（pendingPermissions gauge）或投成普通权限提示。
 */
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

export function isUserInputBackedPermissionToolName(value: string | undefined): boolean {
  return value === ASK_USER_QUESTION_TOOL_NAME || value === EXIT_PLAN_MODE_TOOL_NAME;
}
