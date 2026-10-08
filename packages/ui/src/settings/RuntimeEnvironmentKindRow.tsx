/**
 * 「运行时环境」卡的单运行时行（node/uv）：已装版本 + 可用上游 + 最近验证 +
 * 生命周期操作按钮。纯展示组件（specs/agent-runtimes.md §4.6 生命周期矩阵）。
 */
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RuntimeKind } from "@/store/runtimeStore.js";
import type { ReverifyState, UpdateCheckState } from "@/settings/runtimeEnvironmentCardHelpers.js";
import { Loader2Icon } from "lucide-react";

export function RuntimeEnvironmentKindRow({
  label,
  installed,
  updateCheck,
  reverify,
  installing,
  onInstall,
  onCheckUpdate,
  onReverify,
  onRemove,
}: {
  label: string;
  installed: string | null;
  updateCheck: UpdateCheckState | undefined;
  reverify: ReverifyState | undefined;
  installing: RuntimeKind | null;
  onInstall: () => void;
  onCheckUpdate: () => void;
  onReverify: () => void;
  onRemove: () => void;
}) {
  const { intl } = useZCodeIntl();
  const busy = installing !== null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-card-border bg-surface px-3 py-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-ui-base font-medium text-foreground">{label}</span>
          {installed ? (
            <span className="font-mono text-ui-sm text-foreground-subtle">{installed}</span>
          ) : (
            <span className="text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.mcp.runtime.notInstalled" })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ui-sm">
          {updateCheck ? (
            updateCheck.updateAvailable ? (
              <span className="text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.mcp.runtime.updateAvailable" },
                  { version: updateCheck.latest },
                )}
              </span>
            ) : (
              <span className="text-foreground-subtlest">
                {intl.formatMessage({ id: "settings.mcp.runtime.upToDate" })}
              </span>
            )
          ) : null}
          {reverify ? (
            <span className={reverify.ok ? "text-success" : "text-destructive"}>
              {reverify.ok
                ? intl.formatMessage(
                    { id: "settings.mcp.runtime.lastVerifyOk" },
                    { version: reverify.version ?? "" },
                  )
                : intl.formatMessage({ id: "settings.mcp.runtime.lastVerifyFailed" })}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {installed ? (
          <>
            {updateCheck?.updateAvailable ? (
              // [ulw] MAJOR-1：更新入口——检查更新发现新版本时渲染「更新到 {version}」，
              // 复用与安装相同的 onInstall/store action（install 编排 dir→runtime.json→
              // CURRENT→GC 自带同版 no-op 门，直接指向新版本即完成更新）。
              <Button type="button" variant="default" size="xs" onClick={onInstall} disabled={busy}>
                {intl.formatMessage(
                  { id: "settings.mcp.runtime.updateTo" },
                  { version: updateCheck.latest },
                )}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onCheckUpdate}
              disabled={busy}
            >
              {intl.formatMessage({ id: "settings.mcp.runtime.checkUpdate" })}
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={onReverify} disabled={busy}>
              {intl.formatMessage({ id: "settings.mcp.runtime.reverify" })}
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={onRemove} disabled={busy}>
              {intl.formatMessage({ id: "settings.mcp.runtime.remove" })}
            </Button>
          </>
        ) : (
          <Button type="button" variant="default" size="xs" onClick={onInstall} disabled={busy}>
            {busy ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({ id: "settings.mcp.runtime.install" })}
          </Button>
        )}
      </div>
    </div>
  );
}
