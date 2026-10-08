/**
 * specs/agent-runtimes.md §4.6/§4.7 A2′ 服务门面：UI 卡（W6）经本 seam 消费的
 * LocalRuntimeService——install/checkUpdate/remove/reverify/status + 镜像 override
 * 管理 + 探测状态快照。桌面 host 组装注册归 W6（本相不注册）。
 *
 * 依赖注入：fetch/spawn/根目录/时钟均可注入（跨平台与测试）；日志统一
 * createServiceLogger("local-runtime")（每轮探测一行汇总）。
 */
import { join } from "node:path";
import type { ServiceLogger } from "../../logger/serviceLogger.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { readCurrentPointer } from "./current.js";
import { installRuntime } from "./install.js";
import { checkUpdateRuntime, removeRuntime, reverifyRuntime } from "./lifecycle.js";
import {
  NODE_KNOWN_GOOD_PROBE_TAG,
  MIRROR_CANDIDATE_TABLES,
  UV_KNOWN_GOOD_PROBE_TAG,
  probeArtifactClass,
} from "./probe.js";
import {
  APP_RUNTIME_ARTIFACT_CLASSES,
  readAppRuntimeJson,
  resolveEffectiveDecisions,
  resolveReprobeSlots,
  writeAppRuntimeJson,
  type AppRuntimeArtifactClass,
  type AppRuntimeDecisions,
  type AppRuntimeJson,
} from "./runtime-json.js";
import {
  resolveRuntimeJsonPath,
  resolveRuntimeRootDir,
  type LocalRuntimeDeps,
  type LocalRuntimeInstallOptions,
  type LocalRuntimeInstallResult,
  type LocalRuntimeReverifyResult,
  type LocalRuntimeUpdateCheck,
} from "./shared.js";
export type {
  LocalRuntimeInstallOptions,
  LocalRuntimeInstallResult,
  LocalRuntimeProgressEvent,
  LocalRuntimeReverifyResult,
  LocalRuntimeUpdateCheck,
} from "./shared.js";
export type { LocalRuntimeKind } from "./shared.js";

/** 非法 override 候选（不在候选表取值域）= 明确报错。 */
export class InvalidMirrorOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMirrorOverrideError";
  }
}

export interface LocalRuntimeStatusSnapshot {
  readonly runtimeJson: AppRuntimeJson | null;
  readonly effectiveDecisions: AppRuntimeDecisions | null;
  readonly current: { readonly node: string | null; readonly uv: string | null };
  readonly reprobeSlots: readonly AppRuntimeArtifactClass[];
}

export interface LocalRuntimeProbeSnapshot {
  readonly perClass: readonly {
    readonly artifactClass: AppRuntimeArtifactClass;
    readonly winner: string;
    readonly measurements: readonly {
      readonly candidate: string;
      readonly httpCode: number;
      readonly latencyMs: number;
      readonly ok: boolean;
    }[];
  }[];
}

export interface LocalRuntimeService {
  install(
    kind: "node" | "uv",
    options?: LocalRuntimeInstallOptions,
  ): Promise<LocalRuntimeInstallResult>;
  checkUpdate(kind: "node" | "uv"): Promise<LocalRuntimeUpdateCheck>;
  remove(kind: "node" | "uv"): Promise<void>;
  reverify(kind: "node" | "uv"): Promise<LocalRuntimeReverifyResult>;
  status(): LocalRuntimeStatusSnapshot;
  setMirrorOverride(artifactClass: AppRuntimeArtifactClass, candidateId: string): Promise<void>;
  clearMirrorOverride(artifactClass: AppRuntimeArtifactClass): Promise<void>;
  /** 显式 refresh 探测（只作用于无 override 位）并持久化，返回排名快照。 */
  probeMirrors(options?: { readonly force?: boolean }): Promise<LocalRuntimeProbeSnapshot>;
}

export interface LocalRuntimeServiceOptions extends LocalRuntimeDeps {
  readonly logger?: ServiceLogger;
}

export class LocalRuntimeServiceImpl implements LocalRuntimeService {
  private readonly deps: LocalRuntimeDeps;
  private readonly logger: ServiceLogger;

  constructor(options: LocalRuntimeServiceOptions = {}) {
    this.deps = options;
    this.logger = options.logger ?? createServiceLogger("local-runtime");
  }

  private resolveRuntimeRootDir(): string {
    return resolveRuntimeRootDir(this.deps);
  }

  private resolveJsonPath(): string {
    return resolveRuntimeJsonPath(this.deps);
  }

  install(
    kind: "node" | "uv",
    options: LocalRuntimeInstallOptions = {},
  ): Promise<LocalRuntimeInstallResult> {
    return installRuntime(kind, options, this.deps);
  }

  checkUpdate(kind: "node" | "uv"): Promise<LocalRuntimeUpdateCheck> {
    return checkUpdateRuntime(kind, this.deps);
  }

  remove(kind: "node" | "uv"): Promise<void> {
    return removeRuntime(kind, this.deps);
  }

  reverify(kind: "node" | "uv"): Promise<LocalRuntimeReverifyResult> {
    return reverifyRuntime(kind, this.deps);
  }

