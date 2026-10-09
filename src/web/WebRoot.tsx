import { useEffect, useState } from "react";
import App from "../App";
import { closeEvents, request } from "./bridge";
import { flushSettings, loadSettings } from "./settings";
import logo from "../../src-tauri/icons/128x128@2x.png";
import "./web.css";

export default function WebRoot() {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void request("/api/auth/session").then(loadSettings).then(() => setReady(true)).catch(() => {}).finally(() => setChecking(false));
    const expired = () => { closeEvents(); setReady(false); setError("登录已过期，请重新登录"); };
    const failure = (event: globalThis.Event) => setError(String((event as CustomEvent).detail));
    window.addEventListener("sucanvas:session-expired", expired);
    window.addEventListener("sucanvas:web-error", failure);
    return () => { window.removeEventListener("sucanvas:session-expired", expired); window.removeEventListener("sucanvas:web-error", failure); closeEvents(); };
  }, []);
  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      setPassword(""); await loadSettings(); setReady(true);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function logout() { await flushSettings(); await request("/api/auth/logout", { method: "POST" }); closeEvents(); setReady(false); }
  if (checking) return <main className="web-login"><p>正在连接画布…</p></main>;
  if (!ready) return <main className="web-login"><form onSubmit={login} className="web-login-card">
    <img src={logo} alt="" /><h1>SuCanvas</h1><p>登录你的画布</p>
    <label htmlFor="web-password">密码</label>
    <input id="web-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
    {error && <p role="alert">{error}</p>}<button type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
  </form></main>;
  return <><App /><button className="web-logout" type="button" onClick={() => void logout().catch((error) => setError(String(error)))}>退出登录</button>
    {error && <div className="web-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
  </>;
}
