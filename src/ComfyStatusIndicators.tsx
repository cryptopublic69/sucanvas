import { memo, useEffect, useRef, useState } from "react";
import type { ComfySocket } from "./web/comfySocket";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Thermometer } from "lucide-react";
import { openComfyProgressSocket } from "./CanvasNode";
import type { ComfyQueueSummary, JsonObject } from "./CanvasNode";
import { comfyStatusMessage } from "./comfyLivePreview";

type ComfyMonitorChannel = "local" | "colab";

const MONITOR_CHANNEL_STORAGE_KEY = "infinite-canvas:comfy-monitor-channel";

function readStoredMonitorChannel(): ComfyMonitorChannel {
  try {
    return window.localStorage.getItem(MONITOR_CHANNEL_STORAGE_KEY) === "colab" ? "colab" : "local";
  } catch {
    return "local";
  }
}

type ComfyGpuMonitor = {
  temperatureCelsius: number | null;
  cpuUtilization: number | null;
  vramUsedBytes: number;
  vramTotalBytes: number;
};

function comfyGpuMonitorFromSocketData(data: unknown): ComfyGpuMonitor | null {
  if (typeof data !== "string") return null;
  try {
    const message = comfyStatusMessage(data);
    if (!message || message.type !== "crystools.monitor" || !message.data || typeof message.data !== "object") {
      return null;
    }
    const payload = message.data as JsonObject;
    const gpu = payload.gpus;
    if (!Array.isArray(gpu) || !gpu.length || !gpu[0] || typeof gpu[0] !== "object") return null;
    const values = gpu[0] as JsonObject;
    const rawTemp = Number(values.gpu_temperature);
    const vramUsedBytes = Number(values.vram_used);
    const vramTotalBytes = Number(values.vram_total);
    if (![vramUsedBytes, vramTotalBytes].every(Number.isFinite) || vramTotalBytes <= 0) {
      return null;
    }
    const rawCpu = Number(payload.cpu_utilization);
    return {
      temperatureCelsius: Number.isFinite(rawTemp) ? rawTemp : null,
      cpuUtilization: Number.isFinite(rawCpu) ? rawCpu : null,
      vramUsedBytes,
      vramTotalBytes,
    };
  } catch {
    return null;
  }
}

const MONITOR_SILENCE_MS = 20_000;

function isCrystoolsMonitorMessage(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    return comfyStatusMessage(data)?.type === "crystools.monitor";
  } catch {
    return false;
  }
}

