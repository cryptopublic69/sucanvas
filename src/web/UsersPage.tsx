import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Copy, KeyRound, Pencil, Trash2, UserPlus, X } from "lucide-react";
import { userLabel, type WebUser } from "./account";
import {
  createUser, defaultTransferTarget, deleteUser, formatUserTime, generateTemporaryPassword, listUsers, resetUserPassword,
  setUserDisabled, setUserDisplayName, setUserRole, type ManagedUser,
} from "./adminUsers";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const roleLabel = (role: WebUser["role"]) => role === "admin" ? "管理员" : "成员";

type Dialog =
  | { kind: "create" }
  | { kind: "rename"; user: ManagedUser }
  | { kind: "reset"; user: ManagedUser }
  | { kind: "delete"; user: ManagedUser };
// Shown once after create/reset so the admin can hand the password over.
type Secret = { username: string; password: string; reason: string };

function DialogFrame({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="web-admin-dialog-backdrop" role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="web-admin-dialog">
        <header><h2>{title}</h2><button type="button" className="web-admin-icon" onClick={onClose} aria-label="关闭"><X size={16} /></button></header>
        {children}
      </div>
    </div>
  );
}

function TemporaryPasswordField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <label className="web-admin-field">
      临时密码
      <div className="web-admin-inline">
        <input value={value} onChange={(event) => onChange(event.currentTarget.value)} autoComplete="off" spellCheck={false}
          maxLength={128} disabled={disabled} placeholder="至少 4 个字符" />
        <button type="button" className="web-admin-secondary" onClick={() => onChange(generateTemporaryPassword())} disabled={disabled}>随机生成</button>
      </div>
      <small>对方首次登录时必须改成自己的密码。</small>
    </label>
  );
}

