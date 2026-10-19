import { useCallback, useEffect, useMemo, useState } from "react";
import { FileAudio, FileVideo, File as FileIcon, RotateCcw, Trash2, X } from "lucide-react";
import { formatUserTime } from "./adminUsers";
import {
  categoryLabel, daysLeft, filterMedia, formatBytes, listMediaCleanup, outcomeMessage, previewKind, previewUrl, purgeMediaFiles,
  restoreMediaFiles, trashMediaFiles, type MediaFilter, type MediaItem, type MediaListing, type MediaOutcome,
} from "./adminMedia";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type Tab = "candidates" | "trash";
type Confirm = { kind: "trash" | "purge"; references: string[] };

function Preview({ item }: { item: MediaItem }) {
  const kind = previewKind(item.name);
  const url = previewUrl(item);
  if (kind === "image" && url) return <img className="web-media-thumb" src={url} alt="" loading="lazy" />;
  const Icon = kind === "video" ? FileVideo : kind === "audio" ? FileAudio : FileIcon;
  return <span className="web-media-thumb is-icon"><Icon size={18} aria-hidden="true" /></span>;
}

// Admin page: files no canvas has referenced for the grace period, and the
// trash. Every action is re-checked by the server and reported file by file.
export function MediaCleanupPage({ onClose }: { onClose: () => void }) {
  const [listing, setListing] = useState<MediaListing | null>(null);
  const [tab, setTab] = useState<Tab>("candidates");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<MediaFilter>({ category: "", user: "", sort: "size" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const reload = useCallback(async () => {
    try { setListing(await listMediaCleanup()); }
    catch (loadError) { setError(message(loadError)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (confirm) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [confirm, onClose]);

  const all = listing ? (tab === "candidates" ? listing.candidates : listing.trash) : [];
  const items = useMemo(() => filterMedia([...all], filter), [all, filter]);
  const names = useMemo(() => new Map([...(listing?.candidates ?? []), ...(listing?.trash ?? [])].map((item) => [item.reference, item.name])), [listing]);
  const chosen = items.filter((item) => selected.has(item.reference));
  const chosenBytes = chosen.reduce((sum, item) => sum + item.size, 0);
  const categories = [...new Set(all.map((item) => item.category))].sort();
  const switchTab = (next: Tab) => { setTab(next); setSelected(new Set()); setNotice(""); setError(""); };
  const toggle = (reference: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(reference)) next.delete(reference); else next.add(reference);
    return next;
  });
  const toggleAll = () => setSelected(chosen.length === items.length ? new Set() : new Set(items.map((item) => item.reference)));

  const run = async (action: string, change: () => Promise<MediaOutcome>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(outcomeMessage(action, await change(), names)); setConfirm(null); setSelected(new Set()); }
    catch (changeError) { setError(message(changeError)); setConfirm(null); }
    finally { setBusy(false); await reload(); }
  };
  const references = chosen.map((item) => item.reference);

  return (
    <main className="web-admin-page" aria-label="素材清理">
      <header className="web-admin-header">
        <div>
          <span className="app-lock-eyebrow">SUCANVAS · 管理员</span>
          <h1>素材清理</h1>
          {listing && <p className="web-media-summary" data-testid="media-summary">
            可清理 {listing.candidates.length} 个，共 {formatBytes(listing.candidateBytes)} · 回收区 {listing.trash.length} 个
            <span className="web-admin-muted">（无引用满 {listing.graceDays} 天才会列出；回收区保留 {listing.trashRetentionDays} 天后自动删除）</span>
          </p>}
        </div>
        <div className="web-admin-header-actions">
          <button type="button" className="web-admin-icon" onClick={onClose} aria-label="关闭素材清理" title="关闭（Esc）"><X size={18} /></button>
        </div>
      </header>
      <nav className="web-media-tabs" aria-label="素材分类">
        <button type="button" className={tab === "candidates" ? "is-active" : ""} onClick={() => switchTab("candidates")}>可清理</button>
        <button type="button" className={tab === "trash" ? "is-active" : ""} onClick={() => switchTab("trash")}>回收区</button>
      </nav>
      <div className="web-media-toolbar">
        <select aria-label="类型" value={filter.category} onChange={(event) => setFilter({ ...filter, category: event.currentTarget.value })}>
          <option value="">全部类型</option>
          {categories.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
        </select>
        <input aria-label="按用户筛选" placeholder="按用户筛选（创建者或删除者）" value={filter.user}
          onChange={(event) => setFilter({ ...filter, user: event.currentTarget.value })} />
        <select aria-label="排序" value={filter.sort} onChange={(event) => setFilter({ ...filter, sort: event.currentTarget.value as MediaFilter["sort"] })}>
          <option value="size">按大小</option>
          <option value="time">按时间</option>
          <option value="name">按文件名</option>
        </select>
        <span className="web-media-selection">已选 {chosen.length} 个（{formatBytes(chosenBytes)}）</span>
        {tab === "candidates"
          ? <button type="button" className="web-admin-primary" disabled={busy || !chosen.length}
            onClick={() => setConfirm({ kind: "trash", references })}><Trash2 size={14} aria-hidden="true" />移入回收区</button>
          : <>
            <button type="button" className="web-admin-secondary" disabled={busy || !chosen.length}
              onClick={() => void run("还原", () => restoreMediaFiles(references))}><RotateCcw size={14} aria-hidden="true" />还原</button>
            <button type="button" className="web-admin-danger" disabled={busy || !chosen.length}
              onClick={() => setConfirm({ kind: "purge", references })}><Trash2 size={14} aria-hidden="true" />彻底删除</button>
          </>}
      </div>
      {error && <div className="web-admin-message is-error" role="alert">{error}</div>}
      {notice && <div className="web-admin-message" role="status">{notice}</div>}
      {listing === null ? <p className="web-admin-empty">正在检查素材引用…</p> : items.length === 0
        ? <p className="web-admin-empty">{tab === "candidates" ? "没有可清理的素材" : "回收区是空的"}</p> : (
          <table className="web-admin-table web-media-table">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="全选" checked={chosen.length === items.length} onChange={toggleAll} /></th>
                <th aria-label="预览" /><th>文件名</th><th>大小</th><th>类型</th><th>原画布</th><th>创建者</th><th>谁删的</th>
                <th>{tab === "candidates" ? "无引用起始" : "移入回收区"}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.reference} data-reference={item.reference}>
                  <td><input type="checkbox" aria-label={`选择 ${item.name}`} checked={selected.has(item.reference)} onChange={() => toggle(item.reference)} /></td>
                  <td><Preview item={item} /></td>
                  <td><strong title={item.reference}>{item.name}</strong></td>
                  <td className="web-admin-time">{formatBytes(item.size)}</td>
                  <td>{categoryLabel(item.category)}</td>
                  <td>{item.canvasName ?? <span className="web-admin-muted">—</span>}</td>
                  <td>{item.createdBy ?? <span className="web-admin-muted">—</span>}</td>
                  <td>{item.releasedBy ?? <span className="web-admin-muted">—</span>}</td>
                  <td className="web-admin-time">{item.trashedAt
                    ? <>{formatUserTime(item.trashedAt)} <span className="web-admin-muted">· {daysLeft(item.trashedAt, listing.trashRetentionDays)} 天后删除</span></>
                    : formatUserTime(item.unreferencedSince)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {confirm && (
        <div className="web-admin-dialog-backdrop" role="dialog" aria-modal="true" aria-label={confirm.kind === "trash" ? "移入回收区" : "彻底删除"}
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); setConfirm(null); } }}>
          <div className="web-admin-dialog">
            <header><h2>{confirm.kind === "trash" ? "移入回收区" : "彻底删除"}</h2>
              <button type="button" className="web-admin-icon" onClick={() => !busy && setConfirm(null)} aria-label="关闭"><X size={16} /></button></header>
            {confirm.kind === "trash"
              ? <p className="web-admin-hint">把选中的 {confirm.references.length} 个文件（{formatBytes(chosenBytes)}）移入回收区。执行前服务器会再检查一遍，仍被画布引用的会跳过。回收区里的文件 {listing?.trashRetentionDays ?? 30} 天内可以还原。</p>
              : <p className="web-admin-hint is-danger">彻底删除选中的 {confirm.references.length} 个文件（{formatBytes(chosenBytes)}）。<strong>删除后无法恢复。</strong></p>}
            <footer>
              <button type="button" className="web-admin-secondary" onClick={() => setConfirm(null)} disabled={busy}>取消</button>
              <button type="button" className={confirm.kind === "trash" ? "web-admin-primary" : "web-admin-danger"} disabled={busy} autoFocus
                onClick={() => void run(confirm.kind === "trash" ? "移入回收区" : "彻底删除",
                  () => (confirm.kind === "trash" ? trashMediaFiles : purgeMediaFiles)(confirm.references))}>
                {busy ? "正在处理…" : confirm.kind === "trash" ? "移入回收区" : "确认彻底删除"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
