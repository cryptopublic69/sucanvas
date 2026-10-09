import { request } from "./bridge";

export type ComfyConnection = {
  comfyUrl: string;
  comfyInputDirectory: string;
  comfyOutputDirectory: string;
};

export function readComfyConnection(): Promise<ComfyConnection> {
  return request("/api/comfy-config");
}

export function saveComfyConnection(connection: ComfyConnection): Promise<ComfyConnection> {
  if (connection.comfyUrl.replace(/\/+$/, "") === `${window.location.origin}/api/comfy`) {
    throw new Error("请填写实际的 ComfyUI 服务地址，不能填写画布代理地址");
  }
  return request("/api/comfy-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(connection),
  });
}
