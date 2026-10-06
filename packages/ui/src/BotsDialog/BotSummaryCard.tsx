import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Clock3, Trash2 } from "lucide-react";
import type { BotConfig, BotReplyGranularity, BotServiceStatus } from "@zcode/shared";
import { normalizePermissionTimeoutMinutes } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  getBotReplyGranularitiesForProvider,
  getBotReplyGranularityEntryForProvider,
  getBotRuntimeErrorDetail,
} from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";
import { ProviderIcon, runtimeDot, runtimeText } from "./shared.js";

export function BotSummaryCard({
  bot,
  runtime,
  selectedBotDisplayName,
  selectedBotName,
  fallbackBotName,
  renaming,
  onStartRename,
  onCommitNameDraft,
  onNameDraftChange,
  onNameCompositionEnd,
  onNameCompositionStart,
  onNameInputKeyDown,
  onPatchBot,
}: {
  bot: BotConfig;
  runtime: BotServiceStatus["botRuntime"][number] | undefined;
  selectedBotDisplayName: string;
  selectedBotName: string;
  fallbackBotName: string;
  renaming: boolean;
  onStartRename: () => void;
  onCommitNameDraft: () => void;
  onNameDraftChange: (value: string) => void;
  onNameCompositionEnd?: () => void;
  onNameCompositionStart?: () => void;
  onNameInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const nameMeasureButtonRef = useRef<HTMLButtonElement | null>(null);
  const [nameEditorWidth, setNameEditorWidth] = useState<number | null>(null);
  const isBound = Boolean(bot.providerUserId);
  // 修复原因：连接失败会直接阻断 /bind，不能再用“未绑定”覆盖真正的阻塞状态。
  const summaryStatusText =
    runtime?.status === "error"
      ? intl.formatMessage({
          id:
            bot.provider === "feishu"
              ? "bots.runtime.feishuConnectionFailed"
              : bot.provider === "lark"
                ? "bots.runtime.larkConnectionFailed"
                : "bots.runtime.connectionFailed",
        })
      : isBound
        ? runtimeText(runtime, bot.enabled, (id) => intl.formatMessage({ id }))
        : intl.formatMessage({ id: "bots.unbound" });
  const nameEditorText = selectedBotName || fallbackBotName;
  // F0：错误详情对所有 provider 可见——汇总行保留通用 i18n 标签，原始运行时 message
  // 作为次行展示（title 提示完整内容），不再只对 feishu 暴露细节。
  const runtimeErrorDetail = getBotRuntimeErrorDetail(runtime);

  useLayoutEffect(() => {
    if (!renaming) {
      setNameEditorWidth(null);
      return undefined;
    }
    const measureButton = nameMeasureButtonRef.current;
    if (!measureButton) {
      return undefined;
    }
    const updateWidth = () => {
      setNameEditorWidth(Math.ceil(measureButton.getBoundingClientRect().width));
    };
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(measureButton);
    return () => resizeObserver.disconnect();
  }, [nameEditorText, renaming]);

  const botNameControl = (
    <div className="min-w-0">
      {renaming ? (
        <label
          className="relative inline-block min-w-6 max-w-md align-middle"
          style={nameEditorWidth ? { width: `${nameEditorWidth}px` } : undefined}
        >
          <span className="sr-only">{intl.formatMessage({ id: "bots.name" })}</span>
          <button
            ref={nameMeasureButtonRef}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 invisible max-w-md overflow-hidden rounded-sm px-1 text-left text-ui-lg font-medium"
            // 隐藏测量节点默认会折叠首尾空格，导致输入名称带空格时宽度偏小；保留空白才能和 input 的实际内容宽度一致。
            style={{ whiteSpace: "pre" }}
          >
            {nameEditorText}
          </button>
          <input
            autoFocus
            className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-lg font-medium leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
            value={selectedBotName}
            onBlur={onCommitNameDraft}
            onChange={(event) => onNameDraftChange(event.target.value)}
            onCompositionEnd={onNameCompositionEnd}
            onCompositionStart={onNameCompositionStart}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={onNameInputKeyDown}
            placeholder={fallbackBotName}
          />
        </label>
      ) : (
        <button
          type="button"
          className="min-w-0 max-w-md truncate rounded-sm px-1 text-left text-ui-lg font-medium hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
          onClick={onStartRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onStartRename();
            }
          }}
        >
          {selectedBotDisplayName}
        </button>
      )}
    </div>
  );

  const botIdentityDescription = (
    <span className="inline-flex items-center gap-2 text-foreground-subtle">
      {isBound || runtime?.status === "error" ? (
        <span className={cn("size-1.5 rounded-full", runtimeDot(runtime, bot.enabled))} />
      ) : (
        <Clock3 className="size-3 text-foreground-subtle" />
      )}
      {summaryStatusText}
    </span>
  );

  return (
    <div className="flex items-center gap-3 pb-2 px-2">
      <ProviderIcon provider={bot.provider} className="size-12 shrink-0 text-foreground-subtle" />
      <div className="min-w-0 flex-1 space-y-1">
        {botNameControl}
        {botIdentityDescription}
        {runtimeErrorDetail ? (
          <div
            className="min-w-0 truncate text-ui-sm leading-4 text-foreground-subtle"
            title={runtimeErrorDetail}
          >
            {runtimeErrorDetail}
          </div>
        ) : null}
      </div>
      <div className="shrink-0">
        <Switch checked={bot.enabled} onCheckedChange={(enabled) => onPatchBot({ enabled })} />
      </div>
    </div>
  );
}