export function UsersPage({ actor, onClose }: { actor: WebUser; onClose: () => void }) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [copied, setCopied] = useState(false);
  // Dialog fields.
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<WebUser["role"]>("user");
  const [password, setPassword] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [dialogError, setDialogError] = useState("");

  const reload = useCallback(async () => {
    try { setUsers(await listUsers()); }
    catch (loadError) { setError(message(loadError)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (dialog || secret) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [dialog, secret, onClose]);

  const open = (next: Dialog) => {
    setDialogError(""); setNotice(""); setError("");
    if (next.kind === "create") { setUsername(""); setDisplayName(""); setRole("user"); setPassword(generateTemporaryPassword()); }
    if (next.kind === "rename") setDisplayName(next.user.displayName ?? "");
    if (next.kind === "reset") setPassword(generateTemporaryPassword());
    if (next.kind === "delete") setTransferTo(defaultTransferTarget(users ?? [], next.user.id, actor.id));
    setDialog(next);
  };
  // Runs one change; the list is always re-read from the server afterwards,
  // so what the page shows is what was saved.
  const run = async (change: () => Promise<string | void>, inDialog = false) => {
    setBusy(true); setError(""); setNotice(""); setDialogError("");
    try {
      const done = await change();
      if (inDialog) setDialog(null);
      if (done) setNotice(done);
    }
    catch (changeError) { if (inDialog) setDialogError(message(changeError)); else setError(message(changeError)); }
    finally { setBusy(false); await reload(); }
  };

  const submitDialog = () => {
    if (!dialog || busy) return;
    if (dialog.kind === "create") void run(async () => {
      const created = await createUser({ username, displayName, role, temporaryPassword: password });
      setSecret({ username: created.username, password, reason: "新账号已创建" });
      return `已创建用户 ${created.username}`;
    }, true);
    if (dialog.kind === "rename") void run(async () => {
      const renamed = await setUserDisplayName(dialog.user.id, displayName);
      return `已更新 ${renamed.username} 的显示名`;
    }, true);
    if (dialog.kind === "reset") void run(async () => {
      const reset = await resetUserPassword(dialog.user.id, password);
      setSecret({ username: reset.username, password, reason: "密码已重置，该用户已登录的设备全部退出" });
      return `已重置 ${reset.username} 的密码`;
    }, true);
    if (dialog.kind === "delete") void run(async () => {
      const deleted = await deleteUser(dialog.user.id, transferTo);
      return `已删除用户 ${deleted.username}，${deleted.transferredCanvases} 张画布已转给 ${deleted.transferredToUsername}`;
    }, true);
  };
  const copySecret = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.password); setCopied(true); }
    catch { setCopied(false); setError("浏览器不允许自动复制，请手动选中密码复制"); }
  };

  const dialogTitle = dialog && { create: "新建用户", rename: "修改显示名", reset: "重置密码", delete: "删除用户" }[dialog.kind];
  const deleting = dialog?.kind === "delete" ? dialog.user : null;
  return (
    <main className="web-admin-page" aria-label="用户管理">
      <header className="web-admin-header">
        <div>
          <span className="app-lock-eyebrow">SUCANVAS · 管理员</span>
          <h1>用户管理</h1>
        </div>
        <div className="web-admin-header-actions">
          <button type="button" className="web-admin-primary" onClick={() => open({ kind: "create" })} disabled={busy}><UserPlus size={15} aria-hidden="true" />新建用户</button>
          <button type="button" className="web-admin-icon" onClick={onClose} aria-label="关闭用户管理" title="关闭（Esc）"><X size={18} /></button>
        </div>
      </header>
      {error && <div className="web-admin-message is-error" role="alert">{error}</div>}
      {notice && <div className="web-admin-message" role="status">{notice}</div>}
      {users === null ? <p className="web-admin-empty">正在读取用户…</p> : (
        <table className="web-admin-table">
          <thead>
            <tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>待改密</th><th>创建时间</th><th aria-label="操作" /></tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const self = user.id === actor.id;
              return (
                <tr key={user.id} data-username={user.username} className={user.disabled ? "is-disabled" : ""}>
                  <td><strong>{user.username}</strong>{self && <span className="web-admin-badge">我</span>}</td>
                  <td>{user.displayName || <span className="web-admin-muted">—</span>}</td>
                  <td>
                    <select value={user.role} aria-label={`${user.username} 的角色`} disabled={busy || self}
                      title={self ? "不能修改自己的角色" : undefined}
                      onChange={(event) => { const next = event.currentTarget.value as WebUser["role"]; void run(async () => { await setUserRole(user.id, next); return `${user.username} 已改为${roleLabel(next)}`; }); }}>
                      <option value="user">成员</option>
                      <option value="admin">管理员</option>
                    </select>
                  </td>
                  <td><span className={`web-admin-status ${user.disabled ? "is-off" : "is-on"}`}>{user.disabled ? "已停用" : "正常"}</span></td>
                  <td>{user.mustChangePassword ? <span className="web-admin-status is-pending">待改密</span> : <span className="web-admin-muted">否</span>}</td>
                  <td className="web-admin-time">{formatUserTime(user.createdAt)}</td>
                  <td className="web-admin-actions">
                    <button type="button" onClick={() => open({ kind: "rename", user })} disabled={busy} title="修改显示名"><Pencil size={13} aria-hidden="true" />改名</button>
                    <button type="button" onClick={() => open({ kind: "reset", user })} disabled={busy} title="设置临时密码"><KeyRound size={13} aria-hidden="true" />重置密码</button>
                    <button type="button" disabled={busy || self} title={self ? "不能停用自己的账号" : undefined}
                      onClick={() => void run(async () => { await setUserDisabled(user.id, !user.disabled); return `${user.username} 已${user.disabled ? "启用" : "停用"}`; })}>
                      {user.disabled ? "启用" : "停用"}
                    </button>
                    <button type="button" className="is-danger" onClick={() => open({ kind: "delete", user })} disabled={busy || self}
                      title={self ? "不能删除自己的账号" : undefined}><Trash2 size={13} aria-hidden="true" />删除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {dialog && dialogTitle && (
        <DialogFrame title={dialogTitle} onClose={() => !busy && setDialog(null)}>
          <form onSubmit={(event) => { event.preventDefault(); submitDialog(); }}>
            {dialog.kind === "create" && <>
              <label className="web-admin-field">
                用户名
                <input value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoFocus autoComplete="off"
                  autoCapitalize="none" spellCheck={false} maxLength={32} disabled={busy} placeholder="3–32 位英文字母、数字或 _ - ." />
              </label>
              <label className="web-admin-field">
                显示名（可选）
                <input value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} maxLength={64} disabled={busy} />
              </label>
              <label className="web-admin-field">
                角色
                <select value={role} onChange={(event) => setRole(event.currentTarget.value as WebUser["role"])} disabled={busy}>
                  <option value="user">成员</option>
                  <option value="admin">管理员</option>
                </select>
              </label>
              <TemporaryPasswordField value={password} onChange={setPassword} disabled={busy} />
            </>}
            {dialog.kind === "rename" && (
              <label className="web-admin-field">
                {dialog.user.username} 的显示名（留空则显示用户名）
                <input value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} autoFocus maxLength={64} disabled={busy} />
              </label>
            )}
            {dialog.kind === "reset" && <>
              <p className="web-admin-hint">为 <strong>{userLabel(dialog.user)}</strong> 设置临时密码。保存后该用户已登录的设备全部退出。</p>
              <TemporaryPasswordField value={password} onChange={setPassword} disabled={busy} />
            </>}
            {deleting && <>
              <p className="web-admin-hint is-danger">删除 <strong>{userLabel(deleting)}</strong>（{deleting.username}）后无法恢复，该用户的登录立即失效。</p>
              <label className="web-admin-field">
                该用户的画布转给
                <select value={transferTo} onChange={(event) => setTransferTo(event.currentTarget.value)} disabled={busy} aria-label="画布转给">
                  {(users ?? []).filter((user) => user.id !== deleting.id).map((user) => (
                    <option key={user.id} value={user.id}>{user.username}{user.displayName ? `（${user.displayName}）` : ""} · {roleLabel(user.role)}{user.disabled ? " · 已停用" : ""}</option>
                  ))}
                </select>
                <small>私有画布和共享画布都会转过去，共享状态不变。</small>
              </label>
            </>}
            {dialogError && <div className="web-admin-message is-error" role="alert">{dialogError}</div>}
            <footer>
              <button type="button" className="web-admin-secondary" onClick={() => setDialog(null)} disabled={busy}>取消</button>
              <button type="submit" className={deleting ? "web-admin-danger" : "web-admin-primary"}
                disabled={busy || (dialog.kind === "create" && (!username.trim() || !password)) || (dialog.kind === "reset" && !password) || (!!deleting && !transferTo)}>
                {busy ? "正在保存…" : deleting ? "删除用户" : dialog.kind === "create" ? "创建" : "保存"}
              </button>
            </footer>
          </form>
        </DialogFrame>
      )}

      {secret && (
        <DialogFrame title="临时密码" onClose={() => { setSecret(null); setCopied(false); }}>
          <p className="web-admin-hint">{secret.reason}。请把下面的临时密码交给 <strong>{secret.username}</strong>，<strong>关闭后不会再显示</strong>。</p>
          <div className="web-admin-secret">
            <code>{secret.password}</code>
            <button type="button" className="web-admin-secondary" onClick={() => void copySecret()}><Copy size={14} aria-hidden="true" />{copied ? "已复制" : "复制"}</button>
          </div>
          <footer><button type="button" className="web-admin-primary" onClick={() => { setSecret(null); setCopied(false); }}>我已记下</button></footer>
        </DialogFrame>
      )}
    </main>
  );
}
