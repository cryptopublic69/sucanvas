import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Thermometer } from "lucide-react";
import { openComfyProgressSocket } from "./CanvasNode";
import type { ComfyQueueSummary, JsonObject } from "./CanvasNode";
import { comfyStatusMessage } from "./comfyLivePreview";

type ComfyGpuMonitor = {
  temperatureCelsius: number;
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
    const gpu = (message.data as JsonObject).gpus;
    if (!Array.isArray(gpu) || !gpu.length || !gpu[0] || typeof gpu[0] !== "object") return null;
    const values = gpu[0] as JsonObject;
    const temperatureCelsius = Number(values.gpu_temperature);
    const vramUsedBytes = Number(values.vram_used);
    const vramTotalBytes = Number(values.vram_total);
    if (![temperatureCelsius, vramUsedBytes, vramTotalBytes].every(Number.isFinite)) {
      return null;
    }
    return { temperatureCelsius, vramUsedBytes, vramTotalBytes };
  } catch {
    return null;
  }
}

export const ComfyStatusIndicators = memo(function ComfyStatusIndicators({ serverUrl, showGpu = true }: { serverUrl: string; showGpu?: boolean }) {
  const [comfyQueueCounts, setComfyQueueCounts] = useState<ComfyQueueSummary>({
    runningCount: 0,
    pendingCount: 0,
    totalCount: 0,
  });
  const [comfyGpuMonitor, setComfyGpuMonitor] = useState<ComfyGpuMonitor | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const summary = await invoke<ComfyQueueSummary>("get_comfyui_queue_summary", {
          serverUrl,
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
  }, [serverUrl]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    const monitorClientId = `infinite-canvas-gpu-monitor-${crypto.randomUUID()}`;

    const reconnect = () => {
      if (disposed) return;
      reconnectTimer = window.setTimeout(() => void connect(), 3000);
    };
    const connect = async () => {
      const nextSocket = await openComfyProgressSocket(monitorClientId, serverUrl);
      if (disposed) {
        nextSocket?.close();
        return;
      }
      if (!nextSocket) {
        reconnect();
        return;
      }
      socket = nextSocket;
      nextSocket.addEventListener("message", (event) => {
        const nextMonitor = comfyGpuMonitorFromSocketData(event.data);
        if (nextMonitor && !disposed) setComfyGpuMonitor((current) =>
          current?.temperatureCelsius === nextMonitor.temperatureCelsius
          && current.vramUsedBytes === nextMonitor.vramUsedBytes
          && current.vramTotalBytes === nextMonitor.vramTotalBytes ? current : nextMonitor);
      });
      nextSocket.addEventListener("close", () => {
        if (socket === nextSocket) socket = null;
        reconnect();
      }, { once: true });
    };

    setComfyGpuMonitor(null);
    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
  }, [serverUrl]);

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

  const comfyGpuIndicator = comfyGpuMonitor ? (
    <span
      className="comfy-gpu-summary"
      aria-label={`ComfyUI GPU 温度 ${Math.round(comfyGpuMonitor.temperatureCelsius)} 摄氏度，显存占用 ${(comfyGpuMonitor.vramUsedBytes / 1024 ** 3).toFixed(1)}/${(comfyGpuMonitor.vramTotalBytes / 1024 ** 3).toFixed(1)} GiB`}
    >
      <Thermometer size={14} aria-hidden="true" />
      <strong>{Math.round(comfyGpuMonitor.temperatureCelsius)}°C</strong>
      <span>VRAM {(comfyGpuMonitor.vramUsedBytes / 1024 ** 3).toFixed(1)}/{(comfyGpuMonitor.vramTotalBytes / 1024 ** 3).toFixed(1)} GiB</span>
    </span>
  ) : null;

  return <>{comfyQueueIndicator}{showGpu && comfyGpuIndicator}</>;
});
