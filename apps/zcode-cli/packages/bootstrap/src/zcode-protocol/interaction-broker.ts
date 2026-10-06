import { raceClientRequestWithV4Interaction } from "./interaction-response-race.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionInputSchema,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SESSION_ENTRY_PERMISSION_AUTO_RESOLUTION,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  type AskUserQuestion,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
  type SessionId,
} from "@zcode/contracts";
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  zcodePermissionResponseSchema,
  zcodeProtocolMethods,
  zcodeUserInputResponseSchema,
  type ZCodePermissionOption,
  type ZCodePermissionResponse,
  type ZCodeUserInputQuestion,
  type ZCodeUserInputResponse,
} from "@zcode/shared";
import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import {
  buildProtocolPermissionOptions,
  buildSessionPermissionUpdates,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  toLegacyPermissionOptionsPolicy,
  buildPermissionDeniedContent,
  PERMISSION_DENIED_BY_USER_CONTENT,
} from "./permission-options.js";

const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";
const INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS = 1_000;

export function createProtocolInteractionBroker(
  context: ZCodeProtocolAgentServerContext,
): PermissionBrokerPort {
  return {
    requestPermission(request, options) {
      if (request.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        return requestUserInput(context, request, options);
      }
      if (request.toolName === EXIT_PLAN_MODE_TOOL_NAME) {
        return requestExitPlanModeApproval(context, request, options);
      }
      return requestPermission(context, request, options);
    },
  };
}

async function requestPermission(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
): Promise<PermissionBrokerResult> {
  const permissionOptions = buildProtocolPermissionOptions(request);
  // v3 反向 RPC 的选项列表：会话免确认只在 v4 投放（旧桌面回传 response 原文，认不出会话语义）。
  const legacyPermissionOptions = buildProtocolPermissionOptions({
    ...request,
    optionsPolicy: toLegacyPermissionOptionsPolicy(request.optionsPolicy),
  });
  // spec §3a.3/§3b（bot-permissions）：权限交互按 kind "permission" 注册；所属
  // session 携带 permissionAutoDenyMs 时登记表为该条目武装无应答倒计时（到期代答
  // deny-shaped，落入下方映射的 deny 兜底）。无 deadline（桌面会话/未配置 bot）=
  // 无倒计时，行为与今天的 "other" kind 逐字节一致。
  const permissionRegistration = buildPermissionInteractionRegistrationOptions(
    request,
    await resolvePermissionDeadline(context, request),
    createPermissionAutoResolutionPersistence(context, request),
  );
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestPermission,
        {
          input: request.input,
          reason: request.reason,
          requestId: request.requestId,
          riskLevel: request.riskLevel,
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          options: legacyPermissionOptions,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodePermissionResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 answer → ZCodePermissionResponse：optionId 语义来自 v4 reducer 合成的
    // allowOnce/allowAlways/deny（见 product-projection onPermissionRequested）。
    (answer) => {
      const response = v4AnswerToPermissionResponse(answer, permissionOptions, request.toolName);
      return response.decision === "deny" && answer.freeText?.trim()
        ? { ...response, preserveReasonFormatting: true }
        : response;
    },
    {
      ...permissionRegistration,
      ...(!request.origin &&
      !request.optionsPolicy &&
      options?.claimResponse &&
      context.deps?.sessionStore?.commitPermissionFullAccess
        ? {
            fullAccess: async () => {
              if (!options.claimResponse!()) throw new Error("Permission response already settled");
              options.signal?.throwIfAborted();
              const record = context.sessions.get(String(request.sessionId));
              if (!record) throw new Error("Permission session unavailable");
              const eventId = await record.app.runtime.grantPermissionFullAccess(
                request.requestId,
                options.signal,
              );
              await context.v4Gateway?.waitForPermissionGrantCommit(
                String(request.sessionId),
                eventId,
              );
            },
          }
        : {}),
    },
  );
  return {
    ...response,
    // 兼容原因：legacy 客户端允许省略 reason；普通用户拒绝仍需向模型明确工具未执行，
    // 否则 core 会回退为通用的 `Permission denied for <tool>`，无法阻止绕过式尝试。
    ...(response.decision === "deny" && !response.reason?.trim()
      ? { reason: PERMISSION_DENIED_BY_USER_CONTENT }
      : {}),
    resolvedAt: new Date(),
  };
}

