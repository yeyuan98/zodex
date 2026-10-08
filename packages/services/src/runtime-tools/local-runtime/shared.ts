/**
 * specs/agent-runtimes.md §4.6/§4.7 A2′ 共享契约：kind/进度事件/依赖注入/结果
 * 类型与跨编排小工具（install / lifecycle / download-verify 三模块共用）。
 */
import { join } from "node:path";
import type { ServiceLogger } from "../../logger/serviceLogger.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { resolveAppRuntimeRootDir } from "./runtime-json.js";
import type { AppRuntimeArtifactClass } from "./runtime-json.js";
import type { ProbeFetchOptions } from "./probe.js";
import type { UpstreamFetchOptions } from "./upstream.js";

export type LocalRuntimeKind = "node" | "uv";

/** 冒烟（--version）超时：秒级预算，显著小于下载超时。 */
export const SMOKE_TIMEOUT_MS = 15_000;
/** 旧版本目录 GC 宽限期（§4.6：无指针引用且过宽限期才回收）。 */
export const VERSION_DIR_GC_GRACE_MS = 7 * 24 * 3600_000;

export class LocalRuntimeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRuntimeInstallError";
  }
}

export interface LocalRuntimeProgressEvent {
  readonly kind: LocalRuntimeKind;
  readonly phase:
    | "probe"
    | "resolve-version"
    | "download"
    | "verify"
    | "extract"
    | "finalize"
    | "smoke";
  readonly message?: string;
  readonly version?: string;
  readonly candidate?: string;
  readonly bytes?: number;
  readonly totalBytes?: number | null;
}

export interface LocalRuntimeDeps {
  readonly logger?: ServiceLogger;
  readonly fetchImpl?: typeof fetch;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  /** 注入运行时根（默认 `<config>/.runtime`，与 L3 读取同源）。 */
  readonly runtimeRootDir?: string;
  readonly now?: () => number;
}

export interface LocalRuntimeInstallOptions {
  readonly forceReprobe?: boolean;
  readonly onProgress?: (event: LocalRuntimeProgressEvent) => void;
}

export interface LocalRuntimeInstallResult {
  readonly kind: LocalRuntimeKind;
  readonly version: string;
  readonly candidate: string;
  readonly alreadyInstalled: boolean;
}

export interface LocalRuntimeUpdateCheck {
  readonly kind: LocalRuntimeKind;
  readonly pinned: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
}

export interface LocalRuntimeReverifyResult {
  readonly kind: LocalRuntimeKind;
  readonly ok: boolean;
  readonly version: string | null;
  readonly output: string | null;
}

export function resolveRuntimeRootDir(deps: LocalRuntimeDeps): string {
  return deps.runtimeRootDir ?? resolveAppRuntimeRootDir();
}

export function resolveRuntimeJsonPath(deps: LocalRuntimeDeps): string {
  return join(resolveRuntimeRootDir(deps), "runtime.json");
}

export function resolveRuntimeKindDir(deps: LocalRuntimeDeps, kind: LocalRuntimeKind): string {
  return join(resolveRuntimeRootDir(deps), kind);
}

export function kindArtifactClass(kind: LocalRuntimeKind): AppRuntimeArtifactClass {
  return kind === "node" ? "nodeDist" : "uvRelease";
}

export function fetchOptionsFor(deps: LocalRuntimeDeps): ProbeFetchOptions & UpstreamFetchOptions {
  return deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
}

export function resolveLogger(deps: LocalRuntimeDeps): ServiceLogger {
  return deps.logger ?? createServiceLogger("local-runtime");
}

export function onProgressSafe(
  onProgress: ((event: LocalRuntimeProgressEvent) => void) | undefined,
  event: LocalRuntimeProgressEvent,
): void {
  onProgress?.(event);
}
