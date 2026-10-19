import { useCallback, useEffect, useState } from "react";
import App from "../App";
import { closeEvents } from "./bridge";
import { flushSettings, loadSettings } from "./settings";
import { currentSession, signOut, stageFor, switchEditMode, type WebUser } from "./account";
import { LoginScreen, PasswordChangeScreen, UserMenu } from "./AccountScreens";
import { UsersPage } from "./UsersPage";
import { MediaCleanupPage } from "./MediaCleanupPage";
import { registerAssignableUsersHandler, registerEditModeHandler, setAccessUser } from "../account/access";
import { listUsers } from "./adminUsers";
import "./web.css";

// "password": the account must replace its temporary password before using the canvas.
type Stage = "checking" | "login" | "password" | "ready";
// Admin pages reopen after a reload: "#users" user management, "#media" media cleanup.
type AdminPage = "users" | "media";
const ADMIN_HASHES: Record<string, AdminPage> = { "#users": "users", "#media": "media" };
function showAdminHash(page: AdminPage | null) {
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", page ? `${pathname}${search}#${page}` : `${pathname}${search}`);
}

export default function WebRoot() {
  const [stage, setStage] = useState<Stage>("checking");
  const [user, setUser] = useState<WebUser | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adminPage, setAdminPage] = useState<AdminPage | null>(null);
  // The same decision runs after sign-in, after a forced change and on reload,
  // so a refreshed page lands where the action left it.
  const enter = useCallback(async (next: WebUser, editModeSeconds: number | null = null) => {
    setUser(next);
    // The canvas reads role and edit mode from here; settings decide where to save.
    setAccessUser(next, editModeSeconds);
    if (stageFor(next) === "password") { closeEvents(); setStage("password"); return; }
    await loadSettings();
    const page = ADMIN_HASHES[window.location.hash];
    if (page) {
      if (next.role === "admin") setAdminPage(page); else showAdminHash(null);
    }
    setStage("ready");
  }, []);
  const leave = useCallback(() => { closeEvents(); setUser(null); setAccessUser(null); setChangingPassword(false); setAdminPage(null); setStage("login"); }, []);
  const showAdminPage = (page: AdminPage | null) => { setAdminPage(page); showAdminHash(page); };
  useEffect(() => {
    let cancelled = false;
    registerEditModeHandler(switchEditMode);
    // "画布设置" owner list: enabled accounts (the server refuses disabled ones too).
    registerAssignableUsersHandler(async () => (await listUsers()).filter((user) => !user.disabled));
    void currentSession().then((session) => cancelled ? undefined : enter(session.user, session.editModeRemainingSeconds ?? null)).catch(() => { if (!cancelled) setStage("login"); });
    const expired = () => { leave(); setNotice("登录已失效，请重新登录"); };
    const passwordRequired = () => { closeEvents(); setChangingPassword(false); setStage("password"); };
    const failure = (event: globalThis.Event) => setError(String((event as CustomEvent).detail));
    window.addEventListener("sucanvas:session-expired", expired);
    window.addEventListener("sucanvas:password-change-required", passwordRequired);
    window.addEventListener("sucanvas:web-error", failure);
    return () => {
      cancelled = true;
      registerEditModeHandler(null);
      registerAssignableUsersHandler(null);
      window.removeEventListener("sucanvas:session-expired", expired);
      window.removeEventListener("sucanvas:password-change-required", passwordRequired);
      window.removeEventListener("sucanvas:web-error", failure);
      closeEvents();
    };
  }, [enter, leave]);
  async function logout() {
    // Settings are only writable with full access; a forced-change session has none.
    if (stage === "ready") await flushSettings();
    await signOut();
    leave(); setNotice("");
  }
  const signOutSafely = () => void logout().catch((logoutError) => setError(String(logoutError)));
  if (stage === "checking") return <main className="app-lock-screen is-loading"><p>正在连接画布…</p></main>;
  return <>
    {stage === "login" && <LoginScreen notice={notice} onSignedIn={async (next) => { setNotice(""); await enter(next); }} />}
    {stage === "password" && <PasswordChangeScreen forced user={user} onDone={(next) => enter(next)} onSignOut={signOutSafely} />}
    {stage === "ready" && user && <>
      <App />
      <UserMenu user={user} onChangePassword={() => setChangingPassword(true)} onSignOut={signOutSafely}
        onManageUsers={user.role === "admin" ? () => showAdminPage("users") : undefined}
        onCleanMedia={user.role === "admin" ? () => showAdminPage("media") : undefined} />
      {adminPage === "users" && user.role === "admin" && <UsersPage actor={user} onClose={() => showAdminPage(null)} />}
      {adminPage === "media" && user.role === "admin" && <MediaCleanupPage onClose={() => showAdminPage(null)} />}
      {changingPassword && <PasswordChangeScreen forced={false} user={user}
        onDone={(next) => { setUser(next); setChangingPassword(false); setError(""); setNotice("密码已修改，此账号在其他设备上的登录已退出"); }}
        onCancel={() => setChangingPassword(false)} />}
      {notice && <div className="web-notice" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}
    </>}
    {error && <div className="web-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
  </>;
}
