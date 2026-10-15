// The desktop path continues to use its native, single WebSocket connection.
export type ComfySocket = Pick<WebSocket, "readyState" | "binaryType" | "close" | "addEventListener">;

export const COMFY_SOCKET_HEARTBEAT = '{"type":"sucanvas.websocket.heartbeat"}';
const CONNECT_TIMEOUT_MS = 12_000;
const STALE_AFTER_MS = 35_000;
let sessionCheck: Promise<void> | null = null;

function checkSession() {
  if (sessionCheck) return;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5000);
  sessionCheck = fetch("/api/auth/session", { credentials: "same-origin", signal: controller.signal })
    .then(response => {
      if (response.status === 401) window.dispatchEvent(new Event("sucanvas:session-expired"));
    })
    .catch(() => { /* An unreachable server is not evidence of an expired session. */ })
    .finally(() => { window.clearTimeout(timer); sessionCheck = null; });
}

class RecoveringComfySocket extends EventTarget {
  private socket: WebSocket | null = null;
  private stopped = false;
  private failures = 0;
  private lastReceived = 0;
  private retryTimer: number | undefined;
  private connectTimer: number | undefined;
  private watchdogTimer: number | undefined;
  private firstTimer: number | undefined;
  private resolveFirst!: () => void;
  private type: BinaryType = "blob";
  readonly ready: Promise<void>;

  constructor(private readonly url: string) {
    super();
    this.ready = new Promise(resolve => { this.resolveFirst = resolve; });
    // A preview outage must not prevent submitting the generation itself.
    this.firstTimer = window.setTimeout(() => this.finishFirst(), 4000);
    window.addEventListener("online", this.wake);
    window.addEventListener("pageshow", this.wake);
    window.addEventListener("focus", this.wake);
    window.addEventListener("sucanvas:session-expired", this.expire);
    document.addEventListener("visibilitychange", this.wake);
    this.connect();
  }

  get readyState() { return this.stopped ? WebSocket.CLOSED : this.socket?.readyState ?? WebSocket.CONNECTING; }
  get binaryType() { return this.type; }
  set binaryType(value: BinaryType) { this.type = value; if (this.socket) this.socket.binaryType = value; }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, listener, options);
  }

  private finishFirst() {
    window.clearTimeout(this.firstTimer);
    this.firstTimer = undefined;
    this.resolveFirst();
  }

  private releaseSocket() {
    window.clearTimeout(this.connectTimer);
    window.clearTimeout(this.watchdogTimer);
    const socket = this.socket;
    this.socket = null; // Ignore late close/message events from the old transport.
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  private fail(reason: string) {
    if (this.stopped) return;
    this.releaseSocket();
    this.finishFirst();
    this.failures++;
    console.warn("[comfy-ws] reconnecting", { reason, attempt: this.failures });
    checkSession();
    window.clearTimeout(this.retryTimer);
    const delay = Math.min(10_000, 1000 * 2 ** Math.min(this.failures - 1, 4));
    this.retryTimer = window.setTimeout(() => { this.retryTimer = undefined; this.connect(); }, delay);
  }

  private connect() {
    if (this.stopped || this.socket) return;
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); }
    catch { this.fail("connection could not start"); return; }
    this.socket = socket;
    socket.binaryType = this.type;
    this.connectTimer = window.setTimeout(() => this.fail("connection timeout"), CONNECT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) return;
      window.clearTimeout(this.connectTimer);
      this.lastReceived = Date.now();
      this.finishFirst();
      this.watch();
      this.dispatchEvent(new Event("open"));
    });
    socket.addEventListener("message", event => {
      if (this.socket !== socket || this.stopped) return;
      this.lastReceived = Date.now();
      this.failures = 0;
      if (event.data === COMFY_SOCKET_HEARTBEAT) return;
      this.dispatchEvent(new MessageEvent("message", { data: event.data }));
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.fail("transport error");
    });
    socket.addEventListener("close", event => {
      if (this.socket === socket) this.fail(`transport closed (${event.code})`);
    });
  }

  private watch() {
    if (this.stopped) return;
    this.watchdogTimer = window.setTimeout(() => {
      if (!document.hidden && Date.now() - this.lastReceived >= STALE_AFTER_MS) this.fail("heartbeat timeout");
      else this.watch();
    }, 5000);
  }

  private wake = () => {
    if (this.stopped || document.hidden || this.socket?.readyState === WebSocket.CONNECTING) return;
    if (this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastReceived < STALE_AFTER_MS) return;
    this.releaseSocket();
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connect();
  };

  private expire = () => this.close(1000, "session expired");

  close(code = 1000, reason = "") {
    if (this.stopped) return;
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    this.releaseSocket();
    this.finishFirst();
    window.removeEventListener("online", this.wake);
    window.removeEventListener("pageshow", this.wake);
    window.removeEventListener("focus", this.wake);
    window.removeEventListener("sucanvas:session-expired", this.expire);
    document.removeEventListener("visibilitychange", this.wake);
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

export async function openWebComfySocket(url: string): Promise<ComfySocket> {
  const socket = new RecoveringComfySocket(url);
  await socket.ready;
  return socket;
}