/**
 * v4 permission 应答映射：优先按 optionId 精确匹配 buildProtocolPermissionOptions
 * 合成的选项（allow_project 携带 permissionUpdates 持久化规则，不能丢）；投影侧
 * 合成的 allowAlways 语义等价 allow_project。未知 optionId 按 deny 兜底——权限
 * 语义下宁可拒绝也不放行未知应答。
 *
 * workflow Refine：该选项只在 v4 投影
 * 合成、不进 legacy 选项列表，所以在精确匹配之前特判。freeText 为空、或非
 * CreateWorkflow 工具伪造该 optionId，都落到既有 deny 兜底且不带 reasonSource——
 * 反馈升级为 user message 的通道必须只对真实用户输入开放。
 */
// 同 v4AnswerToUserInputResponse——导出供测试直测映射（spec §7.4：permission 到期
// deny-shaped 应答经该映射落 deny 兜底）；仅测试消费，不属于包对外 API。
export function v4AnswerToPermissionResponse(
  answer: V4InteractionAnswer,
  permissionOptions: ZCodePermissionOption[],
  toolName: string,
): ZCodePermissionResponse & {
  reasonSource?: PermissionBrokerResult["reasonSource"];
  sessionPermissionUpdates?: PermissionBrokerResult["sessionPermissionUpdates"];
} {
  const refineFeedback = answer.freeText?.trim();
  if (
    (toolName === CREATE_WORKFLOW_TOOL_NAME || toolName === AMEND_WORKFLOW_TOOL_NAME) &&
    answer.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID &&
    refineFeedback
  ) {
    return {
      decision: "deny",
      reason: refineFeedback,
      reasonSource: "workflow_refine_feedback",
    };
  }
  const exact = permissionOptions.find((option) => option.optionId === answer.optionId);
  if (exact) {
    if (exact.kind === "deny") {
      return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
    }
    // 会话免确认：会话语义在这里合成，而不是放进
    // option.response——wire 上 zcodePermissionUpdateSchema 是 strict，旧桌面多一个字段就丢事件。
    if (exact.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND) {
      return {
        ...exact.response,
        sessionPermissionUpdates: buildSessionPermissionUpdates(toolName),
      };
    }
    return exact.response;
  }
  if (answer.optionId === "allowAlways") {
    const allowAlways = permissionOptions.find((option) => option.kind === "allow_always");
    if (allowAlways) {
      return allowAlways.response;
    }
  }
  if (answer.optionId === "allowOnce") {
    return { decision: "allow", reason: "Approved once" };
  }
  // deny/rejectOnce/rejectAlways、未知 optionId、无 optionId 全部落 deny。
  return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
}

async function requestUserInput(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
): Promise<PermissionBrokerResult> {
  const parsed = AskUserQuestionInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      decision: "deny",
      reason: `Invalid AskUserQuestion input: ${
        parsed.error.issues[0]?.message ?? "schema validation failed"
      }`,
      resolvedAt: new Date(),
    };
  }

  const initialAutoResolution = await readPersistedAutoResolution(context, request);

  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: parsed.data.questions.map(mapAskUserQuestion),
          requestId: request.requestId,
          schema: { toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 AskUserQuestion：freeText/optionId 落到单题 answer 槽位
    // （normalizeAskUserQuestionResponseContent 的 content.answer 兼容路径）；
    // deny 落 decline。多题场景等 v4 投影建模 userInput kind 后再精确映射。
    (answer) => v4AnswerToUserInputResponse(answer),
    createInteractionRegistrationOptions(
      request,
      "askUserQuestion",
      context,
      initialAutoResolution,
    ),
  );

  return userInputResponseToBrokerResult(request, response);
}

// 导出供 test/interactionBroker.test.ts 直测映射（B2 broker 透传钉住）；仅测试消费，
// 不属于包对外 API（包出口见 package.json exports）。
export function v4AnswerToUserInputResponse(answer: V4InteractionAnswer): ZCodeUserInputResponse {
  // answer.action 存在（host adapter respondElicitation 收敛路径）
  // 时按旧 respondUserInput 语义精确直传——content 携带多题 answers/annotations，
  // normalizeAskUserQuestionResponseContent 继续负责 schema 收敛。
  if (answer.action) {
    if (answer.action === "accept") {
      return { action: "accept", content: answer.content ?? {} };
    }
    // specs/bot-inbound-resilience.md §B2.2：decline/cancel 不得丢弃 content——
    // B2 会话失败信号经 respondElicitation 收敛为 decline+{failureReason}，旧映射只回
    // {action} 会让 failureReason 永远到不了 agent。content 原样直传（wire schema
    // zcodeUserInputResponseSchema 已接受），failureReason → reason——消费方
    // userInputResponseToBrokerResult / planApprovalResponseToBrokerResult 只读 reason。
    return {
      action: answer.action,
      ...(answer.content ? { content: answer.content } : {}),
      ...(typeof answer.content?.failureReason === "string"
        ? { reason: answer.content.failureReason }
        : {}),
    };
  }
  const text = answer.freeText?.trim();
  if (text) {
    return { action: "accept", content: { answer: text } };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return { action: "accept", content: {} };
  }
  return { action: "decline" };
}