export const ComfyStatusIndicators = memo(function ComfyStatusIndicators({
  serverUrl,
  colabServerUrl,
  colabLabel,
  showGpu = true,
}: {
  serverUrl: string;
  colabServerUrl?: string;
  colabLabel?: string;
  showGpu?: boolean;
}) {
  const [selectedChannel, setSelectedChannel] = useState<ComfyMonitorChannel>(readStoredMonitorChannel);
  const [menuOpen, setMenuOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const activeChannel: ComfyMonitorChannel = colabServerUrl && selectedChannel === "colab" ? "colab" : "local";
  const effectiveServerUrl = activeChannel === "colab" && colabServerUrl ? colabServerUrl : serverUrl;

  const [comfyQueueCounts, setComfyQueueCounts] = useState<ComfyQueueSummary>({
    runningCount: 0,
    pendingCount: 0,
    totalCount: 0,
  });
  const [comfyGpuMonitor, setComfyGpuMonitor] = useState<ComfyGpuMonitor | null>(null);

  useEffect(() => {
    if (!colabServerUrl) setMenuOpen(false);
  }, [colabServerUrl]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const selectMonitorChannel = (nextChannel: ComfyMonitorChannel) => {
    setSelectedChannel(nextChannel);
    setMenuOpen(false);
    try {
      window.localStorage.setItem(MONITOR_CHANNEL_STORAGE_KEY, nextChannel);
    } catch {
      // Ignore storage errors in restricted environments.
    }
  };

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    setComfyQueueCounts({ runningCount: 0, pendingCount: 0, totalCount: 0 });
    const poll = async () => {
      try {
        const summary = await invoke<ComfyQueueSummary>("get_comfyui_queue_summary", {
          serverUrl: effectiveServerUrl,
        });
        if (!disposed) setComfyQueueCounts((current) =>
          current.runningCount === summary.runningCount && current.pendingCount === summary.pendingCount
          && current.totalCount === summary.totalCount ? current : summary);
      } catch {
        // Global queue visibility is supplemental and must not interrupt editing or generation.
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [effectiveServerUrl]);

  useEffect(() => {
    let disposed = false;
    let socket: ComfySocket | null = null;
    let reconnectTimer: number | null = null;
    let statsTimer: number | null = null;
    const newMonitorClientId = () => `infinite-canvas-gpu-monitor-${crypto.randomUUID()}`;
    let monitorClientId = newMonitorClientId();
    // Silence detection only applies once this ComfyUI has proven it sends crystools data.
    let monitorSeen = false;
    let lastMonitorAt = 0;

    const pollSystemStatsFallback = async () => {
      if (disposed || import.meta.env.MODE !== "web") return;
      if (monitorSeen && Date.now() - lastMonitorAt < 10_000) return;
      try {
        const response = await fetch(`${effectiveServerUrl}/system_stats`, { credentials: "same-origin" });
        if (!response.ok || disposed) return;
        const payload = await response.json() as { devices?: Array<{ vram_total?: unknown; vram_free?: unknown }> };
        const device = Array.isArray(payload?.devices) ? payload.devices[0] : null;
        const vramTotal = Number(device?.vram_total);
        const vramFree = Number(device?.vram_free);
        if (!disposed && Number.isFinite(vramTotal) && vramTotal > 0 && Number.isFinite(vramFree) && vramFree >= 0) {
          if (monitorSeen && Date.now() - lastMonitorAt < 10_000) return;
          setComfyGpuMonitor({
            temperatureCelsius: null,
            cpuUtilization: null,
            vramUsedBytes: Math.max(0, vramTotal - vramFree),
            vramTotalBytes: vramTotal,
          });
        }
      } catch {
        // Ignore transient HTTP fallback errors.
      }
    };

    const reconnect = () => {
      if (disposed) return;
      reconnectTimer = window.setTimeout(() => void connect(), 3000);
    };
    const connect = async () => {
      const nextSocket = await openComfyProgressSocket(monitorClientId, effectiveServerUrl);
      if (disposed) {
        nextSocket?.close();
        return;
      }
      if (!nextSocket) {
        reconnect();
        return;
      }
      socket = nextSocket;
      lastMonitorAt = Date.now();
      nextSocket.addEventListener("message", (event) => {
        if (isCrystoolsMonitorMessage(event.data)) {
          monitorSeen = true;
          lastMonitorAt = Date.now();
        }
        const nextMonitor = comfyGpuMonitorFromSocketData(event.data);
        if (nextMonitor && !disposed) setComfyGpuMonitor((current) =>
          current?.temperatureCelsius === nextMonitor.temperatureCelsius
          && current?.cpuUtilization === nextMonitor.cpuUtilization
          && current.vramUsedBytes === nextMonitor.vramUsedBytes
          && current.vramTotalBytes === nextMonitor.vramTotalBytes ? current : nextMonitor);
      });
      nextSocket.addEventListener("close", () => {
        if (socket === nextSocket) socket = null;
        reconnect();
      }, { once: true });
    };
    // An open socket that ComfyUI no longer addresses stays silent forever; a fresh
    // clientId cannot collide with an upstream registration that is still finishing.
    const silenceWatch = window.setInterval(() => {
      if (disposed || !monitorSeen || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMonitorAt < MONITOR_SILENCE_MS) return;
      console.warn("[comfy-ws] GPU monitor silent, reconnecting with a new client id");
      monitorClientId = newMonitorClientId();
      socket.close();
    }, 5000);

    setComfyGpuMonitor(null);
    void connect();
    if (import.meta.env.MODE === "web") {
      void pollSystemStatsFallback();
      statsTimer = window.setInterval(() => void pollSystemStatsFallback(), 4000);
    }
    return () => {
      disposed = true;
      window.clearInterval(silenceWatch);
      if (statsTimer !== null) window.clearInterval(statsTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
  }, [effectiveServerUrl]);

  const comfyQueueIndicator = comfyQueueCounts.totalCount > 0 ? (
    <span
      className="comfy-queue-summary"
      title={`当前 ${comfyQueueCounts.totalCount} 个任务，${comfyQueueCounts.runningCount} 个正在执行，${comfyQueueCounts.pendingCount} 个等待中`}
      aria-label={`当前 ${comfyQueueCounts.totalCount} 个任务，${comfyQueueCounts.runningCount} 个正在执行，${comfyQueueCounts.pendingCount} 个等待中`}
    >
      <span aria-hidden="true" />
      {comfyQueueCounts.totalCount}
    </span>
  ) : null;

  const gpuMetricAria = comfyGpuMonitor
    ? `${activeChannel === "colab" ? "Colab" : "本地"} ComfyUI ${comfyGpuMonitor.cpuUtilization !== null ? `CPU ${Math.round(comfyGpuMonitor.cpuUtilization)}%，` : ""}${comfyGpuMonitor.temperatureCelsius !== null ? `GPU 温度 ${Math.round(comfyGpuMonitor.temperatureCelsius)} 摄氏度，` : ""}显存占用 ${(comfyGpuMonitor.vramUsedBytes / 1024 ** 3).toFixed(1)}/${(comfyGpuMonitor.vramTotalBytes / 1024 ** 3).toFixed(1)} GiB`
    : `${activeChannel === "colab" ? "Colab" : "本地"} ComfyUI 资源监控等待数据`;

  const metricsContent = comfyGpuMonitor ? (
    <>
      {comfyGpuMonitor.temperatureCelsius !== null && (
        <>
          <Thermometer size={14} aria-hidden="true" />
          <strong>{Math.round(comfyGpuMonitor.temperatureCelsius)}°C</strong>
        </>
      )}
      {comfyGpuMonitor.cpuUtilization !== null && (
        <span>CPU {Math.round(comfyGpuMonitor.cpuUtilization)}%</span>
      )}
      <span>VRAM {(comfyGpuMonitor.vramUsedBytes / 1024 ** 3).toFixed(1)}/{(comfyGpuMonitor.vramTotalBytes / 1024 ** 3).toFixed(1)} GiB</span>
    </>
  ) : (
    <span>等待监控</span>
  );

  const comfyGpuIndicator = colabServerUrl ? (
    <div ref={switcherRef} className="comfy-monitor-switcher">
      <button
        type="button"
        className="comfy-gpu-summary is-switchable"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${gpuMetricAria}（点击切换监控目标）`}
        title="切换画布资源监控目标（本地 / Colab）"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className={`comfy-monitor-source ${activeChannel === "colab" ? "is-colab" : ""}`}>
          {activeChannel === "colab" ? "Colab" : "本地"}
        </span>
        {metricsContent}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="comfy-monitor-menu" role="menu" aria-label="ComfyUI 资源监控目标">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeChannel === "local"}
            className={activeChannel === "local" ? "is-active" : ""}
            onClick={() => selectMonitorChannel("local")}
          >
            本地 ComfyUI
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeChannel === "colab"}
            className={activeChannel === "colab" ? "is-active" : ""}
            onClick={() => selectMonitorChannel("colab")}
          >
            {colabLabel ? `Colab · ${colabLabel}` : "Colab ComfyUI"}
          </button>
        </div>
      )}
    </div>
  ) : comfyGpuMonitor ? (
    <span className="comfy-gpu-summary" aria-label={gpuMetricAria}>
      {metricsContent}
    </span>
  ) : null;

  return <>{comfyQueueIndicator}{showGpu && comfyGpuIndicator}</>;
});
