import { useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import App from "../App";
import { closeEvents, request } from "./bridge";
import { flushSettings, loadSettings } from "./settings";
import { AppLockScreen } from "../security/AppLockScreen";
import "./web.css";

export default function WebRoot() {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void request("/api/auth/session").then(loadSettings).then(() => { if (!cancelled) setReady(true); }).catch(() => {}).finally(() => { if (!cancelled) setChecking(false); });
    const expired = () => { closeEvents(); setReady(false); setError("访问会话已过期，请重新解锁"); };
    const failure = (event: globalThis.Event) => setError(String((event as CustomEvent).detail));
    window.addEventListener("sucanvas:session-expired", expired);
    window.addEventListener("sucanvas:web-error", failure);
    return () => { cancelled = true; window.removeEventListener("sucanvas:session-expired", expired); window.removeEventListener("sucanvas:web-error", failure); closeEvents(); };
  }, []);
  async function unlock() {
    setChecking(true); setError("");
    try { await loadSettings(); setReady(true); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setChecking(false); }
  }
  async function logout() { await flushSettings(); await request("/api/auth/logout", { method: "POST" }); closeEvents(); setReady(false); }
  if (checking) return <main className="app-lock-screen is-loading"><p>正在连接画布…</p></main>;
  return <>{ready ? <><App /><button className="web-logout" type="button" title="退出并锁定" aria-label="退出并锁定" onClick={() => void logout().catch((error) => setError(String(error)))}><LockKeyhole size={16} aria-hidden="true" /></button></>
    : <AppLockScreen onUnlock={() => void unlock()} />}
    {error && <div className="web-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
  </>;
}
