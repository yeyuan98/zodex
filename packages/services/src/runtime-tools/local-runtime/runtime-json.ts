/**
 * specs/agent-runtimes.md §4.1（固化与复用）/§4.7（A2′ 实现契约）TS 实现：
 * app 级 runtime.json = 决策与状态唯一持久层（`<config>/.runtime/runtime.json`）。
 * effective decision = override ?? probed；重探触发只作用于无 override 的决策位；
 * tmp+rename 原子写 + 读端容错（缺失/损坏 = treat-as-absent，不猜）；更新顺序
 * 不变量（新目录→runtime.json→CURRENT→GC）；override 源硬失败 = 明确报错 +
 * 保留 override。
 *
 * 同步 IO 说明：读端与 CURRENT 同规、供 L3 每 spawn 同步解析（§2.5 accessSync
 * 先例）；写端同步 tmp+rename 保证原子可见（W5 测试契约为同步调用形）。
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getZCodeDataRootDir } from "../../paths.js";

const DAY_MS = 24 * 3600_000;

export type AppRuntimeArtifactClass =
  | "nodeDist"
  | "uvRelease"
  | "pypiIndex"
  | "npmRegistry"
  | "pbsMirror";

export const APP_RUNTIME_ARTIFACT_CLASSES: readonly AppRuntimeArtifactClass[] = [
  "nodeDist",
  "uvRelease",
  "pypiIndex",
  "npmRegistry",
  "pbsMirror",
];

export type AppRuntimeDecisions = Record<AppRuntimeArtifactClass, string>;

export interface AppRuntimeMirrorMeasurement {
  readonly candidate: string;
  readonly httpCode: number;
  readonly latencyMs: number;
  readonly ok: boolean;
  /** 归属工件类（A2′ 附加标注：schema 基础上的 additive 字段，供次优顺位重建）。 */
  readonly artifactClass?: AppRuntimeArtifactClass;
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

/** `<config>/.runtime/runtime.json`（与 C3 L3 读取同源：getDataBaseDir/ZCODE_DATA_BASE_DIR 解析）。 */
export function resolveAppRuntimeJsonPath(): string {
  return join(getZCodeDataRootDir(), ".runtime", "runtime.json");
}

/** `<config>/.runtime`（node/uv 版本目录的父根）。 */
export function resolveAppRuntimeRootDir(): string {
  return join(getZCodeDataRootDir(), ".runtime");
}

/** effective decision = override ?? probed（§4.7）。 */
export function resolveEffectiveDecisions(json: AppRuntimeJson): AppRuntimeDecisions {
  return {
    nodeDist: json.overrides?.nodeDist ?? json.decisions.nodeDist,
    uvRelease: json.overrides?.uvRelease ?? json.decisions.uvRelease,
    pypiIndex: json.overrides?.pypiIndex ?? json.decisions.pypiIndex,
    npmRegistry: json.overrides?.npmRegistry ?? json.decisions.npmRegistry,
    pbsMirror: json.overrides?.pbsMirror ?? json.decisions.pbsMirror,
  };
}

function isProbedAtExpired(json: AppRuntimeJson, nowMs: number): boolean {
  const probedAtMs = Date.parse(json.probedAt);
  if (!Number.isFinite(probedAtMs)) return true;
  return nowMs - probedAtMs > json.ttlDays * DAY_MS;
}

/**
 * 重探槽位：TTL（probedAt 超 ttlDays）/ 显式 force → 需要重探的工件类集合，
 * **只含无 override 的决策位**（§4.7）。
 */
export function resolveReprobeSlots(
  json: AppRuntimeJson,
  options: { readonly nowMs: number; readonly force?: boolean },
): AppRuntimeArtifactClass[] {
  if (!options.force && !isProbedAtExpired(json, options.nowMs)) {
    return [];
  }
  return APP_RUNTIME_ARTIFACT_CLASSES.filter(
    (artifactClass) => json.overrides?.[artifactClass] === undefined,
  );
}

function nextTmpSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** 原子写：`runtime.json.tmp*` → rename（L3 每 spawn 解析，半写 JSON 不可见）。 */
export function writeAppRuntimeJson(filePath: string, json: AppRuntimeJson): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${nextTmpSuffix()}`;
  writeFileSync(tmpPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读端容错（与 CURRENT 同规）：缺失/损坏 → null（treat-as-absent + warn，不猜）。
 * 形状校验只做最小必要（probedAt 字符串 + decisions 对象），垃圾 JSON = null。
 */
export function readAppRuntimeJson(filePath: string): AppRuntimeJson | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  if (typeof parsed.probedAt !== "string" || !isPlainRecord(parsed.decisions)) return null;
  return parsed as unknown as AppRuntimeJson;
}

export type UpdateOrderingStep = "version-dir" | "runtime-json" | "current" | "gc";

const CANONICAL_UPDATE_ORDERING: readonly UpdateOrderingStep[] = [
  "version-dir",
  "runtime-json",
  "current",
  "gc",
];

/**
 * 更新顺序不变量（§4.7 写读契约 (iii)）：新 `v<ver>/` 目录就绪 → 写 runtime.json
 * （pinned）→ CURRENT 原子换指针 → 旧目录 GC。steps 为数据校验输入。
 */
export function validateUpdateOrdering(steps: readonly UpdateOrderingStep[]): {
  readonly ok: boolean;
  readonly firstOutOfOrder?: UpdateOrderingStep;
} {
  for (let index = 0; index < CANONICAL_UPDATE_ORDERING.length; index += 1) {
    const expected = CANONICAL_UPDATE_ORDERING[index];
    const actual = steps[index];
    if (actual !== expected) {
      return typeof actual === "string" ? { ok: false, firstOutOfOrder: actual } : { ok: false };
    }
  }
  return steps.length === CANONICAL_UPDATE_ORDERING.length
    ? { ok: true }
    : { ok: false, firstOutOfOrder: steps[CANONICAL_UPDATE_ORDERING.length] };
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
  const overrideValue = json.overrides?.[failedClass];
  return {
    json,
    error:
      `镜像 override 源硬失败：${failedClass}` +
      `${overrideValue ? `（override = ${overrideValue}）` : ""}；` +
      "override 已原样保留、绝不静默回落到已弃用源；请在运行时卡更换 override 候选或稍后重试",
  };
}
