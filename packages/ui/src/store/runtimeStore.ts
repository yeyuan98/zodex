import { create } from "zustand";

// ============================================================
// 设置页 MCP 区「运行时环境」卡（alpha.2 A2′/D2）的 renderer store
// ============================================================
//
// specs/agent-runtimes.md §4.6/§4.7（生命周期矩阵 + A2′ 实现契约）+ alpha2-plan D2：
// 卡内容 = 已装版本（CURRENT）+ 可用上游版本 + 最近验证结果 + 探测摘要（五类工件
// × 候选延迟排名）+ 操作（安装/检查更新/重新验证/删除）+ 镜像切换（写 overrides）。
// 服务经 module-level DI 注入（mcpStore 的 setMcpStorePlatform 先例）；卡经
// useBaseWorkspaceServices()（本机全局事实源）取数，状态不进 TUI 局部态。
//
// TODO(W6)：当前为 W1 红测桩——store 初始态 + no-op action，零行为。

export type RuntimeArtifactClass =
  | "nodeDist"
  | "uvRelease"
  | "pypiIndex"
  | "npmRegistry"
  | "pbsMirror";

export type RuntimeKind = "node" | "uv";

export interface RuntimeMirrorRankingRow {
  readonly candidate: string;
  readonly httpCode: number;
  readonly latencyMs: number;
  readonly ok: boolean;
}

/** 卡片状态快照（refreshStatus 的派生源）。 */
export interface RuntimeStatusSnapshot {
  readonly installed: { readonly node: string | null; readonly uv: string | null };
  readonly available: { readonly node: readonly string[]; readonly uv: readonly string[] };
  readonly lastVerify: { readonly node: string | null; readonly uv: string | null };
  readonly probeRanking: Partial<Record<RuntimeArtifactClass, readonly RuntimeMirrorRankingRow[]>>;
}

/** 安装/删除流的进度事件（经 store 事件面向卡内进度呈现）。 */
export interface RuntimeProgressEvent {
  readonly kind: RuntimeKind;
  readonly phase: string;
  readonly atMs: number;
}

/** 运行时卡服务 seam（DI 注入；实现位于 services/host 侧，W5/W6 落地）。 */
export interface RuntimeStoreService {
  getRuntimeStatus(): Promise<RuntimeStatusSnapshot>;
  setMirrorOverride(artifactClass: RuntimeArtifactClass, candidate: string | null): Promise<void>;
  installRuntime(kind: RuntimeKind): Promise<void>;
  removeRuntime(kind: RuntimeKind): Promise<void>;
}

let runtimeStoreService: RuntimeStoreService | null = null;

export function setRuntimeStoreService(service: RuntimeStoreService | null): void {
  runtimeStoreService = service;
}

export function getRuntimeStoreService(): RuntimeStoreService | null {
  return runtimeStoreService;
}

interface RuntimeCardState {
  readonly status: RuntimeStatusSnapshot | null;
  readonly installing: RuntimeKind | null;
  readonly progress: readonly RuntimeProgressEvent[];
  /** 镜像切换：写 overrides（override 优先于探测决策，§4.7）。 */
  setMirrorOverride(artifactClass: RuntimeArtifactClass, candidate: string): Promise<void>;
  clearMirrorOverride(artifactClass: RuntimeArtifactClass): Promise<void>;
  refreshStatus(): Promise<void>;
  installRuntime(kind: RuntimeKind): Promise<void>;
  removeRuntime(kind: RuntimeKind): Promise<void>;
}

export const useRuntimeStore = create<RuntimeCardState>()(() => ({
  status: null,
  installing: null,
  progress: [],
  // TODO(W6)：接线服务调用、进度事件与错误呈现。
  setMirrorOverride: async () => {},
  clearMirrorOverride: async () => {},
  refreshStatus: async () => {},
  installRuntime: async () => {},
  removeRuntime: async () => {},
}));
