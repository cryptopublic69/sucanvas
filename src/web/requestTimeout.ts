export const WEB_REQUEST_TIMEOUT_MS = 60_000;

export class WebRequestTimeoutError extends Error {
  constructor() {
    super("服务器响应超时，请重新进入项目确认操作结果。");
    this.name = "WebRequestTimeoutError";
  }
}

// Include response-body reads in the deadline. Never retry a mutation implicitly.
export async function withRequestTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs = WEB_REQUEST_TIMEOUT_MS,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    const reason = parent?.reason ?? new DOMException("请求已取消", "AbortError");
    rejectAbort(reason);
    controller.abort(reason);
  };
  try {
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) cancel();
    if (timeoutMs > 0) timer = setTimeout(() => {
      const error = new WebRequestTimeoutError();
      rejectAbort(error);
      controller.abort(error);
    }, timeoutMs);
    return await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}

export function rpcTimeoutMs(command: string): number {
  // These RPCs wait for generation completion or large file operations.
  return /^(submit_comfyui_|export_|import_|restore_(app_backup|workflow_module)|capture_video_poster)/.test(command)
    ? 0 : WEB_REQUEST_TIMEOUT_MS;
}
