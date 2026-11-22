import { request } from "../web/bridge";
import type { ColabProfileStatus } from "./types";

export const COLAB_PROXY_PATH = "/api/comfy-colab";

export function readColabProfile(): Promise<ColabProfileStatus> {
  return request("/api/colab-profile");
}

export function colabProxyServerUrl(): string {
  return `${window.location.origin}${COLAB_PROXY_PATH}`;
}

export function isColabProxyUrl(normalizedUrl: string): boolean {
  return normalizedUrl === `${window.location.origin}${COLAB_PROXY_PATH}`
    || normalizedUrl === COLAB_PROXY_PATH;
}