async function requestExitPlanModeApproval(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
): Promise<PermissionBrokerResult> {
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: [createExitPlanModeApprovalQuestion()],
          requestId: request.requestId,
          schema: { interaction: "plan_approval", toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 plan approval：allow 类 optionId = 批准；freeText = 计划反馈
    // （planApprovalResponseToBrokerResult 走 plan_approval_feedback deny）；否则 decline。
    (answer) => v4AnswerToPlanApprovalResponse(answer),
    createInteractionRegistrationOptions(request, "other"),
  );

  return planApprovalResponseToBrokerResult(response);
}

// 同 v4AnswerToUserInputResponse——导出仅供测试直测映射。
export function v4AnswerToPlanApprovalResponse(
  answer: V4InteractionAnswer,
): ZCodeUserInputResponse {
  // 同 v4AnswerToUserInputResponse——host adapter 收敛路径直传
  // action/content，planApprovalResponseToBrokerResult 继续做 approve/feedback 归一。
  if (answer.action) {
    if (answer.action === "accept") {
      return { action: "accept", content: answer.content ?? {} };
    }
    // specs/bot-inbound-resilience.md §B2.2：与普通问答映射同构的 content 透传 +
    // failureReason → reason（planApprovalResponseToBrokerResult 只读 reason）。
    return {
      action: answer.action,
      ...(answer.content ? { content: answer.content } : {}),
      ...(typeof answer.content?.failureReason === "string"
        ? { reason: answer.content.failureReason }
        : {}),
    };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return {
      action: "accept",
      content: { answer: EXIT_PLAN_MODE_APPROVAL_APPROVE },
    };
  }
  const feedback = answer.freeText?.trim();
  if (feedback) {
    return { action: "accept", content: { answer: feedback } };
  }
  return { action: "decline" };
}

function createExitPlanModeApprovalQuestion(): ZCodeUserInputQuestion {
  return {
    header: "Plan",
    options: [
      {
        description: "Exit plan mode and start implementation.",
        label: "Approve",
        value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
      },
    ],
    question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
  };
}

function withInteractionRequestRecovery(
  options: PermissionBrokerRequestOptions | undefined,
  signal: AbortSignal,
): PermissionBrokerRequestOptions & { reannounceIntervalMs: number } {
  return {
    ...options,
    // v4 竞速：内部 signal 已级联外层 options.signal（见 raceClientRequestWithV4Interaction），
    // v4 应答命中时经它取消悬空的反向 RPC。
    signal,
    // 桌面/恢复链路里 UI 可能只从 snapshot 恢复出 pending 交互，
    // 但 host 里原 protocol id 对应的内存登记已丢失。等待用户响应期间按同一业务
    // requestId 重发现有协议请求，让 host 重新登记可响应的 protocolRequestId。
    reannounceIntervalMs: INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS,
  };
}

function mapAskUserQuestion(question: AskUserQuestion): ZCodeUserInputQuestion {
  return {
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      description: option.description,
      label: option.label,
      preview: option.preview,
      value: option.label,
    })),
    question: question.question,
  };
}

function userInputResponseToBrokerResult(
  request: PermissionBrokerRequest,
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason:
        response.reason ??
        (response.action === "cancel"
          ? "AskUserQuestion was cancelled"
          : "AskUserQuestion was declined"),
      resolvedAt: new Date(),
    };
  }

  const input = isRecord(request.input) ? request.input : {};
  const content = normalizeAskUserQuestionResponseContent(input, response.content);
  return {
    decision: "modify",
    modifiedInput: {
      ...input,
      ...content,
    },
    reason: response.reason,
    resolvedAt: new Date(),
  };
}

