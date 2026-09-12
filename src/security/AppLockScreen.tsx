import { invoke } from "@tauri-apps/api/core";
import {
  Eye,
  EyeOff
} from "lucide-react";
import {
  useState
} from "react";
import suCanvasLogo from "../../src-tauri/icons/128x128@2x.png";

export function AppLockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const unlock = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const accepted = await invoke<boolean>("verify_app_lock_password", { password });
      if (!accepted) {
        setPassword("");
        setError("密码错误，请重新输入");
        return;
      }
      onUnlock();
    } catch (unlockError) {
      const message = unlockError instanceof Error ? unlockError.message : String(unlockError);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-lock-screen">
      <form
        className="app-lock-card"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <div className="app-lock-mark">
          <img src={suCanvasLogo} alt="" />
        </div>
        <span className="app-lock-eyebrow">SUCANVAS</span>
        <h1>应用已锁定</h1>
        <p>输入本机应用锁密码以继续。</p>
        <label>
          密码
          <div className="app-lock-screen-input">
            <input
              autoFocus
              type={passwordVisible ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoComplete="current-password"
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => setPasswordVisible((visible) => !visible)}
              title={passwordVisible ? "隐藏密码" : "显示密码"}
              aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
            >
              {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        <div className={`app-lock-screen-feedback ${error ? "is-error" : ""}`} aria-live="polite">
          {error || "密码只在本机验证"}
        </div>
        <button className="app-lock-unlock" type="submit" disabled={!password || busy}>
          {busy ? "正在验证…" : "解锁"}
        </button>
      </form>
    </main>
  );
}
