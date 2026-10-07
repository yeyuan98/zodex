/**
 * specs/agent-runtimes.md §4.3（解压归一化布局矩阵）/§4.6（解压工具）纯函数契约：
 * node win `.zip` 与 unix `.tar.xz` 均含 `node-v<ver>-<os>-<arch>/` 顶层需剥离；
 * uv win `.zip` 平铺 / unix `uv-<triple>/` 顶层剥离；Windows 用系统自带
 * tar.exe（bsdtar）解 `.zip`/`.tar.xz`。
 *
 * TODO(W5)：当前为 W1 红测桩——零行为，仅锁定签名与语义。
 */

export type RuntimeArchiveKind = "node-unix-tar" | "node-win-zip" | "uv-unix-tar" | "uv-win-zip";

/**
 * 归一化映射：归档成员路径 → 版本目录（`v<ver>/`）内目标相对路径。
 * topLevelDir = 预期顶层目录名（uv win 平铺 = ""）；成员不在 topLevelDir 下 → null。
 */
export function mapArchiveMemberToTargetPath(options: {
  readonly kind: RuntimeArchiveKind;
  readonly memberPath: string;
  readonly topLevelDir: string;
}): string | null {
  // TODO(W5)
  void options;
  return null;
}

/** 解压工具选择：win 平台 `.zip`/`.tar.xz` 均 = 系统 tar.exe（bsdtar 兼容）；unix = tar。 */
export function resolveExtractionTool(archiveFileName: string, platform: NodeJS.Platform): string {
  // TODO(W5)
  void archiveFileName;
  void platform;
  return "";
}
