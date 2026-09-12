import {
  Eye,
  EyeOff,
  LockKeyhole
} from "lucide-react";

type SecuritySettingsPanelProps = {
  appLockEnabled: boolean;
  appLockStatusReady: boolean;
  appLockPasswordVisible: boolean;
  appLockCurrentPassword: string;
  setAppLockCurrentPassword: React.Dispatch<React.SetStateAction<string>>;
  saveAppLockPassword: () => Promise<void>;
  appLockBusy: boolean;
  setAppLockPasswordVisible: React.Dispatch<React.SetStateAction<boolean>>;
  appLockNewPassword: string;
  setAppLockNewPassword: React.Dispatch<React.SetStateAction<string>>;
  appLockConfirmPassword: string;
  setAppLockConfirmPassword: React.Dispatch<React.SetStateAction<string>>;
  appLockMessage: string;
  appLockMessageKind: "success" | "error";
  turnOffAppLock: () => Promise<void>;
};

export function SecuritySettingsPanel({
  appLockEnabled,
  appLockStatusReady,
  appLockPasswordVisible,
  appLockCurrentPassword,
  setAppLockCurrentPassword,
  saveAppLockPassword,
  appLockBusy,
  setAppLockPasswordVisible,
  appLockNewPassword,
  setAppLockNewPassword,
  appLockConfirmPassword,
  setAppLockConfirmPassword,
  appLockMessage,
  appLockMessageKind,
  turnOffAppLock,
}: SecuritySettingsPanelProps) {
  return (
    <section className="app-lock-settings settings-pane" aria-labelledby="app-lock-settings-title">
      <div className="app-lock-settings-heading">
        <span className="app-lock-settings-icon"><LockKeyhole size={16} /></span>
        <div>
          <strong id="app-lock-settings-title">本机应用锁</strong>
          <small>密码经 Argon2 加盐哈希后保存在本机，不会保存明文。</small>
        </div>
        <span className={`app-lock-status ${appLockEnabled ? "is-enabled" : ""}`}>
          {!appLockStatusReady ? "读取中" : appLockEnabled ? "已启用" : "未启用"}
        </span>
      </div>
      {appLockStatusReady && (
        <div className="app-lock-fields">
          {appLockEnabled && (
            <label>
              当前密码
              <div className="password-input-wrap">
                <input
                  type={appLockPasswordVisible ? "text" : "password"}
                  value={appLockCurrentPassword}
                  onChange={(event) => setAppLockCurrentPassword(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveAppLockPassword();
                    }
                  }}
                  autoComplete="current-password"
                  disabled={appLockBusy}
                />
                <button
                  type="button"
                  onClick={() => setAppLockPasswordVisible((visible) => !visible)}
                  title={appLockPasswordVisible ? "隐藏密码" : "显示密码"}
                  aria-label={appLockPasswordVisible ? "隐藏密码" : "显示密码"}
                >
                  {appLockPasswordVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>
          )}
          <div className="app-lock-new-passwords">
            <label>
              {appLockEnabled ? "新密码" : "设置密码"}
              <input
                type={appLockPasswordVisible ? "text" : "password"}
                value={appLockNewPassword}
                onChange={(event) => setAppLockNewPassword(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveAppLockPassword();
                  }
                }}
                autoComplete="new-password"
                placeholder="至少 4 个字符"
                maxLength={128}
                disabled={appLockBusy}
              />
            </label>
            <label>
              确认新密码
              <input
                type={appLockPasswordVisible ? "text" : "password"}
                value={appLockConfirmPassword}
                onChange={(event) => setAppLockConfirmPassword(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveAppLockPassword();
                  }
                }}
                autoComplete="new-password"
                maxLength={128}
                disabled={appLockBusy}
              />
            </label>
          </div>
          {appLockMessage && (
            <p className={`app-lock-message is-${appLockMessageKind}`} role="status">
              {appLockMessage}
            </p>
          )}
          <div className="app-lock-actions">
            {appLockEnabled && (
              <button
                type="button"
                className="app-lock-disable"
                onClick={() => void turnOffAppLock()}
                disabled={appLockBusy || !appLockCurrentPassword}
              >
                关闭应用锁
              </button>
            )}
            <button
              type="button"
              className="app-lock-save"
              onClick={() => void saveAppLockPassword()}
              disabled={appLockBusy || !appLockNewPassword || !appLockConfirmPassword || (appLockEnabled && !appLockCurrentPassword)}
            >
              {appLockBusy ? "处理中…" : appLockEnabled ? "修改密码" : "启用应用锁"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
