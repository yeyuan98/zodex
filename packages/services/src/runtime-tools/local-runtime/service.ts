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
  AllProbeCandidatesDeadError,
  UV_KNOWN_GOOD_PROBE_TAG,
  probeArtifactClass,
} from "./probe.js";
import {
  APP_RUNTIME_ARTIFACT_CLASSES,
  isFillerRuntimeArtifactClass,
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
  /**
   * 显式 refresh 探测（只作用于无 override 位）并持久化，返回排名快照。
   * F5（§4.7 MINOR-6）：useMirrors === false（OFF）时 = 纯展示腿——只更新
   * measurements/快照与日志，不写 decisions/overrides（开关状态原样保留）。
   */
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
    // D2：切换写 override 后立即重验该类连通（刷新 measurements 供卡内排名展示）；
    // 探测轮自身会跳过 override 位，故单独探测该类。重探失败只 warn——override 已
    // 落盘，不因瞬时网络回滚用户选择。
    try {
      await this.refreshMirrorMeasurementsForClass(artifactClass);
    } catch (error) {
      this.logger.warn(
        undefined,
        `mirror override reprobe failed: ${artifactClass} (${String(error)})`,
      );
    }
  }

  /** 单类重探（仅刷新 measurements；decisions/overrides 不动）。 */
  private async refreshMirrorMeasurementsForClass(
    artifactClass: AppRuntimeArtifactClass,
  ): Promise<void> {
    const jsonPath = this.resolveJsonPath();
    const json = readAppRuntimeJson(jsonPath);
    if (!json) return;
    const probeVersion =
      artifactClass === "nodeDist"
        ? json.pinned.node || NODE_KNOWN_GOOD_PROBE_TAG
        : artifactClass === "uvRelease"
          ? json.pinned.uv || UV_KNOWN_GOOD_PROBE_TAG
          : "";
    const result = await probeArtifactClass(
      artifactClass,
      probeVersion,
      this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
    );
    const measurements = json.measurements
      .filter((entry) => entry.artifactClass !== artifactClass)
      .concat(result.measurements.map((entry) => ({ ...entry, artifactClass })));
    writeAppRuntimeJson(jsonPath, { ...json, measurements });
    // 每轮探测一行汇总（§4.7 日志通道）。
    this.logger.info(
      undefined,
      `mirror override reprobe: ${artifactClass} alive=${result.measurements.filter((entry) => entry.ok).length}/${result.measurements.length}`,
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
    // F5（§4.7 手动 Probe = 纯展示腿，MINOR-6）：OFF（useMirrors === false）下
    // 手动 Probe 只更新 measurements/快照与日志，**不写 decisions/overrides**
    // （否则违背「仅信息展示」；ON 行为不变——照常持久化）。内部调用方
    // （ensureRuntimeJsonForOverride，B 边缘）保持持久语义，走 persist 变体。
    const existing = readAppRuntimeJson(this.resolveJsonPath());
    return this.probeMirrorsInternal(options, existing, existing?.useMirrors !== false);
  }

  /**
   * 探测轮实现（公共展示腿与内部持久腿共用）：persistDecisions = true 时照常
   * 写 decisions 并刷新 probedAt（现行为）；false（OFF 展示腿）时 decisions/
   * overrides/probedAt 原样保留（决策新鲜度时钟不因纯展示探测被拨快——ON 恢复
   * 后 TTL 判定仍以真实决策轮为准），仅 measurements 更新。
   */
  private async probeMirrorsInternal(
    options: { readonly force?: boolean },
    existing: AppRuntimeJson | null,
    persistDecisions: boolean,
  ): Promise<LocalRuntimeProbeSnapshot> {
    const jsonPath = this.resolveJsonPath();
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
    // F2 类间并行（§4.1，alpha.3）：五类 Promise.allSettled——手动 Probe 腿与 install
    // 探测编排（runProbeRound）两处同形（wall = max(类) ≈ ≤5s；原类间串行上限
    // 5×5s=25s、§2o 取证实测 16.65s）。类内并行维持（probe.ts 不动）。
    const settled = await Promise.allSettled(
      slots.map((artifactClass) => {
        // 探针版本来源（§4.1）：上一轮钉住版本；首轮无记录用内置 known-good tag。
        const probeVersion =
          artifactClass === "nodeDist"
            ? existing?.pinned.node || NODE_KNOWN_GOOD_PROBE_TAG
            : artifactClass === "uvRelease"
              ? existing?.pinned.uv || UV_KNOWN_GOOD_PROBE_TAG
              : "";
        return probeArtifactClass(
          artifactClass,
          probeVersion,
          this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
        );
      }),
    );
    // F6（alpha.3，§4.1 规则 4 类域限定 + §4.7）：全灭报错仅适用**安装相关类**
    // （nodeDist/uvRelease——手动 Probe 撞上 all-dead 照旧 loud 抛出，语义不变）；
    // 填充类 all-dead = 降级（warn + decisions 键删），与 install 探测轮
    // （runProbeRound）两处同形。非 AllProbeCandidatesDeadError 的意外拒绝保守
    // 照旧 loud；仍按 slots 顺序抛第一个不可降级拒绝。
    for (const [index, artifactClass] of slots.entries()) {
      const result = settled[index];
      if (result === undefined || result.status !== "rejected") continue;
      if (
        isFillerRuntimeArtifactClass(artifactClass) &&
        result.reason instanceof AllProbeCandidatesDeadError
      ) {
        continue;
      }
      throw result.reason;
    }
    // 汇总行按候选表类序确定性拼接（slots 源自 APP_RUNTIME_ARTIFACT_CLASSES 序）——
    // 并行完成顺序不得影响输出（§9 (C)：`probe round:` 是 rig checklist 的 grep 锚点）。
    for (const [index, artifactClass] of slots.entries()) {
      const result = settled[index];
      if (result === undefined) continue;
      if (result.status === "fulfilled") {
        // OFF 展示腿不写 decisions（§4.7 MINOR-6）：探测 winner 只进快照/measurements。
        if (persistDecisions) {
          decisions[artifactClass] = result.value.outcome.winner;
        }
        measurements.push(
          ...result.value.measurements.map((entry) => ({ ...entry, artifactClass })),
        );
        perClass.push({
          artifactClass,
          winner: result.value.outcome.winner,
          measurements: result.value.measurements,
        });
        const winnerMeasurement = result.value.measurements.find(
          (entry) => entry.candidate === result.value.outcome.winner,
        );
        summary.push(
          `${artifactClass}=${result.value.outcome.winner}${winnerMeasurement ? `(${winnerMeasurement.latencyMs}ms)` : ""}`,
        );
        continue;
      }
      // F6 填充类降级（§4.7 键删语义 + MINOR-13）：all-dead → **显式删除**该类
      // decisions 键（不保 stale 镜像值；省略合并会复活已删键）；OFF 展示腿本就
      // 不写 decisions，同样不复活；无 winner 无快照条目；汇总行按类序占位标记；
      // warn 一行/类（不逐候选刷屏）。
      if (persistDecisions) {
        delete decisions[artifactClass];
      }
      summary.push(`${artifactClass}=all-dead`);
      this.logger.warn(
        undefined,
        `probe degrade: ${artifactClass} 所有候选探测失败——decisions 键删除（不填空，不保 stale 镜像值）；手工覆盖位 = runtime.json overrides 字段`,
      );
    }
    // 每轮探测一行汇总（§4.7 日志通道：不逐候选刷屏）。
    this.logger.info(undefined, `probe round: ${summary.join(" ")}`);
    const merged: AppRuntimeJson = {
      // OFF 展示腿不拨快决策新鲜度时钟：probedAt 语义 = 最近一次**持久化决策**轮。
      probedAt: persistDecisions
        ? new Date(nowMs).toISOString()
        : (existing?.probedAt ?? new Date(nowMs).toISOString()),
      ttlDays: existing?.ttlDays ?? 7,
      decisions: decisions as AppRuntimeDecisions,
      ...(existing?.overrides ? { overrides: existing.overrides } : {}),
      measurements,
      pinned: existing?.pinned ?? { node: "", uv: "" },
      // F5 MAJOR-5（§4.7 useMirrors schema）：合并字面量逐字段构造——遗漏该字段
      // 会把 OFF 静默翻回缺省 true。仅在场时保留（缺席 = true 现行为）。
      ...(existing?.useMirrors !== undefined ? { useMirrors: existing.useMirrors } : {}),
    };
    writeAppRuntimeJson(jsonPath, merged);
    return { perClass };
  }

  /** override 写入前需有决策载体：runtime.json 缺席时先跑一轮探测建立基线。 */
  private async ensureRuntimeJsonForOverride(): Promise<AppRuntimeJson> {
    const jsonPath = this.resolveJsonPath();
    const existing = readAppRuntimeJson(jsonPath);
    if (existing) return existing;
    // B 边缘（§4.7/F5）：runtime.json 缺席 + 用户设 override 时允许探测建立
    // decisions 载体——保持持久语义（OFF 投影下惰性、ON 后生效，不翻开关）；
    // 缺席 = useMirrors 缺省 true，与公共展示腿的 OFF 判定不冲突。
    await this.probeMirrorsInternal({ force: true }, null, true);
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
