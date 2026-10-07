/**
 * specs/agent-runtimes.md §4.3（安装布局：版本化目录 + CURRENT 原子指针）/§4.6（GC）
 * 契约：CURRENT tmp+rename 原子换指针、读端容错（禁目录扫描回退）、版本目录 GC
 * 决策（含 Windows 文件锁 = 保留 + 标记重试）。
 *
 * TODO(W5)：当前为 W1 红测桩——零行为（写 no-op、读恒 null、GC 全保留），仅锁定
 * 签名与语义。
 */

/** CURRENT 原子写入：`CURRENT.tmp*` → fs.rename（同卷原子；读者只见旧或新、无半写）。 */
export function writeCurrentPointer(runtimeKindDir: string, version: string): void {
  // TODO(W5)
  void runtimeKindDir;
  void version;
}

/**
 * CURRENT 读取（§4.3 读端容错）：内容 = 版本目录名；缺失/不可解析/悬空（指向已
 * GC 目录）→ null；**禁止**回退扫描最高 `v<ver>`（会复活待 GC 版本）。
 */
export function readCurrentPointer(runtimeKindDir: string): string | null {
  // TODO(W5)
  void runtimeKindDir;
  return null;
}

/** 版本目录元数据（GC 决策输入，纯数据）。 */
export interface RuntimeVersionDirMeta {
  readonly dirName: string;
  readonly lastTouchedMs: number;
  /** Windows 文件锁模拟标记：运行中进程持有目录内文件。 */
  readonly locked?: boolean;
}

/** GC 计划：remove = 本轮删除；keep = 保留（被引用/宽限期内）；retryLater = 锁定保留待启动重试。 */
export interface VersionDirGcPlan {
  readonly remove: readonly string[];
  readonly keep: readonly string[];
  readonly retryLater: readonly string[];
}

/**
 * GC 规则（§4.6）：未被 CURRENT 引用且已过宽限期 → remove；被引用 → keep；
 * 未引用但在宽限期内 → keep；locked（win 文件锁）→ 保留 + 标记 retryLater
 * （desktop main 启动时重试）。
 */
export function planVersionDirGc(
  meta: readonly RuntimeVersionDirMeta[],
  options: {
    readonly currentVersion: string | null;
    readonly nowMs: number;
    readonly graceMs: number;
  },
): VersionDirGcPlan {
  // TODO(W5)：stub = 保守无行为（全部保留，不删除、不标记重试）。
  void options;
  return { remove: [], keep: meta.map((entry) => entry.dirName), retryLater: [] };
}