  status(): LocalRuntimeStatusSnapshot {
    const runtimeJson = readAppRuntimeJson(this.resolveJsonPath());
    const rootDir = this.resolveRuntimeRootDir();
    const nowMs = (this.deps.now ?? Date.now)();
    return {
      runtimeJson,
      effectiveDecisions: runtimeJson ? resolveEffectiveDecisions(runtimeJson) : null,
      current: {
        node: readCurrentPointer(join(rootDir, "node")),
        uv: readCurrentPointer(join(rootDir, "uv")),
      },
      reprobeSlots: runtimeJson ? resolveReprobeSlots(runtimeJson, { nowMs }) : [],
    };
  }

  async setMirrorOverride(
    artifactClass: AppRuntimeArtifactClass,
    candidateId: string,
  ): Promise<void> {
    const validIds = MIRROR_CANDIDATE_TABLES[artifactClass].map((spec) => spec.id);
    if (!validIds.includes(candidateId)) {
      throw new InvalidMirrorOverrideError(
        `invalid mirror override for ${artifactClass}: ${candidateId}（合法候选：${validIds.join(" / ")}）`,
      );
    }
    const json = await this.ensureRuntimeJsonForOverride();
    const overrides = { ...json.overrides, [artifactClass]: candidateId };
    writeAppRuntimeJson(this.resolveJsonPath(), { ...json, overrides });
    this.logger.info(
      undefined,
      `mirror override set: ${artifactClass}=${candidateId}（后续下载/填空走新源；下一 spawn 生效）`,
    );
  }

  async clearMirrorOverride(artifactClass: AppRuntimeArtifactClass): Promise<void> {
    const jsonPath = this.resolveJsonPath();
    const json = readAppRuntimeJson(jsonPath);
    if (!json?.overrides || json.overrides[artifactClass] === undefined) return;
    const overrides = { ...json.overrides };
    delete overrides[artifactClass];
    writeAppRuntimeJson(jsonPath, {
      ...json,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    });
    this.logger.info(undefined, `mirror override cleared: ${artifactClass}（回落探测决策）`);
  }

  async probeMirrors(
    options: { readonly force?: boolean } = {},
  ): Promise<LocalRuntimeProbeSnapshot> {
    const jsonPath = this.resolveJsonPath();
    const existing = readAppRuntimeJson(jsonPath);
    const nowMs = (this.deps.now ?? Date.now)();
    const slots = existing
      ? resolveReprobeSlots(existing, { nowMs, force: options.force ?? true })
      : [...APP_RUNTIME_ARTIFACT_CLASSES];
    if (slots.length === 0) {
      return { perClass: [] };
    }
    const perClass: {
      artifactClass: AppRuntimeArtifactClass;
      winner: string;
      measurements: readonly {
        candidate: string;
        httpCode: number;
        latencyMs: number;
        ok: boolean;
      }[];
    }[] = [];
    const decisions = { ...existing?.decisions };
    const measurements = existing
      ? existing.measurements.filter(
          (entry) => !entry.artifactClass || !slots.includes(entry.artifactClass),
        )
      : [];
    const summary: string[] = [];
    for (const artifactClass of slots) {
      const probeVersion =
        artifactClass === "nodeDist"
          ? existing?.pinned.node || NODE_KNOWN_GOOD_PROBE_TAG
          : artifactClass === "uvRelease"
            ? existing?.pinned.uv || UV_KNOWN_GOOD_PROBE_TAG
            : "";
      const result = await probeArtifactClass(
        artifactClass,
        probeVersion,
        this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
      );
      decisions[artifactClass] = result.outcome.winner;
      measurements.push(...result.measurements.map((entry) => ({ ...entry, artifactClass })));
      perClass.push({
        artifactClass,
        winner: result.outcome.winner,
        measurements: result.measurements,
      });
      const winnerMeasurement = result.measurements.find(
        (entry) => entry.candidate === result.outcome.winner,
      );
      summary.push(
        `${artifactClass}=${result.outcome.winner}${winnerMeasurement ? `(${winnerMeasurement.latencyMs}ms)` : ""}`,
      );
    }
    // 每轮探测一行汇总（§4.7 日志通道：不逐候选刷屏）。
    this.logger.info(undefined, `probe round: ${summary.join(" ")}`);
    const merged: AppRuntimeJson = {
      probedAt: new Date(nowMs).toISOString(),
      ttlDays: existing?.ttlDays ?? 7,
      decisions: decisions as AppRuntimeDecisions,
      ...(existing?.overrides ? { overrides: existing.overrides } : {}),
      measurements,
      pinned: existing?.pinned ?? { node: "", uv: "" },
    };
    writeAppRuntimeJson(jsonPath, merged);
    return { perClass };
  }

  /** override 写入前需有决策载体：runtime.json 缺席时先跑一轮探测建立基线。 */
  private async ensureRuntimeJsonForOverride(): Promise<AppRuntimeJson> {
    const jsonPath = this.resolveJsonPath();
    const existing = readAppRuntimeJson(jsonPath);
    if (existing) return existing;
    await this.probeMirrors({ force: true });
    const created = readAppRuntimeJson(jsonPath);
    if (!created) {
      throw new InvalidMirrorOverrideError("runtime.json 建立失败（探测轮未落盘）");
    }
    return created;
  }
}

export function createLocalRuntimeService(
  options: LocalRuntimeServiceOptions = {},
): LocalRuntimeService {
  return new LocalRuntimeServiceImpl(options);
}