export function BotReplyGranularityCard({
  bot,
  onPatchBot,
}: {
  bot: BotConfig;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const replyGranularities = getBotReplyGranularitiesForProvider(bot.provider);
  const selectedGranularity = getBotReplyGranularityEntryForProvider(bot.provider, bot.replyMode);

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "bots.replyGranularity" })}
      description={intl.formatMessage({
        id: selectedGranularity.descriptionId,
      })}
      control={
        <Select
          value={selectedGranularity.id}
          onValueChange={(replyMode) => onPatchBot({ replyMode: replyMode as BotReplyGranularity })}
        >
          <SelectTrigger size="lg" className="w-48 justify-between">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {replyGranularities.map((granularity) => (
              <SelectItem key={granularity.id} value={granularity.id}>
                {intl.formatMessage({ id: granularity.labelId })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

export function BotPermissionTimeoutCard({
  bot,
  onPatchBot,
}: {
  bot: BotConfig;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const storedValue = bot.currentOptions.permissionTimeoutMinutes;
  const [draft, setDraft] = useState<string>(() =>
    storedValue !== undefined ? String(storedValue) : "",
  );

  // specs/bot-permissions.md §3a.1/D2（3.15.0 Track B）：保存成功回填或切换 Bot 时，
  // 草稿输入框跟随持久化值重置（空 = 读取时默认 10，不落盘写默认——W2 先例）。
  useEffect(() => {
    setDraft(storedValue !== undefined ? String(storedValue) : "");
  }, [bot.id, storedValue]);

  // 提交时经 shared 读取时归一（"7" ⇒ 7、越界 clamp [1,1440]、非法 ⇒ 10）；空值 = 恢复默认。
  const commitDraft = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (storedValue === undefined) return;
      onPatchBot({
        currentOptions: { ...bot.currentOptions, permissionTimeoutMinutes: undefined },
      });
      return;
    }
    const next = normalizePermissionTimeoutMinutes(trimmed);
    setDraft(String(next));
    if (storedValue === next) return;
    onPatchBot({ currentOptions: { ...bot.currentOptions, permissionTimeoutMinutes: next } });
  };

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "bots.permissionTimeout" })}
      description={intl.formatMessage({ id: "bots.permissionTimeout.description" })}
      control={
        <Input
          type="number"
          min={1}
          max={1440}
          step={1}
          inputMode="numeric"
          htmlSize={4}
          value={draft}
          placeholder="10"
          aria-label={intl.formatMessage({ id: "bots.permissionTimeout" })}
          className="w-24 text-right"
          onBlur={commitDraft}
          onChange={(event) => {
            // number 输入允许空值和科学计数法；保留空值便于编辑，只接收非负整数文本。
            const value = event.target.value;
            if (value === "" || /^\d+$/.test(value)) {
              setDraft(value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
      }
    />
  );
}

export function BotDangerCard({ onDelete }: { onDelete: () => void }) {
  const { intl } = useZCodeIntl();

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "bots.delete" })}
        description={intl.formatMessage({ id: "bots.delete.description" })}
        control={
          <Button
            variant="destructive"
            size="lg"
            onClick={onDelete}
            title={intl.formatMessage({ id: "bots.delete" })}
          >
            <Trash2 className="size-4" />
            {intl.formatMessage({ id: "bots.delete" })}
          </Button>
        }
      />
    </SettingsGroupCard>
  );
}
