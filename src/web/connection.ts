import { request } from "./bridge";
import { isColabProxyUrl } from "../colab/api";
import type { ColabProfileOption } from "../colab/types";

export type ComfyConnection = {
  comfyUrl: string;
  comfyInputDirectory: string;
  comfyOutputDirectory: string;
  colabComfyUrl?: string;
  colabSsPassword?: string;
  colabProfile?: ColabProfileOption;
};

export function readComfyConnection(): Promise<ComfyConnection> {
  return request("/api/comfy-config");
}

export function saveComfyConnection(connection: ComfyConnection): Promise<ComfyConnection> {
  const normalizedUrl = connection.comfyUrl.replace(/\/+$/, "");
  const normalizedColabUrl = (connection.colabComfyUrl ?? "").replace(/\/+$/, "");
  if (
    normalizedUrl === `${window.location.origin}/api/comfy`
    || isColabProxyUrl(normalizedUrl)
    || normalizedColabUrl === `${window.location.origin}/api/comfy`
    || isColabProxyUrl(normalizedColabUrl)
  ) {
    throw new Error("请填写实际的 ComfyUI 服务地址，不能填写画布代理地址");
  }
  return request("/api/comfy-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(connection),
  });
}
