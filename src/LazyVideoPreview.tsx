import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Film } from "lucide-react";
import { posterMemoryCache, requestVideoPoster } from "./videoPosterCache";
import { videoPreviewScheduler } from "./videoPreviewScheduler";

export interface VideoPreviewHandle { playFullscreen(): void }
interface Props {
  src: string;
  muted?: boolean;
  onDimensions?: (width: number, height: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onEnded?: () => void;
  onTimeUpdate?: (video: HTMLVideoElement) => void;
}

const positions = new Map<string, number>();

export const LazyVideoPreview = forwardRef<VideoPreviewHandle, Props>(function LazyVideoPreview(props, ref) {
  const { src, muted = false } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [mounted, setMounted] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const [poster, setPoster] = useState(() => posterMemoryCache.peek(src)?.url ?? "");
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ownedVideo = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const alive = useRef(true);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ownership = useRef<(() => void) | undefined>(undefined);
  const pendingFrame = useRef<{ video: HTMLVideoElement; handle: number } | undefined>(undefined);

  function cancelPendingFrame() {
    if (!pendingFrame.current) return;
    pendingFrame.current.video.cancelVideoFrameCallback(pendingFrame.current.handle);
    pendingFrame.current = undefined;
  }

  function revealFallbackFrame(video: HTMLVideoElement) {
    if (typeof video.requestVideoFrameCallback === "function") return;
    if (alive.current && ownedVideo.current === video && video.readyState >= 2 && !video.seeking) {
      setFrameReady(true);
    }
  }

  function clearTimers() {
    clearTimeout(hoverTimer.current);
    clearTimeout(unloadTimer.current);
  }

  function release() {
    clearTimers();
    cancelPendingFrame();
    const video = ownedVideo.current;
    if (video) {
      positions.delete(src);
      positions.set(src, video.ended ? 0 : video.currentTime);
      if (positions.size > 128) positions.delete(positions.keys().next().value!);
      video.pause();
      video.removeAttribute("src");
      video.load();
      ownedVideo.current = null;
    }
    callbacks.current.onPlayingChange?.(false);
    ownership.current?.();
    ownership.current = undefined;
    if (alive.current) {
      setMounted(false);
      setFrameReady(false);
    }
  }

  function activate(fullscreen = false) {
    clearTimers();
    if (document.hidden || (document.fullscreenElement && document.fullscreenElement !== videoRef.current)) return;
    if (!ownership.current) ownership.current = videoPreviewScheduler.claim(release);
    // Mount synchronously so requestFullscreen keeps the button's user activation.
    flushSync(() => {
      if (videoRef.current?.getAttribute("src") !== src) setFrameReady(false);
      setMounted(true);
      setFailed(false);
    });
    const video = videoRef.current;
    if (!video) { release(); return; }
    ownedVideo.current = video;
    if (video.getAttribute("src") !== src) video.src = src;
    cancelPendingFrame();
    if (typeof video.requestVideoFrameCallback === "function") {
      pendingFrame.current = {
        video,
        handle: video.requestVideoFrameCallback(() => {
          pendingFrame.current = undefined;
          if (alive.current && ownedVideo.current === video && video.hasAttribute("src")) setFrameReady(true);
        }),
      };
    } else {
      revealFallbackFrame(video);
    }
    if (fullscreen) void video.requestFullscreen().catch(() => {});
    void video.play().catch(() => {
      if (alive.current && videoRef.current === video && video.hasAttribute("src")) setFailed(true);
    });
  }

  useImperativeHandle(ref, () => ({ playFullscreen: () => activate(true) }));

  useLayoutEffect(() => {
    alive.current = true;
    let releasePoster: (() => void) | undefined;
    let cancelPoster: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let retries = 0;
    const retryDelays = [2500, 10000];
    setPoster(posterMemoryCache.peek(src)?.url ?? "");
    const loadPoster = () => {
      cancelPoster?.();
      cancelPoster = requestVideoPoster(src, (result) => {
        if (disposed) return;
        if (!result) {
          if (retries < retryDelays.length) retryTimer = setTimeout(loadPoster, retryDelays[retries++]);
          return;
        }
        releasePoster?.();
        const cached = posterMemoryCache.retain(src);
        releasePoster = cached?.release;
        setPoster(cached?.url ?? "");
        if (result.width && result.height) callbacks.current.onDimensions?.(result.width, result.height);
      });
    };
    loadPoster();
    const visibility = () => { if (document.hidden) release(); };
    const fullscreenChange = () => {
      if (!document.fullscreenElement && !wrapperRef.current?.matches(":hover")) release();
    };
    const fullscreenSpace = (event: KeyboardEvent) => {
      const video = videoRef.current;
      if (event.code !== "Space" || !video || document.fullscreenElement !== video) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== "keydown" || event.repeat) return;
      if (video.ended) {
        video.currentTime = 0;
        activate();
      } else if (video.paused) {
        activate();
      } else {
        video.pause();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreenChange);
    window.addEventListener("keydown", fullscreenSpace, true);
    window.addEventListener("keyup", fullscreenSpace, true);
    return () => {
      alive.current = false;
      disposed = true;
      clearTimeout(retryTimer);
      cancelPoster?.();
      release();
      releasePoster?.();
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreenChange);
      window.removeEventListener("keydown", fullscreenSpace, true);
      window.removeEventListener("keyup", fullscreenSpace, true);
    };
  }, [src]);

  return (
    <span
      ref={wrapperRef}
      className="lazy-video-preview"
      onMouseEnter={() => {
        clearTimers();
        hoverTimer.current = setTimeout(() => activate(), 250);
      }}
      onMouseLeave={() => {
        clearTimers();
        if (videoRef.current && document.fullscreenElement === videoRef.current) return;
        videoRef.current?.pause();
        unloadTimer.current = setTimeout(release, 1200);
      }}
      onClick={() => { if (!mounted || failed) activate(); }}
    >
      {poster ? <img src={poster} alt="视频封面" draggable={false} /> : (
        <span className="lazy-video-placeholder"><Film size={24} /><small>悬停播放</small></span>
      )}
      {mounted && (
        <video
          ref={videoRef}
          className={frameReady ? "is-frame-ready" : undefined}
          poster={poster || undefined}
          muted={muted}
          preload="none"
          playsInline
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            callbacks.current.onDimensions?.(video.videoWidth, video.videoHeight);
            const position = positions.get(src) ?? 0;
            if (position > 0 && position < video.duration - 0.1) video.currentTime = position;
          }}
          onPlay={() => callbacks.current.onPlayingChange?.(true)}
          onLoadedData={(event) => revealFallbackFrame(event.currentTarget)}
          onPlaying={(event) => revealFallbackFrame(event.currentTarget)}
          onSeeked={(event) => revealFallbackFrame(event.currentTarget)}
          onPause={() => callbacks.current.onPlayingChange?.(false)}
          onEnded={() => {
            callbacks.current.onPlayingChange?.(false);
            callbacks.current.onEnded?.();
          }}
          onTimeUpdate={(event) => callbacks.current.onTimeUpdate?.(event.currentTarget)}
          onError={() => { setFailed(true); release(); }}
        />
      )}
    </span>
  );
});