function planApprovalResponseToBrokerResult(
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  const answer = normalizePlanApprovalAnswer(response.content);
  if (answer === EXIT_PLAN_MODE_APPROVAL_APPROVE) {
    return {
      decision: "allow",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  if (!answer) {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  return {
    decision: "deny",
    reason: answer,
    reasonSource: "plan_approval_feedback",
    resolvedAt: new Date(),
  };
}

function normalizePlanApprovalAnswer(
  content: Record<string, unknown> | undefined,
): string | undefined {
  if (!content) {
    return undefined;
  }
  const answers = isRecord(content.answers) ? content.answers : {};
  const answer = normalizeAnswerValue(
    answers[EXIT_PLAN_MODE_APPROVAL_QUESTION] ?? content.answer_0 ?? content.answer,
  )?.trim();
  return answer && answer.length > 0 ? answer : undefined;
}

function normalizeAskUserQuestionResponseContent(
  input: Record<string, unknown>,
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!content) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  const answers = normalizeAskUserQuestionAnswers(input, content);
  if (answers) {
    normalized.answers = answers;
  }

  const annotations = normalizeAskUserQuestionAnnotations(content.annotations);
  if (annotations) {
    normalized.annotations = annotations;
  }

  // UI 为兼容旧单题路径会同时提交 answer_0 / answer。
  // AskUserQuestionInputSchema 是 strict，直接把这些旧字段合并回 tool input 会触发
  // Tool input failed inputSchema validation，所以这里只保留 schema 明确允许的字段。
  return normalized;
}

function normalizeAskUserQuestionAnswers(
  input: Record<string, unknown>,
  content: Record<string, unknown>,
): Record<string, string> | undefined {
  const questionTexts = readAskUserQuestionTexts(input);
  if (questionTexts.length === 0) {
    return undefined;
  }

  const rawAnswers = isRecord(content.answers) ? content.answers : {};
  const answers: Record<string, string> = {};
  questionTexts.forEach((questionText, index) => {
    const rawAnswer =
      rawAnswers[questionText] ??
      content[`answer_${index}`] ??
      (questionTexts.length === 1 ? content.answer : undefined);
    const answer = normalizeAnswerValue(rawAnswer);
    if (answer !== undefined) {
      answers[questionText] = answer;
    }
  });

  // action=accept + content.answers={} 是 runtime 自动继续的显式成功语义；
  // 必须保留空对象，和 content 完全缺失（旧客户端批准但未提供答案）区分。
  if (isRecord(content.answers) && Object.keys(content.answers).length === 0) {
    return {};
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function createInteractionRegistrationOptions(
  request: PermissionBrokerRequest,
  kind: V4InteractionRegistrationOptions["kind"],
  context?: ZCodeProtocolAgentServerContext,
  initialAutoResolution?: V4InteractionRegistrationOptions["initialAutoResolution"],
): V4InteractionRegistrationOptions {
  return {
    sessionId: String(request.sessionId),
    kind,
    ...(initialAutoResolution ? { initialAutoResolution } : {}),
    ...(kind === "askUserQuestion" && context
      ? {
          onAutoResolutionUpdated: async (autoResolution) => {
            const record = context.sessions?.get(String(request.sessionId));
            if (!record) return;
            try {
              await record.app.runtime.recordUserInputAutoResolutionUpdate({
                interactionId: request.requestId,
                toolCallId: request.toolCallId,
                autoResolution,
                traceContext: {
                  ...record.traceContext,
                  traceId: request.traceId,
                  turnId: request.turnId,
                },
              });
            } catch (error) {
              context.logger?.error(
                "Failed to persist user input auto-resolution state",
                error instanceof Error ? error : new Error(String(error)),
                {
                  interactionId: request.requestId,
                  sessionId: request.sessionId,
                },
              );
            }
          },
        }
      : {}),
  };
}

/**
 * spec §3a.3/§3b.1（bot-permissions）：权限交互登记表选项装配（纯函数，持久化回调
 * 由调用方注入，便于单测钉住 kind/deadline 边界）——kind "permission" + 会话
 * permissionAutoDenyMs 作为 per-entry autoResolutionMs；重启恢复时附带持久化的
 * initialAutoResolution（绝对时间，登记表恢复同一 deadlineAt，不重置时钟）。
 */
export function buildPermissionInteractionRegistrationOptions(
  request: PermissionBrokerRequest,
  deadline: {
    permissionAutoDenyMs?: number;
    initialAutoResolution?: V4InteractionRegistrationOptions["initialAutoResolution"];
  } = {},
  onAutoResolutionUpdated?: V4InteractionRegistrationOptions["onAutoResolutionUpdated"],
): V4InteractionRegistrationOptions {
  return {
    sessionId: String(request.sessionId),
    kind: "permission",
    ...(deadline.permissionAutoDenyMs !== undefined
      ? { autoResolutionMs: deadline.permissionAutoDenyMs }
      : {}),
    ...(deadline.initialAutoResolution
      ? { initialAutoResolution: deadline.initialAutoResolution }
      : {}),
    ...(onAutoResolutionUpdated ? { onAutoResolutionUpdated } : {}),
  };
}

/**
 * spec §3a.3：deadline 事实源是 CLI session record（v4 createSession 写入的
 * permissionAutoDenyMs）；重启后 record 经 resume 重建不携带该值，倒计时恢复改由
 * 持久化 session entry 的绝对时间承担（两者并列，登记表侧 initialAutoResolution
 * 优先于重新武装）。
 * F2（spec §8.2.4 CLI resume 缺口，owner 决策 2026-10-06）：resume 重建 record 不带
 * deadline 字段时，回落读取会话级 permission-deadline entry（createSession 建档时经
 * host 钩子持久化，与 per-interaction permission-auto-resolution 条目同一 store/
 * overwrite 模式）——record 字段仍是建档主源，无 entry ⇒ 无倒计时（桌面/未配置
 * 语义不变，场景20b）；建档路径行为不变（场景20c）。
 */
const SESSION_ENTRY_PERMISSION_DEADLINE = "permission-deadline";

async function resolvePermissionDeadline(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
): Promise<{
  permissionAutoDenyMs?: number;
  initialAutoResolution?: V4InteractionRegistrationOptions["initialAutoResolution"];
}> {
  const sessionRecord = context.sessions.get(String(request.sessionId));
  const permissionAutoDenyMs =
    sessionRecord?.permissionAutoDenyMs ??
    (await readPersistedPermissionDeadline(context, request));
  const initialAutoResolution = await readPersistedAutoResolution(
    context,
    request,
    "permission",
  );
  return {
    ...(permissionAutoDenyMs !== undefined ? { permissionAutoDenyMs } : {}),
    ...(initialAutoResolution ? { initialAutoResolution } : {}),
  };
}

/**
 * F2（spec §8.2.4）：resume 形态 record 的 deadline 回落读取——会话级
 * permission-deadline entry 按 time.updated 取最新一条，data.permissionAutoDenyMs
 * 必须为正数；store 缺席/读取失败仅 warn 并返回 undefined（无倒计时，不阻断交互）。
 */
async function readPersistedPermissionDeadline(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
): Promise<number | undefined> {
  const sessionStore = context.deps?.sessionStore;
  if (!sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: request.sessionId,
      type: SESSION_ENTRY_PERMISSION_DEADLINE,
    });
    const latest = [...entries].sort((left, right) => right.time.updated - left.time.updated)[0];
    const value = latest && isRecord(latest.data) ? latest.data.permissionAutoDenyMs : undefined;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch (error) {
    context.logger?.warn("Failed to restore session permission deadline", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.permission_deadline_restore_failed",
      module: "bootstrap.zcode_protocol",
      sessionId: request.sessionId,
    });
    return undefined;
  }
}

/**
 * F2（spec §8.2.4）：会话级 deadline 持久化写入——v4 createSession 建档写入 record
 * 字段的同时经 host 钩子调用（单一写入方）。稳定 id ⇒ overwrite 语义（与
 * permission-auto-resolution:<requestId> 同模式）；写失败仅 warn：record 字段仍是
 * 本次进程内的主源，entry 只服务重启后 resume 的新提示。
 */
export async function persistSessionPermissionDeadlineEntry(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  permissionAutoDenyMs: number,
): Promise<void> {
  const sessionStore = context.deps?.sessionStore;
  if (!sessionStore?.saveSessionEntry) return;
  const now = Date.now();
  try {
    await sessionStore.saveSessionEntry({
      id: `${SESSION_ENTRY_PERMISSION_DEADLINE}:${sessionId}`,
      sessionID: sessionId as SessionId,
      type: SESSION_ENTRY_PERMISSION_DEADLINE,
      time: { created: now, updated: now },
      data: { permissionAutoDenyMs },
    });
  } catch (error) {
    context.logger?.warn("Failed to persist session permission deadline", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.permission_deadline_persist_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
    });
  }
}

/**
 * spec §3b.4：permission 倒计时持久化——与 askUserQuestion 同一 session-entry 覆写
 * 模式（按 interactionId 稳定 id，只保留最终状态）。deadline 是 bootstrap 会话概念
 * （v4 createSession 字段），不进 core 事件面，由 broker 直写 store；写失败仅 warn，
 * 不阻断交互（倒计时权威在登记表内存态，持久化只服务重启恢复）。
 */
function createPermissionAutoResolutionPersistence(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
): V4InteractionRegistrationOptions["onAutoResolutionUpdated"] {
  return async (autoResolution) => {
    const sessionStore = context.deps?.sessionStore;
    if (!sessionStore?.saveSessionEntry) return;
    try {
      await sessionStore.saveSessionEntry({
        id: `permission-auto-resolution:${request.requestId}`,
        sessionID: request.sessionId,
        type: SESSION_ENTRY_PERMISSION_AUTO_RESOLUTION,
        time: {
          created: autoResolution.startedAt,
          updated: Date.now(),
        },
        data: {
          interactionId: request.requestId,
          toolCallId: request.toolCallId,
          autoResolution,
          traceId: request.traceId,
          ...(request.turnId ? { turnId: request.turnId } : {}),
        },
      });
    } catch (error) {
      context.logger?.warn("Failed to persist permission auto-resolution state", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.permission_auto_resolution_persist_failed",
        interactionId: request.requestId,
        module: "bootstrap.zcode_protocol",
        sessionId: request.sessionId,
      });
    }
  };
}

