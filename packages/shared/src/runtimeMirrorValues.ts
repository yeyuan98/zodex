/**
 * specs/agent-runtimes.md §2.5 L3（镜像缺省填空）/§4.7（effective decision）共享取值表：
 * runtime.json 的 decisions/overrides 存候选 **id**（W5 probe.ts MIRROR_CANDIDATE_TABLES
 * 的取值域），而 L3 填空与 Bash 腿填空需要**环境变量值（URL）**。adapters 不依赖
 * services（§2.5 `<config>` 解析同源约束），因此该 id→URL 投影表放在 shared，
 * 两腿共用一份，避免候选 id 与填空 URL 双表漂移。
 *
 * 取值与 services `runtime-tools/local-runtime/probe.ts` 候选表的 buildProbeUrl
 * 同源（origin 部分即填空 URL）；新增候选时两处同步。
 */

/** 填空相关的三个工件类（nodeDist/uvRelease 不参与 env 填空）。 */
export type RuntimeMirrorFillClass = "npmRegistry" | "pypiIndex" | "pbsMirror";

/** 候选 id → 环境变量填空值（URL）。 */
export const RUNTIME_MIRROR_ENV_VALUES: Readonly<
  Record<RuntimeMirrorFillClass, Readonly<Record<string, string>>>
> = {
  npmRegistry: {
    "registry.npmjs.org": "https://registry.npmjs.org",
    "registry.npmmirror.com": "https://registry.npmmirror.com",
  },
  pypiIndex: {
    "pypi.org": "https://pypi.org/simple",
    tuna: "https://pypi.tuna.tsinghua.edu.cn/simple",
    aliyun: "https://mirrors.aliyun.com/pypi/simple",
    tencent: "https://mirrors.cloud.tencent.com/pypi/simple",
  },
  pbsMirror: {
    "registry.npmmirror.com": "https://registry.npmmirror.com/-/binary/python-build-standalone",
    "github.com": "https://github.com/astral-sh/python-build-standalone/releases/download",
  },
};

/** 三个填空键各自的环境变量名（§4.4：npm 键小写优先）。 */
export const RUNTIME_MIRROR_ENV_KEYS: Readonly<Record<RuntimeMirrorFillClass, string>> = {
  npmRegistry: "npm_config_registry",
  pypiIndex: "UV_DEFAULT_INDEX",
  pbsMirror: "UV_PYTHON_INSTALL_MIRROR",
};

export interface RuntimeMirrorFillDecision {
  readonly npmRegistry?: string;
  readonly pypiIndex?: string;
  readonly pbsMirror?: string;
}

/**
 * 候选 id 决策 → 填空值投影：id 不在取值表内（手改 runtime.json 的自定义值）时
 * 原样透传——尊重 `--base` 手工覆盖位语义（§4.1 规则 4），不静默丢弃。
 */
export function resolveRuntimeMirrorEnvValues(
  decision: RuntimeMirrorFillDecision,
): RuntimeMirrorFillDecision {
  const project = (artifactClass: RuntimeMirrorFillClass): string | undefined => {
    const candidateId = decision[artifactClass];
    if (candidateId === undefined) return undefined;
    return RUNTIME_MIRROR_ENV_VALUES[artifactClass][candidateId] ?? candidateId;
  };
  const npmRegistry = project("npmRegistry");
  const pypiIndex = project("pypiIndex");
  const pbsMirror = project("pbsMirror");
  return {
    ...(npmRegistry !== undefined ? { npmRegistry } : {}),
    ...(pypiIndex !== undefined ? { pypiIndex } : {}),
    ...(pbsMirror !== undefined ? { pbsMirror } : {}),
  };
}
