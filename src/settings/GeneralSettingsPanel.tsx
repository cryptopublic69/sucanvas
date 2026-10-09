import type {
  UiFontSize
} from "../CanvasNode";

type GeneralSettingsPanelProps = {
  comfySettingsBusy?: boolean;
  comfySettingsError?: string;
  uiFontSize: UiFontSize;
  setUiFontSize: React.Dispatch<React.SetStateAction<UiFontSize>>;
  comfyUiServerUrlDraft: string;
  setComfyUiServerUrlDraft: React.Dispatch<React.SetStateAction<string>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  comfyInputRootDraft: string;
  setComfyInputRootDraft: React.Dispatch<React.SetStateAction<string>>;
  comfyOutputRootDraft: string;
  setComfyOutputRootDraft: React.Dispatch<React.SetStateAction<string>>;
};

export function GeneralSettingsPanel({
  comfySettingsBusy = false,
  comfySettingsError = "",
  uiFontSize,
  setUiFontSize,
  comfyUiServerUrlDraft,
  setComfyUiServerUrlDraft,
  setSettingsOpen,
  comfyInputRootDraft,
  setComfyInputRootDraft,
  comfyOutputRootDraft,
  setComfyOutputRootDraft,
}: GeneralSettingsPanelProps) {
  return (
    <section className="settings-pane general-settings-pane" aria-labelledby="general-settings-title">
      <div className="settings-pane-heading">
        <h3 id="general-settings-title">基础设置</h3>
        <p>{import.meta.env.MODE === "web" ? "配置画布服务器连接的 ComfyUI 地址与映射目录，保存后立即生效。" : "配置远程 ComfyUI 的服务地址与 Windows 映射路径。"}</p>
      </div>
      <section className="general-settings-group" aria-labelledby="appearance-settings-title">
        <div className="general-settings-group-heading">
          <h4 id="appearance-settings-title">界面</h4>
          <p>调整应用中的文字与控件显示密度。</p>
        </div>
        <section className="ui-font-size-setting" aria-labelledby="ui-font-size-setting-title">
          <div>
            <strong id="ui-font-size-setting-title">界面字号</strong>
            <small>中字号会同步扩大文字、控件高度和菜单间距。</small>
          </div>
          <div className="ui-font-size-options" role="radiogroup" aria-label="界面字号">
            {(["small", "medium"] as const).map((size) => (
              <button
                key={size}
                type="button"
                role="radio"
                aria-checked={uiFontSize === size}
                className={uiFontSize === size ? "is-active" : ""}
                onClick={() => setUiFontSize(size)}
              >
                <span aria-hidden="true">Aa</span>
                {size === "small" ? "小" : "中"}
              </button>
            ))}
          </div>
        </section>
      </section>
      <section className="general-settings-group comfyui-settings-group" aria-label="ComfyUI 配置">
        {comfySettingsError && <p role="alert">{comfySettingsError}</p>}
        <div className="comfyui-settings-fields">
          <label>
            ComfyUI 服务地址
            <input
              disabled={comfySettingsBusy}
              value={comfyUiServerUrlDraft}
              onChange={(event) => setComfyUiServerUrlDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSettingsOpen(false);
                }
              }}
              placeholder="例如：http://192.168.5.108:8188"
              spellCheck={false}
            />
            <small>
              {import.meta.env.MODE === "web" ? "填写实际的 ComfyUI 地址，例如 http://192.168.5.108:8188。浏览器通过画布服务器连接，保存后新请求使用此地址。" : "ComfyUI 网页与 API 的服务地址。保存后，生成提交、队列、预览和进度连接都会改用此地址。"}
            </small>
          </label>
          <label>
            ComfyUI 输入映射目录
            <input
              disabled={comfySettingsBusy}
              value={comfyInputRootDraft}
              onChange={(event) => setComfyInputRootDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSettingsOpen(false);
                }
              }}
              placeholder="例如：X:\ComfyUI_windows_portable\ComfyUI\input"
              spellCheck={false}
            />
            <small>
              {import.meta.env.MODE === "web" ? "填写运行 Web 后端的机器可访问的 ComfyUI input 根目录，用于任务结束后清理输入文件。不要包含 infinite-canvas；留空则不自动清理。" : <>请填写 ComfyUI 的 input 根目录，例如
              X:\ComfyUI_windows_portable\ComfyUI\input。不要包含 infinite-canvas；程序会自动创建并在任务结束后清理
              infinite-canvas\任务ID。留空则不自动清理。</>}
            </small>
          </label>
          <label>
            ComfyUI 输出映射目录
            <input
              disabled={comfySettingsBusy}
              value={comfyOutputRootDraft}
              onChange={(event) => setComfyOutputRootDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSettingsOpen(false);
                }
              }}
              placeholder="例如：X:\ComfyUI_windows_portable\ComfyUI\output"
              spellCheck={false}
            />
            <small>
              {import.meta.env.MODE === "web" ? "填写运行 Web 后端的机器可访问的 ComfyUI output 根目录。生成结果会保存在画布服务器，仅需要直接读取 ComfyUI 文件时填写；可以留空。" : "请选择或填写远端 ComfyUI 的 output 根目录，不要包含生成任务的子文件夹和文件名。"}
            </small>
          </label>
        </div>
      </section>
    </section>
  );
}
