/**
 * 「运行时环境」卡（RuntimeEnvironmentCard）的非 JSX 辅助：常量、状态形状、
 * 探测排名投影与 store 服务适配（ILocalRuntimeService → RuntimeStoreService）。
 */
import type { ILocalRuntimeService } from "@zcode/services";
import type {
  RuntimeArtifactClass,
  RuntimeKind,
  RuntimeMirrorRankingRow,
} from "@/store/runtimeStore.js";

/** 五类工件 × 镜像切换/排名展示顺序（install 相关两类在前）。 */
export const RUNTIME_ARTIFACT_CLASS_ORDER: readonly RuntimeArtifactClass[] = [
  "nodeDist",
  "uvRelease",
  "npmRegistry",
  "pypiIndex",
  "pbsMirror",
];

export const RUNTIME_KINDS: readonly RuntimeKind[] = ["node", "uv"];

/** Select 的 auto 占位值（真实候选 id 不会以 __ 开头）。 */
export const MIRROR_AUTO_VALUE = "__auto";

export interface UpdateCheckState {
  readonly latest: string;
  readonly updateAvailable: boolean;
}

export interface ReverifyState {
  readonly ok: boolean;
  readonly version: string | null;
}

export interface MirrorSelectionState {
  /** effective decision（override ?? probed），id 形态。 */
  readonly effective: Partial<Record<RuntimeArtifactClass, string>>;
  /** 用户 override 位（id 形态；缺席 = auto）。 */
  readonly overrides: Partial<Record<RuntimeArtifactClass, string>>;
}

/** listMirrorCandidates 的卡内状态形状（五类工件 → 候选表）。 */
export type MirrorCandidateMap = Readonly<
  Record<string, readonly { id: string; isOrigin: boolean }[]>
>;

/** MirrorSelectionState 的空态初始值（卡内 useState 种子）。 */
export const EMPTY_MIRROR_SELECTION: MirrorSelectionState = { effective: {}, overrides: {} };

/** owner ③(2)：服务快照 → 卡内镜像选择状态（effective + overrides 投影）。 */
export function extractMirrorSelection(snapshot: {
  readonly effectiveDecisions?: unknown;
  readonly runtimeJson?: { readonly overrides?: unknown } | null;
}): MirrorSelectionState {
  return {
    effective: (snapshot.effectiveDecisions ?? {}) as MirrorSelectionState["effective"],
    overrides: (snapshot.runtimeJson?.overrides ?? {}) as MirrorSelectionState["overrides"],
  };
}

export function buildProbeRanking(
  measurements:
    | readonly {
        readonly candidate: string;
        readonly httpCode: number;
        readonly latencyMs: number;
        readonly ok: boolean;
        readonly artifactClass?: string;
      }[]
    | undefined,
): Partial<Record<RuntimeArtifactClass, readonly RuntimeMirrorRankingRow[]>> {
  if (!measurements) return {};
  const grouped = new Map<RuntimeArtifactClass, RuntimeMirrorRankingRow[]>();
  for (const entry of measurements) {
    if (!entry.artifactClass) continue;
    const artifactClass = entry.artifactClass as RuntimeArtifactClass;
    const rows = grouped.get(artifactClass) ?? [];
    rows.push({
      candidate: entry.candidate,
      httpCode: entry.httpCode,
      latencyMs: entry.latencyMs,
      ok: entry.ok,
    });
    grouped.set(artifactClass, rows);
  }
  const ranking: Partial<Record<RuntimeArtifactClass, readonly RuntimeMirrorRankingRow[]>> = {};
  for (const [artifactClass, rows] of grouped) {
    // 排名展示：可用者按延迟升序，不可用者殿后（稳定排序）；可用性同时以文字
    // 呈现（延迟 vs 不可用），不依赖颜色单独传达状态（a11y）。
    ranking[artifactClass] = rows.toSorted((left, right) => {
      if (left.ok !== right.ok) return left.ok ? -1 : 1;
      return left.latencyMs - right.latencyMs;
    });
  }
  return ranking;
}

export function makeRuntimeCardStoreService(service: ILocalRuntimeService) {
  return {
    getRuntimeStatus: async () => {
      const snapshot = await service.status();
      return {
        installed: snapshot.current,
        // 可用上游版本与最近验证结果由显式「检查更新 / 重新验证」动作填充
        // （上游解析是网络操作，不随卡片挂载自动触发——D2 更新语义不随 app 版本）。
        available: { node: [] as const, uv: [] as const },
        lastVerify: { node: null, uv: null },
        probeRanking: buildProbeRanking(snapshot.runtimeJson?.measurements),
        // F5（§4.7 useMirrors schema）：全局「使用镜像」开关的状态源——从服务
        // runtimeJson.useMirrors 投影；仅显式 false 为 OFF，缺省/非布尔 = true
        // （与服务侧 useMirrors === false 的 OFF 判定同义）。纯投影，开关本体 W-B。
        useMirrors: snapshot.runtimeJson?.useMirrors !== false,
      };
    },
    setMirrorOverride: async (artifactClass: RuntimeArtifactClass, candidate: string | null) => {
      if (candidate === null) {
        await service.clearMirrorOverride(artifactClass);
        return;
      }
      await service.setMirrorOverride(artifactClass, candidate);
    },
    // W-B1 收口（§4.7 F5）：Switch 写入腿接线——port 的 setUseMirrors 已翻必选。
    setUseMirrors: async (useMirrors: boolean) => {
      await service.setUseMirrors(useMirrors);
    },
    // owner ③(4)/§4.6 F5：手动 Probe 委托（force 由 store 动作传入）——结果快照
    // 不在此消费，经 refreshStatus → status().runtimeJson.measurements →
    // buildProbeRanking 流入排名数据（纯展示腿，§4.7 MINOR-6）。
    probeMirrors: async (options?: { readonly force?: boolean }) => {
      await service.probeMirrors(options);
    },
    installRuntime: async (kind: RuntimeKind) => {
      await service.install(kind);
    },
    removeRuntime: async (kind: RuntimeKind) => {
      await service.remove(kind);
    },
  };
}
