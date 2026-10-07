/**
 * specs/agent-runtimes.md §2.5（Bash 工具腿：app 级 host 侧追加）契约：app 运行时
 * 在场（CURRENT 有效 + bin 目录存在）→ 向 Bash env 追加（append，非前插）app 级
 * bin 目录 + 镜像缺省填空；缺席 → null（patch 不变）。W6 把本 seam 接进
 * `runtimeCommandEnv.ts` 的 `buildRuntimeProcessEnvPatch` 与 agent spawn 缝
 * （两段——app-bin 追加段与填空值——都在 agent spawn 缝重算，防池化陈旧）。
 *
 * TODO(W6)：当前为 W1 红测桩——零行为（恒 null），仅锁定签名与语义。
 */

export interface AppRuntimeBashAppendInput {
  /** app 级运行时根（<config>/.runtime）。 */
  readonly root: string;
  readonly current: { readonly node: string | null; readonly uv: string | null };
  /** bin 目录存在性检查（注入 fs，保持纯函数可测）。 */
  readonly binDirExists: (dir: string) => boolean;
  /** effective decision（§4.7 override ?? probed）的填空投影。 */
  readonly decisions: {
    readonly npmRegistry?: string;
    readonly pypiIndex?: string;
    readonly pbsMirror?: string;
  };
  readonly platform?: NodeJS.Platform;
}

export interface AppRuntimeBashAppendResult {
  /** 追加到 PATH 尾部的 app 级 bin 目录（追加语义，与 MCP 腿前插区分）。 */
  readonly pathAppend: readonly string[];
  /** 镜像缺省填空键（大小写不敏感存在性；键已存在不覆盖）。 */
  readonly envFill: Readonly<Record<string, string>>;
}

export function buildAppRuntimeBashAppend(
  baseEnv: NodeJS.ProcessEnv,
  input: AppRuntimeBashAppendInput,
): AppRuntimeBashAppendResult | null {
  // TODO(W6)
  void baseEnv;
  void input;
  return null;
}
