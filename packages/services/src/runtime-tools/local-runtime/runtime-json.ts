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

/**
 * F6（alpha.3，§4.7 填充类失败降级 + plan §9 MINOR-13 类型涟漪）：decisions 值允许
 * **缺席**（键删 = 不填空，不保 stale 镜像值）——填充类探测 all-dead 时合并删除
 * 该键；读端容错（缺键 = 不填），effective 投影对缺席 = undefined → L3/Bash 不填。
 * Partial 形制与 overrides 同构（省略/delete 皆合法；spread 只携带在场键）。
 */
export type AppRuntimeDecisions = Partial<Record<AppRuntimeArtifactClass, string>>;

/**
 * F6（alpha.3，§4.1 规则 4 类域限定）：「全灭→报错」仅适用**安装相关类**
 * （nodeDist/uvRelease——all-dead = 中止安装，语义不变）；**填充类**
 * （pypiIndex/npmRegistry/pbsMirror）all-dead = warn + decisions 键删（§4.7
 * F6 键删语义），安装照常（不连累安装）。install 探测轮（runProbeRound）与
 * service.probeMirrors 两处同形消费本分域。
 */
export const FILLER_RUNTIME_ARTIFACT_CLASSES: readonly AppRuntimeArtifactClass[] = [
  "pypiIndex",
  "npmRegistry",
  "pbsMirror",
];

export function isFillerRuntimeArtifactClass(artifactClass: AppRuntimeArtifactClass): boolean {
  return FILLER_RUNTIME_ARTIFACT_CLASSES.includes(artifactClass);
}

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
  /**
   * F5（alpha.3，§4.7）：全局镜像开关的唯一持久状态（卡内 Switch 写入）。
   * additive 可选字段，**缺省 true = 现行为**；读端容错不猜——非布尔/缺席
   * 一律按缺省 true 处理（投影判 `=== false`）。
   */
  readonly useMirrors?: boolean;
}

/**
 * F5（alpha.3，§4.7 D1）：OFF 投影的全类 origin id（「不用镜像」=「用官方」）。
 * 与 probe.ts MIRROR_CANDIDATE_TABLES 的 isOrigin 候选同源（id 即取值域）；
 * 供 resolveEffectiveDecisions 唯一投影与 buildCandidateLadder origin-only
 * 梯次（MAJOR-1）共用，避免双表漂移。
 *
 * 注：显式标注全键在场的 Record（非 Partial<AppRuntimeDecisions>）——OFF 投影
 * 与 origin-only 梯次的消费端需要 string（F6 键删语义不适用于本常量）。
 */
export const APP_RUNTIME_ORIGIN_DECISIONS: Readonly<Record<AppRuntimeArtifactClass, string>> = {
  nodeDist: "nodejs.org",
  uvRelease: "github.com",
  pypiIndex: "pypi.org",
  npmRegistry: "registry.npmjs.org",
  pbsMirror: "github.com",
};

/** `<config>/.runtime/runtime.json`（与 C3 L3 读取同源：getDataBaseDir/ZCODE_DATA_BASE_DIR 解析）。 */
export function resolveAppRuntimeJsonPath(): string {
  return join(getZCodeDataRootDir(), ".runtime", "runtime.json");
}

/** `<config>/.runtime`（node/uv 版本目录的父根）。 */
export function resolveAppRuntimeRootDir(): string {
  return join(getZCodeDataRootDir(), ".runtime");
}

/**
 * effective decision = override ?? probed（§4.7）。
 *
 * F5（alpha.3，§4.7 投影唯一/D1）：`useMirrors === false`（显式 OFF；缺省/
 * 非布尔 = true 现行为）→ **全类** effective = origin id，无视 decisions/
 * overrides——下载选路、L3/Bash 填空、卡片显示全部消费本投影（单一事实源，
 * 不出现「开关关了、下载还走镜像」的分裂）。overrides 被压制但**不删**
 * （ON 恢复即生效；压制期间 override 源硬失败规则不武装）。
 *
 * F6（alpha.3，§4.7）：probed 键缺席（填充类 all-dead 键删）= 原样透传 undefined
 * （override ?? undefined = undefined）——读端容错缺键 = 不填，不猜默认镜像。
 */
export function resolveEffectiveDecisions(json: AppRuntimeJson): AppRuntimeDecisions {
  if (json.useMirrors === false) {
    return { ...APP_RUNTIME_ORIGIN_DECISIONS };
  }
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
