/**
 * specs/agent-runtimes.md §4.6/§4.7「运行时环境」卡的服务端口（RPC seam）：
 * 类型 + descriptor 定义为 browser-safe（无 node 依赖），供 renderer 经
 * base/local workspace services 消费；实现在 services node 入口
 * （LocalRuntimeServiceImpl，W5）注册。快照/结果类型均为纯 JSON（RPC 可序列化）。
 */
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../../descriptors.js";
import type { LocalRuntimeProbeSnapshot, LocalRuntimeStatusSnapshot } from "./service.js";
import type {
  LocalRuntimeInstallResult,
  LocalRuntimeReverifyResult,
  LocalRuntimeUpdateCheck,
} from "./shared.js";

export type LocalRuntimeArtifactClassId =
  | "nodeDist"
  | "uvRelease"
  | "pypiIndex"
  | "npmRegistry"
  | "pbsMirror";

export type LocalRuntimeKindId = "node" | "uv";

/** 镜像候选描述（候选表纯数据投影；id 即 runtime.json decisions/overrides 取值域）。 */
export interface LocalRuntimeMirrorCandidateInfo {
  readonly id: string;
  readonly isOrigin: boolean;
}

/** UI 卡消费面：方法全为 Promise 形（RPC 代理）；进度事件为 store 侧本地派生。 */
export interface ILocalRuntimeService {
  install(kind: LocalRuntimeKindId): Promise<LocalRuntimeInstallResult>;
  checkUpdate(kind: LocalRuntimeKindId): Promise<LocalRuntimeUpdateCheck>;
  remove(kind: LocalRuntimeKindId): Promise<void>;
  reverify(kind: LocalRuntimeKindId): Promise<LocalRuntimeReverifyResult>;
  status(): Promise<LocalRuntimeStatusSnapshot>;
  /** 卡内镜像切换：写 overrides（§4.7 override 优先于探测决策）+ 该类连通重探。 */
  setMirrorOverride(artifactClass: LocalRuntimeArtifactClassId, candidateId: string): Promise<void>;
  /** 清除 override（回落探测决策）。 */
  clearMirrorOverride(artifactClass: LocalRuntimeArtifactClassId): Promise<void>;
  /** 显式 refresh 探测（只作用于无 override 位）并持久化，返回排名快照。 */
  probeMirrors(options?: { readonly force?: boolean }): Promise<LocalRuntimeProbeSnapshot>;
  /** 五类工件候选表（纯数据，供卡的镜像切换下拉）。 */
  listMirrorCandidates(): Promise<
    Readonly<Record<LocalRuntimeArtifactClassId, readonly LocalRuntimeMirrorCandidateInfo[]>>
  >;
  /**
   * 卡内「使用镜像」Switch 写 useMirrors（§4.7 F5：全局镜像开关的唯一持久状态）。
   * W-B2 卡片腿已接线（node.ts RPC 委托 + helpers 适配器），本端口方法必选。
   */
  setUseMirrors(useMirrors: boolean): Promise<void>;
}

export const ILocalRuntimeService = createServiceDescriptor<ILocalRuntimeService>(
  ServiceChannels.LocalRuntime,
);

export type {
  LocalRuntimeInstallResult,
  LocalRuntimeReverifyResult,
  LocalRuntimeUpdateCheck,
} from "./shared.js";
export type { LocalRuntimeProbeSnapshot, LocalRuntimeStatusSnapshot } from "./service.js";