async function readPersistedAutoResolution(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  scope: "userInput" | "permission" = "userInput",
): Promise<V4InteractionRegistrationOptions["initialAutoResolution"]> {
  const sessionStore = context.deps?.sessionStore;
  if (!sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: request.sessionId,
      type:
        scope === "permission"
          ? SESSION_ENTRY_PERMISSION_AUTO_RESOLUTION
          : SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
    });
    const matching = entries
      .filter((entry) => {
        const data = isRecord(entry.data) ? entry.data : {};
        return (
          data.interactionId === request.requestId &&
          String(data.toolCallId ?? "") === String(request.toolCallId)
        );
      })
      .sort((left, right) => right.time.updated - left.time.updated)[0];
    if (!matching || !isRecord(matching.data)) return undefined;
    return parsePersistedAutoResolution(matching.data.autoResolution);
  } catch (error) {
    context.logger?.warn("Failed to restore user input auto-resolution state", {
      error: error instanceof Error ? error.message : String(error),
      event:
        scope === "permission"
          ? "zcode_protocol.permission_auto_resolution_restore_failed"
          : "zcode_protocol.user_input_auto_resolution_restore_failed",
      interactionId: request.requestId,
      module: "bootstrap.zcode_protocol",
      sessionId: request.sessionId,
    });
    return undefined;
  }
}

