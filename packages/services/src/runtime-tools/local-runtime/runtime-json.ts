/**
 * specs/agent-runtimes.md §4.1（固化与复用）/§4.7（A2′ 实现契约）纯函数契约：
 * app 级 runtime.json = 决策与状态唯一持久层。effective decision = override ??
 * probed；重探触发只作用于无 override 的决策位；tmp+rename 原子写 + 读端容错
 * （缺失/损坏 = treat-as-absent，不猜）；更新顺序不变量（新目录→runtime.json→
 * CURRENT→GC）；override 源硬失败 = 明确报错 + 保留 override。
 *
 * TODO(W5)：当前为 W1 红测桩——零行为，仅锁定签名与语义。
 */

export type AppRuntimeArtifactClass =
  | "nodeDist"
  | "uvRelease"
  | "pypiIndex"
  | "npmRegistry"
  | "pbsMirror";

export type AppRuntimeDecisions = Record<AppRuntimeArtifactClass, string>;

export interface AppRuntimeMirrorMeasurement {
  readonly candidate: string;
  readonly httpCode: number;
  readonly latencyMs: number;
  readonly ok: boolean;
}

/** app 级 runtime.json schema（§4.7：§4.1 基础上另含 overrides 与 pinned）。 */
export interface AppRuntimeJson {
  readonly probedAt: string;
  readonly ttlDays: number;
  readonly decisions: AppRuntimeDecisions;
  /** 用户切换项（卡内镜像切换写入）；同形，优先于探测决策。 */
  readonly overrides?: Partial<AppRuntimeDecisions>;
  readonly measurements: readonly AppRuntimeMirrorMeasurement[];
  readonly pinned: { readonly node: string; readonly uv: string };
}

/** effective decision = override ?? probed（§4.7）。 */
export function resolveEffectiveDecisions(json: AppRuntimeJson): AppRuntimeDecisions {
  // TODO(W5)：stub 不应用 override（直接返回 probed 决策）。
  return { ...json.decisions };
}

/**
 * 重探槽位：TTL（probedAt 超 ttlDays）/ 显式 force → 需要重探的工件类集合，
 * **只含无 override 的决策位**（§4.7）。
 */
export function resolveReprobeSlots(
  json: AppRuntimeJson,
  options: { readonly nowMs: number; readonly force?: boolean },
): AppRuntimeArtifactClass[] {
  // TODO(W5)
  void options;
  void json;
  return [];
}

/** 原子写：`runtime.json.tmp*` → rename（L3 每 spawn 解析，半写 JSON 不可见）。 */
export function writeAppRuntimeJson(filePath: string, json: AppRuntimeJson): void {
  // TODO(W5)
  void filePath;
  void json;
}

/**
 * 读端容错（与 CURRENT 同规）：缺失/损坏 → null（treat-as-absent + warn，不猜）。
 */
export function readAppRuntimeJson(filePath: string): AppRuntimeJson | null {
  // TODO(W5)
  void filePath;
  return null;
}

export type UpdateOrderingStep = "version-dir" | "runtime-json" | "current" | "gc";

/**
 * 更新顺序不变量（§4.7 写读契约 (iii)）：新 `v<ver>/` 目录就绪 → 写 runtime.json
 * （pinned）→ CURRENT 原子换指针 → 旧目录 GC。steps 为数据校验输入。
 */
export function validateUpdateOrdering(steps: readonly UpdateOrderingStep[]): {
  readonly ok: boolean;
  readonly firstOutOfOrder?: UpdateOrderingStep;
} {
  // TODO(W5)
  void steps;
  return { ok: true };
}

/**
 * override 源硬失败处置（§4.7 写读契约 (iv)）：**明确报错 + 保留 override**，
 * 绝不静默回落到用户已弃用的源（error 非空；json 的 overrides 原样保留）。
 */
export function applyOverrideSourceHardFailure(
  json: AppRuntimeJson,
  failedClass: AppRuntimeArtifactClass,
): {
  readonly json: AppRuntimeJson;
  readonly error: string;
} {
  // TODO(W5)：stub 返回原 json（保留 override），error 为空（红测位）。
  void failedClass;
  return { json, error: "" };
}
