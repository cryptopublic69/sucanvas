import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import { webVideoStills } from "./videoStillCache";

export function useVideoStill(src: string, host: RefObject<HTMLElement | null>): string {
  const [frame, setFrame] = useState<{ src: string; url: string } | null>(null);
  useLayoutEffect(() => {
    if (import.meta.env.MODE !== "web" || !src || !host.current) return;
    const element = host.current;
    const subscription = webVideoStills.watch(src, url => setFrame({ src, url }));
    let inView = true;
    const refresh = () => subscription.setVisible(inView && !document.hidden);
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0);
      refresh();
    }, { root: element.closest(".react-flow"), threshold: 0 }) : undefined;
    observer?.observe(element);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      subscription.release();
    };
  }, [src, host]);
  if (import.meta.env.MODE !== "web" || !src) return "";
  return frame?.src === src ? frame.url : webVideoStills.peek(src);
}
