import { create } from "zustand";
import { logger } from "@/logger.js";

// ============================================================
// 设置页 MCP 区「运行时环境」卡（alpha.2 A2′/D2）的 renderer store
// ============================================================
//
// specs/agent-runtimes.md §4.6/§4.7（生命周期矩阵 + A2′ 实现契约）+ alpha2-plan D2：
// 卡内容 = 已装版本（CURRENT）+ 可用上游版本 + 最近验证结果 + 探测摘要（五类工件
// × 候选延迟排名）+ 操作（安装/检查更新/重新验证/删除）+ 镜像切换（写 overrides）。
// 服务经 module-level DI 注入（mcpStore 的 setMcpStorePlatform 先例）；卡经
// useBaseWorkspaceServices()（本机全局事实源）取数，状态不进 TUI 局部态。
// 运行时 = 机器全局（非 workspace-scoped），无 workspace-key 守卫。

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
  /** F5（§4.7）：全局「使用镜像」开关投影（服务 runtimeJson.useMirrors；缺省 true）。 */
  readonly useMirrors?: boolean;
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
  readonly error: string | null;
  /** 镜像切换：写 overrides（override 优先于探测决策，§4.7）。 */
  setMirrorOverride(artifactClass: RuntimeArtifactClass, candidate: string): Promise<void>;
  clearMirrorOverride(artifactClass: RuntimeArtifactClass): Promise<void>;
  refreshStatus(): Promise<void>;
  installRuntime(kind: RuntimeKind): Promise<void>;
  removeRuntime(kind: RuntimeKind): Promise<void>;
}

function appendProgress(
  progress: readonly RuntimeProgressEvent[],
  event: RuntimeProgressEvent,
): readonly RuntimeProgressEvent[] {
  // 进度事件有界（最近 200 条），防长安装流无限增长。
  return [...progress, event].slice(-200);
}

export const useRuntimeStore = create<RuntimeCardState>()((set, get) => ({
  status: null,
  installing: null,
  progress: [],
  error: null,

  setMirrorOverride: async (artifactClass, candidate) => {
    const service = runtimeStoreService;
    if (!service) {
      logger.warn("[runtimeStore] setMirrorOverride without service seam");
      return;
    }
    // F4（§4.7）：error 只在新动作开始时清（install start 同形制），成功路径不清。
    set({ error: null });
    try {
      await service.setMirrorOverride(artifactClass, candidate);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
    await get().refreshStatus();
  },

  clearMirrorOverride: async (artifactClass) => {
    const service = runtimeStoreService;
    if (!service) {
      logger.warn("[runtimeStore] clearMirrorOverride without service seam");
      return;
    }
    // F4（§4.7）：同上——新动作开始时才清 error。
    set({ error: null });
    try {
      await service.setMirrorOverride(artifactClass, null);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
    await get().refreshStatus();
  },

  refreshStatus: async () => {
    const service = runtimeStoreService;
    if (!service) {
      return;
    }
    try {
      const status = await service.getRuntimeStatus();
      // F4（§4.7 错误呈现契约）：成功刷新只写快照、保留既有 error——错误常驻
      // 至下一动作开始（新动作 start 才清），不得让失败错误只存活一个异步 tick。
      set({ status });
    } catch (error) {
      // 状态读取失败不清空已有快照（陈旧好过空白），只记错误供卡内呈现。
      set({ error: String(error) });
    }
  },

  installRuntime: async (kind) => {
    const service = runtimeStoreService;
    if (!service) {
      logger.warn("[runtimeStore] installRuntime without service seam");
      return;
    }
    if (get().installing) {
      return;
    }
    set((state) => ({
      installing: kind,
      progress: appendProgress(state.progress, { kind, phase: "start", atMs: Date.now() }),
      error: null,
    }));
    try {
      await service.installRuntime(kind);
      set((state) => ({
        progress: appendProgress(state.progress, { kind, phase: "done", atMs: Date.now() }),
      }));
    } catch (error) {
      // F4/MINOR-14（§4.7 选定机制 = rethrow）：失败记账（progress/error）后必须
      // rethrow——与 setMirrorOverride/removeRuntime 同形制；catch 吞掉会使卡侧
      // .catch 成死代码（成败同日志 "install done" 的根因）。finally 的
      // refreshStatus 照常执行，且其成功路径不再擦掉此处 error（见上 F4）。
      set((state) => ({
        progress: appendProgress(state.progress, { kind, phase: "failed", atMs: Date.now() }),
        error: String(error),
      }));
      throw error;
    } finally {
      set({ installing: null });
      await get().refreshStatus();
    }
  },

  removeRuntime: async (kind) => {
    const service = runtimeStoreService;
    if (!service) {
      logger.warn("[runtimeStore] removeRuntime without service seam");
      return;
    }
    // F4（§4.7）：同 setMirrorOverride——新动作开始时才清 error。
    set({ error: null });
    try {
      await service.removeRuntime(kind);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
    await get().refreshStatus();
  },
}));
