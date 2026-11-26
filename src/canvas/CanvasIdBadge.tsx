import { Check, Info } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export interface CopyCanvasIdEnvironment {
  writeClipboardText?: (text: string) => Promise<void>;
  execCopyCommand?: (text: string) => boolean;
}

export interface CopyCanvasIdResult {
  ok: boolean;
  method: "clipboard" | "execCommand" | "manual";
}

function browserCopyWithExecCommand(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  const selection = document.getSelection?.();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }
  return copied;
}

/**
 * Copies `canvasId` to clipboard, falling back to `document.execCommand("copy")`
 * on non-HTTPS LAN origins before prompting manual copy.
 */
export async function copyCanvasIdText(
  text: string,
  env?: CopyCanvasIdEnvironment,
): Promise<CopyCanvasIdResult> {
  const writeClipboardText = env?.writeClipboardText
    ?? (typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? (value: string) => navigator.clipboard.writeText(value)
      : undefined);

  if (writeClipboardText) {
    try {
      await writeClipboardText(text);
      return { ok: true, method: "clipboard" };
    } catch {
      // Fall back to execCommand for insecure origins or denied async clipboard.
    }
  }

  const execCopy = env?.execCopyCommand ?? browserCopyWithExecCommand;
  try {
    if (execCopy(text)) {
      return { ok: true, method: "execCommand" };
    }
  } catch {
    // Fall through to manual fallback.
  }

  return { ok: false, method: "manual" };
}

interface CanvasIdBadgeProps {
  canvasId: string;
  variant: "card" | "header";
  onCopied?: (canvasId: string) => void;
}

export function CanvasIdBadge({ canvasId, variant, onCopied }: CanvasIdBadgeProps) {
  const [copied, setCopied] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setCopied(false);
    setManualOpen(false);
  }, [canvasId]);

  useEffect(() => {
    if (!manualOpen) return;
    manualInputRef.current?.focus();
    manualInputRef.current?.select();
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setManualOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setManualOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [manualOpen]);

  const handleCopy = async () => {
    const result = await copyCanvasIdText(canvasId);
    if (result.ok) {
      setManualOpen(false);
      setCopied(true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
      onCopied?.(canvasId);
    } else {
      setManualOpen(true);
    }
  };

  const stopBubble = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    event.stopPropagation();
  };

  const showTooltip = hovered || focused || copied || manualOpen;
  const iconSize = variant === "card" ? 13 : 12;
  const shortcutLabel = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)
    ? "⌘+C"
    : "Ctrl+C";

  return (
    <span
      ref={rootRef}
      className={`canvas-id-badge is-${variant}${showTooltip ? " is-open" : ""}${copied ? " is-copied" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="canvas-id-info-button"
        aria-label={`复制画布 ID：${canvasId}`}
        title={`画布 ID：${canvasId}（点击复制）`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void handleCopy();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && manualOpen) {
            event.preventDefault();
            setManualOpen(false);
          }
        }}
      >
        {copied ? <Check size={iconSize} /> : <Info size={iconSize} />}
      </button>
      {showTooltip && (
        <div
          className="canvas-id-tooltip"
          role="status"
          onClick={stopBubble}
          onMouseDown={stopBubble}
        >
          {manualOpen ? (
            <>
              <input
                ref={manualInputRef}
                type="text"
                readOnly
                className="canvas-id-manual-input"
                value={canvasId}
                aria-label="画布 ID"
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
              <small>无法写入剪贴板，请按 {shortcutLabel} 复制</small>
            </>
          ) : (
            <>
              <code>{canvasId}</code>
              <small>{copied ? "已复制到剪贴板" : "点击复制画布 ID"}</small>
            </>
          )}
        </div>
      )}
    </span>
  );
}