function parsePersistedAutoResolution(
  value: unknown,
): V4InteractionRegistrationOptions["initialAutoResolution"] {
  if (!isRecord(value) || typeof value.startedAt !== "number") return undefined;
  if (
    (value.state === "hiddenGrace" || value.state === "visibleCountdown") &&
    typeof value.visibleAt === "number" &&
    typeof value.deadlineAt === "number"
  ) {
    return {
      state: value.state,
      startedAt: value.startedAt,
      visibleAt: value.visibleAt,
      deadlineAt: value.deadlineAt,
    };
  }
  if (value.state === "snoozed" && typeof value.snoozedAt === "number") {
    return {
      state: "snoozed",
      startedAt: value.startedAt,
      snoozedAt: value.snoozedAt,
    };
  }
  return undefined;
}

function readAskUserQuestionTexts(input: Record<string, unknown>): string[] {
  const questions = input.questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) =>
      isRecord(question) && typeof question.question === "string" ? question.question : undefined,
    )
    .filter((question): question is string => question !== undefined);
}

function normalizeAnswerValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    // 旧客户端曾用空字符串表示跳过；统一丢弃 blank，避免其进入
    // answers 后被 core 当作用户偏好。非空答案同时在协议边界去除外围空白。
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
      .join(", ");
  }
  return undefined;
}

function normalizeAskUserQuestionAnnotations(
  value: unknown,
): Record<string, { preview?: string; notes?: string }> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([question, annotation]) => {
      if (!isRecord(annotation)) {
        return undefined;
      }
      const normalizedAnnotation = {
        ...(typeof annotation.preview === "string" ? { preview: annotation.preview } : {}),
        ...(typeof annotation.notes === "string" ? { notes: annotation.notes } : {}),
      };
      return Object.keys(normalizedAnnotation).length > 0
        ? ([question, normalizedAnnotation] as const)
        : undefined;
    })
    .filter(
      (entry): entry is readonly [string, { preview?: string; notes?: string }] =>
        entry !== undefined,
    );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
