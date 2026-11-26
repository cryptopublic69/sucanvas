import { useState, type ReactElement } from "react";
import type { ColabNodeContext } from "../colab/types";
import {
  buildVideoChannelSelectOptions,
  clampExternalDuration,
  externalModeLabel,
  resolveExternalModelSpec,
} from "./catalog";
import type {
  ExternalProvidersNodeContext,
  ExternalVideoProviderId,
  VideoExecutionChannel,
} from "./types";

export interface SelectOptionItem {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
}

export type ChannelSelectComponent = (props: {
  value: string;
  options: SelectOptionItem[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
}) => ReactElement;

export function VideoChannelSelect({
  colab,
  channel,
  onSelect,
  Select,
}: {
  colab?: ColabNodeContext;
  channel: VideoExecutionChannel;
  onSelect: (nextChannel: VideoExecutionChannel) => void;
  Select: ChannelSelectComponent;
}) {
  if (import.meta.env.MODE !== "web") return null;
  const options = buildVideoChannelSelectOptions({
    colabEnabled: Boolean(colab?.enabled),
    colabAvailable: Boolean(colab?.available),
    colabConfigured: Boolean(colab?.configured),
    colabStatusLabel: colab?.profileStatus?.label,
    colabError: colab?.profileStatus?.error,
  });
  return (
    <div
      className="video-workflow-module-select video-channel-select"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span>执行渠道</span>
      <Select
        value={channel}
        ariaLabel="视频执行渠道"
        title="选择视频生成执行渠道（Colab 不可用时置灰，其他渠道可直接选择）"
        options={options}
        onChange={(value) => onSelect(value as VideoExecutionChannel)}
      />
    </div>
  );
}

export function ExternalProviderVideoFields({
  provider,
  content,
  providersContext,
  Select,
  onUpdateContent,
}: {
  provider: ExternalVideoProviderId;
  content: Record<string, unknown>;
  providersContext?: ExternalProvidersNodeContext;
  Select: ChannelSelectComponent;
  onUpdateContent: (patch: Record<string, unknown>) => void;
}) {
  const [busyAction, setBusyAction] = useState<"confirm" | "cancel" | null>(null);
  const [actionError, setActionError] = useState("");
  const snapshot = providersContext?.providersById[provider];
  const models = snapshot?.models ?? [];
  const spec = resolveExternalModelSpec(provider, content.externalModelId, snapshot);

  const selectedResolution = typeof content.externalResolution === "string"
    && spec.resolutions.includes(content.externalResolution)
    ? content.externalResolution
    : spec.defaultResolution;

  const selectedMode = typeof content.externalMode === "string"
    && spec.modes.includes(content.externalMode)
    ? content.externalMode
    : spec.modes[0] ?? "auto";

  const enableSound = content.externalEnableSound !== false;
  const jobId = typeof content.externalJobId === "string" ? content.externalJobId : "";
  const isAwaitingConfirmation = content.status === "awaiting_confirmation"
    || content.externalJobStatus === "awaiting_confirmation";
  const quoteSummary = typeof content.externalQuoteSummary === "string"
    ? content.externalQuoteSummary
    : "";

  return (
    <div className="external-provider-fields" onPointerDown={(event) => event.stopPropagation()}>
      <div className="video-workflow-module-select">
        <span>平台状态</span>
        <div
          className={`external-provider-status-pill ${snapshot?.ready ? "is-ready" : "is-warn"}`}
          title={snapshot?.error ?? snapshot?.statusText ?? "点击设置可查看服务器 CLI 状态"}
        >
          <span className="external-provider-dot" aria-hidden="true" />
          <span>{snapshot?.statusText ?? "服务器可用渠道"}</span>
        </div>
      </div>

      <div className="video-workflow-module-select">
        <span>选择模型</span>
        <Select
          value={spec.id}
          ariaLabel="外部平台 Seedance 模型"
          options={models.map((m) => ({
            value: m.id,
            label: m.label,
            title: `Seedance ${m.series} · ${m.minDuration}-${m.maxDuration}秒`,
          }))}
          onChange={(modelId) => {
            const nextSpec = resolveExternalModelSpec(provider, modelId, snapshot);
            const currentDuration = typeof content.generationDuration === "number"
              ? content.generationDuration
              : nextSpec.defaultDuration;
            onUpdateContent({
              externalModelId: nextSpec.id,
              externalResolution: nextSpec.resolutions.includes(selectedResolution)
                ? selectedResolution
                : nextSpec.defaultResolution,
              externalMode: nextSpec.modes.includes(selectedMode)
                ? selectedMode
                : (nextSpec.modes[0] ?? "auto"),
              generationDuration: clampExternalDuration(currentDuration, nextSpec),
              status: "idle",
              validationMessage: "",
            });
          }}
        />
      </div>

      <div className="video-workflow-module-select">
        <span>分辨率</span>
        {spec.resolutions.length > 1 ? (
          <Select
            value={selectedResolution}
            ariaLabel="外部平台视频分辨率"
            options={spec.resolutions.map((res) => ({
              value: res,
              label: res === "auto" ? "自动（平台默认）" : res.toUpperCase(),
            }))}
            onChange={(resolution) => onUpdateContent({
              externalResolution: resolution,
              status: "idle",
              validationMessage: "",
            })}
          />
        ) : (
          <div
            className="video-locked-value external-provider-locked-value"
            title="当前模型仅支持默认固定分辨率"
          >
            {selectedResolution === "auto"
              ? "自动（由平台决定）"
              : `${selectedResolution.toUpperCase()}（默认固定）`}
          </div>
        )}
      </div>

      <div className="video-workflow-module-select">
        <span>生成模式</span>
        {spec.modes.length > 1 ? (
          <Select
            value={selectedMode}
            ariaLabel="外部平台视频生成模式"
            options={spec.modes.map((mode) => ({
              value: mode,
              label: externalModeLabel(mode),
            }))}
            onChange={(mode) => onUpdateContent({
              externalMode: mode,
              status: "idle",
              validationMessage: "",
            })}
          />
        ) : (
          <div
            className="video-locked-value external-provider-locked-value"
            title="当前平台使用默认生成模式"
          >
            {externalModeLabel(selectedMode)}
          </div>
        )}
      </div>

      {spec.supportsAudioToggle && (
        <div className="video-workflow-module-select">
          <span>原生音频</span>
          <div className="video-channel-options" role="radiogroup" aria-label="原生音频开关">
            <button
              type="button"
              role="radio"
              aria-checked={enableSound}
              className={enableSound ? "is-active" : ""}
              onClick={() => onUpdateContent({ externalEnableSound: true })}
            >
              开启
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!enableSound}
              className={!enableSound ? "is-active" : ""}
              onClick={() => onUpdateContent({ externalEnableSound: false })}
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {isAwaitingConfirmation && jobId && providersContext && (
        <div className="external-provider-confirm-card" role="region" aria-label="积分确认">
          <p>{quoteSummary || "该平台已计算积分消耗，请确认是否继续生成"}</p>
          {actionError && <small className="external-provider-error">{actionError}</small>}
          <div className="external-provider-confirm-actions">
            <button
              type="button"
              className="external-confirm-btn is-primary"
              disabled={busyAction !== null}
              onClick={async () => {
                setBusyAction("confirm");
                setActionError("");
                try {
                  await providersContext.onConfirmJob(jobId);
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusyAction(null);
                }
              }}
            >
              {busyAction === "confirm" ? "确认中…" : "确认消耗并生成"}
            </button>
            <button
              type="button"
              className="external-confirm-btn"
              disabled={busyAction !== null}
              onClick={async () => {
                setBusyAction("cancel");
                setActionError("");
                try {
                  await providersContext.onCancelJob(jobId);
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusyAction(null);
                }
              }}
            >
              {busyAction === "cancel" ? "取消中…" : "取消"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ExternalProviderPlaceholderActions({
  content,
  providersContext,
}: {
  content: Record<string, unknown>;
  providersContext?: ExternalProvidersNodeContext;
}) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const jobId = typeof content.externalJobId === "string" ? content.externalJobId : "";
  if (content.status !== "awaiting_confirmation" || !jobId || !providersContext) {
    return null;
  }
  return (
    <div
      className="nodrag external-placeholder-confirm-bar"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="external-confirm-btn is-primary"
        disabled={busy !== null}
        onClick={async () => {
          setBusy("confirm");
          try {
            await providersContext.onConfirmJob(jobId);
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "confirm" ? "确认中…" : "确认并开始生成"}
      </button>
      <button
        type="button"
        className="external-confirm-btn"
        disabled={busy !== null}
        onClick={async () => {
          setBusy("cancel");
          try {
            await providersContext.onCancelJob(jobId);
          } finally {
            setBusy(null);
          }
        }}
      >
        取消
      </button>
    </div>
  );
}

export function ExternalProviderSnapshotInfo({
  snapshot,
}: {
  snapshot: Record<string, unknown>;
}) {
  const providerLabel = typeof snapshot.externalProviderLabel === "string"
    ? snapshot.externalProviderLabel
    : "";
  const modelLabel = typeof snapshot.externalModelLabel === "string"
    ? snapshot.externalModelLabel
    : "";
  const resolution = typeof snapshot.externalResolution === "string"
    ? snapshot.externalResolution
    : "";
  const mode = typeof snapshot.externalMode === "string"
    ? snapshot.externalMode
    : "";
  const credits = typeof snapshot.externalQuotedCredits === "number"
    ? snapshot.externalQuotedCredits
    : null;
  if (!providerLabel) return null;
  return (
    <section className="generated-video-stage-info">
      <h4>外部平台参数</h4>
      <dl>
        <dt>执行平台</dt>
        <dd>{providerLabel}</dd>
        {modelLabel && (
          <>
            <dt>生成模型</dt>
            <dd>{modelLabel}</dd>
          </>
        )}
        {resolution && (
          <>
            <dt>分辨率</dt>
            <dd>{resolution.toUpperCase()}</dd>
          </>
        )}
        {mode && (
          <>
            <dt>生成模式</dt>
            <dd>{externalModeLabel(mode)}</dd>
          </>
        )}
        {credits !== null && (
          <>
            <dt>报价积分</dt>
            <dd>{credits}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
