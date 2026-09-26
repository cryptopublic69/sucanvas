import { useEffect, type RefObject } from "react";

// Only bind while open: collapsed dropdowns leave wheel handling to React Flow.
export function useDropdownWheel(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  menuSelector: string,
  activeKey?: string | number | null,
): void {
  useEffect(() => {
    const control = ref.current;
    if (!open || !control) return;
    const handleWheel = (event: WheelEvent) => {
      const menu = control.querySelector<HTMLElement>(menuSelector);
      if (!menu) return;
      // Also capture at either end of the list; never chain scrolling to canvas.
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? menu.clientHeight : 1;
      menu.scrollTop += event.deltaY * unit;
    };
    control.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => control.removeEventListener("wheel", handleWheel, true);
  }, [ref, open, menuSelector, activeKey]);
}
