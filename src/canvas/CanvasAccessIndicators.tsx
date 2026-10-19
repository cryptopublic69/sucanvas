// Read-only state and "who else is here" as compact toolbar items (UI change
// after CANVAS-012c3): a lock chip whose popover holds the owner and the edit
// mode switch, and initials avatars for the other users on this canvas.
// Nothing floats over the canvas any more.
import { useEffect, useRef, useState } from "react";
import { Lock, PencilLine } from "lucide-react";
import { presenceAvatars, presenceLabel, type PresentUser } from "../account/presence";

const CONFLICT_HINT = "同一节点被两人同时修改时，后保存的会覆盖先保存的";

export function CanvasPresenceAvatars({ others }: { others: PresentUser[] }) {
  if (!others.length) return null;
  const { shown, extra } = presenceAvatars(others);
  const label = presenceLabel(others);
  return (
    <div className="canvas-presence-avatars" role="status" aria-label={label} title={`${label}\n${CONFLICT_HINT}`}>
      {shown.map((user) => (
        <span key={user.userId} className="canvas-presence-avatar" aria-hidden="true">{user.initial}</span>
      ))}
      {extra > 0 && <span className="canvas-presence-avatar is-extra" aria-hidden="true">+{extra}</span>}
    </div>
  );
}

export function CanvasAccessChip({
  editing,
  ownerName,
  onToggleEdit,
}: {
  editing: boolean;
  ownerName: string;
  onToggleEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className={`canvas-access-chip-wrap${editing ? " is-editing" : ""}`} ref={root}>
      <button
        type="button"
        className="canvas-access-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={editing ? `正在编辑 ${ownerName} 的画布` : `${ownerName} 的私有画布 · 只读`}
        onClick={() => setOpen((value) => !value)}
      >
        {editing ? <PencilLine size={13} aria-hidden="true" /> : <Lock size={13} aria-hidden="true" />}
        <span>{editing ? "编辑中" : "只读"}</span>
      </button>
      {open && (
        <div className="canvas-access-popover" role="dialog" aria-label="画布访问状态">
          <p>
            {editing
              ? `正在编辑 ${ownerName} 的画布。编辑模式 30 分钟后自动关闭，修改会记录审计。`
              : `${ownerName} 的私有画布，当前只读，节点不可编辑。`}
          </p>
          <button
            type="button"
            className="canvas-access-popover-action"
            onClick={() => {
              setOpen(false);
              onToggleEdit();
            }}
          >
            {editing ? "退出编辑模式" : "开启编辑模式"}
          </button>
        </div>
      )}
    </div>
  );
}
