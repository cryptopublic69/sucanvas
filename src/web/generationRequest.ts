type TaskResponse<T> = { taskId?: string; pending?: boolean; result?: T; error?: string };
type Request = <T>(path: string, options?: RequestInit, timeoutMs?: number) => Promise<T>;

export function recoverableWebGenerationFailure(content: Record<string, unknown>): boolean {
  return content.generationPlaceholder === true && content.status === "invalid"
    && typeof content.placeholderClientId === "string" && Boolean(content.placeholderClientId)
    && typeof content.validationMessage === "string"
    && /^(?:生成|图片生成|图片放大|超分|2采)失败：/.test(content.validationMessage)
    && /(?:<title>\s*(?:502|503|504)\b|\bHTTP\s+(?:502|503|504)\b|\b(?:502|503|504)\s+(?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b|服务器响应超时|Failed to fetch|NetworkError)/i.test(content.validationMessage);
}

export class WebHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WebHttpError";
  }
}

function interrupted(error: unknown): boolean {
  return error instanceof TypeError || error instanceof SyntaxError
    || (error instanceof Error && error.name === "WebRequestTimeoutError")
    || (error instanceof WebHttpError && [408, 429, 502, 503, 504].includes(error.status));
}

// Submit once. After an ambiguous response, only read the same task's result;
// retrying a ComfyUI submission could generate and charge for a second video.
export async function generationRequest<T>(
  request: Request,
  command: string,
  body: string,
  options: {
    taskId?: string;
    sleep?: () => Promise<void>;
    onUnavailable?: () => void;
  } = {},
): Promise<T> {
  const taskId = options.taskId ?? crypto.randomUUID();
  const sleep = options.sleep ?? (() => new Promise<void>(resolve => window.setTimeout(resolve, 2000)));
  let unavailableReported = false;
  try {
    const response = await request<TaskResponse<T>>(`/api/invoke/${encodeURIComponent(command)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(body), webTaskId: taskId }),
    }, 20_000);
    // Also accept the original protocol during a staged server update.
    if ("result" in response) return response.result as T;
    if (response.taskId !== taskId) throw new Error("服务器未返回有效的生成任务编号");
  } catch (error) {
    if (!interrupted(error)) throw error;
  }
  for (;;) {
    await sleep();
    let response: TaskResponse<T>;
    try {
      response = await request<TaskResponse<T>>(`/api/generation-tasks/${encodeURIComponent(taskId)}`, undefined, 20_000);
    } catch (error) {
      if (error instanceof WebHttpError && error.status === 404) {
        // A server restart loses the in-memory transport record. Keep the
        // canvas recovery record intact until the user reopens the project.
        if (!unavailableReported) {
          unavailableReported = true;
          options.onUnavailable?.();
        }
        continue;
      }
      if (interrupted(error)) continue;
      throw error;
    }
    if (response.error) throw new Error(response.error);
    if ("result" in response) return response.result as T;
    if (!response.pending) throw new Error("生成任务返回了无效状态");
  }
}
