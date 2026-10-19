import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, HardDrive, KeyRound, LogOut, UserRound, Users } from "lucide-react";
import suCanvasLogo from "../../src-tauri/icons/128x128@2x.png";
import { changeOwnPassword, newPasswordProblem, signIn, userLabel, type WebUser } from "./account";
import { formatBytes, listMediaCleanup } from "./adminMedia";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function PasswordInput({ value, onChange, visible, onToggle, autoComplete, autoFocus, disabled }: {
  value: string; onChange: (value: string) => void; visible: boolean; onToggle?: () => void;
  autoComplete: string; autoFocus?: boolean; disabled: boolean;
}) {
  return (
    <div className="app-lock-screen-input">
      <input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.currentTarget.value)}
        autoComplete={autoComplete} autoFocus={autoFocus} disabled={disabled} maxLength={128} />
      {onToggle && (
        <button type="button" onClick={onToggle} title={visible ? "隐藏密码" : "显示密码"} aria-label={visible ? "隐藏密码" : "显示密码"}>
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      )}
    </div>
  );
}

export function LoginScreen({ onSignedIn, notice }: { onSignedIn: (user: WebUser) => Promise<void>; notice?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true); setError("");
    try { await onSignedIn(await signIn(username, password)); }
    catch (signInError) { setPassword(""); setError(message(signInError)); }
    finally { setBusy(false); }
  };
  return (
    <main className="app-lock-screen">
      <form className="app-lock-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="app-lock-mark"><img src={suCanvasLogo} alt="" /></div>
        <span className="app-lock-eyebrow">SUCANVAS</span>
        <h1>登录</h1>
        <p>使用管理员分配的账号访问画布。</p>
        <label>
          用户名
          <div className="app-lock-screen-input">
            <input value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="username"
              autoCapitalize="none" spellCheck={false} autoFocus disabled={busy} maxLength={32} />
          </div>
        </label>
        <label className="web-account-field">
          密码
          <PasswordInput value={password} onChange={setPassword} visible={visible} onToggle={() => setVisible((value) => !value)}
            autoComplete="current-password" disabled={busy} />
        </label>
        <div className={`app-lock-screen-feedback ${error ? "is-error" : ""}`} aria-live="polite">{error || notice || "账号由管理员创建，忘记密码请联系管理员重置"}</div>
        <button className="app-lock-unlock" type="submit" disabled={!username.trim() || !password || busy}>{busy ? "正在登录…" : "登录"}</button>
      </form>
    </main>
  );
}

// `forced`: first sign-in or after an admin reset; the only way out is changing or signing out.
export function PasswordChangeScreen({ user, forced, onDone, onCancel, onSignOut }: {
  user: WebUser | null; forced: boolean; onDone: (user: WebUser) => Promise<void> | void; onCancel?: () => void; onSignOut?: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy) return;
    const problem = newPasswordProblem(next, confirmation);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try { await onDone(await changeOwnPassword(current, next)); }
    catch (changeError) { setError(message(changeError)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (forced || !onCancel) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [forced, onCancel]);
  return (
    <main className={`app-lock-screen ${forced ? "" : "web-password-dialog"}`} role={forced ? undefined : "dialog"} aria-modal={forced ? undefined : true}>
      <form className="app-lock-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <span className="app-lock-eyebrow">{userLabel(user) || "SUCANVAS"}</span>
        <h1>{forced ? "请设置新密码" : "修改密码"}</h1>
        <p>{forced ? "这是管理员设置的临时密码，设置自己的新密码后才能继续使用。" : "修改后，此账号在其他设备上的登录会退出。"}</p>
        <label>
          {forced ? "临时密码" : "当前密码"}
          <PasswordInput value={current} onChange={setCurrent} visible={visible} onToggle={() => setVisible((value) => !value)}
            autoComplete="current-password" autoFocus disabled={busy} />
        </label>
        <label className="web-account-field">
          新密码
          <PasswordInput value={next} onChange={setNext} visible={visible} autoComplete="new-password" disabled={busy} />
        </label>
        <label className="web-account-field">
          确认新密码
          <PasswordInput value={confirmation} onChange={setConfirmation} visible={visible} autoComplete="new-password" disabled={busy} />
        </label>
        <div className={`app-lock-screen-feedback ${error ? "is-error" : ""}`} aria-live="polite">{error || "至少 4 个字符"}</div>
        <button className="app-lock-unlock" type="submit" disabled={!current || !next || !confirmation || busy}>{busy ? "正在保存…" : "保存新密码"}</button>
        {forced
          ? onSignOut && <button className="web-account-secondary" type="button" onClick={onSignOut} disabled={busy}>退出登录</button>
          : onCancel && <button className="web-account-secondary" type="button" onClick={onCancel} disabled={busy}>取消</button>}
      </form>
    </main>
  );
}

// `onManageUsers` / `onCleanMedia` are passed for admins only; regular users never get the entries.
export function UserMenu({ user, onChangePassword, onManageUsers, onCleanMedia, onSignOut }: {
  user: WebUser; onChangePassword: () => void; onManageUsers?: () => void; onCleanMedia?: () => void; onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  // "可清理 N 个 · X": read when the admin opens the menu.
  const [cleanable, setCleanable] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !onCleanMedia) return;
    let cancelled = false;
    void listMediaCleanup()
      .then((listing) => { if (!cancelled) setCleanable(listing.candidates.length ? `${listing.candidates.length} 个 · ${formatBytes(listing.candidateBytes)}` : ""); })
      .catch(() => { if (!cancelled) setCleanable(""); });
    return () => { cancelled = true; };
  }, [open, onCleanMedia]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);
  const label = userLabel(user);
  return (
    <div className="web-user-menu" ref={root}>
      {open && (
        <div className="web-user-menu-popup" role="menu">
          <div className="web-user-menu-header">
            <strong>{label}</strong>
            <small>{user.displayName ? `${user.username} · ` : ""}{user.role === "admin" ? "管理员" : "成员"}</small>
          </div>
          {onManageUsers && <button type="button" role="menuitem" onClick={() => { setOpen(false); onManageUsers(); }}><Users size={14} aria-hidden="true" />用户管理</button>}
          {onCleanMedia && <button type="button" role="menuitem" onClick={() => { setOpen(false); onCleanMedia(); }}><HardDrive size={14} aria-hidden="true" />素材清理
            {cleanable && <span className="web-admin-badge" data-testid="media-badge">{cleanable}</span>}</button>}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onChangePassword(); }}><KeyRound size={14} aria-hidden="true" />修改密码</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}><LogOut size={14} aria-hidden="true" />退出登录</button>
        </div>
      )}
      <button className="web-logout" type="button" title={label} aria-label={`用户菜单：${label}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <UserRound size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
