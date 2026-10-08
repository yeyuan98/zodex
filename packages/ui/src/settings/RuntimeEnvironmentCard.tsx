/**
 * 设置页 MCP 区「运行时环境」卡（specs/agent-runtimes.md §4.6/§4.7 + alpha3 W-B2）：
 * 已装版本 + 生命周期操作（安装/检查更新/重新验证/删除-确认框）+ 全局「使用镜像」
 * 开关（写 useMirrors，常显卡顶）+ 镜像明细（五类工件排名 + 每类 Select 切换，
 * 默认折叠；trigger 行带手动 Probe）。运行时 = 本机全局事实源：服务必须来自
 * base/local workspace services（远端 host 不注册）。行组件与非 JSX 辅助见
 * RuntimeEnvironmentKindRow / runtimeEnvironmentCardHelpers。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ILocalRuntimeService } from "@zcode/services";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import {
  setRuntimeStoreService,
  useRuntimeStore,
  type RuntimeArtifactClass,
  type RuntimeKind,
} from "@/store/runtimeStore.js";
import { RuntimeEnvironmentKindRow } from "@/settings/RuntimeEnvironmentKindRow.js";
import {
  EMPTY_MIRROR_SELECTION,
  MIRROR_AUTO_VALUE,
  RUNTIME_ARTIFACT_CLASS_ORDER,
  RUNTIME_KINDS,
  extractMirrorSelection,
  makeRuntimeCardStoreService,
  type MirrorCandidateMap,
  type MirrorSelectionState,
  type ReverifyState,
  type UpdateCheckState,
} from "@/settings/runtimeEnvironmentCardHelpers.js";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";

export function RuntimeEnvironmentCard({ service }: { service?: ILocalRuntimeService }) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const status = useRuntimeStore((state) => state.status);
  const installing = useRuntimeStore((state) => state.installing);
  const probing = useRuntimeStore((state) => state.probing);
  const storeError = useRuntimeStore((state) => state.error);
  const lastFailedInstallKind = useRuntimeStore((state) => state.lastFailedInstallKind);
  const refreshStatus = useRuntimeStore((state) => state.refreshStatus);
  const installRuntime = useRuntimeStore((state) => state.installRuntime);
  const removeRuntime = useRuntimeStore((state) => state.removeRuntime);
  const setMirrorOverride = useRuntimeStore((state) => state.setMirrorOverride);
  const clearMirrorOverride = useRuntimeStore((state) => state.clearMirrorOverride);
  const setUseMirrors = useRuntimeStore((state) => state.setUseMirrors);
  const probeMirrors = useRuntimeStore((state) => state.probeMirrors);
  const [candidates, setCandidates] = useState<MirrorCandidateMap>({});
  const [mirrorSelection, setMirrorSelection] =
    useState<MirrorSelectionState>(EMPTY_MIRROR_SELECTION);
  const [updateChecks, setUpdateChecks] = useState<Partial<Record<RuntimeKind, UpdateCheckState>>>(
    {},
  );
  const [reverifies, setReverifies] = useState<Partial<Record<RuntimeKind, ReverifyState>>>({});

  const refreshMirrorSelection = useCallback(() => {
    if (!service) return;
    void service
      .status()
      .then((snapshot) => {
        setMirrorSelection(extractMirrorSelection(snapshot));
      })
      .catch((error) => logger.warn("[runtimeCard] read mirror decisions failed", String(error)));
  }, [service]);

  useEffect(() => {
    if (!service) return;
    setRuntimeStoreService(makeRuntimeCardStoreService(service));
    void refreshStatus();
    refreshMirrorSelection();
    void service
      .listMirrorCandidates()
      .then(setCandidates)
      .catch((error) => logger.warn("[runtimeCard] list mirror candidates failed", String(error)));
    return () => {
      setRuntimeStoreService(null);
    };
  }, [service, refreshStatus, refreshMirrorSelection]);

  const handleInstall = useCallback(
    (kind: RuntimeKind) => {
      // 卡级生命周期事件走 logger.lifecycle（§2l：普通 logger.* 生产 no-op）。
      logger.lifecycle.info("[runtimeCard] install requested", { kind });
      void installRuntime(kind)
        .then(() => logger.lifecycle.info("[runtimeCard] install done", { kind }))
        .catch((error) => {
          // owner ③(8)/§4.6 F1：成败分流日志——store 自 P7b 起 rethrow，本 catch 为活代码；
          // 错误正文已入 store.error 常驻呈现，这里只补首行原因。
          const reason = String(error).split("\n")[0];
          logger.lifecycle.info("[runtimeCard] install failed", { kind, reason });
        });
    },
    [installRuntime],
  );

  const handleUseMirrorsChange = useCallback(
    (checked: boolean) => {
      // owner ③(1)/§4.7 F5：写入走 W-B1 store action；失败（含服务侧守卫拒绝）由
      // store.error 常驻呈现，开关不自造本地翻转——refreshStatus 后从服务快照重投影。
      void setUseMirrors(checked).catch(() => undefined);
    },
    [setUseMirrors],
  );

  const handleProbe = useCallback(() => {
    // owner ③(4)/§4.6 F5：手动 Probe = probeMirrors({force:true}) 纯展示腿（§4.7
    // MINOR-6），排名数据经 refreshStatus 流入；失败（含 P6 互斥拒绝文案）常驻错误段。
    void probeMirrors().catch(() => undefined);
  }, [probeMirrors]);

  const handleCheckUpdate = useCallback(
    async (kind: RuntimeKind) => {
      if (!service) return;
      try {
        const result = await service.checkUpdate(kind);
        setUpdateChecks((current) => ({
          ...current,
          [kind]: { latest: result.latest, updateAvailable: result.updateAvailable },
        }));
      } catch (error) {
        toast(intl.formatMessage({ id: "settings.mcp.runtime.checkUpdateFailed" }), {
          durationMs: 8_000,
        });
        logger.warn("[runtimeCard] check update failed", { kind, error: String(error) });
      }
    },
    [service, intl],
  );

  const handleReverify = useCallback(
    async (kind: RuntimeKind) => {
      if (!service) return;
      try {
        const result = await service.reverify(kind);
        setReverifies((current) => ({
          ...current,
          [kind]: { ok: result.ok, version: result.version },
        }));
      } catch (error) {
        toast(intl.formatMessage({ id: "settings.mcp.runtime.reverifyFailed" }), {
          durationMs: 8_000,
        });
        logger.warn("[runtimeCard] reverify failed", { kind, error: String(error) });
      }
    },
    [service, intl],
  );

  const handleRemove = useCallback(
    async (kind: RuntimeKind) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.mcp.runtime.removeConfirmTitle" }, { kind }),
        description: intl.formatMessage({ id: "settings.mcp.runtime.removeConfirmDescription" }),
        confirmLabel: intl.formatMessage({ id: "settings.mcp.runtime.removeConfirmAction" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      logger.lifecycle.info("[runtimeCard] remove requested", { kind });
      try {
        await removeRuntime(kind);
        logger.lifecycle.info("[runtimeCard] remove done", { kind });
      } catch (error) {
        toast(intl.formatMessage({ id: "settings.mcp.runtime.actionFailed" }), {
          durationMs: 8_000,
        });
        logger.warn("[runtimeCard] remove failed", { kind, error: String(error) });
      }
    },
    [confirmDialog, intl, removeRuntime],
  );

  const handleMirrorChange = useCallback(
    async (artifactClass: RuntimeArtifactClass, value: string) => {
      // auto = 清除 override（回落探测决策）；显式候选 = 写 override（服务侧同步
      // 重探该类连通）。切换后续下载与缺省填空走新源，下一次任务 spawn 生效。
      try {
        if (value === MIRROR_AUTO_VALUE) {
          await clearMirrorOverride(artifactClass);
        } else {
          await setMirrorOverride(artifactClass, value);
        }
        logger.lifecycle.info("[runtimeCard] mirror decision changed", { artifactClass, value });
      } catch (error) {
        toast(intl.formatMessage({ id: "settings.mcp.runtime.mirrorSwitchFailed" }), {
          durationMs: 8_000,
        });
        logger.warn("[runtimeCard] mirror switch failed", { artifactClass, error: String(error) });
        return;
      }
      refreshMirrorSelection();
    },
    [clearMirrorOverride, setMirrorOverride, refreshMirrorSelection],
  );

  const rankingRows = useMemo(() => status?.probeRanking ?? {}, [status]);
  // owner ③(1)：开关状态源 = 快照投影（undefined/缺席 = ON，§4.7 F5 缺省 true）。
  const useMirrors = status?.useMirrors ?? true;

  if (!service) return null;

  return (
    <section
      className="space-y-4 rounded-xl border border-card-border bg-card p-4"
      data-runtime-environment-card="true"
      aria-label={intl.formatMessage({ id: "settings.mcp.runtime.title" })}
    >
      <div className="min-w-0 space-y-1">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.mcp.runtime.title" })}
        </h4>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.runtime.description" })}
        </p>
      </div>

      {/* owner ③(1)/§4.6 F5：全局「使用镜像」开关常显卡顶；仅 probing 期间禁用（翻转廉价，服务侧仅与 probe 互斥）。 */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-card-border bg-surface px-3 py-2">
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.mcp.runtime.useMirrors" })}
          </div>
          <div className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.mcp.runtime.useMirrorsDescription" })}
          </div>
        </div>
        <Switch
          checked={useMirrors}
          disabled={probing}
          onCheckedChange={handleUseMirrorsChange}
          aria-label={intl.formatMessage({ id: "settings.mcp.runtime.useMirrors" })}
        />
      </div>

      {/* owner ③(6)：node/uv 行常显；③(5)：probing 期间 inert 禁用行内操作（含安装按钮，行组件共用 busy 语义）。 */}
      <div
        className={cn("space-y-2", probing && "opacity-60")}
        inert={probing ? true : undefined}
        aria-busy={probing}
      >
        {RUNTIME_KINDS.map((kind) => (
          <RuntimeEnvironmentKindRow
            key={kind}
            label={intl.formatMessage({ id: `settings.mcp.runtime.${kind}` })}
            installed={status?.installed[kind] ?? null}
            updateCheck={updateChecks[kind]}
            reverify={reverifies[kind]}
            installing={installing}
            onInstall={() => handleInstall(kind)}
            onCheckUpdate={() => void handleCheckUpdate(kind)}
            onReverify={() => void handleReverify(kind)}
            onRemove={() => void handleRemove(kind)}
          />
        ))}
      </div>

      {installing ? (
        <div className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          {intl.formatMessage(
            { id: "settings.mcp.runtime.installing" },
            { kind: intl.formatMessage({ id: `settings.mcp.runtime.${installing}` }) },
          )}
        </div>
      ) : null}

      {/* owner ③(7)/§4.6 F4：错误常驻（存活至下一动作开始）；安装失败旁重试入口（复用 install action + lastFailedInstallKind 记账）。 */}
      {storeError ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 flex-1 break-all text-ui-sm text-destructive">{storeError}</p>
          {lastFailedInstallKind ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={installing !== null || probing}
              onClick={() => handleInstall(lastFailedInstallKind)}
            >
              {intl.formatMessage(
                { id: "settings.mcp.runtime.retryInstall" },
                {
                  kind: intl.formatMessage({ id: `settings.mcp.runtime.${lastFailedInstallKind}` }),
                },
              )}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* owner ③(2)(3)/§4.6 F5：五类明细默认折叠；trigger 行 =「镜像明细」+ Probe（探测 spinner、安装禁用，P6 守卫兜底）。 */}
      <Collapsible defaultOpen={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-card-border bg-surface px-3 py-2">
          <CollapsibleTrigger className="group/mirror-details flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30">
            <ChevronDownIcon
              className="size-4 shrink-0 text-foreground-subtle transition-transform group-data-[state=open]/mirror-details:rotate-180"
              aria-hidden="true"
            />
            <span className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.mcp.runtime.mirrorDetails" })}
            </span>
          </CollapsibleTrigger>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={installing !== null || probing}
            onClick={handleProbe}
          >
            {probing ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({ id: "settings.mcp.runtime.probeAction" })}
          </Button>
        </div>
        <CollapsibleContent className="space-y-3 pt-3">
          <h5 className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.mcp.runtime.mirrorSection" })}
          </h5>
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.mcp.runtime.mirrorNote" })}
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {RUNTIME_ARTIFACT_CLASS_ORDER.map((artifactClass) => {
              const rows = rankingRows[artifactClass];
              const classCandidates = candidates[artifactClass] ?? [];
              const override = mirrorSelection.overrides[artifactClass];
              const effective = mirrorSelection.effective[artifactClass];
              return (
                <div
                  key={artifactClass}
                  className="space-y-2 rounded-lg border border-card-border bg-surface px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-ui-sm text-foreground">
                        {intl.formatMessage({ id: `settings.mcp.runtime.mirror.${artifactClass}` })}
                      </div>
                      {effective ? (
                        <div className="font-mono text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage(
                            { id: "settings.mcp.runtime.mirrorCurrent" },
                            { candidate: effective },
                          )}
                        </div>
                      ) : null}
                    </div>
                    <Select
                      value={override ?? MIRROR_AUTO_VALUE}
                      onValueChange={(value) => void handleMirrorChange(artifactClass, value)}
                    >
                      <SelectTrigger
                        className="h-7 w-44 rounded-md px-2 text-ui-sm"
                        aria-label={intl.formatMessage({
                          id: `settings.mcp.runtime.mirror.${artifactClass}`,
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent
                        position="popper"
                        align="start"
                        side="bottom"
                        sideOffset={4}
                        collisionPadding={8}
                      >
                        <SelectItem value={MIRROR_AUTO_VALUE} className="text-ui-base">
                          {intl.formatMessage({ id: "settings.mcp.runtime.mirrorAuto" })}
                        </SelectItem>
                        {classCandidates.map((candidate) => (
                          <SelectItem
                            key={candidate.id}
                            value={candidate.id}
                            className="text-ui-base"
                          >
                            <span className="font-mono">{candidate.id}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {rows && rows.length > 0 ? (
                    <ul className="space-y-1">
                      {rows.map((row) => (
                        <li key={row.candidate} className="flex items-center gap-2 text-ui-sm">
                          <span
                            className={row.ok ? "text-success" : "text-destructive"}
                            aria-hidden="true"
                          >
                            ●
                          </span>
                          <span className="min-w-0 truncate font-mono text-foreground-subtle">
                            {row.candidate}
                          </span>
                          <span className="text-foreground-subtlest">
                            {row.ok
                              ? intl.formatMessage(
                                  { id: "settings.mcp.runtime.probeLatency" },
                                  { code: row.httpCode, latency: row.latencyMs },
                                )
                              : intl.formatMessage({ id: "settings.mcp.runtime.probeFailed" })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ui-sm text-foreground-subtlest">
                      {intl.formatMessage({ id: "settings.mcp.runtime.probeEmpty" })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
