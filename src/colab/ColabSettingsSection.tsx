import type { ColabChannelController, ColabProfileOption } from "./types";

export function ColabSettingsSection({
  colab,
  busy,
}: {
  colab: ColabChannelController;
  busy: boolean;
}) {
  if (!colab.enabled) return null;
  const status = colab.profileStatus;
  return (
    <>
      <label className="settings-field">
        <span>Colab ComfyUI 服务地址</span>
        <input
          type="url"
          disabled={busy}
          placeholder="https://xxxx.trycloudflare.com（可选）"
          value={colab.comfyUrlDraft}
          onChange={(event) => colab.setComfyUrlDraft(event.target.value)}
        />
        <small>
          填写 Colab 上运行中的 Cloudflare Tunnel 地址；Web 版仅通过服务器代理连接，并在节点选择 Colab 渠道时启用。留空则禁用 Colab 渠道。
        </small>
      </label>
      <label className="settings-field">
        <span>Colab SS 解码密码</span>
        <input
          type="text"
          disabled={busy}
          placeholder="5555（与 Colab SS_tools 节点一致，可留空）"
          value={colab.ssPasswordDraft}
          onChange={(event) => colab.setSsPasswordDraft(event.target.value)}
        />
        <small>
          用于提交给 Colab SS_tools 隐藏节点编码及服务端纯 Rust 自动提取 MP4。
        </small>
      </label>
      <label className="settings-field">
        <span>Colab 档位（兜底选择）</span>
        <div className="colab-profile-control-row">
          <select
            disabled={busy}
            value={colab.profileDraft}
            onChange={(event) => colab.setProfileDraft(event.currentTarget.value as ColabProfileOption)}
            aria-label="Colab 档位兜底选择"
          >
            <option value="">自动识别（推荐）</option>
            <option value="dasiwa">DaSiWa V5xs</option>
            <option value="cobijada">Cobijada</option>
          </select>
          <button
            type="button"
            className="dialog-cancel colab-profile-refresh-button"
            disabled={busy || colab.profileLoading}
            onClick={() => {
              void colab.refreshProfile();
            }}
          >
            {colab.profileLoading ? "检测中…" : "重新检测"}
          </button>
        </div>
        <small>
          {status?.configured
            ? status.available
              ? `当前实例在线：${status.label}（${status.source === "detected" ? "已自动识别" : "使用手动兜底"} · ${status.diffusionModelName.split("/").pop()}）`
              : `状态：${status.error ?? "当前实例不可用"}`
            : "默认自动读取 Colab 笔记本写入的身份文件；旧版实例可手动指定 DaSiWa V5xs 或 Cobijada。仅管理员可配置 Colab 地址，所有成员在实例在线时可使用。"}
        </small>
      </label>
    </>
  );
}
